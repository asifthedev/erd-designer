import type { NextFunction, Request, Response } from 'express'
import { SESSION_COOKIE, userForToken } from '../auth/sessions'
import { config } from '../config'

export type AuthUser = { id: string; email: string; name: string | null }

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser
  }
}

/** True when `origin` is this API's own origin or one the operator listed in ALLOWED_ORIGINS. */
function isTrustedOrigin(origin: string, req: Request) {
  if (config.allowedOrigins.includes(origin)) return true
  try {
    return new URL(origin).host === req.host
  } catch {
    return false // "null" and other junk origins
  }
}

/**
 * CSRF guard for cookie auth: a browser always sends Origin on a cross-site write, so a write from an origin
 * that isn't ours is refused. (Cookies are also SameSite=Lax.) Non-browser clients send no Origin, and they
 * can't carry a victim's cookie, so they pass.
 */
export function originCheck(req: Request, res: Response, next: NextFunction) {
  const safe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
  const origin = req.headers.origin
  if (!safe && origin && !isTrustedOrigin(origin, req)) {
    res.status(403).json({ error: 'Origin not allowed' })
    return
  }
  next()
}

/** Reads the session cookie and sets req.user when it is valid. */
export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  req.user = (await userForToken(req.cookies?.[SESSION_COOKIE])) ?? undefined
  next()
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'Not signed in' })
    return
  }
  next()
}
