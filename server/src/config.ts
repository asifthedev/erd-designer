import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see .env.example)'),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  /**
   * Extra browser origins allowed to make cookie-authenticated writes (comma separated). The API's own origin
   * is always allowed, so a same-origin deployment (the default setup) needs nothing here.
   */
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  /** Set to 1 when the API sits behind a reverse proxy, so client IPs (rate limiting) are read correctly. */
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  /**
   * Outgoing email (verification and password-reset codes), as an SMTP connection URL, e.g.
   * smtps://user:password@smtp.example.com:465. Without it, production refuses to send codes (so nobody can sign
   * up unverified); development prints the email, code included, to the server console instead.
   */
  SMTP_URL: z.string().optional(),
  /** The From: header, e.g. "erd.designer <no-reply@example.com>". Required together with SMTP_URL. */
  MAIL_FROM: z.string().optional(),
  /**
   * The admin panel's single login. Admins are not website users: they are set here, so there is no sign-up for it
   * and nothing in the database to steal. ADMIN_PASSWORD_HASH comes from `npm run admin:hash -w server`. Without
   * both, the admin panel answers 503 "not set up".
   */
  ADMIN_EMAIL: z.string().trim().toLowerCase().optional(),
  // Pasting into a dashboard often adds a trailing space / newline or wraps the value in quotes: neither is part of the hash.
  ADMIN_PASSWORD_HASH: z
    .string()
    .transform((v) => v.trim().replace(/^(['"])(.*)\1$/, '$2').trim())
    .optional(),
  /** Requests for a code always take at least this long, so answers can't reveal whether an address has an account. */
  CODE_REQUEST_MIN_MS: z.coerce.number().int().min(0).default(900),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment:', z.prettifyError(parsed.error))
  process.exit(1)
}

export const config = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  allowedOrigins: parsed.data.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  /** Vercel always fronts the function with its proxy, so client IPs must come from X-Forwarded-For. */
  trustProxy: parsed.data.TRUST_PROXY === '1' || Boolean(process.env.VERCEL),
}
