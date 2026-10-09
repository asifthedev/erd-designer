import { classifyStatus, UpstreamError } from './errors'
import type { AdapterOptions } from './types'

/** Pulls the provider's own error sentence out of a JSON error body, whatever its shape. */
export function errorMessageOf(body: unknown, fallback: string): string {
  const b = body as { error?: unknown; message?: unknown } | null
  const e = b?.error
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') return (e as { message: string }).message
  if (typeof b?.message === 'string') return b.message
  return fallback
}

/**
 * POSTs JSON and returns the streaming Response, or throws an UpstreamError the router understands. The first-byte
 * timeout only covers the wait for the response headers (it is switched off once they arrive, so a long answer is never cut).
 */
export async function postStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  opts: AdapterOptions,
): Promise<Response> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (opts.signal.aborted) throw new UpstreamError('Aborted', 'aborted')
  opts.signal.addEventListener('abort', onAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, opts.firstByteMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    })
    clearTimeout(timer)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let parsed: unknown = null
      try {
        parsed = JSON.parse(text)
      } catch {
        /* not JSON */
      }
      const message = errorMessageOf(parsed, text.slice(0, 300) || `HTTP ${res.status}`)
      const retryAfter = Number(res.headers.get('retry-after'))
      throw new UpstreamError(message, classifyStatus(res.status, message), res.status, retryAfter > 0 ? retryAfter * 1000 : undefined)
    }
    // From here the body is read by readSse with its own idle timeout, and aborting the caller still stops it.
    opts.signal.removeEventListener('abort', onAbort)
    opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
    return res
  } catch (e) {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', onAbort)
    if (e instanceof UpstreamError) throw e
    if (timedOut) throw new UpstreamError('No response from the model in time', 'timeout')
    if (opts.signal.aborted) throw new UpstreamError('Aborted', 'aborted')
    throw new UpstreamError(`Could not reach the AI service (${(e as Error)?.name ?? 'error'})`, 'network')
  }
}
