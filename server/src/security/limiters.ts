import type { Request } from 'express'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import { PgStore } from './pgStore'

const common = {
  standardHeaders: 'draft-8',
  legacyHeaders: false,
} as const

const tooMany = (message: string) => ({ error: message })

/** Client IP, with IPv6 addresses collapsed to their /56 so one host can't dodge limits by rotating addresses. */
const ip = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown')

/**
 * Coarse per-IP ceiling for the whole API (in memory: cheap, per instance). It only has to blunt floods and
 * naive bots; the platform's own DDoS protection handles volumetric traffic and the Postgres-backed limiters
 * below guard the expensive / abusable endpoints exactly.
 */
export const globalLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  limit: 300,
  keyGenerator: ip,
  message: tooMany('Too many requests. Slow down.'),
})

/**
 * Sign-up counts EVERY attempt (successful too): otherwise a bot could mint unlimited accounts.
 * 5 new accounts per hour per IP is generous for humans and useless for spam.
 */
export const signupLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60_000,
  limit: 5,
  keyGenerator: ip,
  store: new PgStore('signup'),
  message: tooMany('Too many sign-ups from this network. Try again later.'),
})

/** Password guessing from one IP: failed logins only, so real users who got in aren't punished. */
export const loginIpLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 15,
  skipSuccessfulRequests: true,
  keyGenerator: ip,
  store: new PgStore('login-ip'),
  message: tooMany('Too many attempts. Try again in a few minutes.'),
})

/**
 * Password guessing against ONE account from many IPs (a botnet). Keyed on the email in the body, so the
 * target account slows down regardless of where the guesses come from.
 */
export const loginAccountLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `acct:${String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254)}`,
  store: new PgStore('login-acct'),
  message: tooMany('Too many attempts for this account. Try again in a few minutes.'),
  // The key is an email, not an IP, so the library's IPv6 key-generator warning doesn't apply.
  validate: { keyGeneratorIpFallback: false },
})

/** Saving is debounced client-side (~1/s at worst); 60 saves a minute per user leaves headroom and caps abuse. */
export const saveLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  limit: 60,
  keyGenerator: (req) => `user:${req.user?.id ?? ip(req)}`,
  store: new PgStore('save'),
  message: tooMany('Saving too fast. Try again in a moment.'),
  validate: { keyGeneratorIpFallback: false },
})

/** Creating diagrams: each row is storage, so keep bulk creation in check (the per-user cap is the hard limit). */
export const createLimiter = rateLimit({
  ...common,
  windowMs: 10 * 60_000,
  limit: 30,
  keyGenerator: (req) => `user:${req.user?.id ?? ip(req)}`,
  store: new PgStore('create'),
  message: tooMany('Creating diagrams too fast. Try again in a few minutes.'),
  validate: { keyGeneratorIpFallback: false },
})
