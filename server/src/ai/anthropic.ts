import { classifyStatus, UpstreamError } from './errors'
import { errorMessageOf, postStream } from './http'
import { readSse } from './sse'
import type { Adapter, ChatMessage, FinishReason, UpstreamRequest } from './types'

/** Anthropic's own Messages API (no gateway in between): used when ANTHROPIC_API_KEY is set. */

export function toAnthropicMessages(messages: ChatMessage[]) {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const images = (m.images ?? []).flatMap((url) => {
        const hit = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(url)
        return hit ? [{ type: 'image', source: { type: 'base64', media_type: hit[1], data: hit[2] } }] : []
      })
      out.push({ role: 'user', content: [...images, { type: 'text', text: m.content }] })
    }
    else if (m.role === 'assistant') {
      const content: unknown[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const c of m.toolCalls ?? []) {
        let input: unknown = {}
        try {
          input = JSON.parse(c.arguments || '{}')
        } catch {
          /* keep {} */
        }
        content.push({ type: 'tool_use', id: c.id, name: c.name, input })
      }
      out.push({ role: 'assistant', content })
    } else {
      // All results of one assistant turn go in ONE user message.
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }
      const last = out[out.length - 1]
      if (last?.role === 'user' && (last.content[0] as { type?: string })?.type === 'tool_result') last.content.push(block)
      else out.push({ role: 'user', content: [block] })
    }
  }
  return out
}

const STOP: Record<string, FinishReason> = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length' }

export const streamAnthropic: Adapter = async function* (req: UpstreamRequest, opts) {
  const body = {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: true,
    // The fixed rules are cached between requests; only the canvas part is paid for in full each time.
    system: [
      { type: 'text', text: req.systemStatic, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: req.systemDynamic },
    ],
    messages: toAnthropicMessages(req.messages),
    tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
  }
  const res = await postStream(
    `${opts.baseUrl.replace(/\/+$/, '')}/v1/messages`,
    { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01' },
    body,
    opts,
  )

  const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>()
  let input = 0
  let output = 0
  let stop: FinishReason | null = null
  let finished = false
  let sawTool = false

  for await (const { data } of readSse(res, opts)) {
    let ev: any
    try {
      ev = JSON.parse(data)
    } catch {
      continue
    }
    switch (ev.type) {
      case 'message_start':
        input = Number(ev.message?.usage?.input_tokens) || 0
        output = Number(ev.message?.usage?.output_tokens) || 0
        break
      case 'content_block_start':
        blocks.set(ev.index, { type: ev.content_block?.type, id: ev.content_block?.id, name: ev.content_block?.name, json: '' })
        break
      case 'content_block_delta': {
        const block = blocks.get(ev.index)
        if (ev.delta?.type === 'text_delta' && ev.delta.text) yield { type: 'text', delta: ev.delta.text }
        else if (ev.delta?.type === 'input_json_delta' && block) block.json += ev.delta.partial_json ?? ''
        break
      }
      case 'content_block_stop': {
        const block = blocks.get(ev.index)
        if (block?.type === 'tool_use' && block.name) {
          sawTool = true
          yield { type: 'tool_call', id: block.id ?? `call_${ev.index}`, name: block.name, arguments: block.json.trim() || '{}' }
        }
        blocks.delete(ev.index)
        break
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stop = STOP[ev.delta.stop_reason] ?? 'other'
        if (ev.usage?.output_tokens != null) output = Number(ev.usage.output_tokens) || output
        break
      case 'message_stop':
        finished = true
        break
      case 'error': {
        const message = errorMessageOf(ev, 'The model failed')
        const kind = ev.error?.type === 'overloaded_error' ? 'overloaded' : ev.error?.type === 'rate_limit_error' ? 'rate_limit' : classifyStatus(500, message)
        throw new UpstreamError(message, kind)
      }
    }
    if (finished) break
  }

  if (!finished) throw new UpstreamError('The answer was cut off', 'network')
  yield { type: 'usage', inputTokens: input, outputTokens: output }
  yield { type: 'done', finishReason: sawTool ? 'tool_calls' : (stop ?? 'stop') }
}
