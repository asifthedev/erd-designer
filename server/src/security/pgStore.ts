import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit'
import { prisma } from '../db'

/**
 * express-rate-limit store backed by Postgres, so counters are shared by every server instance
 * (an in-memory store is useless on serverless, where each request may hit a fresh process).
 *
 * One atomic upsert per hit: start a new window when the old one expired, otherwise increment.
 */
export class PgStore implements Store {
  private windowMs = 60_000
  readonly prefix: string
  /** Rate-limit keys are namespaced per limiter so e.g. login and signup counters never mix. */
  constructor(prefix: string) {
    this.prefix = prefix
  }

  init(options: Options) {
    this.windowMs = options.windowMs
  }

  private k(key: string) {
    return `${this.prefix}:${key}`
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const rows = await prisma.$queryRaw<{ count: number; reset_at: Date }[]>`
      INSERT INTO erd_rate_limits (key, count, reset_at)
      VALUES (${this.k(key)}, 1, (now() AT TIME ZONE 'utc') + (${this.windowMs} * interval '1 millisecond'))
      ON CONFLICT (key) DO UPDATE SET
        count    = CASE WHEN erd_rate_limits.reset_at <= (now() AT TIME ZONE 'utc') THEN 1 ELSE erd_rate_limits.count + 1 END,
        reset_at = CASE WHEN erd_rate_limits.reset_at <= (now() AT TIME ZONE 'utc')
                        THEN (now() AT TIME ZONE 'utc') + (${this.windowMs} * interval '1 millisecond')
                        ELSE erd_rate_limits.reset_at END
      RETURNING count, reset_at`
    // Opportunistic cleanup (~1% of hits) keeps the table from growing without needing a cron job.
    if (Math.random() < 0.01) {
      void prisma.rateLimit.deleteMany({ where: { resetAt: { lt: new Date() } } }).catch(() => {})
    }
    return { totalHits: rows[0].count, resetTime: rows[0].reset_at }
  }

  async decrement(key: string): Promise<void> {
    await prisma.$executeRaw`
      UPDATE erd_rate_limits SET count = GREATEST(count - 1, 0) WHERE key = ${this.k(key)}`
  }

  async resetKey(key: string): Promise<void> {
    await prisma.rateLimit.deleteMany({ where: { key: this.k(key) } })
  }
}
