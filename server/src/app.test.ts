import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app'
import { prisma } from './db'
import { setMailer, type Mail } from './mail/mailer'

const hasDb = Boolean(process.env.DATABASE_URL)
const app = createApp()

let ipCounter = 0
/** A fresh fake client IP, so rate-limit counters from one test never leak into another. */
const freshIp = () => `10.${Math.floor(++ipCounter / 65000)}.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`

const PASSWORD = 'correct horse battery'
const emailFor = (n: string) => `${n}-${Math.random().toString(36).slice(2, 8)}@example.com`

// Every email the server would have sent, in order, instead of sending it.
let outbox: Mail[] = []
const mailsTo = (email: string) => outbox.filter((m) => m.to === email.trim().toLowerCase())
/** The 6-digit code in the latest email to `email`. */
const codeFor = (email: string) => /\b(\d{6})\b/.exec(mailsTo(email).at(-1)?.text ?? '')?.[1] ?? ''
const post = (path: string, body: object, ip = freshIp()) => request(app).post(path).set('X-Forwarded-For', ip).send(body)
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
        columns: [
          { id: 'c1', name: 'id', type: 'uuid', primaryKey: true, notNull: true, unique: true, default: '' },
        ],
      },
    },
  ],
  manyToMany: [],
}

describe.skipIf(!hasDb)('API (integration, real PostgreSQL)', () => {
  beforeAll(() => setMailer({ send: async (mail) => void outbox.push(mail) }))
  beforeEach(async () => {
    outbox = []
    await prisma.emailCode.deleteMany()
    await prisma.diagram.deleteMany()
    await prisma.session.deleteMany()
    await prisma.user.deleteMany()
    await prisma.rateLimit.deleteMany()
  })
  afterAll(async () => {
    setMailer()
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
        .send(`{"email":"p@x.co","password":"correct horse battery","code":"${codeFor('p@x.co')}","__proto__":{"admin":true},"id":"hacked","passwordHash":"x"}`)
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
      for (let i = 0; i < 5; i++) expect((await post('/api/auth/signup', { email, password: PASSWORD, code: wrong })).status).toBe(400)
      expect((await post('/api/auth/signup', { email, password: PASSWORD, code: right })).status).toBe(400)
      expect(await prisma.user.count()).toBe(0)
    })

    it('does not let parallel requests squeeze in extra guesses', async () => {
      const email = emailFor('parallel')
      await askSignupCode(email)
      const right = codeFor(email)
      const wrong = right === '123456' ? '654321' : '123456'
      const wrongs = await Promise.all(Array.from({ length: 8 }, () => post('/api/auth/signup', { email, password: PASSWORD, code: wrong })))
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
      expect((await post('/api/auth/signup', { email: late, password: PASSWORD, code: codeFor(late) })).status).toBe(400)
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
      if (first !== second) expect((await post('/api/auth/signup', { email, password: PASSWORD, code: first })).status).toBe(400)
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
    const reset = (email: string, code: string, password = NEW_PASSWORD) => post('/api/auth/password/reset', { email, code, password })

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
      for (let i = 0; i < 5; i++) expect((await post('/api/auth/password/verify', { email, code: wrong })).status).toBe(400)
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
      for (let i = 0; i < 21; i++) statuses.push((await post('/api/auth/password/reset', { email: emailFor('x'), code: '111111', password: NEW_PASSWORD }, ip)).status)
      expect(statuses.slice(0, 20).every((s) => s === 400)).toBe(true)
      expect(statuses[20]).toBe(429)
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

    it('lists each diagram with its table count and database, without loading the content', async () => {
      const u = await signUp()
      await create(u, { title: 'Shop', data: diagram })
      await create(u, { title: 'MySQL one', data: { ...diagram, provider: 'mysql', nodes: [...diagram.nodes, { ...diagram.nodes[0], id: 't2', data: { ...diagram.nodes[0].data, id: 't2', name: 'posts' } }] } })
      const blank = await create(u)
      expect(blank.body.diagram).toMatchObject({ tableCount: 0, provider: 'postgresql', pinned: false })

      const list = (await request(app).get('/api/diagrams').set('Cookie', u.cookie)).body.diagrams
      expect(list.map((d: { title: string; tableCount: number; provider: string }) => [d.title, d.tableCount, d.provider])).toEqual([
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
