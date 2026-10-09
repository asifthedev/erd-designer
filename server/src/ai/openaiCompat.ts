import { classifyStatus, UpstreamError } from './errors'
import { errorMessageOf, postStream } from './http'
import { readSse } from './sse'
import type { Adapter, ChatMessage, FinishReason, StreamEvent, UpstreamRequest } from './types'

/**
 * The OpenAI "chat completions" wire format, spoken by OpenRouter, Vercel AI Gateway, LiteLLM, OpenAI itself and most
 * other gateways: ONE adapter reaches hundreds of models from many companies with a single key.
 */

type Flavor = 'openrouter' | 'generic'
export const flavorOf = (baseUrl: string): Flavor => (/(^|\.)openrouter\.ai$/.test(new URL(baseUrl).hostname) ? 'openrouter' : 'generic')

export function toOpenAiMessages(req: UpstreamRequest) {
  const out: unknown[] = [{ role: 'system', content: `${req.systemStatic}\n\n${req.systemDynamic}` }]
  for (const m of req.messages as ChatMessage[]) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.images?.length
          ? [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))]
          : m.content,
      })
    }
    else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
    else {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      })
    }
  }
  return out
}

const FINISH: Record<string, FinishReason> = { stop: 'stop', tool_calls: 'tool_calls', function_call: 'tool_calls', length: 'length' }

export const streamOpenAiCompat: Adapter = async function* (req, opts) {
  const flavor = flavorOf(opts.baseUrl)
  const body = {
    model: req.model,
    messages: toOpenAiMessages(req),
    tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    tool_choice: 'auto',
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxTokens,
    // OpenRouter: only route to providers that really support tools, and report the cost of every call.
    ...(flavor === 'openrouter' ? { usage: { include: true }, provider: { require_parameters: true } } : {}),
  }
  const res = await postStream(
    `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    { Authorization: `Bearer ${opts.apiKey}`, 'X-Title': 'erd.designer' },
    body,
    opts,
  )

  const calls: { id: string; name: string; args: string }[] = []
  let finish: FinishReason | null = null
  let sawDone = false
  let tokens: Extract<StreamEvent, { type: 'usage' }> | null = null

  for await (const { data } of readSse(res, opts)) {
    if (data === '[DONE]') {
      sawDone = true
      break
    }
    let chunk: any
    try {
      chunk = JSON.parse(data)
    } catch {
      continue // a malformed keep-alive line is not worth failing the answer for
    }
    if (chunk.error) {
      // Gateways report failures that happen after the 200 inside the stream.
      const message = errorMessageOf(chunk, 'The model failed')
      const code = Number(chunk.error.code)
      throw new UpstreamError(message, Number.isFinite(code) && code >= 400 ? classifyStatus(code, message) : 'overloaded', code || undefined)
    }
    if (chunk.usage) {
      tokens = {
        type: 'usage',
        inputTokens: Number(chunk.usage.prompt_tokens) || 0,
        outputTokens: Number(chunk.usage.completion_tokens) || 0,
        costUsd: typeof chunk.usage.cost === 'number' ? chunk.usage.cost : undefined,
      }
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text', delta: delta.content }
    for (const tc of (delta.tool_calls ?? []) as any[]) {
      // Fragments of one call share an index; a call that arrives whole may omit it.
      const index = typeof tc.index === 'number' ? tc.index : tc.id ? calls.length : Math.max(calls.length - 1, 0)
      const call = (calls[index] ??= { id: '', name: '', args: '' })
      if (tc.id) call.id = tc.id
      if (tc.function?.name) call.name += tc.function.name
      if (typeof tc.function?.arguments === 'string') call.args += tc.function.arguments
    }
    if (choice.finish_reason) finish = FINISH[choice.finish_reason] ?? 'other'
  }

  if (!finish && !sawDone) throw new UpstreamError('The answer was cut off', 'network')
  const complete = calls.filter((c) => c.name)
  for (const [i, c] of complete.entries()) {
    yield { type: 'tool_call', id: c.id || `call_${i}`, name: c.name, arguments: c.args.trim() || '{}' }
  }
  if (tokens) yield tokens
  yield { type: 'done', finishReason: complete.length ? 'tool_calls' : (finish ?? 'stop') }
}
