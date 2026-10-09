import express, { Router, type Response } from 'express'
import { availableModels, defaultModel, fallbackChain, modelsForPlan, type ModelInfo } from '../ai/catalog'
import { PUBLIC_MESSAGES, UpstreamError } from '../ai/errors'
import { SYSTEM_STATIC, systemDynamic } from '../ai/prompt'
import { checkConversation, chatRequestSchema } from '../ai/requestSchema'
import { liveRoute, routeChat, type Route, type RouterDeps } from '../ai/router'
import { config } from '../config'
import { effectiveAi, type EffectiveAi } from '../ai/settings'
import { prismaUsage, type UsageStore } from '../ai/usage'
import { requireAuth } from '../middleware/auth'
import { entitlementOf } from '../plans'
import { aiLimiter } from '../security/limiters'
import { TOOL_SPECS } from '../../../shared/aiToolSpecs'

/** Replies are capped so one answer can never run up a large bill. A full schema of a dozen tables fits easily. */
const MAX_OUTPUT_TOKENS = 8_000
const REQUEST_TIMEOUT_MS = config.AI_REQUEST_TIMEOUT_MS

type Deps = {
  usage: UsageStore
  /** The settings in force (what the admin saved, else the environment). */
  settings: () => Promise<EffectiveAi>
  models: (s: EffectiveAi) => Promise<ModelInfo[]>
  routeFor: (m: ModelInfo, s: EffectiveAi) => Route
  router: Omit<RouterDeps, 'routeFor'>
  /** Whether the account is on the Free plan (cheap models only, smaller daily limit). */
  isFree: (userId: string) => Promise<boolean>
}

const liveDeps = (): Deps => ({
  usage: prismaUsage,
  settings: effectiveAi,
  models: (s) =>
    s.enabled
      ? availableModels({ gatewayUrl: s.gatewayUrl, gatewayKey: s.gatewayKey, anthropicKey: s.anthropicKey, models: s.modelsSpec })
      : Promise.resolve([]),
  routeFor: (m, s) =>
    liveRoute(m, { gatewayUrl: s.gatewayUrl, gatewayKey: s.gatewayKey, anthropicUrl: s.anthropicUrl, anthropicKey: s.anthropicKey }),
  router: {},
  isFree: async (userId) => (await entitlementOf(userId)).kind === 'free',
})

const limitFor = (s: EffectiveAi, free: boolean) => (free ? s.dailyLimitFree : s.dailyLimitPaid)

const toPublic = (m: ModelInfo) => ({ id: m.id, label: m.label, maker: m.maker, tier: m.tier, contextTokens: m.contextTokens })

export function createAiRouter(overrides: Partial<Deps> = {}) {
  const deps = { ...liveDeps(), ...overrides }
  const router = Router()
  // Authenticate BEFORE reading any body.
  router.use(requireAuth)

  router.get('/models', async (req, res) => {
    const userId = req.user!.id
    const settings = await deps.settings()
    const [all, free, used] = await Promise.all([deps.models(settings), deps.isFree(userId), deps.usage.usedToday(userId)])
    const models = modelsForPlan(all, free)
    res.json({
      enabled: models.length > 0,
      models: models.map(toPublic),
      defaultModel: defaultModel(models, settings.defaultModel)?.id ?? null,
      quota: { used, limit: limitFor(settings, free) },
      // Models only a paid plan can use, so the picker can show them locked.
      locked: free ? all.filter((m) => !models.includes(m)).map(toPublic) : [],
    })
  })

  router.post('/chat', aiLimiter, express.json({ limit: '1mb' }), async (req, res) => {
    const input = chatRequestSchema.parse(req.body)
    const conversationProblem = checkConversation(input.messages)
    if (conversationProblem) {
      res.status(400).json({ error: conversationProblem, code: 'bad_conversation' })
      return
    }
    const userId = req.user!.id
    const settings = await deps.settings()
    const [all, free] = await Promise.all([deps.models(settings), deps.isFree(userId)])
    const allowed = modelsForPlan(all, free)
    if (!allowed.length) {
      res.status(503).json({ error: 'The AI assistant is not set up on this server.', code: 'not_configured' })
      return
    }
    const chosen = input.model ? allowed.find((m) => m.id === input.model) : defaultModel(allowed, settings.defaultModel)
    if (!chosen) {
      const locked = all.some((m) => m.id === input.model)
      res.status(locked ? 403 : 400).json({
        error: locked ? 'That model needs a paid plan. Pick a model marked as included in your plan.' : 'Unknown model.',
        code: locked ? 'model_locked' : 'unknown_model',
      })
      return
    }
    if (settings.maxDailySpendUsd && (await deps.usage.spendToday()) >= settings.maxDailySpendUsd) {
      res.status(503).json({ error: "The AI assistant has reached today's capacity. Please try again tomorrow.", code: 'capacity' })
      return
    }
    const limit = limitFor(settings, free)
    if (!(await deps.usage.reserve(userId, limit))) {
      res.status(429).json({
        error: free
          ? `You used all ${limit} free AI requests for today. Upgrade your plan for more, or come back tomorrow.`
          : `You used all ${limit} AI requests for today. They reset at midnight UTC.`,
        code: 'daily_limit',
      })
      return
    }

    await stream(res, deps, {
      userId,
      chosen,
      chain: [chosen, ...fallbackChain(chosen, allowed)],
      free,
      limit,
      body: input,
      settings,
    })
  })

  return router
}

type Job = {
  userId: string
  chosen: ModelInfo
  chain: ModelInfo[]
  free: boolean
  limit: number
  body: ReturnType<typeof chatRequestSchema.parse>
  settings: EffectiveAi
}

/** Runs the model call and streams it to the browser as server-sent events. Owns the reserved request until it ends. */
async function stream(res: Response, deps: Deps, job: Job) {
  const started = Date.now()
  const abort = new AbortController()
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, REQUEST_TIMEOUT_MS)
  // The person closed the tab or pressed Stop: stop paying for the answer.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })

  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  const send = (event: object) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  // Proxies close connections that go quiet while a model is thinking.
  const beat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n')
  }, 15_000)

  let delivered = false
  let used = { inputTokens: 0, outputTokens: 0, costUsd: undefined as number | undefined }
  let outcome = 'ok'
  let model = job.chosen
  try {
    const events = routeChat(
      job.chain,
      {
        systemStatic: SYSTEM_STATIC,
        systemDynamic: systemDynamic(job.body.canvas),
        messages: job.body.messages,
        tools: TOOL_SPECS,
        maxTokens: MAX_OUTPUT_TOKENS,
      },
      { signal: abort.signal, firstByteMs: 25_000, idleMs: 30_000 },
      { ...deps.router, routeFor: (m) => deps.routeFor(m, job.settings) },
    )
    for await (const ev of events) {
      if (ev.type === 'model') {
        model = ev.model
        send({ type: 'model', id: ev.model.id, label: ev.model.label, fellBackFrom: ev.fellBackFrom?.label })
      } else if (ev.type === 'usage') {
        used = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, costUsd: ev.costUsd }
      } else if (ev.type === 'done') {
        send({ type: 'done', finishReason: ev.finishReason })
      } else {
        delivered = true
        send(ev)
      }
    }
  } catch (e) {
    const err = e instanceof UpstreamError ? e : new UpstreamError(String((e as Error)?.message ?? e), 'unknown')
    const kind = timedOut && err.kind === 'aborted' ? 'timeout' : err.kind
    outcome = `error:${kind}`
    // Operators need the real reason; the person gets a friendly sentence that leaks nothing.
    console.error(`[ai] ${job.chosen.id} failed (${kind}${err.status ? ` ${err.status}` : ''}): ${err.message}`)
    if (kind !== 'aborted') send({ type: 'error', ...PUBLIC_MESSAGES[kind] })
  } finally {
    clearTimeout(deadline)
    clearInterval(beat)
  }

  // A request that produced nothing is given back; one that answered (even partly) stays counted.
  try {
    if (!delivered && outcome !== 'ok') await deps.usage.release(job.userId)
    else await deps.usage.record(job.userId, used)
  } catch (e) {
    console.error('[ai] could not record usage:', (e as Error).message)
  }
  console.info(
    `[ai] user=${job.userId} model=${model.id} plan=${job.free ? 'free' : 'paid'} ms=${Date.now() - started} in=${used.inputTokens} out=${used.outputTokens} cost=${used.costUsd ?? '-'} outcome=${outcome}`,
  )
  if (!res.writableEnded) res.end()
}

export const aiRouter = createAiRouter()
