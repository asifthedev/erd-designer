import express, { Router } from 'express'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'
import { diagramSchema } from '../schemas'
import { saveLimiter } from '../security/limiters'

export const diagramRouter = Router()

// Authenticate BEFORE reading the body, so anonymous clients can't make the server buffer 2 MB payloads.
diagramRouter.use(requireAuth)

/** The signed-in user's saved workspace, or `data: null` if they haven't saved one yet. */
diagramRouter.get('/', async (req, res) => {
  const row = await prisma.diagram.findUnique({ where: { userId: req.user!.id } })
  res.json({ data: row?.data ?? null, updatedAt: row?.updatedAt ?? null })
})

diagramRouter.put('/', saveLimiter, express.json({ limit: '2mb' }), async (req, res) => {
  const data = diagramSchema.parse(req.body)
  const row = await prisma.diagram.upsert({
    where: { userId: req.user!.id },
    create: { userId: req.user!.id, data },
    update: { data },
  })
  res.json({ updatedAt: row.updatedAt })
})
