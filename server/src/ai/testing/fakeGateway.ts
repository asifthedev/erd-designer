import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * A stand-in for an AI gateway / provider that speaks the real wire formats over real HTTP (OpenAI-compatible
 * chat completions and Anthropic messages), so the adapters, the router and the route are tested on a real network
 * path. Used by the tests and by the browser end-to-end check. Nothing here is shipped to production.
 */

export type Call = { path: string; body: any; headers: IncomingMessage['headers'] }
export type Reply =
  | { kind: 'sse'; chunks: string[]; /** Split every chunk in two writes at an awkward place. */ tear?: boolean; delayMs?: number; hang?: boolean; dropAfter?: number }
  | { kind: 'http'; status: number; body: unknown; headers?: Record<string, string> }
export type Script = (call: Call, index: number) => Reply | Promise<Reply>

const sse = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`

export type OpenAiPart = { text?: string[]; toolCalls?: { id: string; name: string; args: string }[]; usage?: { prompt: number; completion: number; cost?: number }; finish?: string }

/** The chunks an OpenAI-compatible gateway sends for one answer. Tool arguments arrive in three fragments, as in real life. */
export function openAiStream({ text = [], toolCalls = [], usage, finish }: OpenAiPart): string[] {
  const out: string[] = [': OPENROUTER PROCESSING\n\n']
  out.push(sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }))
  for (const t of text) out.push(sse({ choices: [{ index: 0, delta: { content: t } }] }))
  toolCalls.forEach((c, index) => {
    out.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] } }] }))
    const third = Math.ceil(c.args.length / 3)
    for (let i = 0; i < c.args.length; i += third) {
      out.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: c.args.slice(i, i + third) } }] } }] }))
    }
  })
  out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: finish ?? (toolCalls.length ? 'tool_calls' : 'stop') }] }))
  if (usage) out.push(sse({ choices: [], usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, ...(usage.cost != null ? { cost: usage.cost } : {}) } }))
  out.push('data: [DONE]\n\n')
  return out
}

export function anthropicStream({ text = [], toolCalls = [], usage }: OpenAiPart): string[] {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const out = [ev('message_start', { message: { usage: { input_tokens: usage?.prompt ?? 1, output_tokens: 1 } } }), ev('ping', {})]
  let index = 0
  if (text.length) {
    out.push(ev('content_block_start', { index, content_block: { type: 'text', text: '' } }))
    for (const t of text) out.push(ev('content_block_delta', { index, delta: { type: 'text_delta', text: t } }))
    out.push(ev('content_block_stop', { index }))
    index++
  }
  for (const c of toolCalls) {
    out.push(ev('content_block_start', { index, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }))
    const half = Math.ceil(c.args.length / 2)
    out.push(ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: c.args.slice(0, half) } }))
    out.push(ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: c.args.slice(half) } }))
    out.push(ev('content_block_stop', { index }))
    index++
  }
  out.push(ev('message_delta', { delta: { stop_reason: toolCalls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: usage?.completion ?? 5 } }))
  out.push(ev('message_stop', {}))
  return out
}

export type FakeGateway = { url: string; calls: Call[]; models: unknown[]; close: () => Promise<void> }

export async function startFakeGateway(port: number, script: Script, models: unknown[] = []): Promise<FakeGateway> {
  const calls: Call[] = []
  const state = { models }
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const path = req.url ?? ''
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: state.models }))
      return
    }
    const call: Call = { path, body: raw ? JSON.parse(raw) : null, headers: req.headers }
    const index = calls.push(call) - 1
    const reply = await script(call, index)
    if (reply.kind === 'http') {
      res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers })
      res.end(JSON.stringify(reply.body))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    let sent = 0
    for (const chunk of reply.chunks) {
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs))
      if (reply.dropAfter != null && sent >= reply.dropAfter) {
        res.destroy()
        return
      }
      if (reply.tear && chunk.length > 6) {
        const cut = Math.floor(chunk.length / 2)
        res.write(chunk.slice(0, cut))
        await new Promise((r) => setTimeout(r, 2))
        res.write(chunk.slice(cut))
      } else res.write(chunk)
      sent++
    }
    if (reply.hang) return // never ends: the caller's idle timeout has to cut it
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    get models() {
      return state.models
    },
    set models(v: unknown[]) {
      state.models = v
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  } as FakeGateway
}
