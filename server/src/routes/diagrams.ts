import express, { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'
import { BLANK_DIAGRAM, createDiagramSchema, MAX_DIAGRAMS_PER_USER, updateDiagramSchema } from '../schemas'
import { createLimiter, saveLimiter } from '../security/limiters'

export const diagramsRouter = Router()

// Authenticate BEFORE reading the body, so anonymous clients can't make the server buffer 2 MB payloads.
diagramsRouter.use(requireAuth)

/** Everything except the (large) content: what the sidebar lists. */
const summary = { id: true, title: true, updatedAt: true } as const

const isUniqueId = (id: string) => z.uuid().safeParse(id).success
const isMissingRow = (err: unknown) => (err as { code?: string } | null)?.code === 'P2025'
const notFound = { error: 'Diagram not found' }

/** The signed-in user's diagrams, oldest first (a stable order, so the list doesn't jump while editing). */
diagramsRouter.get('/', async (req, res) => {
  const diagrams = await prisma.diagram.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: 'asc' },
    select: summary,
  })
  res.json({ diagrams })
})

diagramsRouter.post('/', createLimiter, express.json({ limit: '2mb' }), async (req, res) => {
  const input = createDiagramSchema.parse(req.body)
  const userId = req.user!.id
  if ((await prisma.diagram.count({ where: { userId } })) >= MAX_DIAGRAMS_PER_USER) {
    res.status(409).json({ error: `You can keep up to ${MAX_DIAGRAMS_PER_USER} diagrams. Delete one to add another.` })
    return
  }
  const diagram = await prisma.diagram.create({
    data: { userId, title: input.title ?? 'Untitled diagram', data: input.data ?? BLANK_DIAGRAM },
    select: summary,
  })
  res.status(201).json({ diagram })
})

// Every query below filters by the signed-in user as well as the id, so one account can never touch another's.
diagramsRouter.get('/:id', async (req, res) => {
  const id = String(req.params.id)
  const diagram = isUniqueId(id)
    ? await prisma.diagram.findFirst({
        where: { id, userId: req.user!.id },
        select: { ...summary, data: true },
      })
    : null
  if (!diagram) {
    res.status(404).json(notFound)
    return
  }
  res.json({ diagram })
})

diagramsRouter.put('/:id', saveLimiter, express.json({ limit: '2mb' }), async (req, res) => {
  const id = String(req.params.id)
  const input = updateDiagramSchema.parse(req.body)
  if (!isUniqueId(id)) {
    res.status(404).json(notFound)
    return
  }
  try {
    const row = await prisma.diagram.update({
      where: { id, userId: req.user!.id },
      data: { title: input.title, data: input.data },
      select: { updatedAt: true, title: true },
    })
    res.json({ updatedAt: row.updatedAt, title: row.title })
  } catch (err) {
    if (!isMissingRow(err)) throw err
    res.status(404).json(notFound)
  }
})

diagramsRouter.delete('/:id', saveLimiter, async (req, res) => {
  const id = String(req.params.id)
  const { count } = isUniqueId(id)
    ? await prisma.diagram.deleteMany({ where: { id, userId: req.user!.id } })
    : { count: 0 }
  if (!count) {
    res.status(404).json(notFound)
    return
  }
  res.status(204).end()
})
