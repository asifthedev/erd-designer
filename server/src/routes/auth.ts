import express, { Router } from 'express'
import { dummyHash, hashPassword, verifyPassword } from '../auth/password'
import { endSession, SESSION_COOKIE, startSession } from '../auth/sessions'
import { prisma } from '../db'
import { loginSchema, signupSchema } from '../schemas'
import { loginAccountLimiter, loginIpLimiter, signupLimiter } from '../security/limiters'

export const authRouter = Router()

// Credentials are tiny: a 16 KB cap makes oversized-body abuse pointless on these public endpoints.
authRouter.use(express.json({ limit: '16kb' }))

const publicUser = (u: { id: string; email: string; name: string | null }) => ({
  id: u.id,
  email: u.email,
  name: u.name,
})

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002'

authRouter.post('/signup', signupLimiter, async (req, res) => {
  const input = signupSchema.parse(req.body)
  const exists = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } })
  if (exists) {
    res.status(409).json({ error: 'An account with this email already exists' })
    return
  }
  const passwordHash = await hashPassword(input.password)
  let user
  try {
    user = await prisma.user.create({ data: { email: input.email, name: input.name, passwordHash } })
  } catch (err) {
    // Two simultaneous sign-ups with the same email: the unique index decides, the loser gets the same 409.
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'An account with this email already exists' })
      return
    }
    throw err
  }
  await startSession(res, user.id)
  res.status(201).json({ user: publicUser(user) })
})

authRouter.post('/login', loginIpLimiter, loginAccountLimiter, async (req, res) => {
  const input = loginSchema.parse(req.body)
  const user = await prisma.user.findUnique({ where: { email: input.email } })
  // Always run one hash check, so an unknown email can't be told apart by response time.
  const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash()))
  if (!user || !ok) {
    res.status(401).json({ error: 'Incorrect email or password' })
    return
  }
  await startSession(res, user.id)
  res.json({ user: publicUser(user) })
})

authRouter.post('/logout', async (req, res) => {
  await endSession(res, req.cookies?.[SESSION_COOKIE])
  res.status(204).end()
})

/** Who am I? 200 with `user: null` when signed out, so the app can start without an error in the console. */
authRouter.get('/me', (req, res) => {
  res.json({ user: req.user ?? null })
})
