import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { prisma } from '../db'
import { sharedBreaker } from './router'
import { anthropicStream, openAiStream, startFakeGateway, type FakeGateway, type Reply } from './testing/fakeGateway'

/** End to end over real HTTP: Express app -> router -> adapter -> fake gateway, with real PostgreSQL for accounts and usage. */
const hasDb = Boolean(process.env.DATABASE_URL)
const models = ['test/smart-a', 'test/smart-b', 'test/fast-a', 'test/fast-b'].map((id) => ({ id, name: `Test: ${id}`, supported_parameters: ['tools'] }))

let server: Server
let base = ''
let gateway: FakeGateway
let script: (body: any, index: number) => Reply = () => ({ kind: 'sse', chunks: openAiStream({ text: ['ok'] }) })

const canvas = { provider: 'postgresql', maxTables: 25, tables: [{ name: 'users', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }] }] }
const chat = (cookie: string, body: object, signal?: AbortSignal) =>
  fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body), signal })

async function newUser(planId = 'free') {
  const email = `ai-${randomBytes(4).toString('hex')}@example.com`
  const user = await prisma.user.create({
    data: { email, passwordHash: 'x', planId, planExpiresAt: planId === 'monthly' ? new Date(Date.now() + 86_400_000) : null },
  })
  const token = randomBytes(32).toString('base64url')
  await prisma.session.create({ data: { tokenHash: createHash('sha256').update(token).digest('hex'), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) } })
  return { id: user.id, cookie: `erd_sid=${token}` }
}

/** Reads a whole SSE answer into its events. */
async function events(res: Response) {
  const out: any[] = []
  for (const block of (await res.text()).split('\n\n')) {
    const data = block.split('\n').find((l) => l.startsWith('data: '))
    if (data) out.push(JSON.parse(data.slice(6)))
  }
  return out
}
const json = async (r: Response) => (await r.json()) as any
const usageOf = (userId: string) => prisma.aiUsage.findFirst({ where: { userId } })
const ask = (extra: object = {}) => ({ canvas, messages: [{ role: 'user', content: 'Add an orders table' }], ...extra })

describe.skipIf(!hasDb)('AI assistant API (integration)', () => {
  beforeAll(async () => {
    gateway = await startFakeGateway(49400, (c, i) => script(c.body, i), models)
    server = createApp().listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    server?.closeAllConnections()
    server?.close()
    await gateway?.close()
  })
  beforeEach(() => {
    sharedBreaker.reset()
    gateway.calls.length = 0
    script = () => ({ kind: 'sse', chunks: openAiStream({ text: ['ok'], usage: { prompt: 10, completion: 5, cost: 0.002 } }) })
  })

  it('needs a signed-in account', async () => {
    expect((await fetch(`${base}/api/ai/models`)).status).toBe(401)
    expect((await fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401)
  })

  it('lists the models a plan may use: cheap ones on Free (others shown locked), all on a paid plan', async () => {
    const free = await newUser()
    const got = await json(await fetch(`${base}/api/ai/models`, { headers: { Cookie: free.cookie } }))
    expect(got.enabled).toBe(true)
    expect(got.models.map((m: any) => m.id).sort()).toEqual(['test/fast-a', 'test/fast-b'])
    expect(got.locked.map((m: any) => m.id).sort()).toEqual(['test/smart-a', 'test/smart-b'])
    expect(got.quota).toEqual({ used: 0, limit: 3 })
    const paid = await newUser('monthly')
    const all = await json(await fetch(`${base}/api/ai/models`, { headers: { Cookie: paid.cookie } }))
    expect(all.models).toHaveLength(4)
    expect(all.locked).toEqual([])
    expect(all.quota.limit).toBe(50)
  })

  it('streams an answer with the canvas in the prompt, and counts the usage', async () => {
    script = () => ({
      kind: 'sse',
      tear: true,
      chunks: openAiStream({ text: ['Adding ', 'it.'], toolCalls: [{ id: 'c1', name: 'create_tables', args: '{"tables":[{"name":"orders","columns":[{"name":"id","type":"SERIAL"}]}]}' }], usage: { prompt: 120, completion: 40, cost: 0.01 } }),
    })
    const u = await newUser()
    const res = await chat(u.cookie, ask({ model: 'test/fast-a' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const ev = await events(res)
    expect(ev[0]).toMatchObject({ type: 'model', id: 'test/fast-a' })
    expect(ev.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toBe('Adding it.')
    expect(ev.find((e) => e.type === 'tool_call')).toMatchObject({ id: 'c1', name: 'create_tables' })
    expect(ev.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' })

    const sent = gateway.calls[0].body
    expect(sent.model).toBe('test/fast-a')
    expect(sent.messages[0].content).toContain('<canvas>\ntable users')
    expect(sent.messages[0].content).toContain('Plan limit: 25 tables')
    expect(sent.tools.map((t: any) => t.function.name)).toContain('create_tables')
    expect(JSON.stringify(sent)).not.toContain('test-gateway-key')

    const use = await usageOf(u.id)
    expect(use).toMatchObject({ requests: 1, inputTokens: 120, outputTokens: 40, costMicros: 10_000n })
  })

  it('uses the default model when none is picked, and refuses a locked or unknown one', async () => {
    const u = await newUser()
    expect((await events(await chat(u.cookie, ask())))[0]).toMatchObject({ type: 'model', id: 'test/fast-a' })
    const locked = await chat(u.cookie, ask({ model: 'test/smart-a' }))
    expect(locked.status).toBe(403)
    expect((await json(locked)).code).toBe('model_locked')
    const unknown = await chat(u.cookie, ask({ model: 'nope/nothing' }))
    expect(unknown.status).toBe(400)
    expect((await json(unknown)).code).toBe('unknown_model')
    expect(await usageOf(u.id)).toMatchObject({ requests: 1 }) // refusals cost nothing
  })

  it('refuses bad input without calling the model', async () => {
    const u = await newUser('monthly')
    expect((await chat(u.cookie, { canvas, messages: [] })).status).toBe(400)
    expect((await chat(u.cookie, { messages: [{ role: 'user', content: 'x' }] })).status).toBe(400)
    const wrong = await chat(u.cookie, ask({ messages: [{ role: 'user', content: 'a' }, { role: 'tool', toolCallId: 'zzz', name: 'x', content: 'y' }] }))
    expect(wrong.status).toBe(400)
    expect((await json(wrong)).code).toBe('bad_conversation')
    expect(gateway.calls).toHaveLength(0)
  })

  it('stops at the daily limit and tells a Free account to upgrade', async () => {
    const u = await newUser()
    for (let i = 0; i < 3; i++) expect((await chat(u.cookie, ask())).status).toBe(200)
    const over = await chat(u.cookie, ask())
    expect(over.status).toBe(429)
    const body = await json(over)
    expect(body.code).toBe('daily_limit')
    expect(body.error).toMatch(/upgrade/i)
    expect(gateway.calls).toHaveLength(3)
  })

  it('does not let parallel requests slip past the limit', async () => {
    const u = await newUser()
    const results = await Promise.all(Array.from({ length: 6 }, () => chat(u.cookie, ask()).then((r) => r.status)))
    expect(results.filter((s) => s === 200)).toHaveLength(3)
    expect(results.filter((s) => s === 429)).toHaveLength(3)
  })

  it('gives the request back when the model fails before answering, and never leaks provider text', async () => {
    script = () => ({ kind: 'http', status: 401, body: { error: { message: 'Invalid key sk-or-SECRET-123 for account acme' } } })
    const u = await newUser()
    const ev = await events(await chat(u.cookie, ask()))
    const error = ev.find((e) => e.type === 'error')
    expect(error).toMatchObject({ code: 'unavailable' })
    expect(JSON.stringify(ev)).not.toMatch(/SECRET|acme|sk-or/)
    expect((await usageOf(u.id))?.requests ?? 0).toBe(0)
  })

  it('fails over to another model and says which one answered', async () => {
    script = (body) => (body.model === 'test/fast-b' ? { kind: 'http', status: 503, body: { error: 'overloaded' } } : { kind: 'sse', chunks: openAiStream({ text: ['from fast-a'] }) })
    const u = await newUser()
    const ev = await events(await chat(u.cookie, ask({ model: 'test/fast-b' })))
    expect(ev[0]).toMatchObject({ type: 'model', id: 'test/fast-a', fellBackFrom: 'test/fast-b' })
    expect(ev.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toBe('from fast-a')
    expect(gateway.calls.map((c) => c.body.model)).toEqual(['test/fast-b', 'test/fast-b', 'test/fast-a']) // one retry, then the next model
  })

  it('stops paying for the answer when the browser disconnects', async () => {
    script = () => ({ kind: 'sse', chunks: openAiStream({ text: ['part'] }).slice(0, 4), hang: true })
    const u = await newUser()
    const abort = new AbortController()
    const res = await chat(u.cookie, ask(), abort.signal)
    const reader = res.body!.getReader()
    await reader.read() // the stream is live
    abort.abort()
    await reader.cancel().catch(() => {})
    await new Promise((r) => setTimeout(r, 300))
    // The request stays counted (words were produced); the server is free again rather than hanging on the model.
    expect((await usageOf(u.id))?.requests).toBe(1)
    const again = await chat(u.cookie, ask())
    expect(again.status).toBe(200)
  })

  it('cuts an answer that runs past the time limit and reports it', async () => {
    script = () => ({ kind: 'sse', chunks: openAiStream({ text: ['slow'] }).slice(0, 4), hang: true })
    const u = await newUser('monthly')
    const started = Date.now()
    const ev = await events(await chat(u.cookie, ask()))
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'timeout' })
  }, 20_000)

  it('stops everybody for the day once the spend cap is reached', async () => {
    const rich = await newUser()
    await prisma.$executeRaw`INSERT INTO erd_ai_usage (user_id, day, requests, cost_micros) VALUES (${rich.id}, (now() AT TIME ZONE 'utc')::date, 1, 6000000)`
    const u = await newUser('monthly')
    const res = await chat(u.cookie, ask())
    expect(res.status).toBe(503)
    expect((await json(res)).code).toBe('capacity')
    await prisma.aiUsage.deleteMany({ where: { userId: rich.id } })
  })
})

describe('wire formats stay in sync with the fake used above', () => {
  it('builds both stream shapes', () => {
    expect(openAiStream({ text: ['a'] }).at(-1)).toBe('data: [DONE]\n\n')
    expect(anthropicStream({ text: ['a'] }).at(-1)).toContain('message_stop')
  })
})
