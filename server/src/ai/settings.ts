import { Prisma } from '../../generated/client'
import { config } from '../config'
import { prisma } from '../db'
import { DEFAULT_GATEWAY_MODELS, parseModelEntry, type Tier } from './catalog'
import { decryptSecret, encryptSecret } from './secrets'

/**
 * The assistant's settings as they apply right now: what the admin saved in the dashboard wins, then the server
 * environment, then a built-in default. Read through a short cache (an instance may use a change up to 15 s late; the
 * instance that saved it uses it at once).
 */

export type ModelEntry = { id: string; tier: Tier }

export type EffectiveAi = {
  enabled: boolean
  gatewayUrl: string
  gatewayKey?: string
  anthropicKey?: string
  anthropicUrl: string
  /** `*`, a comma separated list (`id|fast`), or empty for the built-in list: what the catalog understands. */
  modelsSpec: string
  defaultModel?: string
  dailyLimitFree: number
  dailyLimitPaid: number
  maxDailySpendUsd?: number
}

type Row = NonNullable<Awaited<ReturnType<typeof prisma.aiSettings.findUnique>>>

export const AI_DEFAULTS = {
  gatewayUrl: 'https://openrouter.ai/api/v1',
  dailyLimitFree: 30,
  dailyLimitPaid: 500,
}

const TTL_MS = 15_000
let cached: { at: number; row: Row | null } | null = null
export const invalidateAiSettings = () => {
  cached = null
}

export async function readAiRow(): Promise<Row | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.row
  const row = await prisma.aiSettings.findUnique({ where: { id: 1 } })
  cached = { at: Date.now(), row }
  return row
}

/** The stored list (validated again on the way out, so a hand-edited row cannot break the assistant). */
export function storedModels(row: Row | null): ModelEntry[] | null {
  if (!row || !Array.isArray(row.models)) return null
  const out: ModelEntry[] = []
  for (const m of row.models as unknown[]) {
    const e = m as { id?: unknown; tier?: unknown }
    if (typeof e?.id === 'string' && parseModelEntry(e.id)) out.push({ id: e.id, tier: e.tier === 'fast' ? 'fast' : 'smart' })
  }
  return out
}

export const specOf = (models: ModelEntry[]) => models.map((m) => (m.tier === 'fast' ? `${m.id}|fast` : m.id)).join(',')
export const DEFAULT_MODEL_ENTRIES: ModelEntry[] = DEFAULT_GATEWAY_MODELS.map((s) => {
  const e = parseModelEntry(s)!
  return { id: e.slug, tier: e.tier }
})

export async function effectiveAi(): Promise<EffectiveAi> {
  const row = await readAiRow()
  const list = storedModels(row)
  return {
    enabled: row?.enabled ?? true,
    gatewayUrl: row?.gatewayBaseUrl || config.AI_GATEWAY_BASE_URL,
    gatewayKey: decryptSecret(row?.gatewayKeyEnc) ?? config.AI_GATEWAY_API_KEY,
    anthropicKey: decryptSecret(row?.anthropicKeyEnc) ?? config.ANTHROPIC_API_KEY,
    anthropicUrl: config.ANTHROPIC_BASE_URL,
    modelsSpec: row?.offerAllModels ? '*' : list ? specOf(list) : (config.AI_MODELS ?? ''),
    defaultModel: row?.defaultModel || config.AI_DEFAULT_MODEL,
    dailyLimitFree: row?.dailyLimitFree ?? config.AI_DAILY_LIMIT_FREE,
    dailyLimitPaid: row?.dailyLimitPaid ?? config.AI_DAILY_LIMIT_PAID,
    maxDailySpendUsd: row?.maxDailySpendUsd ?? config.AI_MAX_DAILY_SPEND_USD,
  }
}

export type AiPatch = {
  enabled?: boolean
  gatewayBaseUrl?: string | null
  /** A new key, or null to remove the one saved in the dashboard (the environment's, if any, applies again). */
  gatewayKey?: string | null
  anthropicKey?: string | null
  models?: ModelEntry[] | null
  offerAllModels?: boolean
  defaultModel?: string | null
  dailyLimitFree?: number | null
  dailyLimitPaid?: number | null
  maxDailySpendUsd?: number | null
}

/** Saves only the fields present in the patch. */
export async function saveAiSettings(patch: AiPatch): Promise<void> {
  const data: Record<string, unknown> = {}
  if (patch.enabled !== undefined) data.enabled = patch.enabled
  if (patch.gatewayBaseUrl !== undefined) data.gatewayBaseUrl = patch.gatewayBaseUrl
  if (patch.gatewayKey !== undefined) data.gatewayKeyEnc = patch.gatewayKey === null ? null : encryptSecret(patch.gatewayKey)
  if (patch.anthropicKey !== undefined) data.anthropicKeyEnc = patch.anthropicKey === null ? null : encryptSecret(patch.anthropicKey)
  if (patch.models !== undefined) data.models = patch.models === null ? Prisma.DbNull : patch.models
  if (patch.offerAllModels !== undefined) data.offerAllModels = patch.offerAllModels
  if (patch.defaultModel !== undefined) data.defaultModel = patch.defaultModel
  if (patch.dailyLimitFree !== undefined) data.dailyLimitFree = patch.dailyLimitFree
  if (patch.dailyLimitPaid !== undefined) data.dailyLimitPaid = patch.dailyLimitPaid
  if (patch.maxDailySpendUsd !== undefined) data.maxDailySpendUsd = patch.maxDailySpendUsd
  await prisma.aiSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data } as never, update: data as never })
  invalidateAiSettings()
}
