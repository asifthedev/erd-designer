import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery', stored)).toBe(true)
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false)
  })

  it('salts every hash differently and never stores the password', async () => {
    const a = await hashPassword('same-password')
    const b = await hashPassword('same-password')
    expect(a).not.toBe(b)
    expect(a).not.toContain('same-password')
  })

  it('rejects malformed stored values instead of throwing', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false)
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false)
  })
})
