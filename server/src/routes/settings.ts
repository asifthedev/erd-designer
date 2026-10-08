import express, { Router } from 'express'
import { prisma } from '../db'
import { requireAuth } from '../middleware/auth'
import { preferencesSchema, updatePreferencesSchema } from '../schemas'
import { saveLimiter } from '../security/limiters'

export const settingsRouter = Router()

// Authenticate BEFORE reading the body, like the other routers.
settingsRouter.use(requireAuth)

type Row = { preferences: unknown; updatedAt: Date | null }

/**
 * What is stored, keeping only the settings and values this version still knows. A row written by another version
 * may hold something that has since been removed; one such value must not hide the others.
 */
function knownSettings(stored: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!stored || typeof stored !== 'object') return out
  for (const [key, rule] of Object.entries(preferencesSchema.shape)) {
    const parsed = rule.safeParse((stored as Record<string, unknown>)[key])
    if (parsed.success) out[key] = parsed.data
  }
  return out
}

const reply = (row: Row) => ({
  // null (not {}) before anything was ever saved, so a new device can tell "no settings yet" from "all defaults".
  settings: row.preferences == null ? null : knownSettings(row.preferences),
  updatedAt: row.updatedAt,
})

settingsRouter.get('/', async (req, res) => {
  const row = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { preferences: true, preferencesUpdatedAt: true },
  })
  res.json(reply({ preferences: row?.preferences, updatedAt: row?.preferencesUpdatedAt ?? null }))
})

settingsRouter.put('/', saveLimiter, express.json({ limit: '4kb' }), async (req, res) => {
  const patch = updatePreferencesSchema.parse(req.body)
  // One atomic statement: merge the patch into the stored object, so two devices saving at once don't undo each other.
  const rows = await prisma.$queryRaw<{ preferences: unknown; updatedAt: Date }[]>`
    UPDATE erd_users
    SET preferences = COALESCE(preferences, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
        preferences_updated_at = now()
    WHERE id = ${req.user!.id}
    RETURNING preferences, preferences_updated_at AS "updatedAt"`
  res.json(reply(rows[0] ?? { preferences: patch, updatedAt: null }))
})
