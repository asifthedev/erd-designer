import { z } from 'zod'

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

/** Hand-dragged shape of a relation line: offset of its middle from the default route. */
const bend = z.object({ x: z.number().finite(), y: z.number().finite() })

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
    .max(300),
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
export const MAX_DIAGRAMS_PER_USER = 50
const title = z.string().trim().min(1, 'Give the diagram a name').max(100, 'Use at most 100 characters')

/** POST /diagrams: both fields optional, so "New ERD" can create a blank one. */
export const createDiagramSchema = z.object({ title: title.optional(), data: diagramSchema.optional() })

/** PUT /diagrams/:id: rename, save the content, or both in one request. */
export const updateDiagramSchema = z
  .object({ title: title.optional(), data: diagramSchema.optional() })
  .refine((v) => v.title !== undefined || v.data !== undefined, { message: 'Nothing to update' })

/** What a brand-new diagram contains. */
export const BLANK_DIAGRAM: DiagramPayload = { provider: 'postgresql', nodes: [], manyToMany: [] }
