import { prisma } from '../db'

/**
 * Daily AI usage per account. Postgres, not memory, so the limit holds across serverless instances. The `day` is UTC.
 */
export type UsageStore = {
  /** Counts one request unless the account already used `limit` today. False: the limit is reached. */
  reserve(userId: string, limit: number): Promise<boolean>
  /** Gives a reserved request back (the model failed before it answered anything). */
  release(userId: string): Promise<void>
  /** Adds what a finished answer used. */
  record(userId: string, use: { inputTokens: number; outputTokens: number; costUsd?: number }): Promise<void>
  /** Requests used today by the account. */
  usedToday(userId: string): Promise<number>
  /** Spend reported today by everybody, in US dollars. */
  spendToday(): Promise<number>
}

export const prismaUsage: UsageStore = {
  async reserve(userId, limit) {
    if (limit <= 0) return false
    const rows = await prisma.$queryRaw<{ requests: number }[]>`
      INSERT INTO erd_ai_usage (user_id, day, requests)
      VALUES (${userId}, (now() AT TIME ZONE 'utc')::date, 1)
      ON CONFLICT (user_id, day) DO UPDATE SET requests = erd_ai_usage.requests + 1
        WHERE erd_ai_usage.requests < ${limit}
      RETURNING requests`
    return rows.length > 0
  },
  async release(userId) {
    await prisma.$executeRaw`
      UPDATE erd_ai_usage SET requests = GREATEST(requests - 1, 0)
      WHERE user_id = ${userId} AND day = (now() AT TIME ZONE 'utc')::date`
  },
  async record(userId, use) {
    const micros = BigInt(Math.max(0, Math.round((use.costUsd ?? 0) * 1_000_000)))
    await prisma.$executeRaw`
      UPDATE erd_ai_usage
      SET input_tokens = input_tokens + ${Math.max(0, Math.floor(use.inputTokens))},
          output_tokens = output_tokens + ${Math.max(0, Math.floor(use.outputTokens))},
          cost_micros = cost_micros + ${micros}
      WHERE user_id = ${userId} AND day = (now() AT TIME ZONE 'utc')::date`
  },
  async usedToday(userId) {
    const [row] = await prisma.$queryRaw<{ requests: number }[]>`
      SELECT requests FROM erd_ai_usage WHERE user_id = ${userId} AND day = (now() AT TIME ZONE 'utc')::date`
    return row?.requests ?? 0
  },
  async spendToday() {
    const [row] = await prisma.$queryRaw<{ micros: bigint | null }[]>`
      SELECT SUM(cost_micros) AS micros FROM erd_ai_usage WHERE day = (now() AT TIME ZONE 'utc')::date`
    return Number(row?.micros ?? 0n) / 1_000_000
  },
}
