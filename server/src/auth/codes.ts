import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { prisma } from '../db'

/**
 * One-time email codes (see the EmailCode model). 6 digits, valid for 10 minutes, 5 guesses, one live code per
 * address and purpose. Only a salted hash is stored, so a leaked table doesn't reveal usable codes.
 */
export type CodePurpose = 'signup' | 'reset'

export const CODE_TTL_MS = 10 * 60_000
/** Minimum time between two codes for the same address and purpose (stops mail-bombing an inbox). */
export const CODE_COOLDOWN_MS = 60_000
export const MAX_CODE_ATTEMPTS = 5

const hashCode = (purpose: CodePurpose, email: string, salt: string, code: string) =>
  createHash('sha256').update(`${purpose}:${email}:${salt}:${code}`).digest('hex')

/**
 * Creates a fresh code (replacing any earlier one), or says how many seconds to wait. Called the same way whether
 * or not the address has an account, so the answer can't be used to find out.
 */
export async function issueCode(
  email: string,
  purpose: CodePurpose,
): Promise<{ code: string } | { waitSeconds: number }> {
  const latest = await prisma.emailCode.findFirst({ where: { email, purpose }, orderBy: { createdAt: 'desc' } })
  const age = latest ? Date.now() - latest.createdAt.getTime() : Infinity
  if (age < CODE_COOLDOWN_MS) return { waitSeconds: Math.ceil((CODE_COOLDOWN_MS - age) / 1000) }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const salt = randomBytes(16).toString('hex')
  await prisma.$transaction([
    prisma.emailCode.deleteMany({ where: { email, purpose } }),
    prisma.emailCode.create({
      data: { email, purpose, salt, codeHash: hashCode(purpose, email, salt, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
    }),
  ])
  // Housekeeping, off the request path: drop codes that ran out.
  void prisma.emailCode.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {})
  return { code }
}

/**
 * Is `code` the live code for this address? Every call uses up one of the code's guesses, atomically, so parallel
 * requests can't squeeze in extra guesses. Doesn't consume a correct code: call consumeCodes once the action worked.
 */
export async function checkCode(email: string, purpose: CodePurpose, code: string): Promise<boolean> {
  const row = await prisma.emailCode.findFirst({ where: { email, purpose }, orderBy: { createdAt: 'desc' } })
  if (!row || row.expiresAt < new Date() || row.attempts >= MAX_CODE_ATTEMPTS) return false
  const { attempts } = await prisma.emailCode.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } })
  if (attempts > MAX_CODE_ATTEMPTS) return false
  const expected = Buffer.from(row.codeHash, 'hex')
  const actual = Buffer.from(hashCode(purpose, email, row.salt, code), 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** A code is single-use: forget every code for this address and purpose. */
export const consumeCodes = (email: string, purpose: CodePurpose) =>
  prisma.emailCode.deleteMany({ where: { email, purpose } })
