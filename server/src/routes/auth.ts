import express, { Router } from 'express'
import { CODE_COOLDOWN_MS, checkCode, consumeCodes, issueCode, type CodePurpose } from '../auth/codes'
import { dummyHash, hashPassword, verifyPassword } from '../auth/password'
import { endSession, SESSION_COOKIE, startSession } from '../auth/sessions'
import { config } from '../config'
import { prisma } from '../db'
import { getMailer, type Mail } from '../mail/mailer'
import { alreadyRegisteredMail, resetCodeMail, signupCodeMail } from '../mail/templates'
import { emailOnlySchema, loginSchema, resetPasswordSchema, signupSchema, verifyCodeSchema } from '../schemas'
import {
  codeRequestEmailLimiter,
  codeRequestIpLimiter,
  loginAccountLimiter,
  loginIpLimiter,
  signupLimiter,
  verifyLimiter,
} from '../security/limiters'

export const authRouter = Router()

// Credentials are tiny: a 16 KB cap makes oversized-body abuse pointless on these public endpoints.
authRouter.use(express.json({ limit: '16kb' }))

const publicUser = (u: { id: string; email: string; name: string | null }) => ({
  id: u.id,
  email: u.email,
  name: u.name,
})

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `work`, but never answers sooner than `ms`. Sending an email takes noticeably longer than not sending one,
 * so without this the response time would reveal whether an address has an account.
 */
async function atLeast(ms: number, work: () => Promise<void>) {
  const started = Date.now()
  await work()
  await sleep(Math.max(0, ms - (Date.now() - started)))
}

const WRONG_CODE = { error: 'That code is wrong or has expired', field: 'code' }

/**
 * Shared by "send me a sign-up code" and "send me a reset code". The answer is the same whether or not the address
 * has an account (and takes as long): the only difference is which email the address receives.
 *   `compose` returns the email to send for an address that has/hasn't an account, given the fresh code.
 */
async function sendCode(
  req: express.Request,
  res: express.Response,
  purpose: CodePurpose,
  compose: (email: string, hasAccount: boolean, code: string) => Mail | null,
) {
  const { email } = emailOnlySchema.parse(req.body)
  await atLeast(config.CODE_REQUEST_MIN_MS, async () => {
    const mailer = getMailer()
    if (!mailer) {
      res.status(503).json({ error: 'Email is not set up on this server, so codes cannot be sent.' })
      return
    }
    const [issued, user] = await Promise.all([
      issueCode(email, purpose),
      prisma.user.findUnique({ where: { email }, select: { id: true } }),
    ])
    if ('waitSeconds' in issued) {
      res.status(429).json({
        error: `Please wait ${issued.waitSeconds} seconds before asking for another code.`,
        retryAfter: issued.waitSeconds,
      })
      return
    }
    const mail = compose(email, !!user, issued.code)
    if (mail) {
      try {
        await mailer.send(mail)
      } catch (err) {
        console.error('Could not send email', err)
        await consumeCodes(email, purpose) // nothing arrived, so don't make them wait out the cooldown
        res.status(502).json({ error: 'We could not send the email. Try again in a moment.' })
        return
      }
    }
    res.json({ ok: true, cooldownSeconds: CODE_COOLDOWN_MS / 1000 })
  })
}

/** Step 1 of signing up: email a code to the address. (An address that already has an account is told so by email.) */
authRouter.post('/signup/code', codeRequestIpLimiter, codeRequestEmailLimiter, (req, res) =>
  sendCode(req, res, 'signup', (email, hasAccount, code) =>
    hasAccount ? alreadyRegisteredMail(email) : signupCodeMail(email, code),
  ),
)

/** Step 2: the account is only created when the code from that email is entered. */
authRouter.post('/signup', verifyLimiter, signupLimiter, async (req, res) => {
  const input = signupSchema.parse(req.body)
  if (!(await checkCode(input.email, 'signup', input.code))) {
    res.status(400).json(WRONG_CODE)
    return
  }
  // The code proves the address is theirs, so it is now safe to say whether it is taken.
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
  await consumeCodes(input.email, 'signup')
  await startSession(res, user.id)
  res.status(201).json({ user: publicUser(user) })
})

/** Forgot password, step 1: email a reset code (only to an address that has an account; the answer never says). */
authRouter.post('/password/forgot', codeRequestIpLimiter, codeRequestEmailLimiter, (req, res) =>
  sendCode(req, res, 'reset', (email, hasAccount, code) => (hasAccount ? resetCodeMail(email, code) : null)),
)

/**
 * Step 2: is the code right? Lets the form check it on its own page and only then ask for the new password. Changes
 * nothing, and a correct code keeps its guesses (see checkCode). The answer is the same for wrong codes and for
 * addresses without an account.
 */
authRouter.post('/password/verify', verifyLimiter, async (req, res) => {
  const input = verifyCodeSchema.parse(req.body)
  const codeOk = await checkCode(input.email, 'reset', input.code, { refundOnSuccess: true })
  const user = codeOk ? await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }) : null
  if (!user) {
    res.status(400).json(WRONG_CODE)
    return
  }
  res.json({ ok: true })
})

/** Step 3: with the code, choose a new password. Every existing session is ended, so a stolen one stops working. */
authRouter.post('/password/reset', verifyLimiter, async (req, res) => {
  const input = resetPasswordSchema.parse(req.body)
  const codeOk = await checkCode(input.email, 'reset', input.code)
  const user = codeOk ? await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } }) : null
  if (!user) {
    res.status(400).json(WRONG_CODE) // same answer for a wrong code and for an address without an account
    return
  }
  const passwordHash = await hashPassword(input.password)
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
    prisma.session.deleteMany({ where: { userId: user.id } }),
  ])
  await consumeCodes(input.email, 'reset')
  res.json({ ok: true })
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
