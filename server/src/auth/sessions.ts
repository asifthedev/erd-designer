import { createHash, randomBytes } from 'node:crypto'
import type { CookieOptions, Response } from 'express'
import { config } from '../config'
import { prisma } from '../db'

// The `__Host-` prefix makes browsers refuse the cookie unless it is Secure, path=/ and has no Domain,
// which stops sibling subdomains from planting or overwriting it. It needs HTTPS, so production only.
export const SESSION_COOKIE = config.isProd ? '__Host-erd_sid' : 'erd_sid'
const SESSION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** A user can be signed in on this many devices at once; older sessions are dropped. */
const MAX_SESSIONS_PER_USER = 10

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const cookieOptions: CookieOptions = {
  httpOnly: true, // not readable from page scripts
  sameSite: 'lax', // not sent on cross-site POSTs
  secure: config.isProd,
  path: '/',
}

/** Create a session row and set its cookie. Only a hash of the token is stored. */
export async function startSession(res: Response, userId: string) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY_MS)
  await prisma.session.create({ data: { tokenHash: sha256(token), userId, expiresAt } })
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt })

  // Housekeeping, off the request path: drop expired sessions and any beyond the per-user cap.
  void (async () => {
    await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })
    const surplus = await prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: MAX_SESSIONS_PER_USER,
      select: { id: true },
    })
    if (surplus.length) await prisma.session.deleteMany({ where: { id: { in: surplus.map((s) => s.id) } } })
  })().catch(() => {})
}

/** The user behind a session cookie value, or null when it is unknown or expired. */
export async function userForToken(token: unknown) {
  // Cookies are attacker-controlled input: only well-formed tokens are worth a database round trip.
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, name: true } } },
  })
  if (!session) return null
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {})
    return null
  }
  return session.user
}

export async function endSession(res: Response, token: unknown) {
  if (typeof token === 'string' && token) {
    await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } })
  }
  res.clearCookie(SESSION_COOKIE, cookieOptions)
}
