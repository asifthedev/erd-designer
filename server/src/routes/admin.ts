import { createHash, timingSafeEqual } from 'node:crypto'
import express, { Router } from 'express'
import { ADMIN_COOKIE, endAdminSession, requireAdmin, startAdminSession } from '../admin/session'
import { dummyHash, verifyPassword } from '../auth/password'
import { activateOrder, paymentInstructions, savePaymentInstructions } from '../billing'
import { addMonth } from '../billingRules'
import { config } from '../config'
import { prisma } from '../db'
import { FEATURE_KEYS, toPlanInfo } from '../plans'
import {
  adminLoginSchema,
  adminOrderNoteSchema,
  adminSettingsSchema,
  setUserPlanSchema,
  updatePlanSchema,
} from '../schemas'
import { adminAiRouter } from './adminAi'
import { adminLimiter, adminLoginGlobalLimiter, adminLoginIpLimiter } from '../security/limiters'

/**
 * The admin panel's API. Its own login, cookie and sessions (see admin/session.ts); the admin is the one account set
 * in the environment. After login it can: see the numbers, change plans and their prices, see the registered users
 * (and put one on a plan by hand), confirm or cancel orders, and edit the payment instructions.
 */
export const adminRouter = Router()

const sha = (v: string) => createHash('sha256').update(v).digest()
const sameText = (a: string, b: string) => timingSafeEqual(sha(a), sha(b))
const notFound = { error: 'Not found' }

adminRouter.post(
  '/login',
  adminLoginIpLimiter,
  adminLoginGlobalLimiter,
  express.json({ limit: '2kb' }),
  async (req, res) => {
    if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD_HASH) {
      res.status(503).json({ error: 'The admin panel is not set up on this server.' })
      return
    }
    const { email, password } = adminLoginSchema.parse(req.body)
    // The same work whether or not the email is right, and one message for both: nothing reveals which part was wrong.
    const emailOk = sameText(email, config.ADMIN_EMAIL)
    const passwordOk = await verifyPassword(password, emailOk ? config.ADMIN_PASSWORD_HASH : await dummyHash())
    if (!emailOk || !passwordOk) {
      res.status(401).json({ error: 'Wrong email or password.' })
      return
    }
    await startAdminSession(res, config.ADMIN_EMAIL)
    console.log(`[admin] login ${config.ADMIN_EMAIL}`)
    res.json({ admin: { email: config.ADMIN_EMAIL } })
  },
)

adminRouter.post('/logout', async (req, res) => {
  await endAdminSession(res, req.cookies?.[ADMIN_COOKIE])
  res.status(204).end()
})

// ---- Everything below needs the admin session -------------------------------------------------------
adminRouter.use(requireAdmin, adminLimiter, express.json({ limit: '32kb' }))
adminRouter.use('/ai', adminAiRouter)

adminRouter.get('/me', (req, res) => {
  res.json({ admin: req.admin })
})

adminRouter.get('/overview', async (_req, res) => {
  const [users, newUsers, byPlan, pendingOrders, paidOrders, revenue] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } } }),
    prisma.user.groupBy({ by: ['planId'], _count: { _all: true } }),
    prisma.order.count({ where: { status: 'pending' } }),
    prisma.order.count({ where: { status: 'paid' } }),
    prisma.order.groupBy({ by: ['currency'], where: { status: 'paid' }, _sum: { amountCents: true } }),
  ])
  res.json({
    users,
    newUsers,
    usersByPlan: byPlan.map((r) => ({ planId: r.planId, count: r._count._all })),
    pendingOrders,
    paidOrders,
    revenue: revenue.map((r) => ({ currency: r.currency, cents: r._sum.amountCents ?? 0 })),
  })
})

// ---- Plans and prices -------------------------------------------------------------------------------
const planJson = (row: Parameters<typeof toPlanInfo>[0]) => ({ ...toPlanInfo(row), active: row.active })

adminRouter.get('/plans', async (_req, res) => {
  const rows = await prisma.plan.findMany({ orderBy: { sortOrder: 'asc' } })
  res.json({ plans: rows.map(planJson) })
})

adminRouter.put('/plans/:id', async (req, res) => {
  const id = String(req.params.id)
  const input = updatePlanSchema.parse(req.body)
  const row = await prisma.plan.findUnique({ where: { id } })
  if (!row) {
    res.status(404).json(notFound)
    return
  }
  if (row.kind === 'free' && (input.active === false || (input.priceCents ?? 0) > 0)) {
    res.status(400).json({ error: 'The Free plan stays active and costs nothing.' })
    return
  }
  // Features are a set of yes/no switches: an edit changes the ones it names and keeps the rest.
  const features = input.features ? { ...toPlanInfo(row).features, ...input.features } : undefined
  const updated = await prisma.plan.update({ where: { id }, data: { ...input, features } })
  console.log(`[admin] plan ${id} updated by ${req.admin!.email}: ${Object.keys(input).join(', ')}`)
  res.json({ plan: planJson(updated) })
})

// ---- Users --------------------------------------------------------------------------------------------
const PAGE = 25

adminRouter.get('/users', async (req, res) => {
  const page = Math.max(1, Math.floor(Number(req.query.page)) || 1)
  const q = String(req.query.q ?? '')
    .trim()
    .slice(0, 100)
  const where = q
    ? {
        OR: [
          { email: { contains: q, mode: 'insensitive' as const } },
          { name: { contains: q, mode: 'insensitive' as const } },
        ],
      }
    : {}
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE,
      take: PAGE,
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        planId: true,
        planExpiresAt: true,
        plan: { select: { name: true, kind: true } },
        _count: { select: { diagrams: true } },
      },
    }),
  ])
  const now = new Date()
  res.json({
    total,
    page,
    pageSize: PAGE,
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt,
      planId: u.planId,
      planName: u.plan.name,
      planExpiresAt: u.planExpiresAt,
      // A monthly plan that has run out no longer counts (the account is back on Free).
      planExpired: u.plan.kind === 'monthly' && (!u.planExpiresAt || u.planExpiresAt <= now),
      diagrams: u._count.diagrams,
    })),
  })
})

/** Puts an account on a plan by hand (e.g. after a payment made outside the app, or a gift). */
adminRouter.put('/users/:id/plan', async (req, res) => {
  const id = String(req.params.id)
  const input = setUserPlanSchema.parse(req.body)
  const plan = await prisma.plan.findUnique({ where: { id: input.planId } })
  const user = await prisma.user.findUnique({ where: { id }, select: { email: true } })
  if (!plan || !user) {
    res.status(404).json(notFound)
    return
  }
  const planExpiresAt =
    plan.kind === 'monthly' ? (input.expiresAt ? new Date(input.expiresAt) : addMonth(new Date())) : null
  await prisma.user.update({ where: { id }, data: { planId: plan.id, planExpiresAt } })
  console.log(`[admin] ${user.email} put on ${plan.id} by ${req.admin!.email}`)
  res.json({ user: { id, planId: plan.id, planName: plan.name, planExpiresAt } })
})

// ---- Orders -----------------------------------------------------------------------------------------
const orderInclude = { plan: { select: { name: true, kind: true } }, user: { select: { email: true, name: true } } }
type AdminOrder = NonNullable<Awaited<ReturnType<typeof prisma.order.findFirst<{ include: typeof orderInclude }>>>>
const adminOrderJson = (o: AdminOrder) => ({
  id: o.id,
  userId: o.userId,
  userEmail: o.user.email,
  userName: o.user.name,
  planId: o.planId,
  planName: o.plan.name,
  planKind: o.plan.kind,
  status: o.status,
  amountCents: o.amountCents,
  currency: o.currency,
  contact: o.contact,
  reference: o.reference,
  adminNote: o.adminNote,
  createdAt: o.createdAt,
  paidAt: o.paidAt,
})
const isId = (id: string) => /^[0-9a-f-]{36}$/i.test(id)

adminRouter.get('/orders', async (req, res) => {
  const status = String(req.query.status ?? 'all')
  const orders = await prisma.order.findMany({
    where: ['pending', 'paid', 'cancelled'].includes(status) ? { status } : {},
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: orderInclude,
  })
  res.json({ orders: orders.map(adminOrderJson) })
})

adminRouter.post('/orders/:id/paid', async (req, res) => {
  const id = String(req.params.id)
  const result = isId(id) ? await activateOrder(id) : 'missing'
  if (result === 'missing') {
    res.status(404).json(notFound)
    return
  }
  if (result === 'cancelled') {
    res.status(409).json({ error: 'This order was cancelled.' })
    return
  }
  if (result === 'activated') console.log(`[admin] order ${id} marked paid by ${req.admin!.email}`)
  const order = await prisma.order.findUniqueOrThrow({ where: { id }, include: orderInclude })
  res.json({ order: adminOrderJson(order), alreadyPaid: result === 'already_paid' })
})

adminRouter.post('/orders/:id/cancel', async (req, res) => {
  const id = String(req.params.id)
  const { count } = isId(id)
    ? await prisma.order.updateMany({ where: { id, status: 'pending' }, data: { status: 'cancelled' } })
    : { count: 0 }
  if (!count) {
    res.status(404).json({ error: 'Only an order that is still waiting can be cancelled.' })
    return
  }
  res.status(204).end()
})

adminRouter.put('/orders/:id', async (req, res) => {
  const id = String(req.params.id)
  const { adminNote } = adminOrderNoteSchema.parse(req.body)
  if (!isId(id) || !(await prisma.order.findUnique({ where: { id }, select: { id: true } }))) {
    res.status(404).json(notFound)
    return
  }
  const order = await prisma.order.update({ where: { id }, data: { adminNote }, include: orderInclude })
  res.json({ order: adminOrderJson(order) })
})

// ---- Texts ------------------------------------------------------------------------------------------
adminRouter.get('/settings', async (_req, res) => {
  res.json({ paymentInstructions: await paymentInstructions(), featureKeys: FEATURE_KEYS })
})

adminRouter.put('/settings', async (req, res) => {
  const { paymentInstructions: text } = adminSettingsSchema.parse(req.body)
  await savePaymentInstructions(text.trim())
  res.json({ paymentInstructions: await paymentInstructions() })
})
