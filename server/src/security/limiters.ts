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
 * Counts accounts actually CREATED (successful sign-ups): 5 per hour per IP is generous for humans and useless for
 * spam. Failed attempts (wrong code...) are limited separately by the code's own guesses and `verifyLimiter`.
 */
export const signupLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60_000,
  limit: 5,
  skipFailedRequests: true,
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

/** Asking for emails to be sent (codes): per network, 10 an hour, every request counted. */
export const codeRequestIpLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60_000,
  limit: 10,
  keyGenerator: ip,
  store: new PgStore('code-ip'),
  message: tooMany('Too many code requests from this network. Try again later.'),
})

/** ...and per address: 5 an hour for each kind of code, so nobody's inbox can be flooded. */
export const codeRequestEmailLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60_000,
  limit: 5,
  keyGenerator: (req) => `${req.path}:${String(req.body?.email ?? '').trim().toLowerCase().slice(0, 254)}`,
  store: new PgStore('code-email'),
  message: tooMany('Too many codes were requested for this address. Try again later.'),
  validate: { keyGeneratorIpFallback: false },
})

/** Guessing codes: failed checks only, per network. (Each code also allows just 5 guesses in total.) */
export const verifyLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: ip,
  store: new PgStore('code-verify'),
  message: tooMany('Too many wrong codes. Try again in a few minutes.'),
})

/** Guessing the admin password from one IP: failed logins only. Much stricter than for users: there is one admin. */
export const adminLoginIpLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60_000,
  limit: 6,
  skipSuccessfulRequests: true,
  keyGenerator: ip,
  store: new PgStore('admin-login-ip'),
  message: tooMany('Too many attempts. Try again in a few minutes.'),
})

/** ...and from many IPs at once: every failed admin login counts against one shared budget. */
export const adminLoginGlobalLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60_000,
  limit: 20,
  skipSuccessfulRequests: true,
  keyGenerator: () => 'admin',
  store: new PgStore('admin-login-all'),
  message: tooMany('Too many failed admin logins. Try again later.'),
  validate: { keyGeneratorIpFallback: false },
})

/** Placing orders: each is a row the admin has to look at, so keep a person from flooding them. */
export const orderLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60_000,
  limit: 10,
  keyGenerator: (req) => `user:${req.user?.id ?? ip(req)}`,
  store: new PgStore('order'),
  message: tooMany('Too many orders. Try again later.'),
  validate: { keyGeneratorIpFallback: false },
})

/** Everything an admin does after logging in: generous, but not unlimited. */
export const adminLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  limit: 240,
  keyGenerator: (req) => `admin:${req.admin?.email ?? ip(req)}`,
  store: new PgStore('admin'),
  message: tooMany('Too many requests. Slow down.'),
  validate: { keyGeneratorIpFallback: false },
})

/** The AI assistant: every model call costs money, so a person gets 20 a minute (a normal conversation uses a few). */
export const aiLimiter = rateLimit({
  ...common,
  windowMs: 60_000,
  limit: 20,
  keyGenerator: (req) => `user:${req.user?.id ?? ip(req)}`,
  store: new PgStore('ai'),
  message: tooMany('You are sending AI requests too fast. Try again in a moment.'),
  validate: { keyGeneratorIpFallback: false },
})
