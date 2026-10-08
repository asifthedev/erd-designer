import { createHash, randomBytes } from 'node:crypto'
import type { CookieOptions, NextFunction, Request, Response } from 'express'
import { config } from '../config'
import { prisma } from '../db'

/**
 * The admin panel's sessions: a separate cookie and table from the website's, so a website session can never be an
 * admin one and the other way round. They are also shorter, and the cookie is SameSite=Strict.
 */
export const ADMIN_COOKIE = config.isProd ? '__Host-erd_admin' : 'erd_admin'
const ADMIN_SESSION_HOURS = 12
const HOUR_MS = 60 * 60 * 1000

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const cookieOptions: CookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: config.isProd,
  path: '/',
}

declare module 'express-serve-static-core' {
  interface Request {
    admin?: { email: string }
  }
}

export async function startAdminSession(res: Response, email: string) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_HOURS * HOUR_MS)
  await prisma.adminSession.create({ data: { tokenHash: sha256(token), email, expiresAt } })
  res.cookie(ADMIN_COOKIE, token, { ...cookieOptions, expires: expiresAt })
  void prisma.adminSession.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {})
}

export async function endAdminSession(res: Response, token: unknown) {
  if (typeof token === 'string' && token) await prisma.adminSession.deleteMany({ where: { tokenHash: sha256(token) } })
  res.clearCookie(ADMIN_COOKIE, cookieOptions)
}

/** The admin behind a cookie value. Also checks the email is still the configured admin, so changing ADMIN_EMAIL logs everyone out. */
async function adminForToken(token: unknown): Promise<{ email: string } | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null
  const session = await prisma.adminSession.findUnique({ where: { tokenHash: sha256(token) } })
  if (!session) return null
  if (session.expiresAt < new Date() || session.email !== config.ADMIN_EMAIL) {
    await prisma.adminSession.delete({ where: { id: session.id } }).catch(() => {})
    return null
  }
  return { email: session.email }
}

/** Every admin route except login needs this. */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD_HASH) {
    res.status(503).json({ error: 'The admin panel is not set up on this server.' })
    return
  }
  const admin = await adminForToken(req.cookies?.[ADMIN_COOKIE])
  if (!admin) {
    res.status(401).json({ error: 'Not signed in as admin' })
    return
  }
  req.admin = admin
  next()
}
