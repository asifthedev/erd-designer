import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

afterEach(() => vi.unstubAllGlobals())

const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })),
  )

describe('api errors', () => {
  it('carry the field and how long to wait (the "send another code" countdown)', async () => {
    respond(429, { error: 'Please wait 42 seconds before asking for another code.', retryAfter: 42 })
    const err = (await api('/auth/signup/code', { body: { email: 'a@b.co' } }).catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(429)
    expect(err.retryAfter).toBe(42)
    expect(err.message).toMatch(/42 seconds/)

    respond(400, { error: 'That code is wrong or has expired', field: 'code' })
    const wrong = (await api('/auth/signup', { body: {} }).catch((e) => e)) as ApiError
    expect(wrong.field).toBe('code')
    expect(wrong.retryAfter).toBeUndefined()
  })
})

describe('the code requests the store sends', () => {
  it('uses the right endpoints and bodies', async () => {
    const calls: { path: string; body: unknown }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ path: url, body: init.body ? JSON.parse(String(init.body)) : undefined })
        return new Response(JSON.stringify({ ok: true, cooldownSeconds: 60, user: { id: 'u', email: 'a@b.co', name: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const { useAuth } = await import('./store')
    const s = useAuth.getState()

    expect(await s.requestSignupCode('a@b.co')).toBe(60)
    expect(await s.requestResetCode('a@b.co')).toBe(60)
    await s.verifyResetCode({ email: 'a@b.co', code: '123456' }) // the code page, before the new password is asked for
    await s.resetPassword({ email: 'a@b.co', code: '123456', password: 'a new password' })
    expect(calls.map((c) => c.path)).toEqual([
      '/api/auth/signup/code',
      '/api/auth/password/forgot',
      '/api/auth/password/verify',
      '/api/auth/password/reset',
    ])
    expect(calls[2].body).toEqual({ email: 'a@b.co', code: '123456' })
    expect(calls[0].body).toEqual({ email: 'a@b.co' })
    expect(calls[3].body).toEqual({ email: 'a@b.co', code: '123456', password: 'a new password' })
  })
})
