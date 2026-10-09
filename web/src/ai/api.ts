import type { CanvasSnapshot, ChatMessage } from '../../../shared/aiToolSpecs'
import { api, ApiError, BASE } from '../auth/api'

export type ModelOption = { id: string; label: string; maker: string; tier: 'fast' | 'smart'; contextTokens?: number }
export type ModelsResponse = {
  enabled: boolean
  models: ModelOption[]
  defaultModel: string | null
  quota: { used: number; limit: number }
  /** Models only a paid plan can use: shown in the picker, locked. */
  locked: ModelOption[]
}

export const fetchModels = () => api<ModelsResponse>('/ai/models')

/** What the server streams back while a model answers (see server/src/routes/ai.ts). */
export type ServerEvent =
  | { type: 'model'; id: string; label: string; fellBackFrom?: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; code: string; message: string }

export type ChatBody = { model?: string; canvas: CanvasSnapshot; messages: ChatMessage[] }

/**
 * One model call. A failure before the stream starts (not signed in, daily limit, bad request) is thrown as an ApiError
 * with the server's sentence; a failure inside the stream arrives as an `error` event; a connection that ends without
 * `done` or `error` is thrown too (so a half answer is never mistaken for a finished one).
 */
export async function* streamChat(body: ChatBody, signal: AbortSignal): AsyncGenerator<ServerEvent> {
  let res: Response
  try {
    res = await fetch(`${BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
      signal,
    })
  } catch (e) {
    if (signal.aborted) throw e
    throw new ApiError('Cannot reach the server. Check your connection and try again.', 0)
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
    throw new ApiError(data.error ?? 'The AI assistant is not available right now.', res.status, undefined, undefined, data.code)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      let cut: number
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n')
        if (!data) continue // a keep-alive comment
        let event: ServerEvent
        try {
          event = JSON.parse(data) as ServerEvent
        } catch {
          continue
        }
        if (event.type === 'done' || event.type === 'error') finished = true
        yield event
      }
      if (done) break
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  if (!finished && !signal.aborted) throw new ApiError('The connection was interrupted before the answer was complete.', 0)
}
