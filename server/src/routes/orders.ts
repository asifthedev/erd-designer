import express, { Router } from 'express'
import { paymentInstructions } from '../billing'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'
import { entitlementOf } from '../plans'
import { createOrderSchema, updateOrderSchema } from '../schemas'
import { orderLimiter, saveLimiter } from '../security/limiters'

/** The signed-in user's purchase requests (see billing.ts for how an order becomes a plan). */
export const ordersRouter = Router()
ordersRouter.use(requireAuth)

type OrderRow = NonNullable<Awaited<ReturnType<typeof prisma.order.findUnique>>> & {
  plan: { name: string; kind: string }
}

export const orderJson = (o: OrderRow) => ({
  id: o.id,
  planId: o.planId,
  planName: o.plan.name,
  planKind: o.plan.kind,
  status: o.status,
  amountCents: o.amountCents,
  currency: o.currency,
  contact: o.contact,
  reference: o.reference,
  createdAt: o.createdAt,
  paidAt: o.paidAt,
})

const notFound = { error: 'Order not found' }
const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id)

ordersRouter.get('/', async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { plan: { select: { name: true, kind: true } } },
  })
  res.json({ orders: orders.map(orderJson), instructions: await paymentInstructions() })
})

/**
 * Starts a purchase. Nothing is charged here: the order waits for the buyer to pay as the instructions say, and for
 * the admin to confirm it. Asking again for a plan that already has an open order returns that order.
 */
ordersRouter.post('/', orderLimiter, express.json({ limit: '4kb' }), async (req, res) => {
  const input = createOrderSchema.parse(req.body)
  const userId = req.user!.id
  const plan = await prisma.plan.findUnique({ where: { id: input.planId } })
  if (!plan || !plan.active || plan.kind === 'free') {
    res.status(400).json({ error: 'That plan is not available.' })
    return
  }
  const current = await entitlementOf(userId)
  if (current.kind === 'lifetime') {
    res.status(409).json({ error: 'You already have the Lifetime plan.' })
    return
  }
  const include = { plan: { select: { name: true, kind: true } } }
  const open = await prisma.order.findFirst({ where: { userId, planId: plan.id, status: 'pending' }, include })
  if (open) {
    const order =
      input.contact !== undefined
        ? await prisma.order.update({ where: { id: open.id }, data: { contact: input.contact }, include })
        : open
    res.json({ order: orderJson(order), instructions: await paymentInstructions() })
    return
  }
  const order = await prisma.order.create({
    data: {
      userId,
      planId: plan.id,
      amountCents: plan.priceCents,
      currency: plan.currency,
      contact: input.contact ?? '',
    },
    include,
  })
  res.status(201).json({ order: orderJson(order), instructions: await paymentInstructions() })
})

/** The buyer adds a payment reference (transaction id, name on the transfer) so the admin can match the payment. */
ordersRouter.put('/:id', saveLimiter, express.json({ limit: '4kb' }), async (req, res) => {
  const id = String(req.params.id)
  const input = updateOrderSchema.parse(req.body)
  if (!isId(id)) {
    res.status(404).json(notFound)
    return
  }
  const { count } = await prisma.order.updateMany({
    where: { id, userId: req.user!.id, status: 'pending' },
    data: { reference: input.reference, contact: input.contact },
  })
  if (!count) {
    res.status(404).json(notFound)
    return
  }
  const order = await prisma.order.findUniqueOrThrow({
    where: { id },
    include: { plan: { select: { name: true, kind: true } } },
  })
  res.json({ order: orderJson(order) })
})

ordersRouter.post('/:id/cancel', saveLimiter, async (req, res) => {
  const id = String(req.params.id)
  const { count } = isId(id)
    ? await prisma.order.updateMany({
        where: { id, userId: req.user!.id, status: 'pending' },
        data: { status: 'cancelled' },
      })
    : { count: 0 }
  if (!count) {
    res.status(404).json(notFound)
    return
  }
  res.status(204).end()
})
