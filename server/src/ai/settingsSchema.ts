import { z } from 'zod'
import { config } from '../config'
import { parseModelEntry } from './catalog'

/**
 * Where the gateway lives is typed by the admin, and the server then makes requests to it: so it must be a public
 * https address (plain http only for a local test gateway outside production). Names that point inside the network or at the
 * cloud's metadata service are refused. (The admin is trusted; this stops mistakes, not a hostile admin.)
 */
export function isSafeGatewayUrl(value: string): boolean {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return false
  }
  if (u.username || u.password || u.hash) return false
  const host = u.hostname.toLowerCase()
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
  if (local) return !config.isProd && (u.protocol === 'http:' || u.protocol === 'https:')
  if (u.protocol !== 'https:') return false
  if (/^(10|127|0)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) return false
  if (host.startsWith('[') || host.endsWith('.internal') || host.endsWith('.local') || !host.includes('.')) return false
  return true
}

const baseUrl = z
  .string()
  .trim()
  .max(300)
  .refine(isSafeGatewayUrl, 'Use a public https address, for example https://openrouter.ai/api/v1')
const secret = z.string().trim().min(8, 'That key looks too short.').max(400)
const modelEntry = z.object({
  id: z.string().trim().max(120).refine((s) => parseModelEntry(s) !== null, 'A model id looks like company/model-name'),
  tier: z.enum(['fast', 'smart']),
})

/** Every field is optional: a save changes only what it sends. `null` clears a value (the environment or the default applies again). */
export const aiSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  gatewayBaseUrl: baseUrl.nullable().optional(),
  gatewayKey: secret.nullable().optional(),
  anthropicKey: secret.nullable().optional(),
  models: z.array(modelEntry).max(100).nullable().optional(),
  offerAllModels: z.boolean().optional(),
  defaultModel: z.string().trim().max(160).nullable().optional(),
  dailyLimitFree: z.number().int().min(0).max(100_000).nullable().optional(),
  dailyLimitPaid: z.number().int().min(0).max(100_000).nullable().optional(),
  maxDailySpendUsd: z.number().positive().max(1_000_000).nullable().optional(),
})

export const aiTestSchema = z.object({
  /** Test the address and key being typed (not saved yet); omitted: the ones in force now. */
  gatewayBaseUrl: baseUrl.optional(),
  gatewayKey: secret.optional(),
})

export const aiTestModelSchema = z.object({ model: z.string().trim().min(1).max(160) })
