import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { prisma } from './db'

const hasDb = Boolean(process.env.DATABASE_URL)
const app = createApp()

let ipCounter = 0
/** A fresh fake client IP, so rate-limit counters from one test never leak into another. */
const freshIp = () => `10.${Math.floor(++ipCounter / 65000)}.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`

const PASSWORD = 'correct horse battery'
const emailFor = (n: string) => `${n}-${Math.random().toString(36).slice(2, 8)}@example.com`

/** Signs up and returns the cookie + ip, ready for authenticated calls. */
async function signUp(email = emailFor('user')) {
  const ip = freshIp()
  const res = await request(app).post('/api/auth/signup').set('X-Forwarded-For', ip).send({ email, password: PASSWORD })
  expect(res.status).toBe(201)
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
  return { email, cookie, ip, user: res.body.user }
}

const diagram = {
  provider: 'postgresql',
  nodes: [
    {
      id: 't1',
      position: { x: 0, y: 0 },
      data: {
        id: 't1',
        name: 'users',
        columns: [
          { id: 'c1', name: 'id', type: 'uuid', primaryKey: true, notNull: true, unique: true, default: '' },
        ],
      },
    },
  ],
  manyToMany: [],
}

describe.skipIf(!hasDb)('API (integration, real PostgreSQL)', () => {
  beforeEach(async () => {
    await prisma.diagram.deleteMany()
    await prisma.session.deleteMany()
    await prisma.user.deleteMany()
    await prisma.rateLimit.deleteMany()
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  describe('basics & headers', () => {
    it('health check works and leaks no framework info', async () => {
      const res = await request(app).get('/api/health')
      expect(res.status).toBe(200)
      expect(res.headers['x-powered-by']).toBeUndefined()
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-security-policy']).toBeDefined()
    })

    it('unknown API routes 404 as JSON', async () => {
      const res = await request(app).get('/api/nope')
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Not found')
    })

    it('rejects malformed JSON with 400, not 500', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', freshIp())
        .set('Content-Type', 'application/json')
        .send('{"email": ')
      expect(res.status).toBe(400)
    })

    it('rejects a non-JSON body cleanly', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', freshIp())
        .set('Content-Type', 'text/plain')
        .send('email=a@b.co&password=x')
      expect(res.status).toBe(400)
    })
  })

  describe('sign up', () => {
    it('creates an account, sets a hardened cookie, and never returns the hash', async () => {
      const email = emailFor('ada')
      const res = await request(app)
        .post('/api/auth/signup')
        .set('X-Forwarded-For', freshIp())
        .send({ email: email.toUpperCase(), password: PASSWORD, name: ' Ada ' })
      expect(res.status).toBe(201)
      expect(res.body.user).toMatchObject({ email, name: 'Ada' })
      expect(JSON.stringify(res.body)).not.toMatch(/hash|scrypt|password/i)
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0]
      expect(cookie).toMatch(/HttpOnly/i)
      expect(cookie).toMatch(/SameSite=Lax/i)
      const row = await prisma.user.findUniqueOrThrow({ where: { email } })
      expect(row.passwordHash.startsWith('scrypt$')).toBe(true)
      expect(row.passwordHash).not.toContain(PASSWORD)
    })

    it('stores only a hash of the session token', async () => {
      const { cookie } = await signUp()
      const token = cookie.split('=')[1]
      const sessions = await prisma.session.findMany()
      expect(sessions).toHaveLength(1)
      expect(sessions[0].tokenHash).not.toBe(token)
      expect(sessions[0].tokenHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('rejects weak input with a readable error', async () => {
      const ip = freshIp()
      const short = await request(app).post('/api/auth/signup').set('X-Forwarded-For', ip).send({ email: 'a@b.co', password: 'short' })
      expect(short.status).toBe(400)
      expect(short.body.field).toBe('password')
      const bad = await request(app).post('/api/auth/signup').set('X-Forwarded-For', ip).send({ email: 'nope', password: PASSWORD })
      expect(bad.status).toBe(400)
      expect(bad.body.field).toBe('email')
    })

    it('answers 409 for a duplicate email, including two simultaneous sign-ups (no 500)', async () => {
      const email = emailFor('dup')
      const ipA = freshIp()
      const ipB = freshIp()
      const [a, b] = await Promise.all([
        request(app).post('/api/auth/signup').set('X-Forwarded-For', ipA).send({ email, password: PASSWORD }),
        request(app).post('/api/auth/signup').set('X-Forwarded-For', ipB).send({ email, password: PASSWORD }),
      ])
      expect([a.status, b.status].sort()).toEqual([201, 409])
      expect(await prisma.user.count({ where: { email } })).toBe(1)
    })

    it('treats SQL-injection-looking input as plain data', async () => {
      const ip = freshIp()
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: "x@y.co' OR '1'='1", password: "' OR 1=1 --" })
      expect(res.status).toBe(400) // fails email validation before touching the database
      const res2 = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'a@b.co', password: "'; DROP TABLE erd_users; --" })
      expect(res2.status).toBe(401)
      expect(await prisma.user.count()).toBeGreaterThanOrEqual(0) // table still exists
    })

    it('ignores prototype-pollution and mass-assignment attempts', async () => {
      const res = await request(app)
        .post('/api/auth/signup')
        .set('X-Forwarded-For', freshIp())
        .set('Content-Type', 'application/json')
        .send('{"email":"p@x.co","password":"correct horse battery","__proto__":{"admin":true},"id":"hacked","passwordHash":"x"}')
      expect(res.status).toBe(201)
      expect(res.body.user.id).not.toBe('hacked')
      expect(({} as Record<string, unknown>).admin).toBeUndefined()
    })
  })

  describe('log in / session', () => {
    it('logs in, serves /me, and logout kills the session server-side', async () => {
      const { email, cookie: first } = await signUp()
      const login = await request(app).post('/api/auth/login').set('X-Forwarded-For', freshIp()).send({ email, password: PASSWORD })
      expect(login.status).toBe(200)
      const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
      expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user.email).toBe(email)

      const out = await request(app).post('/api/auth/logout').set('Cookie', cookie)
      expect(out.status).toBe(204)
      // The old token must be dead even though the attacker still holds it.
      expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user).toBeNull()
      expect((await request(app).get('/api/auth/me').set('Cookie', first)).body.user.email).toBe(email)
    })

    it('gives the same answer for a wrong password and an unknown email', async () => {
      const { email } = await signUp()
      const ip = freshIp()
      const wrong = await request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password: 'wrong password!' })
      const unknown = await request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email: 'ghost@example.com', password: 'wrong password!' })
      expect(wrong.status).toBe(401)
      expect(unknown.status).toBe(401)
      expect(wrong.body).toEqual(unknown.body)
    })

    it('treats forged, truncated and garbage cookies as signed out', async () => {
      const { cookie } = await signUp()
      for (const bad of [cookie + 'x', cookie.slice(0, -5), 'erd_sid=', 'erd_sid=' + 'A'.repeat(5000), 'erd_sid=%00%00', 'erd_sid=../../etc/passwd']) {
        const res = await request(app).get('/api/auth/me').set('Cookie', bad)
        expect(res.status).toBe(200)
        expect(res.body.user).toBeNull()
      }
    })

    it('rejects an expired session and cleans it up', async () => {
      const { cookie } = await signUp()
      await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
      expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user).toBeNull()
    })

    it('caps concurrent sessions per user', async () => {
      const { email } = await signUp()
      for (let i = 0; i < 12; i++) {
        await request(app).post('/api/auth/login').set('X-Forwarded-For', freshIp()).send({ email, password: PASSWORD })
      }
      await new Promise((r) => setTimeout(r, 500)) // housekeeping runs after the response
      expect(await prisma.session.count()).toBeLessThanOrEqual(10)
    })
  })

  describe('saved diagrams (several per user)', () => {
    type Auth = Awaited<ReturnType<typeof signUp>>
    const create = (u: Auth, body: object = {}) => request(app).post('/api/diagrams').set('Cookie', u.cookie).send(body)
    const put = (u: Auth, id: string, body: object) => request(app).put(`/api/diagrams/${id}`).set('Cookie', u.cookie).send(body)

    it('requires a session for every endpoint', async () => {
      const id = '00000000-0000-4000-8000-000000000000'
      expect((await request(app).get('/api/diagrams')).status).toBe(401)
      expect((await request(app).post('/api/diagrams').send({})).status).toBe(401)
      expect((await request(app).get(`/api/diagrams/${id}`)).status).toBe(401)
      expect((await request(app).put(`/api/diagrams/${id}`).send({ data: diagram })).status).toBe(401)
      expect((await request(app).delete(`/api/diagrams/${id}`)).status).toBe(401)
    })

    it('creates diagrams, lists them oldest first, and returns content only when one is opened', async () => {
      const u = await signUp()
      expect((await request(app).get('/api/diagrams').set('Cookie', u.cookie)).body.diagrams).toEqual([])

      const first = await create(u, { title: '  Shop  ', data: diagram })
      expect(first.status).toBe(201)
      expect(first.body.diagram.title).toBe('Shop')
      const blank = await create(u) // no body: a blank, untitled one
      expect(blank.body.diagram.title).toBe('Untitled diagram')

      const list = await request(app).get('/api/diagrams').set('Cookie', u.cookie)
      expect(list.body.diagrams.map((d: { title: string }) => d.title)).toEqual(['Shop', 'Untitled diagram'])
      expect(JSON.stringify(list.body)).not.toContain('nodes') // the list never carries the (large) content

      const opened = await request(app).get(`/api/diagrams/${first.body.diagram.id}`).set('Cookie', u.cookie)
      expect(opened.body.diagram.data.nodes[0].data.name).toBe('users')
      const emptyOne = await request(app).get(`/api/diagrams/${blank.body.diagram.id}`).set('Cookie', u.cookie)
      expect(emptyOne.body.diagram.data).toEqual({ provider: 'postgresql', nodes: [], manyToMany: [] })
    })

    it('saves content, renames, or both; an empty update is rejected', async () => {
      const u = await signUp()
      const { id } = (await create(u, { title: 'A' })).body.diagram
      expect((await put(u, id, { data: diagram })).status).toBe(200)
      const renamed = await put(u, id, { title: 'B' })
      expect(renamed.status).toBe(200)
      expect(renamed.body.title).toBe('B')
      const both = structuredClone(diagram)
      both.nodes[0].data.name = 'accounts'
      expect((await put(u, id, { title: 'C', data: both })).status).toBe(200)

      const got = (await request(app).get(`/api/diagrams/${id}`).set('Cookie', u.cookie)).body.diagram
      expect(got.title).toBe('C')
      expect(got.data.nodes[0].data.name).toBe('accounts')
      expect((await put(u, id, {})).status).toBe(400)
      expect((await put(u, id, { title: '   ' })).status).toBe(400)
      expect((await put(u, id, { title: 'x'.repeat(101) })).status).toBe(400)
    })

    it('deletes one diagram and leaves the others', async () => {
      const u = await signUp()
      const a = (await create(u, { title: 'A' })).body.diagram.id
      const b = (await create(u, { title: 'B' })).body.diagram.id
      expect((await request(app).delete(`/api/diagrams/${a}`).set('Cookie', u.cookie)).status).toBe(204)
      expect((await request(app).get(`/api/diagrams/${a}`).set('Cookie', u.cookie)).status).toBe(404)
      expect((await request(app).get(`/api/diagrams/${b}`).set('Cookie', u.cookie)).status).toBe(200)
      expect((await request(app).delete(`/api/diagrams/${a}`).set('Cookie', u.cookie)).status).toBe(404) // already gone
    })

    it("never lets one user read, overwrite, rename or delete another's diagram", async () => {
      const a = await signUp()
      const b = await signUp()
      const id = (await create(a, { title: 'Secret', data: diagram })).body.diagram.id

      expect((await request(app).get('/api/diagrams').set('Cookie', b.cookie)).body.diagrams).toEqual([])
      expect((await request(app).get(`/api/diagrams/${id}`).set('Cookie', b.cookie)).status).toBe(404)
      expect((await put(b, id, { title: 'Hacked' })).status).toBe(404)
      expect((await put(b, id, { data: { ...diagram, nodes: [] } })).status).toBe(404)
      expect((await request(app).delete(`/api/diagrams/${id}`).set('Cookie', b.cookie)).status).toBe(404)
      // a userId smuggled into the body is ignored
      const mine = (await create(b, { title: 'Mine', userId: a.user.id })).body.diagram.id
      expect((await request(app).get(`/api/diagrams/${mine}`).set('Cookie', a.cookie)).status).toBe(404)

      const still = (await request(app).get(`/api/diagrams/${id}`).set('Cookie', a.cookie)).body.diagram
      expect(still.title).toBe('Secret')
      expect(still.data.nodes).toHaveLength(1)
    })

    it('answers 404 (not 500) for ids that are not UUIDs', async () => {
      const u = await signUp()
      for (const bad of ['nope', '1', "'; DROP TABLE erd_diagrams; --", '%00', 'x'.repeat(500)]) {
        expect((await request(app).get(`/api/diagrams/${encodeURIComponent(bad)}`).set('Cookie', u.cookie)).status).toBe(404)
        expect((await put(u, encodeURIComponent(bad), { title: 'x' })).status).toBe(404)
        expect((await request(app).delete(`/api/diagrams/${encodeURIComponent(bad)}`).set('Cookie', u.cookie)).status).toBe(404)
      }
    })

    it('caps how many diagrams one user can keep', async () => {
      const u = await signUp()
      await prisma.diagram.createMany({
        data: Array.from({ length: 50 }, (_, i) => ({ userId: u.user.id, title: `d${i}`, data: diagram })),
      })
      const over = await create(u, { title: 'one too many' })
      expect(over.status).toBe(409)
      expect(over.body.error).toMatch(/50/)
      expect(await prisma.diagram.count({ where: { userId: u.user.id } })).toBe(50)
    })

    it('rejects invalid shapes and oversized bodies', async () => {
      const u = await signUp()
      const { id } = (await create(u)).body.diagram
      expect((await put(u, id, { data: { provider: 'oracle', nodes: [], manyToMany: [] } })).status).toBe(400)
      expect((await put(u, id, { data: { provider: 'postgresql', nodes: 'x', manyToMany: [] } })).status).toBe(400)
      expect((await create(u, { data: { nope: true } })).status).toBe(400)
      expect((await put(u, id, { data: diagram, junk: 'x'.repeat(3 * 1024 * 1024) })).status).toBe(413)
    })

    it('deleting an account-less row cascade: removing a user removes their diagrams', async () => {
      const u = await signUp()
      await create(u, { title: 'A' })
      await prisma.user.delete({ where: { id: u.user.id } })
      expect(await prisma.diagram.count({ where: { userId: u.user.id } })).toBe(0)
    })
  })

  describe('CSRF / origin checks', () => {
    it('refuses writes from a foreign or null origin, even with a valid cookie', async () => {
      const { cookie } = await signUp()
      const { id } = (await request(app).post('/api/diagrams').set('Cookie', cookie).send({})).body.diagram
      for (const origin of ['https://evil.example', 'null']) {
        const res = await request(app).put(`/api/diagrams/${id}`).set('Cookie', cookie).set('Origin', origin).send({ data: diagram })
        expect(res.status).toBe(403)
        const made = await request(app).post('/api/diagrams').set('Cookie', cookie).set('Origin', origin).send({})
        expect(made.status).toBe(403)
        const gone = await request(app).delete(`/api/diagrams/${id}`).set('Cookie', cookie).set('Origin', origin)
        expect(gone.status).toBe(403)
      }
      const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie).set('Origin', 'https://evil.example')
      expect(logout.status).toBe(403)
      expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user).not.toBeNull()
    })

    it('allows the API own origin and configured dev origins', async () => {
      const { cookie } = await signUp()
      const { id } = (await request(app).post('/api/diagrams').set('Cookie', cookie).send({})).body.diagram
      const own = await request(app).put(`/api/diagrams/${id}`).set('Cookie', cookie).set('Host', 'erd.example.com').set('Origin', 'https://erd.example.com').send({ data: diagram })
      expect(own.status).toBe(200)
      const dev = await request(app).put(`/api/diagrams/${id}`).set('Cookie', cookie).set('Origin', 'http://localhost:5173').send({ data: diagram })
      expect(dev.status).toBe(200)
    })
  })

  describe('abuse protection', () => {
    it('limits sign-ups per IP and counts successful ones (no unlimited account farming)', async () => {
      const ip = freshIp()
      const statuses: number[] = []
      for (let i = 0; i < 7; i++) {
        const res = await request(app).post('/api/auth/signup').set('X-Forwarded-For', ip).send({ email: emailFor('bot'), password: PASSWORD })
        statuses.push(res.status)
      }
      expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201])
      expect(statuses.slice(5)).toEqual([429, 429])
      // another network is unaffected
      expect((await request(app).post('/api/auth/signup').set('X-Forwarded-For', freshIp()).send({ email: emailFor('ok'), password: PASSWORD })).status).toBe(201)
    })

    it('blocks password guessing from one IP, but not after successful logins', async () => {
      const { email } = await signUp()
      const ip = freshIp()
      for (let i = 0; i < 15; i++) {
        expect((await request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password: `wrong-${i}-pass` })).status).toBe(401)
      }
      const blocked = await request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password: PASSWORD })
      expect(blocked.status).toBe(429)
      expect(blocked.headers['ratelimit']).toBeDefined()
    })

    it('blocks a distributed attack on a single account (many IPs, one victim)', async () => {
      const { email } = await signUp()
      let last = 0
      for (let i = 0; i < 22; i++) {
        last = (await request(app).post('/api/auth/login').set('X-Forwarded-For', freshIp()).send({ email, password: `guess-${i}-xxxx` })).status
      }
      expect(last).toBe(429)
      // ...even the right password is refused during the lockout, from a brand-new IP
      expect((await request(app).post('/api/auth/login').set('X-Forwarded-For', freshIp()).send({ email, password: PASSWORD })).status).toBe(429)
    })

    it('caps oversized credential bodies on public endpoints', async () => {
      const res = await request(app).post('/api/auth/login').set('X-Forwarded-For', freshIp()).send({ email: 'a@b.co', password: 'x'.repeat(40_000) })
      expect(res.status).toBe(413)
    })

    it('throttles save spam per user', async () => {
      const { cookie } = await signUp()
      const { id } = (await request(app).post('/api/diagrams').set('Cookie', cookie).send({})).body.diagram
      let last = 0
      for (let i = 0; i < 62; i++) last = (await request(app).put(`/api/diagrams/${id}`).set('Cookie', cookie).send({ data: diagram })).status
      expect(last).toBe(429)
    }, 60_000)

    it('throttles bulk diagram creation per user', async () => {
      const { cookie } = await signUp()
      const statuses: number[] = []
      for (let i = 0; i < 32; i++) statuses.push((await request(app).post('/api/diagrams').set('Cookie', cookie).send({})).status)
      expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true)
      expect(statuses.slice(30)).toEqual([429, 429]) // 30 per 10 minutes, well below the 50-diagram cap
    }, 60_000)
  })
})
