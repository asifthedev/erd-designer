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
