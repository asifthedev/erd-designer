import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))),
  )

// OWASP-recommended scrypt cost (N=2^15, r=8, p=1 needs ~32 MiB, so the default memory cap is raised).
const N = 2 ** 15
const R = 8
const P = 1
const KEYLEN = 64
const OPTIONS: ScryptOptions = { N, r: R, p: P, maxmem: 128 * N * R * 2 }

/** `scrypt$N$r$p$salt$hash` (base64): the parameters travel with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEYLEN, OPTIONS)
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Verified against when the email is unknown, so "no such user" costs the same time as "wrong password". */
let dummy: Promise<string> | undefined
export const dummyHash = () => (dummy ??= hashPassword('not-a-real-password'))
