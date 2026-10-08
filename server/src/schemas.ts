import { z } from 'zod'
import { FEATURE_KEYS, HARD_MAX_DIAGRAMS, HARD_MAX_TABLES } from './planTypes'

// ---- Accounts ----------------------------------------------------------------------------------
// Length is what matters for passwords (no composition rules); the upper bound stops huge-input abuse.
const password = z.string().min(8, 'Use at least 8 characters').max(128, 'Use at most 128 characters')
const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address'))

/** The 6-digit code from the email (see src/auth/codes.ts). */
const code = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email')

/** Creating an account needs the code sent to that address: no code, no account. */
export const signupSchema = z.object({
  email,
  password,
  code,
  name: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => v || undefined),
})

/** Ask for a code to be emailed (sign-up verification or password reset). */
export const emailOnlySchema = z.object({ email })

export const resetPasswordSchema = z.object({ email, code, password })

/** "Is this code right?", asked on its own page before the new password is chosen. */
export const verifyCodeSchema = z.object({ email, code })

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) })

// ---- Saved diagram -----------------------------------------------------------------------------
// Mirrors the frontend's model (src/core/model.ts). Strict enough that junk can't be stored, loose enough
// that new optional fields don't break old clients.
const action = z.enum(['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT'])

/** Hand-dragged shape of a relation line: how far its lane (x), its two horizontal runs (ys, yt) and, for curved lines, its middle (cy) were moved. */
const bend = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  ys: z.number().finite().optional(),
  yt: z.number().finite().optional(),
  cy: z.number().finite().optional(),
})

const column = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(128),
  type: z.string().max(200),
  primaryKey: z.boolean(),
  notNull: z.boolean(),
  unique: z.boolean(),
  default: z.string().max(500),
  references: z
    .object({
      tableId: z.string().max(100),
      columnId: z.string().max(100),
      onDelete: action.optional(),
      onUpdate: action.optional(),
      bend: bend.optional(),
    })
    .optional(),
})

const table = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(128),
  icon: z.string().max(60).optional(),
  color: z.string().max(20).optional(),
  columns: z.array(column).max(500),
})

export const diagramSchema = z.object({
  provider: z.enum(['postgresql', 'mysql', 'sqlite']),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
        data: table,
      }),
    )
    .max(HARD_MAX_TABLES),
  manyToMany: z
    .array(
      z.object({
        id: z.string().max(100),
        aTableId: z.string().max(100),
        bTableId: z.string().max(100),
        bend: bend.optional(),
      }),
    )
    .max(300),
})

export type DiagramPayload = z.infer<typeof diagramSchema>

// ---- Saved diagrams (a user can keep several) -------------------------------------------------------
export const MAX_DIAGRAMS_PER_USER = HARD_MAX_DIAGRAMS
const title = z.string().trim().min(1, 'Give the diagram a name').max(100, 'Use at most 100 characters')

/** POST /diagrams: both fields optional, so "New ERD" can create a blank one. */
export const createDiagramSchema = z.object({ title: title.optional(), data: diagramSchema.optional() })

/** PUT /diagrams/:id: rename, save the content, pin / unpin, or any of them in one request. */
export const updateDiagramSchema = z
  .object({ title: title.optional(), data: diagramSchema.optional(), pinned: z.boolean().optional() })
  .refine((v) => v.title !== undefined || v.data !== undefined || v.pinned !== undefined, {
    message: 'Nothing to update',
  })

/** What a brand-new diagram contains. */
export const BLANK_DIAGRAM: DiagramPayload = { provider: 'postgresql', nodes: [], manyToMany: [] }

/**
 * The look-and-feel settings kept on the account (the web app's Settings page). The allowed values mirror the lists
 * in web/src/settings.ts (a web test checks that they match). Any subset can be sent: the server merges it into
 * what is stored, so two devices changing different settings don't overwrite each other.
 */
export const preferencesSchema = z.object({
  theme: z.enum(['midnight', 'dracula', 'vercel', 'warm', 'eraser', 'violet']),
  tableFont: z.enum(['google-sans-code', 'jetbrains-mono']),
  tableWeight: z.union([z.literal(300), z.literal(400), z.literal(500)]),
  edgeStyle: z.enum(['orthogonal', 'curved']),
})

/** PUT /settings: one or more of the settings above, nothing else. */
export const updatePreferencesSchema = preferencesSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })

// ---- Buying a plan ----------------------------------------------------------------------------------

/** POST /orders: which plan, and (optionally) how to reach the buyer. */
export const createOrderSchema = z.object({
  planId: z.string().trim().min(1).max(40),
  contact: z.string().trim().max(120).optional(),
})

/** PUT /orders/:id: the buyer adds a payment reference and / or contact while the order is waiting. */
export const updateOrderSchema = z
  .object({ reference: z.string().trim().max(200).optional(), contact: z.string().trim().max(120).optional() })
  .refine((v) => v.reference !== undefined || v.contact !== undefined, { message: 'Nothing to update' })

// ---- The admin panel ---------------------------------------------------------------------------------

export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(200),
})

/** PUT /admin/plans/:id: any of the editable fields. The kind (free / monthly / lifetime) is fixed. */
export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the plan a name').max(40),
    description: z.string().trim().max(200),
    priceCents: z.number().int('The price must be a whole number of cents').min(0).max(100_000_000),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code, like USD or PKR'),
    maxDiagrams: z.number().int().min(1).max(HARD_MAX_DIAGRAMS, `At most ${HARD_MAX_DIAGRAMS}`),
    maxTablesPerDiagram: z.number().int().min(1).max(HARD_MAX_TABLES, `At most ${HARD_MAX_TABLES}`),
    features: z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean()]))).partial(),
    highlights: z.array(z.string().trim().min(1).max(120)).max(12),
    active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })

/** PUT /admin/users/:id/plan: put an account on a plan by hand. A monthly plan needs an end date (default: a month from now). */
export const setUserPlanSchema = z.object({
  planId: z.string().trim().min(1).max(40),
  expiresAt: z.iso.datetime().nullable().optional(),
})

export const adminOrderNoteSchema = z.object({ adminNote: z.string().trim().max(1000) })

export const adminSettingsSchema = z.object({ paymentInstructions: z.string().max(4000) })
