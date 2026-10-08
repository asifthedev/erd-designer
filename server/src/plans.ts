import { prisma } from './db'
import {
  FEATURE_KEYS,
  HARD_MAX_DIAGRAMS,
  HARD_MAX_TABLES,
  PLAN_KINDS,
  type PlanFeatures,
  type PlanKind,
} from './planTypes'

/**
 * Plans: what an account may do. The rows live in the database (so the admin can change prices, limits and features
 * without a deploy); this file turns them into what the rest of the server and the web app use.
 */

export { FEATURE_KEYS, PLAN_KINDS, type FeatureKey, type PlanFeatures, type PlanKind } from './planTypes'

/** A plan as sent to the web app (public: prices and what is included, nothing private). */
export type PlanInfo = {
  id: string
  name: string
  kind: PlanKind
  description: string
  priceCents: number
  currency: string
  maxDiagrams: number
  maxTablesPerDiagram: number
  features: PlanFeatures
  highlights: string[]
  sortOrder: number
}

type PlanRow = NonNullable<Awaited<ReturnType<typeof prisma.plan.findUnique>>>

/** The id of the plan every new account starts on. */
export const FREE_PLAN_ID = 'free'

/** A plan row as PlanInfo: the JSON columns are checked and filled in, so a hand-edited row cannot break the app. */
export function toPlanInfo(row: PlanRow): PlanInfo {
  const stored = (row.features && typeof row.features === 'object' ? row.features : {}) as Record<string, unknown>
  const features = Object.fromEntries(FEATURE_KEYS.map((k) => [k, stored[k] === true])) as PlanFeatures
  const lines = Array.isArray(row.highlights) ? row.highlights.filter((l): l is string => typeof l === 'string') : []
  return {
    id: row.id,
    name: row.name,
    kind: (PLAN_KINDS as readonly string[]).includes(row.kind) ? (row.kind as PlanKind) : 'free',
    description: row.description,
    priceCents: row.priceCents,
    currency: row.currency,
    // Whatever the row says, no plan goes past the limits that protect the database.
    maxDiagrams: Math.min(row.maxDiagrams, HARD_MAX_DIAGRAMS),
    maxTablesPerDiagram: Math.min(row.maxTablesPerDiagram, HARD_MAX_TABLES),
    features,
    highlights: lines,
    sortOrder: row.sortOrder,
  }
}

/** The plans people can choose from, in display order. */
export async function listActivePlans(): Promise<PlanInfo[]> {
  const rows = await prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } })
  return rows.map(toPlanInfo)
}

/** What an account is entitled to right now. */
export type Entitlement = PlanInfo & {
  /** When a monthly plan ends (null: never, i.e. free and lifetime). */
  expiresAt: Date | null
}

/**
 * The plan an account is on right now. A monthly plan that has run out counts as the free plan, so a lapsed
 * subscription never keeps its extra limits (the account's diagrams stay; it just can't add beyond the free limits).
 */
export async function entitlementOf(userId: string): Promise<Entitlement> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { planExpiresAt: true, plan: true },
  })
  const free = async () => {
    const row = await prisma.plan.findUniqueOrThrow({ where: { id: FREE_PLAN_ID } })
    return { ...toPlanInfo(row), expiresAt: null }
  }
  if (!user) return free()
  const lapsed = user.plan.kind === 'monthly' && (!user.planExpiresAt || user.planExpiresAt <= new Date())
  if (lapsed) return free()
  return { ...toPlanInfo(user.plan), expiresAt: user.planExpiresAt }
}

// ---- What is said when a limit is reached -----------------------------------------------------------

const count = (n: number, noun: string) => `${n === 1 ? 'one' : n} ${noun}${n === 1 ? '' : 's'}`

export function diagramLimitMessage(plan: PlanInfo): string {
  return plan.kind === 'free'
    ? `You can only create ${count(plan.maxDiagrams, 'diagram')} on the Free plan. Please upgrade your plan.`
    : `Your ${plan.name} plan includes ${count(plan.maxDiagrams, 'diagram')}. Delete one to add another.`
}

export function tableLimitMessage(plan: PlanInfo): string {
  return plan.kind === 'free'
    ? `The Free plan allows up to ${plan.maxTablesPerDiagram} tables in a diagram. Please upgrade your plan to add more.`
    : `Your ${plan.name} plan allows up to ${plan.maxTablesPerDiagram} tables in a diagram.`
}
