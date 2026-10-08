import supertest from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { hashPassword } from './auth/password'
import { config } from './config'
import { prisma } from './db'
import { setMailer, type Mail } from './mail/mailer'

const hasDb = Boolean(process.env.DATABASE_URL)
const app = createApp()

let ipCounter = 0
/** A fresh fake client IP, so rate-limit counters from one test never leak into another. */
const freshIp = () =>
  `10.${Math.floor(++ipCounter / 65000)}.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`

/**
 * supertest, except every request comes from this test's own IP (set per test): the in-memory global limiter counts
 * per IP over a minute, and one shared IP for the whole suite would trip it, which no real visitor ever would.
 * A test that sets its own X-Forwarded-For still wins (the later `.set` overrides).
 */
let testIp = freshIp()
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
const request = (server: Parameters<typeof supertest>[0]) => {
  const agent = supertest(server)
  return new Proxy(agent, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop === 'string' && VERBS.has(prop) && typeof value === 'function') {
        return (...args: unknown[]) =>
          (value as (...a: unknown[]) => { set: (k: string, v: string) => unknown })
            .apply(target, args)
            .set('X-Forwarded-For', testIp)
      }
      return value
    },
  })
}

const PASSWORD = 'correct horse battery'
const emailFor = (n: string) => `${n}-${Math.random().toString(36).slice(2, 8)}@example.com`

// Every email the server would have sent, in order, instead of sending it.
let outbox: Mail[] = []
const mailsTo = (email: string) => outbox.filter((m) => m.to === email.trim().toLowerCase())
/** The 6-digit code in the latest email to `email`. */
const codeFor = (email: string) => /\b(\d{6})\b/.exec(mailsTo(email).at(-1)?.text ?? '')?.[1] ?? ''
const post = (path: string, body: object, ip = freshIp()) =>
  request(app).post(path).set('X-Forwarded-For', ip).send(body)
const askSignupCode = (email: string, ip = freshIp()) => post('/api/auth/signup/code', { email }, ip)
const askResetCode = (email: string, ip = freshIp()) => post('/api/auth/password/forgot', { email }, ip)
/** Asks for a sign-up code and uses it: the way a real person signs up. */
async function signUpWith(email: string, extra: object = {}, ip = freshIp()) {
  expect((await askSignupCode(email, ip)).status).toBe(200)
  return post('/api/auth/signup', { email, password: PASSWORD, code: codeFor(email), ...extra }, ip)
}

/** Signs up and returns the cookie + ip, ready for authenticated calls. */
async function signUp(email = emailFor('user')) {
  const ip = freshIp()
  const res = await signUpWith(email, {}, ip)
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
        columns: [{ id: 'c1', name: 'id', type: 'uuid', primaryKey: true, notNull: true, unique: true, default: '' }],
      },
    },
  ],
  manyToMany: [],
}

/**
 * The plans as the tests need them (the real ones are rows in the database, edited by the admin). Most tests create
 * several diagrams, so Free is roomy here; the tests about limits lower it themselves. Reset before every test.
 */
const BASELINE: Record<string, object> = {
  free: { priceCents: 0, currency: 'USD', maxDiagrams: 50, maxTablesPerDiagram: 300, active: true, name: 'Free' },
  monthly: { priceCents: 900, currency: 'USD', maxDiagrams: 5, maxTablesPerDiagram: 100, active: true, name: 'Pro' },
  lifetime: {
    priceCents: 19900,
    currency: 'USD',
    maxDiagrams: 50,
    maxTablesPerDiagram: 500,
    active: true,
    name: 'Lifetime',
  },
}
const FEATURES_OFF = { export: false, codeFormats: false, themes: false, localCopy: false, setup: false }
const FEATURES: Record<string, object> = {
  free: FEATURES_OFF,
  monthly: { ...FEATURES_OFF, export: true, codeFormats: true, themes: true },
  lifetime: { export: true, codeFormats: true, themes: true, localCopy: true, setup: true },
}
const resetPlans = () =>
  Promise.all(
    Object.keys(BASELINE).map((id) =>
      prisma.plan.update({ where: { id }, data: { ...BASELINE[id], features: FEATURES[id] } }),
    ),
  )

describe.skipIf(!hasDb)('API (integration, real PostgreSQL)', () => {
  beforeAll(() => setMailer({ send: async (mail) => void outbox.push(mail) }))
  beforeEach(async () => {
    testIp = freshIp()
    outbox = []
    await prisma.emailCode.deleteMany()
    await prisma.order.deleteMany()
    await prisma.diagram.deleteMany()
    await prisma.session.deleteMany()
    await prisma.adminSession.deleteMany()
    await prisma.appSetting.deleteMany()
    await prisma.user.deleteMany()
    await prisma.rateLimit.deleteMany()
    await resetPlans()
  })
  afterAll(async () => {
    setMailer()
    // Leave the plans as the real ones are seeded (Free: 1 diagram, 25 tables).
    await prisma.plan.update({ where: { id: 'free' }, data: { maxDiagrams: 1, maxTablesPerDiagram: 25 } })
    await prisma.plan.update({ where: { id: 'lifetime' }, data: { maxTablesPerDiagram: 500 } })
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
      const res = await signUpWith(email.toUpperCase(), { name: ' Ada ' })
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
      const short = await post('/api/auth/signup', { email: 'a@b.co', password: 'short', code: '123456' })
      expect(short.status).toBe(400)
      expect(short.body.field).toBe('password')
      const bad = await post('/api/auth/signup', { email: 'nope', password: PASSWORD, code: '123456' })
      expect(bad.status).toBe(400)
      expect(bad.body.field).toBe('email')
    })

    it('answers 409 for two simultaneous sign-ups that use the same valid code (no 500)', async () => {
      const email = emailFor('dup')
      await askSignupCode(email)
      const body = { email, password: PASSWORD, code: codeFor(email) }
      const [a, b] = await Promise.all([post('/api/auth/signup', body), post('/api/auth/signup', body)])
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
      await askSignupCode('p@x.co')
      const res = await request(app)
        .post('/api/auth/signup')
        .set('X-Forwarded-For', freshIp())
        .set('Content-Type', 'application/json')
        .send(
          `{"email":"p@x.co","password":"correct horse battery","code":"${codeFor('p@x.co')}","__proto__":{"admin":true},"id":"hacked","passwordHash":"x"}`,
        )
      expect(res.status).toBe(201)
      expect(res.body.user.id).not.toBe('hacked')
      expect(({} as Record<string, unknown>).admin).toBeUndefined()
    })
  })

  describe('email verification at sign-up', () => {
    it('emails a 6-digit code to the address, and stores only a salted hash of it', async () => {
      const email = emailFor('new')
      expect((await askSignupCode(email)).status).toBe(200)
      expect(mailsTo(email)).toHaveLength(1)
      const code = codeFor(email)
      expect(code).toMatch(/^\d{6}$/)
      expect(mailsTo(email)[0].subject).toContain(code)
      const row = await prisma.emailCode.findFirstOrThrow({ where: { email } })
      expect(JSON.stringify(row)).not.toContain(code) // no plaintext code in the database
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000)
    })

    it('cannot register without the code', async () => {
      const email = emailFor('nocode')
      await askSignupCode(email)
      for (const body of [{}, { code: '' }, { code: '12345' }, { code: 'abcdef' }, { code: '000000' }]) {
        const res = await post('/api/auth/signup', { email, password: PASSWORD, ...body })
        expect(res.status).toBe(400)
        expect(res.body.field ?? 'code').toBe('code')
      }
      expect(await prisma.user.count({ where: { email } })).toBe(0)
      expect((await post('/api/auth/signup', { email, password: PASSWORD, code: codeFor(email) })).status).toBe(201)
    })

    it('refuses a code that belongs to another address', async () => {
      const mine = emailFor('mine')
      const theirs = emailFor('theirs')
      await askSignupCode(mine)
      await askSignupCode(theirs)
      const res = await post('/api/auth/signup', { email: theirs, password: PASSWORD, code: codeFor(mine) })
      expect(res.status).toBe(400)
      expect(await prisma.user.count()).toBe(0)
    })

    it('allows 5 guesses, then the code is dead even if the right one is typed', async () => {
      const email = emailFor('guess')
      await askSignupCode(email)
      const right = codeFor(email)
      const wrong = right === '123456' ? '654321' : '123456'
      for (let i = 0; i < 5; i++)
        expect((await post('/api/auth/signup', { email, password: PASSWORD, code: wrong })).status).toBe(400)
      expect((await post('/api/auth/signup', { email, password: PASSWORD, code: right })).status).toBe(400)
      expect(await prisma.user.count()).toBe(0)
    })

    it('does not let parallel requests squeeze in extra guesses', async () => {
      const email = emailFor('parallel')
      await askSignupCode(email)
      const right = codeFor(email)
      const wrong = right === '123456' ? '654321' : '123456'
      const wrongs = await Promise.all(
        Array.from({ length: 8 }, () => post('/api/auth/signup', { email, password: PASSWORD, code: wrong })),
      )
      expect(wrongs.every((r) => r.status === 400)).toBe(true)
      expect((await post('/api/auth/signup', { email, password: PASSWORD, code: right })).status).toBe(400)
    })

    it('a code works once, and expires after 10 minutes', async () => {
      const email = emailFor('once')
      expect((await signUpWith(email)).status).toBe(201)
      expect(await prisma.emailCode.count({ where: { email } })).toBe(0) // used up
      const code = mailsTo(email).length ? codeFor(email) : ''
      expect((await post('/api/auth/signup', { email, password: PASSWORD, code })).status).toBe(400)

      const late = emailFor('late')
      await askSignupCode(late)
      await prisma.emailCode.updateMany({ where: { email: late }, data: { expiresAt: new Date(Date.now() - 1000) } })
      expect((await post('/api/auth/signup', { email: late, password: PASSWORD, code: codeFor(late) })).status).toBe(
        400,
      )
      expect(await prisma.user.count({ where: { email: late } })).toBe(0)
    })

    it('tells nobody whether an address is registered: the same answer, and the owner gets an explanatory email instead of a code', async () => {
      const { email: taken } = await signUp()
      outbox = []
      const fresh = emailFor('fresh')
      const a = await askSignupCode(taken)
      const b = await askSignupCode(fresh)
      expect(a.status).toBe(b.status)
      expect(a.body).toEqual(b.body)
      expect(mailsTo(taken)[0].subject).toMatch(/already have/i)
      expect(mailsTo(taken)[0].text).not.toMatch(/\b\d{6}\b/) // no code goes to a registered address
      expect(mailsTo(fresh)[0].subject).toMatch(/verification code/i)
      // the code that was never sent can't be guessed into an account takeover or a duplicate
      expect((await post('/api/auth/signup', { email: taken, password: PASSWORD, code: '000000' })).status).toBe(400)
    })

    it('makes people wait between codes (the same for known and unknown addresses)', async () => {
      const { email: taken } = await signUp()
      const fresh = emailFor('cool')
      outbox = []
      for (const email of [taken, fresh]) {
        expect((await askSignupCode(email)).status).toBe(200)
        const again = await askSignupCode(email)
        expect(again.status).toBe(429)
        expect(again.body.retryAfter).toBeGreaterThan(0)
        expect(again.body.retryAfter).toBeLessThanOrEqual(60)
      }
      expect(mailsTo(fresh)).toHaveLength(1) // the second request sent nothing
    })

    it('a resent code replaces the old one', async () => {
      const email = emailFor('resend')
      await askSignupCode(email)
      const first = codeFor(email)
      await prisma.emailCode.updateMany({ where: { email }, data: { createdAt: new Date(Date.now() - 61_000) } })
      expect((await askSignupCode(email)).status).toBe(200)
      const second = codeFor(email)
      expect(await prisma.emailCode.count({ where: { email } })).toBe(1)
      if (first !== second)
        expect((await post('/api/auth/signup', { email, password: PASSWORD, code: first })).status).toBe(400)
    })

    it('says so (and lets them retry at once) when the email could not be sent', async () => {
      const email = emailFor('bounce')
      setMailer({ send: async () => Promise.reject(new Error('smtp down')) })
      const res = await askSignupCode(email)
      expect(res.status).toBe(502)
      expect(await prisma.emailCode.count({ where: { email } })).toBe(0) // no cooldown for a code that never arrived
      setMailer({ send: async (mail) => void outbox.push(mail) })
      expect((await askSignupCode(email)).status).toBe(200)
    })

    it('refuses to hand out unverifiable sign-ups when the server has no email set up', async () => {
      setMailer(null)
      const email = emailFor('nomail')
      expect((await askSignupCode(email)).status).toBe(503)
      expect((await askResetCode(email)).status).toBe(503)
      expect((await post('/api/auth/signup', { email, password: PASSWORD, code: '123456' })).status).toBe(400)
      setMailer({ send: async (mail) => void outbox.push(mail) })
    })

    it('limits code requests: 5 an hour per address, 10 an hour per network', async () => {
      const email = emailFor('flood')
      const statuses: number[] = []
      for (let i = 0; i < 6; i++) {
        await prisma.emailCode.deleteMany({ where: { email } }) // skip the 60s wait to reach the hourly cap
        statuses.push((await askSignupCode(email)).status)
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429])

      const ip = freshIp()
      const codes: number[] = []
      for (let i = 0; i < 11; i++) codes.push((await askSignupCode(emailFor('ip'), ip)).status)
      expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true)
      expect(codes[10]).toBe(429)
    })

    it('rejects malformed addresses before sending anything', async () => {
      for (const email of ['', 'nope', 'a@b', 'x'.repeat(300) + '@example.com']) {
        expect((await askSignupCode(email)).status).toBe(400)
      }
      expect(outbox).toHaveLength(0)
    })
  })

  describe('forgot password', () => {
    const NEW_PASSWORD = 'a brand new password'
    const reset = (email: string, code: string, password = NEW_PASSWORD) =>
      post('/api/auth/password/reset', { email, code, password })

    it('emails a code to a registered address and lets them choose a new password with it', async () => {
      const { email } = await signUp()
      outbox = []
      expect((await askResetCode(email)).status).toBe(200)
      expect(mailsTo(email)).toHaveLength(1)
      expect(mailsTo(email)[0].subject).toMatch(/password reset code/i)
      const res = await reset(email, codeFor(email))
      expect(res.status).toBe(200)
      expect(res.headers['set-cookie']).toBeUndefined() // choosing a password doesn't log anyone in

      expect((await post('/api/auth/login', { email, password: PASSWORD })).status).toBe(401) // old one is dead
      expect((await post('/api/auth/login', { email, password: NEW_PASSWORD })).status).toBe(200)
    })

    it('says the same to unknown addresses and sends nothing', async () => {
      const { email } = await signUp()
      outbox = []
      const known = await askResetCode(email)
      const unknown = await askResetCode(emailFor('nobody'))
      expect(unknown.status).toBe(known.status)
      expect(unknown.body).toEqual(known.body)
      expect(outbox).toHaveLength(1)
      expect(outbox[0].to).toBe(email)
    })

    it('ends every existing session, so a stolen cookie stops working', async () => {
      const { email, cookie } = await signUp()
      expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user).not.toBeNull()
      await askResetCode(email)
      expect((await reset(email, codeFor(email))).status).toBe(200)
      expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user).toBeNull()
      expect(await prisma.session.count()).toBe(0)
    })

    it('a code works once, only for that address, and 5 wrong guesses kill it', async () => {
      const { email } = await signUp()
      const other = (await signUp()).email
      await askResetCode(email)
      const code = codeFor(email)

      expect((await reset(other, code)).status).toBe(400) // not their code
      expect((await reset(email, code)).status).toBe(200)
      expect((await reset(email, code, 'yet another password')).status).toBe(400) // used up
      expect((await post('/api/auth/login', { email, password: NEW_PASSWORD })).status).toBe(200)

      await prisma.emailCode.deleteMany() // fresh start for the guessing check
      await askResetCode(email)
      const right = codeFor(email)
      const wrong = right === '123456' ? '654321' : '123456'
      for (let i = 0; i < 5; i++) expect((await reset(email, wrong)).status).toBe(400)
      expect((await reset(email, right)).status).toBe(400)
    })

    it('refuses an expired code, a missing code, a weak new password, and a sign-up code', async () => {
      const { email } = await signUp()
      await askResetCode(email)
      const code = codeFor(email)

      expect((await reset(email, code, 'short')).status).toBe(400) // weak password: rejected up front...
      expect((await reset(email, '')).status).toBe(400)
      expect((await reset(email, code)).status).toBe(200) // ...without having burned any guesses

      await askSignupCode(email) // a registered address gets no sign-up code, so there is nothing to confuse
      await prisma.emailCode.deleteMany({ where: { email } })
      await askResetCode(email)
      await prisma.emailCode.updateMany({ where: { email }, data: { expiresAt: new Date(Date.now() - 1000) } })
      expect((await reset(email, codeFor(email), 'another fine password')).status).toBe(400)
    })

    it('a sign-up code cannot reset a password (and the other way round)', async () => {
      const fresh = emailFor('cross')
      await askSignupCode(fresh)
      const signupCode = codeFor(fresh)
      await prisma.user.create({ data: { email: fresh, passwordHash: 'scrypt$x' } })
      expect((await reset(fresh, signupCode)).status).toBe(400)
    })

    it('checks the code on its own, before the new password is asked for, without using it up', async () => {
      const { email } = await signUp()
      await askResetCode(email)
      const code = codeFor(email)
      const wrong = code === '123456' ? '654321' : '123456'
      const verify = (c: string) => post('/api/auth/password/verify', { email, code: c })

      // 4 wrong tries and then the right one, twice: the right ones don't count against the guesses
      for (let i = 0; i < 4; i++) expect((await verify(wrong)).status).toBe(400)
      const ok = await verify(code)
      expect(ok.status).toBe(200)
      expect(ok.headers['set-cookie']).toBeUndefined() // nothing changes, nobody is logged in
      expect((await verify(code)).status).toBe(200)
      expect((await post('/api/auth/login', { email, password: PASSWORD })).status).toBe(200) // password untouched

      // ...and the code still works for the real reset on the next page
      expect((await reset(email, code)).status).toBe(200)
      expect((await post('/api/auth/login', { email, password: NEW_PASSWORD })).status).toBe(200)
      expect((await verify(code)).status).toBe(400) // used up now
    })

    it('verifying still kills a code after 5 wrong guesses, and says the same for unknown addresses', async () => {
      const { email } = await signUp()
      await askResetCode(email)
      const right = codeFor(email)
      const wrong = right === '123456' ? '654321' : '123456'
      for (let i = 0; i < 5; i++)
        expect((await post('/api/auth/password/verify', { email, code: wrong })).status).toBe(400)
      expect((await post('/api/auth/password/verify', { email, code: right })).status).toBe(400)

      const unknown = await post('/api/auth/password/verify', { email: emailFor('ghost'), code: '123456' })
      const known = await post('/api/auth/password/verify', { email, code: wrong })
      expect(unknown.status).toBe(400)
      expect(unknown.body).toEqual(known.body)
      expect((await post('/api/auth/password/verify', { email, code: 'abc' })).status).toBe(400) // malformed
    })

    it('does not reveal which addresses exist when resetting', async () => {
      const unknown = await reset(emailFor('ghost'), '123456')
      const { email } = await signUp()
      const known = await reset(email, '123456')
      expect(unknown.status).toBe(400)
      expect(unknown.body).toEqual(known.body)
    })

    it('limits wrong codes per network', async () => {
      const ip = freshIp()
      const statuses: number[] = []
      for (let i = 0; i < 21; i++)
        statuses.push(
          (await post('/api/auth/password/reset', { email: emailFor('x'), code: '111111', password: NEW_PASSWORD }, ip))
            .status,
        )
      expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true)
      expect(statuses[20]).toBe(429)
    })
  })

  describe('log in / session', () => {
    it('logs in, serves /me, and logout kills the session server-side', async () => {
      const { email, cookie: first } = await signUp()
      const login = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', freshIp())
        .send({ email, password: PASSWORD })
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
      const wrong = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: 'wrong password!' })
      const unknown = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'ghost@example.com', password: 'wrong password!' })
      expect(wrong.status).toBe(401)
      expect(unknown.status).toBe(401)
      expect(wrong.body).toEqual(unknown.body)
    })

    it('treats forged, truncated and garbage cookies as signed out', async () => {
      const { cookie } = await signUp()
      for (const bad of [
        cookie + 'x',
        cookie.slice(0, -5),
        'erd_sid=',
        'erd_sid=' + 'A'.repeat(5000),
        'erd_sid=%00%00',
        'erd_sid=../../etc/passwd',
      ]) {
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

  describe('account settings (synced preferences)', () => {
    type Auth = Awaited<ReturnType<typeof signUp>>
    const get = (u: Auth) => request(app).get('/api/settings').set('Cookie', u.cookie)
    const put = (u: Auth, body: object) => request(app).put('/api/settings').set('Cookie', u.cookie).send(body)

    it('needs a login', async () => {
      expect((await request(app).get('/api/settings')).status).toBe(401)
      expect((await request(app).put('/api/settings').send({ theme: 'violet' })).status).toBe(401)
    })

    it('has nothing stored until the first save (null, not defaults), then returns what was saved', async () => {
      const u = await signUp()
      const first = await get(u)
      expect(first.body).toEqual({ settings: null, updatedAt: null })

      const saved = await put(u, { theme: 'violet', edgeStyle: 'curved' })
      expect(saved.status).toBe(200)
      expect(saved.body.settings).toEqual({ theme: 'violet', edgeStyle: 'curved' })
      expect(typeof saved.body.updatedAt).toBe('string')
      expect((await get(u)).body.settings).toEqual({ theme: 'violet', edgeStyle: 'curved' })
    })

    it('merges what is sent into what is stored, so devices changing different settings do not overwrite each other', async () => {
      const u = await signUp()
      await put(u, { theme: 'eraser', tableWeight: 500 })
      await put(u, { edgeStyle: 'curved' })
      const after = await put(u, { theme: 'warm' })
      expect(after.body.settings).toEqual({ theme: 'warm', tableWeight: 500, edgeStyle: 'curved' })
    })

    it('only accepts known settings with known values', async () => {
      const u = await signUp()
      for (const bad of [
        {},
        { theme: 'neon' },
        { tableWeight: 450 },
        { tableWeight: '400' },
        { edgeStyle: 'zigzag' },
        { tableFont: 'comic-sans' },
        { theme: 'violet', role: 'admin' }, // an unknown key is refused, not stored
        { theme: { $ne: 1 } },
      ]) {
        expect((await put(u, bad)).status, JSON.stringify(bad)).toBe(400)
      }
      expect((await get(u)).body.settings).toBeNull() // nothing got through
    })

    it("keeps each person's settings to themselves", async () => {
      const a = await signUp()
      const b = await signUp()
      await put(a, { theme: 'dracula' })
      expect((await get(b)).body.settings).toBeNull()
      await put(b, { theme: 'vercel' })
      expect((await get(a)).body.settings).toEqual({ theme: 'dracula' })
    })

    it('hides a stored value this version no longer knows, without hiding the others', async () => {
      const u = await signUp()
      await prisma.user.update({
        where: { id: u.user.id },
        data: { preferences: { theme: 'retired-theme', edgeStyle: 'curved', somethingOld: 1 } },
      })
      expect((await get(u)).body.settings).toEqual({ edgeStyle: 'curved' })
    })
  })

  describe('saved diagrams (several per user)', () => {
    type Auth = Awaited<ReturnType<typeof signUp>>
    const create = (u: Auth, body: object = {}) => request(app).post('/api/diagrams').set('Cookie', u.cookie).send(body)
    const put = (u: Auth, id: string, body: object) =>
      request(app).put(`/api/diagrams/${id}`).set('Cookie', u.cookie).send(body)

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

    it('lists each diagram with its table count and database, without loading the content', async () => {
      const u = await signUp()
      await create(u, { title: 'Shop', data: diagram })
      await create(u, {
        title: 'MySQL one',
        data: {
          ...diagram,
          provider: 'mysql',
          nodes: [
            ...diagram.nodes,
            { ...diagram.nodes[0], id: 't2', data: { ...diagram.nodes[0].data, id: 't2', name: 'posts' } },
          ],
        },
      })
      const blank = await create(u)
      expect(blank.body.diagram).toMatchObject({ tableCount: 0, provider: 'postgresql', pinned: false })

      const list = (await request(app).get('/api/diagrams').set('Cookie', u.cookie)).body.diagrams
      expect(
        list.map((d: { title: string; tableCount: number; provider: string }) => [d.title, d.tableCount, d.provider]),
      ).toEqual([
        ['Shop', 1, 'postgresql'],
        ['MySQL one', 2, 'mysql'],
        ['Untitled diagram', 0, 'postgresql'],
      ])
      expect(typeof list[0].updatedAt).toBe('string')

      // Saving new content refreshes both numbers in the reply, so the sidebar can update without a reload.
      const grown = structuredClone(diagram)
      grown.provider = 'sqlite'
      const saved = await put(u, blank.body.diagram.id, { data: grown })
      expect(saved.body).toMatchObject({ tableCount: 1, provider: 'sqlite', pinned: false })
    })

    it('pins and unpins a diagram without counting as an edit', async () => {
      const u = await signUp()
      const { id, updatedAt } = (await create(u, { title: 'Shop', data: diagram })).body.diagram
      await new Promise((r) => setTimeout(r, 15)) // so a changed updatedAt would be visible

      const pinned = await put(u, id, { pinned: true })
      expect(pinned.status).toBe(200)
      expect(pinned.body).toMatchObject({ pinned: true, title: 'Shop' })
      expect(new Date(pinned.body.updatedAt).getTime()).toBe(new Date(updatedAt).getTime()) // not "edited"

      const list = (await request(app).get('/api/diagrams').set('Cookie', u.cookie)).body.diagrams
      expect(list[0]).toMatchObject({ id, pinned: true })
      expect((await put(u, id, { pinned: false })).body.pinned).toBe(false)
      expect((await put(u, id, { pinned: 'yes' })).status).toBe(400)

      // pinning together with a rename is a real edit and works in one request
      const both = await put(u, id, { pinned: true, title: 'Shop 2' })
      expect(both.body).toMatchObject({ pinned: true, title: 'Shop 2' })
    })

    it("does not let anyone pin another user's diagram", async () => {
      const a = await signUp()
      const b = await signUp()
      const id = (await create(a, { title: 'Mine' })).body.diagram.id
      expect((await put(b, id, { pinned: true })).status).toBe(404)
      expect((await request(app).get('/api/diagrams').set('Cookie', a.cookie)).body.diagrams[0].pinned).toBe(false)
    })

    describe('Free plan limit', () => {
      /** Runs `fn` with the Free plan allowing `max` diagrams (the plans are put back before the next test). */
      async function withLimit(max: number, fn: () => Promise<void>) {
        await prisma.plan.update({ where: { id: 'free' }, data: { maxDiagrams: max } })
        await fn()
      }

      it('allows one diagram, then asks the person to upgrade (nothing is created)', async () => {
        await withLimit(1, async () => {
          const u = await signUp()
          expect((await create(u, { title: 'First' })).status).toBe(201)
          const second = await create(u, { title: 'Second' })
          expect(second.status).toBe(403)
          expect(second.body).toEqual({
            error: 'You can only create one diagram on the Free plan. Please upgrade your plan.',
            code: 'plan_limit',
          })
          const list = (await request(app).get('/api/diagrams').set('Cookie', u.cookie)).body
          expect(list.diagrams.map((d: { title: string }) => d.title)).toEqual(['First']) // the second was not made
          expect(list.plan).toMatchObject({ id: 'free', name: 'Free', kind: 'free', maxDiagrams: 1 })
        })
      })

      it('frees the place when the diagram is deleted, and counts each person on their own', async () => {
        await withLimit(1, async () => {
          const a = await signUp()
          const b = await signUp()
          const first = (await create(a, { title: 'A1' })).body.diagram.id
          expect((await create(b, { title: 'B1' })).status).toBe(201) // b has not used a's place
          expect((await create(a, { title: 'A2' })).status).toBe(403)
          expect((await request(app).delete(`/api/diagrams/${first}`).set('Cookie', a.cookie)).status).toBe(204)
          expect((await create(a, { title: 'A2' })).status).toBe(201)
        })
      })

      it('keeps what an account already has (the limit only stops new ones), and still lets it be edited', async () => {
        const u = await signUp()
        await create(u, { title: 'One' })
        await create(u, { title: 'Two' }) // made before the limit existed (the suite allows 50 here)
        await withLimit(1, async () => {
          expect((await create(u, { title: 'Three' })).status).toBe(403)
          const list = (await request(app).get('/api/diagrams').set('Cookie', u.cookie)).body.diagrams
          expect(list).toHaveLength(2)
          expect((await put(u, list[1].id, { title: 'Two, renamed' })).status).toBe(200)
        })
      })

      it('says how many when the plan allows more than one', async () => {
        await withLimit(3, async () => {
          const u = await signUp()
          for (let i = 0; i < 3; i++) expect((await create(u)).status).toBe(201)
          const over = await create(u)
          expect(over.status).toBe(403)
          expect(over.body.error).toBe('You can only create 3 diagrams on the Free plan. Please upgrade your plan.')
        })
      })
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
        expect(
          (
            await request(app)
              .get(`/api/diagrams/${encodeURIComponent(bad)}`)
              .set('Cookie', u.cookie)
          ).status,
        ).toBe(404)
        expect((await put(u, encodeURIComponent(bad), { title: 'x' })).status).toBe(404)
        expect(
          (
            await request(app)
              .delete(`/api/diagrams/${encodeURIComponent(bad)}`)
              .set('Cookie', u.cookie)
          ).status,
        ).toBe(404)
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
        const res = await request(app)
          .put(`/api/diagrams/${id}`)
          .set('Cookie', cookie)
          .set('Origin', origin)
          .send({ data: diagram })
        expect(res.status).toBe(403)
        const made = await request(app).post('/api/diagrams').set('Cookie', cookie).set('Origin', origin).send({})
        expect(made.status).toBe(403)
        const gone = await request(app).delete(`/api/diagrams/${id}`).set('Cookie', cookie).set('Origin', origin)
        expect(gone.status).toBe(403)
      }
      const logout = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.example')
      expect(logout.status).toBe(403)
      expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).body.user).not.toBeNull()
    })

    it('allows the API own origin and configured dev origins', async () => {
      const { cookie } = await signUp()
      const { id } = (await request(app).post('/api/diagrams').set('Cookie', cookie).send({})).body.diagram
      const own = await request(app)
        .put(`/api/diagrams/${id}`)
        .set('Cookie', cookie)
        .set('Host', 'erd.example.com')
        .set('Origin', 'https://erd.example.com')
        .send({ data: diagram })
      expect(own.status).toBe(200)
      const dev = await request(app)
        .put(`/api/diagrams/${id}`)
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:5173')
        .send({ data: diagram })
      expect(dev.status).toBe(200)
    })
  })

  describe('abuse protection', () => {
    it('limits accounts created per IP (no unlimited account farming)', async () => {
      const ip = freshIp()
      const statuses: number[] = []
      for (let i = 0; i < 7; i++) statuses.push((await signUpWith(emailFor('bot'), {}, ip)).status)
      expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201])
      expect(statuses.slice(5)).toEqual([429, 429])
      // another network is unaffected
      expect((await signUpWith(emailFor('ok'))).status).toBe(201)
    })

    it('blocks password guessing from one IP, but not after successful logins', async () => {
      const { email } = await signUp()
      const ip = freshIp()
      for (let i = 0; i < 15; i++) {
        expect(
          (
            await request(app)
              .post('/api/auth/login')
              .set('X-Forwarded-For', ip)
              .send({ email, password: `wrong-${i}-pass` })
          ).status,
        ).toBe(401)
      }
      const blocked = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email, password: PASSWORD })
      expect(blocked.status).toBe(429)
      expect(blocked.headers['ratelimit']).toBeDefined()
    })

    it('blocks a distributed attack on a single account (many IPs, one victim)', async () => {
      const { email } = await signUp()
      let last = 0
      for (let i = 0; i < 22; i++) {
        last = (
          await request(app)
            .post('/api/auth/login')
            .set('X-Forwarded-For', freshIp())
            .send({ email, password: `guess-${i}-xxxx` })
        ).status
      }
      expect(last).toBe(429)
      // ...even the right password is refused during the lockout, from a brand-new IP
      expect(
        (
          await request(app)
            .post('/api/auth/login')
            .set('X-Forwarded-For', freshIp())
            .send({ email, password: PASSWORD })
        ).status,
      ).toBe(429)
    })

    it('caps oversized credential bodies on public endpoints', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('X-Forwarded-For', freshIp())
        .send({ email: 'a@b.co', password: 'x'.repeat(40_000) })
      expect(res.status).toBe(413)
    })

    it('throttles save spam per user', async () => {
      const { cookie } = await signUp()
      const { id } = (await request(app).post('/api/diagrams').set('Cookie', cookie).send({})).body.diagram
      let last = 0
      for (let i = 0; i < 62; i++)
        last = (await request(app).put(`/api/diagrams/${id}`).set('Cookie', cookie).send({ data: diagram })).status
      expect(last).toBe(429)
    }, 60_000)

    it('throttles bulk diagram creation per user', async () => {
      const { cookie } = await signUp()
      const statuses: number[] = []
      for (let i = 0; i < 32; i++)
        statuses.push((await request(app).post('/api/diagrams').set('Cookie', cookie).send({})).status)
      expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true)
      expect(statuses.slice(30)).toEqual([429, 429]) // 30 per 10 minutes, well below the 50-diagram cap
    }, 60_000)
  })

  // ---- Plans, limits, orders and the admin panel ----------------------------------------------------------
  const tableNode = (n: number) => ({
    id: `t${n}`,
    position: { x: n * 10, y: 0 },
    data: {
      id: `t${n}`,
      name: `table_${n}`,
      columns: [{ id: `c${n}`, name: 'id', type: 'INT', primaryKey: true, notNull: true, unique: true, default: '' }],
    },
  })
  const diagramWith = (tables: number) => ({
    provider: 'postgresql',
    nodes: Array.from({ length: tables }, (_, i) => tableNode(i + 1)),
    manyToMany: [],
  })
  type Who = Awaited<ReturnType<typeof signUp>>
  const asUser = (u: Who) => ({
    get: (path: string) => request(app).get(path).set('Cookie', u.cookie),
    post: (path: string, body: object = {}) => request(app).post(path).set('Cookie', u.cookie).send(body),
    put: (path: string, body: object) => request(app).put(path).set('Cookie', u.cookie).send(body),
    del: (path: string) => request(app).delete(path).set('Cookie', u.cookie),
  })

  describe('plans and their limits', () => {
    it('lists the active plans for anyone (no login), in order, with prices and what each includes', async () => {
      const res = await request(app).get('/api/plans')
      expect(res.status).toBe(200)
      expect(res.headers['cache-control']).toContain('max-age')
      expect(res.body.plans.map((p: { id: string }) => p.id)).toEqual(['free', 'monthly', 'lifetime'])
      const [free, monthly, lifetime] = res.body.plans
      expect(free).toMatchObject({ kind: 'free', priceCents: 0 })
      expect(monthly).toMatchObject({
        kind: 'monthly',
        priceCents: 900,
        currency: 'USD',
        maxDiagrams: 5,
        maxTablesPerDiagram: 100,
      })
      expect(monthly.features).toEqual({
        export: true,
        codeFormats: true,
        themes: true,
        localCopy: false,
        setup: false,
      })
      expect(lifetime.features).toMatchObject({ localCopy: true, setup: true })
      expect(Array.isArray(monthly.highlights)).toBe(true)
      expect(JSON.stringify(res.body)).not.toMatch(/active|updatedAt/) // only what the pricing page needs
    })

    it('hides a plan the admin switched off', async () => {
      await prisma.plan.update({ where: { id: 'lifetime' }, data: { active: false } })
      const ids = (await request(app).get('/api/plans')).body.plans.map((p: { id: string }) => p.id)
      expect(ids).toEqual(['free', 'monthly'])
    })

    it('never promises more than the database can take, whatever a plan row says', async () => {
      await prisma.plan.update({ where: { id: 'lifetime' }, data: { maxTablesPerDiagram: 5000, maxDiagrams: 900 } })
      const lifetime = (await request(app).get('/api/plans')).body.plans.find(
        (p: { id: string }) => p.id === 'lifetime',
      )
      expect(lifetime).toMatchObject({ maxTablesPerDiagram: 300, maxDiagrams: 50 })
    })

    it('has a personal endpoint for the current plan, and it needs a login', async () => {
      expect((await request(app).get('/api/plans/mine')).status).toBe(401)
      const me = await signUp()
      const res = await asUser(me).get('/api/plans/mine')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.body.plan).toMatchObject({ id: 'free', kind: 'free', expiresAt: null })
      await prisma.user.update({ where: { id: me.user.id }, data: { planId: 'monthly', planExpiresAt: new Date(Date.now() + 86_400_000) } })
      expect((await asUser(me).get('/api/plans/mine')).body.plan).toMatchObject({ id: 'monthly', maxDiagrams: 5 })
    })

    it('tells the signed-in user their plan with its limits and features in the diagram list', async () => {
      const u = asUser(await signUp())
      const { plan } = (await u.get('/api/diagrams')).body
      expect(plan).toMatchObject({
        id: 'free',
        kind: 'free',
        maxDiagrams: 50,
        maxTablesPerDiagram: 300,
        expiresAt: null,
      })
      expect(plan.features).toEqual(FEATURES_OFF)
    })

    it('refuses a diagram with more tables than the plan allows, on create and on save', async () => {
      await prisma.plan.update({ where: { id: 'free' }, data: { maxTablesPerDiagram: 3 } })
      const u = asUser(await signUp())
      const tooMany = await u.post('/api/diagrams', { title: 'Big', data: diagramWith(4) })
      expect(tooMany.status).toBe(403)
      expect(tooMany.body).toEqual({
        error: 'The Free plan allows up to 3 tables in a diagram. Please upgrade your plan to add more.',
        code: 'plan_limit_tables',
      })
      const made = await u.post('/api/diagrams', { title: 'Ok', data: diagramWith(3) })
      expect(made.status).toBe(201)
      const id = made.body.diagram.id
      expect((await u.put(`/api/diagrams/${id}`, { data: diagramWith(4) })).body.code).toBe('plan_limit_tables')
      expect((await u.put(`/api/diagrams/${id}`, { data: diagramWith(2) })).status).toBe(200)
      // the refused save left the stored diagram as it was
      expect((await u.get(`/api/diagrams/${id}`)).body.diagram.data.nodes).toHaveLength(2)
    })

    it('lets a diagram that is already over the limit (after a downgrade) be edited and shrunk, but not grow', async () => {
      const u = asUser(await signUp())
      const id = (await u.post('/api/diagrams', { title: 'Grown', data: diagramWith(6) })).body.diagram.id
      await prisma.plan.update({ where: { id: 'free' }, data: { maxTablesPerDiagram: 3 } })
      expect((await u.put(`/api/diagrams/${id}`, { data: diagramWith(6) })).status).toBe(200) // same size: fine
      expect((await u.put(`/api/diagrams/${id}`, { data: diagramWith(5) })).status).toBe(200) // smaller: fine
      const grow = await u.put(`/api/diagrams/${id}`, { data: diagramWith(6) }) // back up to 6 from 5: not fine
      expect(grow.status).toBe(403)
      expect(grow.body.code).toBe('plan_limit_tables')
    })

    it('a monthly plan raises the limits while it runs, and the account is back on Free limits once it has ended', async () => {
      const me = await signUp()
      const u = asUser(me)
      await prisma.user.update({
        where: { id: me.user.id },
        data: { planId: 'monthly', planExpiresAt: new Date(Date.now() + 86_400_000) },
      })
      expect((await u.get('/api/diagrams')).body.plan).toMatchObject({
        id: 'monthly',
        maxDiagrams: 5,
        maxTablesPerDiagram: 100,
      })

      await prisma.user.update({ where: { id: me.user.id }, data: { planExpiresAt: new Date(Date.now() - 1000) } })
      expect((await u.get('/api/diagrams')).body.plan).toMatchObject({ id: 'free', maxDiagrams: 50 })
      await prisma.plan.update({ where: { id: 'free' }, data: { maxTablesPerDiagram: 3 } })
      expect((await u.post('/api/diagrams', { data: diagramWith(4) })).body.code).toBe('plan_limit_tables') // no leftover Pro limits
    })

    it('says what a paid plan includes when its own limit is reached', async () => {
      const me = await signUp()
      const u = asUser(me)
      await prisma.user.update({
        where: { id: me.user.id },
        data: { planId: 'monthly', planExpiresAt: new Date(Date.now() + 86_400_000) },
      })
      for (let i = 0; i < 5; i++) expect((await u.post('/api/diagrams')).status).toBe(201)
      const sixth = await u.post('/api/diagrams')
      expect(sixth.status).toBe(403)
      expect(sixth.body.error).toBe('Your Pro plan includes 5 diagrams. Delete one to add another.')
    })
  })

  describe('orders (buying a plan)', () => {
    it('needs a login', async () => {
      expect((await request(app).get('/api/orders')).status).toBe(401)
      expect((await request(app).post('/api/orders').send({ planId: 'monthly' })).status).toBe(401)
    })

    it("places an order at the plan's current price, with the payment instructions, and returns the same open order if asked again", async () => {
      const u = asUser(await signUp())
      const first = await u.post('/api/orders', { planId: 'monthly' })
      expect(first.status).toBe(201)
      expect(first.body.order).toMatchObject({
        planId: 'monthly',
        planName: 'Pro',
        status: 'pending',
        amountCents: 900,
        currency: 'USD',
      })
      expect(first.body.instructions).toMatch(/payment/i)

      await prisma.plan.update({ where: { id: 'monthly' }, data: { priceCents: 1500 } }) // the admin raises the price
      const again = await u.post('/api/orders', { planId: 'monthly', contact: '+92 300 1234567' })
      expect(again.status).toBe(200)
      expect(again.body.order.id).toBe(first.body.order.id) // one open order per plan, not a pile
      expect(again.body.order).toMatchObject({ amountCents: 900, contact: '+92 300 1234567' }) // the price it was ordered at
      expect((await u.get('/api/orders')).body.orders).toHaveLength(1)
    })

    it('refuses the free plan, unknown plans and plans that are switched off', async () => {
      const u = asUser(await signUp())
      await prisma.plan.update({ where: { id: 'lifetime' }, data: { active: false } })
      for (const planId of ['free', 'nope', 'lifetime'])
        expect((await u.post('/api/orders', { planId })).status, planId).toBe(400)
      expect((await u.post('/api/orders', {})).status).toBe(400)
      expect((await u.post('/api/orders', { planId: 'monthly', contact: 'x'.repeat(121) })).status).toBe(400)
    })

    it('shows each person only their own orders, and only they can update or cancel them', async () => {
      const a = asUser(await signUp())
      const b = asUser(await signUp())
      const id = (await a.post('/api/orders', { planId: 'monthly' })).body.order.id
      expect((await b.get('/api/orders')).body.orders).toEqual([])
      expect((await b.put(`/api/orders/${id}`, { reference: 'steal' })).status).toBe(404)
      expect((await b.post(`/api/orders/${id}/cancel`)).status).toBe(404)

      const updated = await a.put(`/api/orders/${id}`, { reference: 'TXN-123' })
      expect(updated.body.order.reference).toBe('TXN-123')
      expect((await a.post(`/api/orders/${id}/cancel`)).status).toBe(204)
      expect((await a.get('/api/orders')).body.orders[0].status).toBe('cancelled')
      expect((await a.put(`/api/orders/${id}`, { reference: 'late' })).status).toBe(404) // a cancelled order is closed
      // and after cancelling, a new order for the plan can be placed
      expect((await a.post('/api/orders', { planId: 'monthly' })).status).toBe(201)
    })

    it('tells someone who already has the lifetime plan there is nothing to buy', async () => {
      const me = await signUp()
      await prisma.user.update({ where: { id: me.user.id }, data: { planId: 'lifetime' } })
      const res = await asUser(me).post('/api/orders', { planId: 'monthly' })
      expect(res.status).toBe(409)
      expect(res.body.error).toBe('You already have the Lifetime plan.')
    })
  })

  describe('admin panel', () => {
    const ADMIN_EMAIL = 'boss@example.com'
    const ADMIN_PASSWORD = 'an admin password that is long'
    let hash = ''
    beforeAll(async () => {
      hash = await hashPassword(ADMIN_PASSWORD)
    })
    const configureAdmin = (on: boolean) => {
      config.ADMIN_EMAIL = on ? ADMIN_EMAIL : undefined
      config.ADMIN_PASSWORD_HASH = on ? hash : undefined
    }
    beforeEach(() => configureAdmin(true))
    afterAll(() => configureAdmin(false))

    const login = (body: object = { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, ip = freshIp()) =>
      request(app).post('/api/admin/login').set('X-Forwarded-For', ip).send(body)
    async function adminCookie() {
      const res = await login()
      expect(res.status).toBe(200)
      return (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
    }
    const admin = async () => {
      const cookie = await adminCookie()
      return {
        get: (path: string) => request(app).get(`/api/admin${path}`).set('Cookie', cookie),
        post: (path: string, body: object = {}) =>
          request(app).post(`/api/admin${path}`).set('Cookie', cookie).send(body),
        put: (path: string, body: object) => request(app).put(`/api/admin${path}`).set('Cookie', cookie).send(body),
        cookie,
      }
    }

    it('says "not set up" when no admin is configured (and nothing works)', async () => {
      configureAdmin(false)
      expect((await login()).status).toBe(503)
      expect((await request(app).get('/api/admin/me')).status).toBe(503)
    })

    it('logs in with the configured email and password, with a cookie page scripts cannot read', async () => {
      const res = await login()
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ admin: { email: ADMIN_EMAIL } })
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0]
      expect(cookie).toMatch(/^erd_admin=/)
      expect(cookie).toMatch(/HttpOnly/i)
      expect(cookie).toMatch(/SameSite=Strict/i)
      expect((await request(app).get('/api/admin/me').set('Cookie', cookie.split(';')[0])).body.admin.email).toBe(
        ADMIN_EMAIL,
      )
    })

    it('gives one answer for a wrong email and a wrong password, and never sets a cookie', async () => {
      const wrongEmail = await login({ email: 'someone@example.com', password: ADMIN_PASSWORD })
      const wrongPassword = await login({ email: ADMIN_EMAIL, password: 'not the password' })
      for (const res of [wrongEmail, wrongPassword]) {
        expect(res.status).toBe(401)
        expect(res.body).toEqual({ error: 'Wrong email or password.' })
        expect(res.headers['set-cookie']).toBeUndefined()
      }
      expect((await login({ email: ADMIN_EMAIL })).status).toBe(400) // no password at all
    })

    it('slows down password guessing: a few failures from one address and the next try is refused, even with the right password', async () => {
      const ip = freshIp()
      for (let i = 0; i < 6; i++)
        expect((await login({ email: ADMIN_EMAIL, password: `guess ${i}` }, ip)).status).toBe(401)
      const blocked = await login({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, ip)
      expect(blocked.status).toBe(429)
    })

    it('keeps the website and the admin panel apart: neither cookie opens the other', async () => {
      const a = await admin()
      const user = await signUp()
      expect((await request(app).get('/api/admin/users').set('Cookie', user.cookie)).status).toBe(401)
      expect((await request(app).get('/api/diagrams').set('Cookie', a.cookie)).status).toBe(401)
      expect((await request(app).get('/api/admin/users')).status).toBe(401)
    })

    it('logout ends the session; a session also ends when it expires or the admin email is changed', async () => {
      const a = await admin()
      expect((await a.get('/me')).status).toBe(200)
      await request(app).post('/api/admin/logout').set('Cookie', a.cookie)
      expect((await a.get('/me')).status).toBe(401)

      const b = await admin()
      await prisma.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } })
      expect((await b.get('/me')).status).toBe(401)

      const c = await admin()
      config.ADMIN_EMAIL = 'new-boss@example.com'
      expect((await c.get('/me')).status).toBe(401) // an old session does not survive a change of admin
    })

    it('shows the numbers: users by plan, orders and money taken', async () => {
      const u = await signUp()
      await signUp()
      await prisma.user.update({
        where: { id: u.user.id },
        data: { planId: 'monthly', planExpiresAt: new Date(Date.now() + 86_400_000) },
      })
      const order = (await asUser(u).post('/api/orders', { planId: 'monthly' })).body.order
      const a = await admin()
      let overview = (await a.get('/overview')).body
      expect(overview).toMatchObject({ users: 2, newUsers: 2, pendingOrders: 1, paidOrders: 0, revenue: [] })
      expect(overview.usersByPlan).toEqual(
        expect.arrayContaining([
          { planId: 'free', count: 1 },
          { planId: 'monthly', count: 1 },
        ]),
      )
      await a.post(`/orders/${order.id}/paid`)
      overview = (await a.get('/overview')).body
      expect(overview).toMatchObject({ pendingOrders: 0, paidOrders: 1, revenue: [{ currency: 'USD', cents: 900 }] })
    })

    describe('plans and prices', () => {
      it('lists every plan, including ones that are switched off', async () => {
        await prisma.plan.update({ where: { id: 'lifetime' }, data: { active: false } })
        const a = await admin()
        const plans = (await a.get('/plans')).body.plans
        expect(plans.map((p: { id: string; active: boolean }) => [p.id, p.active])).toEqual([
          ['free', true],
          ['monthly', true],
          ['lifetime', false],
        ])
      })

      it('changes a price, limits, features and the pricing-page lines, and the public pricing shows them straight away', async () => {
        const a = await admin()
        const res = await a.put('/plans/monthly', {
          priceCents: 1299,
          currency: 'pkr',
          maxDiagrams: 8,
          maxTablesPerDiagram: 150,
          features: { export: false },
          highlights: ['  Eight diagrams  ', 'No export'],
          name: 'Pro+',
          description: 'New description',
        })
        expect(res.status).toBe(200)
        expect(res.body.plan).toMatchObject({
          priceCents: 1299,
          currency: 'PKR',
          maxDiagrams: 8,
          maxTablesPerDiagram: 150,
          name: 'Pro+',
        })
        // only the feature that was named changed; the rest kept their value
        expect(res.body.plan.features).toEqual({
          export: false,
          codeFormats: true,
          themes: true,
          localCopy: false,
          setup: false,
        })
        const monthly = (await request(app).get('/api/plans')).body.plans.find(
          (p: { id: string }) => p.id === 'monthly',
        )
        expect(monthly).toMatchObject({
          priceCents: 1299,
          currency: 'PKR',
          name: 'Pro+',
          highlights: ['Eight diagrams', 'No export'],
        })
      })

      it("turns a changed limit into the account's real limit at once", async () => {
        const me = await signUp()
        const a = await admin()
        await a.put('/plans/free', { maxTablesPerDiagram: 2 })
        expect((await asUser(me).post('/api/diagrams', { data: diagramWith(3) })).body.code).toBe('plan_limit_tables')
      })

      it('rejects nonsense: negative or fractional prices, bad currencies, limits past the hard caps, unknown fields, nothing at all', async () => {
        const a = await admin()
        for (const bad of [
          { priceCents: -1 },
          { priceCents: 9.5 },
          { currency: 'dollars' },
          { maxDiagrams: 0 },
          { maxDiagrams: 51 },
          { maxTablesPerDiagram: 301 },
          { highlights: Array.from({ length: 13 }, () => 'x') },
          { highlights: [''] },
          { kind: 'lifetime' },
          { id: 'other' },
          {},
        ]) {
          expect((await a.put('/plans/monthly', bad)).status, JSON.stringify(bad)).toBe(400)
        }
        expect((await a.put('/plans/nope', { priceCents: 1 })).status).toBe(404)
      })

      it('keeps the Free plan active and free', async () => {
        const a = await admin()
        expect((await a.put('/plans/free', { active: false })).status).toBe(400)
        expect((await a.put('/plans/free', { priceCents: 100 })).status).toBe(400)
        expect((await a.put('/plans/free', { maxDiagrams: 2 })).status).toBe(200)
      })
    })

    describe('users', () => {
      it('lists the registered users newest first with their plan and how many diagrams they have, and can search and page', async () => {
        const first = await signUp('alice@example.com')
        await asUser(first).post('/api/diagrams', { title: 'One' })
        await new Promise((r) => setTimeout(r, 10))
        await signUp('bob@example.com')
        const a = await admin()
        const all = (await a.get('/users')).body
        expect(all).toMatchObject({ total: 2, page: 1, pageSize: 25 })
        expect(all.users.map((u: { email: string }) => u.email)).toEqual(['bob@example.com', 'alice@example.com'])
        expect(all.users[1]).toMatchObject({ planId: 'free', planName: 'Free', diagrams: 1, planExpired: false })
        expect(JSON.stringify(all)).not.toMatch(/passwordHash|password_hash|scrypt/) // never the password hashes

        const found = (await a.get('/users?q=ALI')).body
        expect(found.total).toBe(1)
        expect(found.users[0].email).toBe('alice@example.com')
        expect((await a.get('/users?page=2')).body.users).toEqual([])
        expect((await a.get('/users?page=abc')).status).toBe(200) // junk becomes page 1
      })

      it('flags a monthly plan that has run out', async () => {
        const me = await signUp()
        await prisma.user.update({
          where: { id: me.user.id },
          data: { planId: 'monthly', planExpiresAt: new Date(Date.now() - 1000) },
        })
        const a = await admin()
        expect((await a.get('/users')).body.users[0]).toMatchObject({ planId: 'monthly', planExpired: true })
      })

      it('puts an account on a plan by hand: monthly gets an end date (a month by default), lifetime and free have none', async () => {
        const me = await signUp()
        const a = await admin()
        const monthly = await a.put(`/users/${me.user.id}/plan`, { planId: 'monthly' })
        expect(monthly.status).toBe(200)
        const ends = new Date(monthly.body.user.planExpiresAt).getTime()
        expect(ends).toBeGreaterThan(Date.now() + 27 * 86_400_000)
        expect(ends).toBeLessThan(Date.now() + 32 * 86_400_000)
        expect((await asUser(me).get('/api/diagrams')).body.plan.id).toBe('monthly')

        const until = new Date(Date.now() + 5 * 86_400_000).toISOString()
        expect(
          (await a.put(`/users/${me.user.id}/plan`, { planId: 'monthly', expiresAt: until })).body.user.planExpiresAt,
        ).toBe(until)
        expect((await a.put(`/users/${me.user.id}/plan`, { planId: 'lifetime' })).body.user.planExpiresAt).toBeNull()
        expect(
          (await a.put(`/users/${me.user.id}/plan`, { planId: 'free', expiresAt: until })).body.user.planExpiresAt,
        ).toBeNull()

        expect((await a.put(`/users/${me.user.id}/plan`, { planId: 'gold' })).status).toBe(404)
        expect((await a.put('/users/00000000-0000-4000-8000-000000000000/plan', { planId: 'free' })).status).toBe(404)
      })
    })

    describe('orders', () => {
      it('shows who ordered what, and confirming the payment starts the plan: a month for monthly, for ever for lifetime', async () => {
        const me = await signUp('buyer@example.com')
        const order = (await asUser(me).post('/api/orders', { planId: 'monthly', contact: '0300 1234567' })).body.order
        const a = await admin()
        const listed = (await a.get('/orders?status=pending')).body.orders
        expect(listed).toHaveLength(1)
        expect(listed[0]).toMatchObject({
          userEmail: 'buyer@example.com',
          planName: 'Pro',
          status: 'pending',
          contact: '0300 1234567',
          amountCents: 900,
        })

        const paid = await a.post(`/orders/${order.id}/paid`)
        expect(paid.status).toBe(200)
        expect(paid.body.order.status).toBe('paid')
        expect(paid.body.order.paidAt).toBeTruthy()
        const plan = (await asUser(me).get('/api/diagrams')).body.plan
        expect(plan).toMatchObject({ id: 'monthly', maxDiagrams: 5, maxTablesPerDiagram: 100 })
        expect(new Date(plan.expiresAt).getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000)

        const life = (await asUser(me).post('/api/orders', { planId: 'lifetime' })).body.order
        await a.post(`/orders/${life.id}/paid`)
        expect((await asUser(me).get('/api/diagrams')).body.plan).toMatchObject({ id: 'lifetime', expiresAt: null })
      })

      it('confirming the same payment twice does not add a second month', async () => {
        const me = await signUp()
        const order = (await asUser(me).post('/api/orders', { planId: 'monthly' })).body.order
        const a = await admin()
        await a.post(`/orders/${order.id}/paid`)
        const once = (await asUser(me).get('/api/diagrams')).body.plan.expiresAt
        const twice = await a.post(`/orders/${order.id}/paid`)
        expect(twice.status).toBe(200)
        expect(twice.body.alreadyPaid).toBe(true)
        expect((await asUser(me).get('/api/diagrams')).body.plan.expiresAt).toBe(once)
      })

      it('renewing early adds the month after the current end', async () => {
        const me = await signUp()
        const end = new Date(Date.now() + 10 * 86_400_000)
        await prisma.user.update({ where: { id: me.user.id }, data: { planId: 'monthly', planExpiresAt: end } })
        const order = (await asUser(me).post('/api/orders', { planId: 'monthly' })).body.order
        await (await admin()).post(`/orders/${order.id}/paid`)
        const after = new Date((await asUser(me).get('/api/diagrams')).body.plan.expiresAt).getTime()
        expect(after).toBeGreaterThan(end.getTime() + 27 * 86_400_000)
        expect(after).toBeLessThan(end.getTime() + 32 * 86_400_000)
      })

      it('a cancelled order cannot be paid, and only an open order can be cancelled', async () => {
        const me = await signUp()
        const order = (await asUser(me).post('/api/orders', { planId: 'monthly' })).body.order
        const a = await admin()
        expect((await a.post(`/orders/${order.id}/cancel`)).status).toBe(204)
        const paid = await a.post(`/orders/${order.id}/paid`)
        expect(paid.status).toBe(409)
        expect(paid.body.error).toBe('This order was cancelled.')
        expect((await a.post(`/orders/${order.id}/cancel`)).status).toBe(404) // already closed
        expect((await asUser(me).get('/api/diagrams')).body.plan.id).toBe('free') // nothing was started
        expect((await a.post('/orders/not-an-id/paid')).status).toBe(404)
      })

      it('the admin can leave a note on an order (for the delivery of a lifetime copy)', async () => {
        const me = await signUp()
        const order = (await asUser(me).post('/api/orders', { planId: 'lifetime' })).body.order
        const a = await admin()
        const res = await a.put(`/orders/${order.id}`, { adminNote: 'Copy installed on 12 Oct' })
        expect(res.body.order.adminNote).toBe('Copy installed on 12 Oct')
        expect((await asUser(me).get('/api/orders')).body.orders[0]).not.toHaveProperty('adminNote') // not shown to the buyer
        expect((await a.put('/orders/00000000-0000-4000-8000-000000000000', { adminNote: 'x' })).status).toBe(404)
      })
    })

    it('stores the payment instructions the buyer sees with their order', async () => {
      const a = await admin()
      expect((await a.get('/settings')).body.paymentInstructions).toMatch(/payment/i) // the default text
      const text = 'Send the amount to JazzCash 0300-0000000, then add the transaction id to your order.'
      expect((await a.put('/settings', { paymentInstructions: `  ${text}  ` })).body.paymentInstructions).toBe(text)
      const me = asUser(await signUp())
      expect((await me.post('/api/orders', { planId: 'monthly' })).body.instructions).toBe(text)
      expect((await me.get('/api/orders')).body.instructions).toBe(text)
      expect((await a.put('/settings', { paymentInstructions: 'x'.repeat(4001) })).status).toBe(400)
      expect((await a.put('/settings', { paymentInstructions: '   ' })).body.paymentInstructions).toMatch(/payment/i) // blank = back to the default
    })
  })
})
