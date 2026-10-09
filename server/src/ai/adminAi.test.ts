import { createHash, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { hashPassword } from '../auth/password'
import { config } from '../config'
import { prisma } from '../db'
import { resetCatalogCache } from './catalog'
import { decryptSecret, encryptSecret, keyHint } from './secrets'
import { invalidateAiSettings } from './settings'
import { isSafeGatewayUrl } from './settingsSchema'
import { sharedBreaker } from './router'
import { openAiStream, startFakeGateway, type FakeGateway, type Reply } from './testing/fakeGateway'

const hasDb = Boolean(process.env.DATABASE_URL)
const models = ['test/smart-a', 'test/smart-b', 'test/fast-a', 'test/fast-b', 'test/notools'].map((id) => ({ id, name: `Test: ${id}`, supported_parameters: id === 'test/notools' ? ['max_tokens'] : ['tools'] }))

describe('secrets', () => {
  it('round-trips, never shows the key in the stored text, and refuses tampering', () => {
    const stored = encryptSecret('sk-or-v1-supersecretvalue')
    expect(stored).toMatch(/^v1\./)
    expect(stored).not.toContain('supersecret')
    expect(decryptSecret(stored)).toBe('sk-or-v1-supersecretvalue')
    expect(encryptSecret('sk-or-v1-supersecretvalue')).not.toBe(stored) // a fresh IV every time
    const tampered = stored.slice(0, -3) + (stored.endsWith('AAA') ? 'BBB' : 'AAA')
    expect(decryptSecret(tampered)).toBeNull()
    expect(decryptSecret('garbage')).toBeNull()
    expect(decryptSecret(null)).toBeNull()
    expect(keyHint('sk-or-v1-abcd1234')).toBe('…1234')
    expect(keyHint('short')).toBe('••••')
  })
})

describe('gateway address check', () => {
  it('accepts public https, refuses everything that points inside or is not https', () => {
    expect(isSafeGatewayUrl('https://openrouter.ai/api/v1')).toBe(true)
    expect(isSafeGatewayUrl('https://ai-gateway.vercel.sh/v1')).toBe(true)
    for (const bad of ['http://openrouter.ai/v1', 'https://169.254.169.254/latest', 'https://10.0.0.5/v1', 'https://192.168.1.1/v1', 'https://172.20.0.1/v1', 'https://metadata.google.internal/x', 'https://user:pw@openrouter.ai/v1', 'ftp://x.com', 'not a url', 'https://intranet/v1']) {
      expect(isSafeGatewayUrl(bad), bad).toBe(false)
    }
    expect(isSafeGatewayUrl('http://127.0.0.1:49400/v1')).toBe(true) // a local test gateway, outside production
  })
})

describe.skipIf(!hasDb)('admin: AI settings (integration)', () => {
  const ADMIN = { email: 'boss@example.com', password: 'an admin password that is long' }
  let server: Server
  let base = ''
  let gateway: FakeGateway
  let adminCookie = ''
  let script: (body: any, index: number) => Reply = () => ({ kind: 'sse', chunks: openAiStream({ text: ['ok'], usage: { prompt: 10, completion: 5, cost: 0.002 } }) })

  const admin = (path: string, method = 'GET', body?: object, cookie = adminCookie) =>
    fetch(`${base}/api/admin/ai${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) })
  const json = async (r: Response) => (await r.json()) as any
  async function newUser(planId = 'monthly') {
    const user = await prisma.user.create({
      data: { email: `ai-${randomBytes(4).toString('hex')}@example.com`, passwordHash: 'x', planId, planExpiresAt: planId === 'monthly' ? new Date(Date.now() + 86_400_000) : null },
    })
    const token = randomBytes(32).toString('base64url')
    await prisma.session.create({ data: { tokenHash: createHash('sha256').update(token).digest('hex'), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) } })
    return { id: user.id, cookie: `erd_sid=${token}` }
  }
  const asUser = (cookie: string, path: string, body?: object) =>
    fetch(`${base}/api/ai${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) })
  const ask = { canvas: { provider: 'postgresql', maxTables: 25, tables: [] }, messages: [{ role: 'user', content: 'hi' }] }
  const reset = async () => {
    await prisma.aiSettings.deleteMany()
    invalidateAiSettings()
    resetCatalogCache()
    sharedBreaker.reset()
  }

  beforeAll(async () => {
    config.ADMIN_EMAIL = ADMIN.email
    config.ADMIN_PASSWORD_HASH = await hashPassword(ADMIN.password)
    gateway = await startFakeGateway(49400, (c, i) => script(c.body, i), models)
    server = createApp().listen(0)
    await new Promise((r) => server.once('listening', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.77.0.1' }, body: JSON.stringify(ADMIN) })
    expect(login.status).toBe(200)
    adminCookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  })
  afterAll(async () => {
    await reset()
    config.ADMIN_EMAIL = undefined
    config.ADMIN_PASSWORD_HASH = undefined
    server?.closeAllConnections()
    server?.close()
    await gateway?.close()
  })
  beforeEach(async () => {
    await reset()
    gateway.calls.length = 0
    script = () => ({ kind: 'sse', chunks: openAiStream({ text: ['ok'], usage: { prompt: 10, completion: 5, cost: 0.002 } }) })
  })
  afterEach(reset)

  it('is for the admin only', async () => {
    expect((await admin('', 'GET', undefined, '')).status).toBe(401)
    const user = await newUser()
    expect((await admin('', 'GET', undefined, user.cookie)).status).toBe(401) // a website session is not an admin session
    expect((await admin('', 'PUT', { enabled: false }, '')).status).toBe(401)
    expect((await admin('/test-model', 'POST', { model: 'x' }, '')).status).toBe(401)
  })

  it('starts from the environment and says so', async () => {
    const s = await json(await admin(''))
    expect(s.gatewayKey).toMatchObject({ set: true, source: 'environment' })
    expect(s.enabled).toBe(true)
    expect(s.models).toBeNull()
    expect(s.effective.dailyLimitFree).toBe(3) // the test environment's value
    expect(JSON.stringify(s)).not.toContain('test-gateway-key')
  })

  it('saves a key encrypted, never returns it, and uses it for the models', async () => {
    const saved = await json(await admin('', 'PUT', { gatewayKey: 'sk-or-v1-dashboardkey-wxyz' }))
    expect(saved.gatewayKey).toEqual({ set: true, source: 'dashboard', hint: '…wxyz', unreadable: false })
    expect(JSON.stringify(saved)).not.toContain('dashboardkey')
    const row = await prisma.aiSettings.findUniqueOrThrow({ where: { id: 1 } })
    expect(row.gatewayKeyEnc).toMatch(/^v1\./)
    expect(row.gatewayKeyEnc).not.toContain('dashboardkey')
    expect(JSON.stringify(row)).not.toContain('dashboardkey')

    const user = await newUser()
    expect((await asUser(user.cookie, '/chat', ask)).status).toBe(200)
    await (await asUser(user.cookie, '/chat', ask)).text()
    expect(gateway.calls.at(-1)!.headers.authorization).toBe('Bearer sk-or-v1-dashboardkey-wxyz') // not the environment's key

    // Removing it falls back to the environment's key.
    const cleared = await json(await admin('', 'PUT', { gatewayKey: null }))
    expect(cleared.gatewayKey).toMatchObject({ source: 'environment' })
    await (await asUser(user.cookie, '/chat', ask)).text()
    expect(gateway.calls.at(-1)!.headers.authorization).toBe('Bearer test-gateway-key')
  })

  it('a save changes only what it sends', async () => {
    await admin('', 'PUT', { dailyLimitFree: 7, defaultModel: 'test/fast-b' })
    const s = await json(await admin('', 'PUT', { dailyLimitPaid: 9 }))
    expect(s).toMatchObject({ dailyLimitFree: 7, dailyLimitPaid: 9, defaultModel: 'test/fast-b' })
    const back = await json(await admin('', 'PUT', { dailyLimitFree: null }))
    expect(back.dailyLimitFree).toBeNull()
    expect(back.effective.dailyLimitFree).toBe(3) // empty: the environment applies again
  })

  it('the model list, tiers and default chosen in the dashboard are what people see', async () => {
    await admin('', 'PUT', { models: [{ id: 'test/smart-b', tier: 'smart' }, { id: 'test/fast-b', tier: 'fast' }, { id: 'test/notools', tier: 'fast' }, { id: 'ghost/none', tier: 'smart' }], defaultModel: 'test/fast-b' })
    const paid = await newUser()
    const got = await json(await asUser(paid.cookie, '/models'))
    expect(got.models.map((m: any) => m.id)).toEqual(['test/smart-b', 'test/fast-b']) // no tools / unknown to the gateway: dropped
    expect(got.defaultModel).toBe('test/fast-b')
    const free = await newUser('free')
    expect((await json(await asUser(free.cookie, '/models'))).models.map((m: any) => m.id)).toEqual(['test/fast-b'])
    // "Offer every model" shows everything that can call tools.
    await admin('', 'PUT', { offerAllModels: true })
    expect((await json(await asUser(paid.cookie, '/models'))).models.map((m: any) => m.id).sort()).toEqual(['test/fast-a', 'test/fast-b', 'test/smart-a', 'test/smart-b'])
    await admin('', 'PUT', { models: null, offerAllModels: false })
    expect((await json(await asUser(paid.cookie, '/models'))).models.length).toBeGreaterThan(0)
  })

  it('the master switch turns the assistant off for everybody', async () => {
    const user = await newUser()
    await admin('', 'PUT', { enabled: false })
    expect((await json(await asUser(user.cookie, '/models'))).enabled).toBe(false)
    const chat = await asUser(user.cookie, '/chat', ask)
    expect(chat.status).toBe(503)
    expect(gateway.calls).toHaveLength(0)
    await admin('', 'PUT', { enabled: true })
    expect((await json(await asUser(user.cookie, '/models'))).enabled).toBe(true)
  })

  it('the daily limit and the spend cap come from the dashboard too', async () => {
    const user = await newUser('free')
    await admin('', 'PUT', { dailyLimitFree: 1 })
    expect((await asUser(user.cookie, '/chat', ask)).status).toBe(200)
    const over = await asUser(user.cookie, '/chat', ask)
    expect(over.status).toBe(429)
    expect((await json(over)).error).toMatch(/1 free AI request/)
    await admin('', 'PUT', { dailyLimitFree: null, maxDailySpendUsd: 0.000001 })
    const other = await newUser('monthly')
    await (await asUser(other.cookie, '/chat', ask)).text() // costs 0.002, over the cap now
    expect((await asUser(other.cookie, '/chat', ask)).status).toBe(503)
    const s = await json(await admin(''))
    expect(s.usage[0]).toMatchObject({ requests: expect.any(Number), users: expect.any(Number) })
    expect(s.usage[0].costUsd).toBeGreaterThan(0)
  })

  it('refuses unsafe or malformed values', async () => {
    for (const body of [{ gatewayBaseUrl: 'https://169.254.169.254/v1' }, { gatewayBaseUrl: 'http://evil.example.com/v1' }, { gatewayKey: 'short' }, { models: [{ id: 'bad id!', tier: 'fast' }] }, { models: [{ id: 'a/b', tier: 'turbo' }] }, { dailyLimitFree: -1 }, { dailyLimitPaid: 1.5 }, { maxDailySpendUsd: 0 }]) {
      const res = await admin('', 'PUT', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(await prisma.aiSettings.count()).toBe(0)
  })

  it('tests a connection, with the typed address and key or the ones in force', async () => {
    const ok = await json(await admin('/test', 'POST', { gatewayBaseUrl: `${gateway.url}/v1`, gatewayKey: 'typed-key-12345' }))
    expect(ok).toMatchObject({ ok: true, total: 5 })
    expect(ok.models.map((m: any) => m.id)).not.toContain('test/notools')
    expect(ok.message).toMatch(/4 of them can call tools/)
    expect(await json(await admin('/test', 'POST', {}))).toMatchObject({ ok: true })
    const nowhere = await json(await admin('/test', 'POST', { gatewayBaseUrl: 'http://127.0.0.1:1/v1', gatewayKey: 'typed-key-12345' }))
    expect(nowhere).toMatchObject({ ok: false, message: 'Could not reach that address.' })
  })

  it('"Try it" proves a model calls tools, and reports one that does not', async () => {
    script = (body) => ({
      kind: 'sse',
      chunks: body.model === 'test/smart-a'
        ? openAiStream({ toolCalls: [{ id: 't1', name: 'auto_layout', args: '{}' }], usage: { prompt: 50, completion: 10, cost: 0.0001 } })
        : openAiStream({ text: ['I will not use tools'], usage: { prompt: 50, completion: 10 } }),
    })
    const good = await json(await admin('/test-model', 'POST', { model: 'test/smart-a' }))
    expect(good).toMatchObject({ ok: true, toolCalled: true, inputTokens: 50, outputTokens: 10 })
    const bad = await json(await admin('/test-model', 'POST', { model: 'test/smart-b' }))
    expect(bad).toMatchObject({ ok: true, toolCalled: false })
    expect(bad.message).toMatch(/did NOT call the tool/)
    script = () => ({ kind: 'http', status: 402, body: { error: { message: 'Insufficient credits' } } })
    expect(await json(await admin('/test-model', 'POST', { model: 'test/smart-a' }))).toMatchObject({ ok: false, kind: 'credits' })
  })

  it('shows what the assistant would offer with the settings in force', async () => {
    await admin('', 'PUT', { models: [{ id: 'test/fast-a', tier: 'fast' }] })
    expect((await json(await admin('/offered'))).models).toEqual([{ id: 'test/fast-a', label: 'test/fast-a', maker: 'Test', tier: 'fast' }].map((m) => ({ ...m, label: expect.any(String) })))
  })
})
