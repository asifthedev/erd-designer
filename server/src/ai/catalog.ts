/**
 * The models people can pick. ONE gateway key reaches many companies' models (they are addressed "company/model");
 * a direct Anthropic key is an optional extra route. Only models that can call tools are ever offered, because the
 * assistant edits the canvas through tools: with the gateway that is checked against its live model list.
 */

export type Tier = 'fast' | 'smart'
export type ModelRoute = 'gateway' | 'anthropic'

export type ModelInfo = {
  /** What the web app sends back to pick this model. */
  id: string
  label: string
  maker: string
  route: ModelRoute
  /** The id the upstream API knows. */
  upstream: string
  /** "fast" models are cheap: the only ones the Free plan may use. */
  tier: Tier
  contextTokens?: number
  /** Can read an image: only these get the screenshot of the canvas. */
  vision: boolean
}

const MAKERS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'x-ai': 'xAI',
  deepseek: 'DeepSeek',
  'meta-llama': 'Meta',
  mistralai: 'Mistral',
  qwen: 'Qwen',
  moonshotai: 'Moonshot',
  'z-ai': 'Z.ai',
  cohere: 'Cohere',
  amazon: 'Amazon',
  nvidia: 'NVIDIA',
}

const title = (s: string) => s.replace(/(^|[-_.:\s])([a-z])/g, (_, sep: string, ch: string) => (sep === '-' || sep === '_' ? ' ' : sep) + ch.toUpperCase()).trim()

/** Built-in list used when AI_MODELS is not set. Ids the gateway does not have are simply dropped, so it can run ahead of reality. */
export const DEFAULT_GATEWAY_MODELS = [
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-opus-5.5',
  'anthropic/claude-haiku-5.5|fast',
  'anthropic/claude-sonnet-4.5',
  'anthropic/claude-haiku-4.5|fast',
  'openai/gpt-5',
  'openai/gpt-5-mini|fast',
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini|fast',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash|fast',
  'deepseek/deepseek-chat-v3.1|fast',
  'x-ai/grok-4',
  'qwen/qwen3-coder|fast',
  'mistralai/mistral-medium-3.1',
  'meta-llama/llama-4-maverick|fast',
]

export const DIRECT_ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'anthropic:claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (direct)', maker: 'Anthropic', route: 'anthropic', upstream: 'claude-sonnet-5-5', tier: 'smart', contextTokens: 200_000, vision: true },
  { id: 'anthropic:claude-opus-5-5', label: 'Claude Opus 5.5 (direct)', maker: 'Anthropic', route: 'anthropic', upstream: 'claude-opus-5-5', tier: 'smart', contextTokens: 200_000, vision: true },
  { id: 'anthropic:claude-haiku-5-5', label: 'Claude Haiku 5.5 (direct)', maker: 'Anthropic', route: 'anthropic', upstream: 'claude-haiku-5-5', tier: 'fast', contextTokens: 200_000, vision: true },
]

/** One gateway entry from AI_MODELS: "company/model" or "company/model|fast". */
export function parseModelEntry(entry: string): { slug: string; tier: Tier } | null {
  const [slug, flag] = entry.split('|').map((s) => s.trim())
  if (!slug || !/^[\w.\-:/@+]+$/.test(slug) || slug.length > 120) return null
  return { slug, tier: flag === 'fast' ? 'fast' : 'smart' }
}

export function gatewayModel(slug: string, tier: Tier, found?: DiscoveredModel): ModelInfo {
  const [company, ...rest] = slug.split('/')
  const maker = MAKERS[company] ?? title(company)
  const name = found?.name?.replace(/^[^:]+:\s*/, '') || title(rest.join('/') || slug)
  return { id: slug, label: name, maker, route: 'gateway', upstream: slug, tier, contextTokens: found?.contextLength, vision: found?.vision ?? guessVision(slug) }
}

// ---- Discovery: what the gateway really has, and which of it can call tools -------------------------------------------

export type DiscoveredModel = { id: string; name?: string; contextLength?: number; supportsTools: boolean; vision?: boolean }

/** When a gateway does not say what a model can read, the families known to read images are assumed to. */
export const guessVision = (id: string) => /claude|gpt-4o|gpt-4\.1|gpt-5|gemini|pixtral|llama-4|grok-4|qwen.*vl|vision/i.test(id)

type Discovery = { at: number; models: Map<string, DiscoveredModel> | null }
let cache: (Discovery & { key: string }) | null = null
const TTL_MS = 10 * 60_000
const FAILED_RETRY_MS = 60_000

/** Parses the gateway's GET /models answer (OpenRouter shape; the Vercel gateway and LiteLLM are close enough). */
export function parseModelList(body: unknown): Map<string, DiscoveredModel> {
  const out = new Map<string, DiscoveredModel>()
  const list = (body as { data?: unknown })?.data
  if (!Array.isArray(list)) return out
  for (const m of list as Record<string, unknown>[]) {
    if (typeof m?.id !== 'string') continue
    const params = m.supported_parameters
    // Without a parameter list the gateway doesn't say; trust the entry. With one, "tools" must be in it.
    const supportsTools = Array.isArray(params) ? params.includes('tools') : m.type === undefined || m.type === 'language'
    const modalities = (m.architecture as { input_modalities?: unknown } | undefined)?.input_modalities
    out.set(m.id, {
      id: m.id,
      vision: Array.isArray(modalities) ? modalities.includes('image') : undefined,
      name: typeof m.name === 'string' ? m.name : undefined,
      contextLength: typeof m.context_length === 'number' ? m.context_length : undefined,
      supportsTools,
    })
  }
  return out
}

/** Where the models come from; read from the environment by routes/ai.ts. */
export type CatalogSettings = {
  gatewayUrl: string
  gatewayKey?: string
  anthropicKey?: string
  /** AI_MODELS: comma separated gateway ids, "*" for everything that can call tools, empty for the built-in list. */
  models?: string
  defaultModel?: string
}

async function discover(s: CatalogSettings, fetchImpl: typeof fetch): Promise<Map<string, DiscoveredModel> | null> {
  const now = Date.now()
  const key = `${s.gatewayUrl}|${s.gatewayKey}`
  if (cache && cache.key === key && now - cache.at < (cache.models ? TTL_MS : FAILED_RETRY_MS)) return cache.models
  try {
    const res = await fetchImpl(`${s.gatewayUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${s.gatewayKey}` },
      signal: AbortSignal.timeout(6_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const models = parseModelList(await res.json())
    if (!models.size) throw new Error('empty model list')
    cache = { at: now, key, models }
  } catch (e) {
    console.warn('[ai] could not read the gateway model list:', (e as Error).message)
    // Keep serving the last good list; with none, the configured list is used as it is.
    cache = { at: now, key, models: cache?.key === key ? cache.models : null }
  }
  return cache.models
}

export const resetCatalogCache = () => {
  cache = null
}

/** Every model that can be offered right now, in display order. */
export async function availableModels(s: CatalogSettings, fetchImpl: typeof fetch = fetch): Promise<ModelInfo[]> {
  const models: ModelInfo[] = []
  if (s.gatewayKey) {
    const found = await discover(s, fetchImpl)
    const wanted = (s.models ?? '').trim()
    if (wanted === '*') {
      // Everything the gateway has that can call tools (newest first as the gateway lists them), capped so the picker stays usable.
      for (const m of [...(found?.values() ?? [])].filter((m) => m.supportsTools).slice(0, 80)) models.push(gatewayModel(m.id, 'smart', m))
    } else {
      const entries = (wanted ? wanted.split(',') : DEFAULT_GATEWAY_MODELS).map(parseModelEntry).filter((e) => e !== null)
      for (const { slug, tier } of entries) {
        const d = found?.get(slug)
        if (found && (!d || !d.supportsTools)) continue // unknown to the gateway, or it cannot call tools
        models.push(gatewayModel(slug, tier, d))
      }
    }
  }
  if (s.anthropicKey) models.push(...DIRECT_ANTHROPIC_MODELS)
  const seen = new Set<string>()
  return models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
}

/** The models one account may use: the Free plan only gets the cheap tier (everything when none is marked cheap). */
export function modelsForPlan(all: ModelInfo[], free: boolean): ModelInfo[] {
  if (!free) return all
  const fast = all.filter((m) => m.tier === 'fast')
  return fast.length ? fast : all
}

export function defaultModel(allowed: ModelInfo[], preferredId?: string): ModelInfo | undefined {
  return allowed.find((m) => m.id === preferredId) ?? allowed[0]
}

/** Other models to try when the chosen one is down: different company first (a provider outage hits all of one's models). */
export function fallbackChain(chosen: ModelInfo, allowed: ModelInfo[], max = 2): ModelInfo[] {
  const others = allowed.filter((m) => m.id !== chosen.id)
  const rank = (m: ModelInfo) => (m.maker !== chosen.maker ? 0 : 2) + (m.tier === chosen.tier ? 0 : 1)
  return others.sort((a, b) => rank(a) - rank(b)).slice(0, max)
}
