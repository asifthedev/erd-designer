import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { config } from '../config'

/**
 * Secrets stored in the database (the AI gateway key) are encrypted with AES-256-GCM. The key comes from APP_SECRET,
 * or, when that is not set, from DATABASE_URL: either way it lives in the server environment, never in the database,
 * so a leaked copy of the database does not reveal them. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 */
const key = () => Buffer.from(hkdfSync('sha256', config.APP_SECRET ?? config.DATABASE_URL, 'erd-designer', 'secrets-v1', 32))

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.')
}

/** The secret, or null when it cannot be read (the environment secret changed, or the value was tampered with). */
export function decryptSecret(token: string | null | undefined): string | null {
  if (!token) return null
  try {
    const [v, iv, tag, data] = token.split('.')
    if (v !== 'v1') return null
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** What the admin panel shows instead of a key: enough to recognise it, not to use it. */
export const keyHint = (secret: string) => (secret.length > 8 ? `…${secret.slice(-4)}` : '••••')
