import { Router } from 'express'
import { TOOL_SPECS } from '../../../shared/aiToolSpecs'
import { streamAnthropic } from '../ai/anthropic'
import { availableModels, DEFAULT_GATEWAY_MODELS, parseModelList, resetCatalogCache } from '../ai/catalog'
import { UpstreamError } from '../ai/errors'
import { streamOpenAiCompat } from '../ai/openaiCompat'
import { decryptSecret, keyHint } from '../ai/secrets'
import { AI_DEFAULTS, DEFAULT_MODEL_ENTRIES, effectiveAi, readAiRow, saveAiSettings, storedModels } from '../ai/settings'
import { aiSettingsSchema, aiTestModelSchema, aiTestSchema } from '../ai/settingsSchema'
import { config } from '../config'
import { prisma } from '../db'
import { adminAiTestLimiter } from '../security/limiters'

/** The AI assistant's part of the admin panel (mounted at /api/admin/ai, behind the admin session). */
export const adminAiRouter = Router()

type KeyState = { set: boolean; source: 'dashboard' | 'environment' | null; hint: string | null; unreadable: boolean }
function keyState(enc: string | null | undefined, env: string | undefined): KeyState {
  const own = decryptSecret(enc)
  if (enc && own === null && !env) return { set: false, source: null, hint: null, unreadable: true }
  if (own) return { set: true, source: 'dashboard', hint: keyHint(own), unreadable: false }
  if (env) return { set: true, source: 'environment', hint: keyHint(env), unreadable: Boolean(enc) }
  return { set: false, source: null, hint: null, unreadable: false }
}

async function usage() {
  const rows = await prisma.$queryRaw<
    { day: Date; requests: bigint; input: bigint; output: bigint; micros: bigint; users: bigint }[]
  >`
    SELECT day, SUM(requests) AS requests, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
           SUM(cost_micros) AS micros, COUNT(*) AS users
    FROM erd_ai_usage
    WHERE day > (now() AT TIME ZONE 'utc')::date - 7
    GROUP BY day ORDER BY day DESC`
  return rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    requests: Number(r.requests),
    inputTokens: Number(r.input),
    outputTokens: Number(r.output),
    costUsd: Number(r.micros) / 1_000_000,
    users: Number(r.users),
  }))
}

async function snapshot() {
  const [row, eff] = await Promise.all([readAiRow(), effectiveAi()])
  const list = storedModels(row)
  return {
    enabled: row?.enabled ?? true,
    gatewayBaseUrl: row?.gatewayBaseUrl ?? null,
    gatewayKey: keyState(row?.gatewayKeyEnc, config.AI_GATEWAY_API_KEY),
    anthropicKey: keyState(row?.anthropicKeyEnc, config.ANTHROPIC_API_KEY),
    models: list,
    offerAllModels: row?.offerAllModels ?? false,
    defaultModel: row?.defaultModel ?? null,
    dailyLimitFree: row?.dailyLimitFree ?? null,
    dailyLimitPaid: row?.dailyLimitPaid ?? null,
    maxDailySpendUsd: row?.maxDailySpendUsd ?? null,
    /** What applies right now when a field is left empty, so the panel can say so. */
    effective: {
      gatewayBaseUrl: eff.gatewayUrl,
      dailyLimitFree: eff.dailyLimitFree,
      dailyLimitPaid: eff.dailyLimitPaid,
      maxDailySpendUsd: eff.maxDailySpendUsd ?? null,
      defaultModel: eff.defaultModel ?? null,
      modelsFromEnvironment: !list && Boolean(config.AI_MODELS),
    },
    defaults: { gatewayBaseUrl: AI_DEFAULTS.gatewayUrl, models: config.AI_MODELS ? null : DEFAULT_MODEL_ENTRIES, modelCount: DEFAULT_GATEWAY_MODELS.length },
    usage: await usage(),
  }
}

adminAiRouter.get('/', async (_req, res) => {
  res.json(await snapshot())
})

adminAiRouter.put('/', async (req, res) => {
  const patch = aiSettingsSchema.parse(req.body)
  await saveAiSettings(patch)
  resetCatalogCache() // a new address, key or list must not wait for the model-list cache
  const changed = Object.keys(patch).map((k) => (k.toLowerCase().includes('key') ? `${k}(secret)` : k))
  console.log(`[admin] ${req.admin?.email} changed AI settings: ${changed.join(', ') || 'nothing'}`)
  res.json(await snapshot())
})

/** Reads the gateway's model list with the address and key being typed (or the ones in force) and says what can call tools. */
adminAiRouter.post('/test', adminAiTestLimiter, async (req, res) => {
  const input = aiTestSchema.parse(req.body)
  const eff = await effectiveAi()
  const base = input.gatewayBaseUrl ?? eff.gatewayUrl
  const key = input.gatewayKey ?? eff.gatewayKey
  if (!key) {
    res.json({ ok: false, message: 'No gateway key yet. Paste one first.' })
    return
  }
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    })
    if (r.status === 401 || r.status === 403) {
      res.json({ ok: false, message: 'The gateway rejected the key.' })
      return
    }
    if (!r.ok) {
      res.json({ ok: false, message: `The gateway answered with an error (HTTP ${r.status}). Check the address.` })
      return
    }
    const models = parseModelList(await r.json().catch(() => null))
    if (!models.size) {
      res.json({ ok: false, message: 'The address answered, but not with a model list. Is it an OpenAI-compatible /v1 address?' })
      return
    }
    const tools = [...models.values()].filter((m) => m.supportsTools)
    res.json({
      ok: true,
      message: `Connected. ${models.size} models, ${tools.length} of them can call tools.`,
      total: models.size,
      models: tools.slice(0, 600).map((m) => ({ id: m.id, name: m.name ?? m.id, contextLength: m.contextLength ?? null })),
    })
  } catch (e) {
    const timeout = (e as Error)?.name === 'TimeoutError'
    res.json({ ok: false, message: timeout ? 'The gateway did not answer in time.' : 'Could not reach that address.' })
  }
})

/**
 * Sends one tiny request to a model and asks it to call a tool: proves the key has credit, the model exists AND that it
 * really calls tools. Costs a fraction of a cent.
 */
adminAiRouter.post('/test-model', adminAiTestLimiter, async (req, res) => {
  const { model } = aiTestModelSchema.parse(req.body)
  const eff = await effectiveAi()
  const direct = model.startsWith('anthropic:')
  const key = direct ? eff.anthropicKey : eff.gatewayKey
  if (!key) {
    res.json({ ok: false, message: direct ? 'No Anthropic key saved.' : 'No gateway key saved.' })
    return
  }
  const started = Date.now()
  const abort = new AbortController()
  const request = {
    model: direct ? model.slice('anthropic:'.length) : model,
    systemStatic: 'You are a connectivity test for a database design tool.',
    systemDynamic: 'Call the auto_layout tool now. Do not write anything else.',
    messages: [{ role: 'user' as const, content: 'Please call the tool.' }],
    tools: TOOL_SPECS.filter((t) => t.name === 'auto_layout'),
    maxTokens: 200,
  }
  let text = ''
  let toolCalled = false
  let tokens: { inputTokens: number; outputTokens: number; costUsd?: number } = { inputTokens: 0, outputTokens: 0 }
  try {
    const adapter = direct ? streamAnthropic : streamOpenAiCompat
    const events = adapter(request, {
      baseUrl: direct ? eff.anthropicUrl : eff.gatewayUrl,
      apiKey: key,
      signal: abort.signal,
      firstByteMs: 20_000,
      idleMs: 20_000,
    })
    const deadline = setTimeout(() => abort.abort(), 30_000)
    try {
      for await (const ev of events) {
        if (ev.type === 'text') text += ev.delta
        else if (ev.type === 'tool_call' && ev.name === 'auto_layout') toolCalled = true
        else if (ev.type === 'usage') tokens = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, costUsd: ev.costUsd }
      }
    } finally {
      clearTimeout(deadline)
    }
    res.json({
      ok: true,
      ms: Date.now() - started,
      toolCalled,
      message: toolCalled ? 'Works, and it calls tools.' : 'It answered, but did NOT call the tool. Do not offer this model.',
      reply: text.slice(0, 200),
      ...tokens,
    })
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(String((e as Error)?.message ?? e), 'unknown')
    // The admin may read the provider's own words (never the key: it is not in them).
    res.json({ ok: false, message: err.message.slice(0, 240), kind: err.kind })
  }
})

// Used by the tests: what the assistant would offer with the settings in force.
adminAiRouter.get('/offered', async (_req, res) => {
  const eff = await effectiveAi()
  const models = await availableModels({ gatewayUrl: eff.gatewayUrl, gatewayKey: eff.gatewayKey, anthropicKey: eff.anthropicKey, models: eff.modelsSpec })
  res.json({ models: models.map((m) => ({ id: m.id, label: m.label, maker: m.maker, tier: m.tier })) })
})
