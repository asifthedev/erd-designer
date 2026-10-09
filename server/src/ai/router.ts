import { streamAnthropic } from './anthropic'
import type { ModelInfo } from './catalog'
import { UpstreamError } from './errors'
import { streamOpenAiCompat } from './openaiCompat'
import type { Adapter, AdapterOptions, StreamEvent, UpstreamRequest } from './types'

/**
 * The model router: tries the chosen model, retries a blip once, and fails over to the next model when a provider
 * is down, all BEFORE the first word reaches the person (after that the answer is committed). A circuit breaker
 * stops sending traffic to a model that keeps failing, so one outage does not make every request wait for timeouts.
 */

export type Route = { adapter: Adapter; baseUrl: string; apiKey: string }
export type RouterEvent = StreamEvent | { type: 'model'; model: ModelInfo; fellBackFrom?: ModelInfo }

export type RouterDeps = {
  routeFor: (m: ModelInfo) => Route
  sleep?: (ms: number) => Promise<void>
  breaker?: Breaker
  random?: () => number
}

const FAILURES_TO_OPEN = 3
const OPEN_FOR_MS = 30_000

/** Per-model failure counter. In memory: each serverless instance learns by itself, which is enough to shed load. */
export class Breaker {
  private state = new Map<string, { failures: number; openUntil: number }>()
  constructor(private now: () => number = Date.now) {}
  isOpen(id: string) {
    const s = this.state.get(id)
    return !!s && s.openUntil > this.now()
  }
  failure(id: string) {
    const s = this.state.get(id) ?? { failures: 0, openUntil: 0 }
    s.failures++
    if (s.failures >= FAILURES_TO_OPEN) s.openUntil = this.now() + OPEN_FOR_MS
    this.state.set(id, s)
  }
  success(id: string) {
    this.state.delete(id)
  }
  reset() {
    this.state.clear()
  }
}

export const sharedBreaker = new Breaker()

export function liveRoute(m: ModelInfo, cfg: { gatewayUrl: string; gatewayKey?: string; anthropicUrl: string; anthropicKey?: string }): Route {
  if (m.route === 'anthropic') {
    if (!cfg.anthropicKey) throw new UpstreamError('Anthropic is not configured', 'auth')
    return { adapter: streamAnthropic, baseUrl: cfg.anthropicUrl, apiKey: cfg.anthropicKey }
  }
  if (!cfg.gatewayKey) throw new UpstreamError('The gateway is not configured', 'auth')
  return { adapter: streamOpenAiCompat, baseUrl: cfg.gatewayUrl, apiKey: cfg.gatewayKey }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function* routeChat(
  chain: ModelInfo[],
  base: Omit<UpstreamRequest, 'model'>,
  timing: Pick<AdapterOptions, 'signal' | 'firstByteMs' | 'idleMs'>,
  deps: RouterDeps,
): AsyncGenerator<RouterEvent> {
  const sleep = deps.sleep ?? defaultSleep
  const breaker = deps.breaker ?? sharedBreaker
  const random = deps.random ?? Math.random
  let lastError: UpstreamError | null = null
  const [first] = chain
  // A route whose key is wrong or out of credit fails for all its models: skip the rest of them, not the other routes.
  const deadRoutes = new Set<string>()

  for (const model of chain) {
    if (deadRoutes.has(model.route)) continue
    // A model that has been failing is skipped, unless it is the last one left.
    if (breaker.isOpen(model.id) && model !== chain[chain.length - 1]) continue
    for (let attempt = 0; attempt < 2; attempt++) {
      let started = false
      try {
        const route = deps.routeFor(model)
        const events = route.adapter(
          { ...base, model: model.upstream },
          { ...timing, baseUrl: route.baseUrl, apiKey: route.apiKey },
        )
        for await (const ev of events) {
          if (!started) {
            started = true
            yield { type: 'model', model, fellBackFrom: model === first ? undefined : first }
          }
          yield ev
        }
        if (!started) yield { type: 'model', model, fellBackFrom: model === first ? undefined : first }
        breaker.success(model.id)
        return
      } catch (e) {
        const err = e instanceof UpstreamError ? e : new UpstreamError(String((e as Error)?.message ?? e), 'unknown')
        if (err.kind === 'aborted') throw err
        if (started) throw err // words were already shown: this answer cannot be swapped for another model's
        lastError = err
        if (err.kind !== 'bad_request' && err.kind !== 'auth') breaker.failure(model.id)
        if (err.kind === 'auth' || err.kind === 'credits') {
          deadRoutes.add(model.route)
          break
        }
        if (err.retryable && attempt === 0) {
          const wait = Math.min(err.retryAfterMs ?? 400 + random() * 400, 2_000)
          await sleep(wait)
          continue
        }
        if (!err.fallbackable) throw err
        break // next model
      }
    }
  }
  throw lastError ?? new UpstreamError('No model is available', 'not_found')
}
