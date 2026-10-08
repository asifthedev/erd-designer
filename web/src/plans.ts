/**
 * Plans on the web side: the shapes the server sends, how a price is written, and the rows of the comparison table.
 * Nothing here talks to the server or to React, so it can be tested on its own. (The server's side is
 * server/src/plans.ts; the paid features are named the same on both.)
 */

/** The paid features a plan can include. */
export const FEATURE_KEYS = ['export', 'codeFormats', 'themes', 'localCopy', 'setup'] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]
export type PlanFeatures = Record<FeatureKey, boolean>
export type PlanKind = 'free' | 'monthly' | 'lifetime'

export type PlanInfo = {
  id: string
  name: string
  kind: PlanKind
  description: string
  /** In the smallest unit of `currency` (cents), so there is no floating point money. */
  priceCents: number
  currency: string
  maxDiagrams: number
  maxTablesPerDiagram: number
  features: PlanFeatures
  /** The bullet lines for the pricing page. */
  highlights: string[]
  sortOrder: number
}

/** What an account has right now: its plan, and when a monthly plan ends. */
export type Entitlement = PlanInfo & { expiresAt: string | null }

const NO_FEATURES: PlanFeatures = { export: false, codeFormats: false, themes: false, localCopy: false, setup: false }

/**
 * The Free plan as the app assumes it until the server says otherwise (a visitor who is not logged in, or the server
 * not answering). The same numbers the server starts with; the real ones come from the database.
 */
export const FREE_FALLBACK: Entitlement = {
  id: 'free',
  name: 'Free',
  kind: 'free',
  description: '',
  priceCents: 0,
  currency: 'USD',
  maxDiagrams: 1,
  maxTablesPerDiagram: 25,
  features: NO_FEATURES,
  highlights: [],
  sortOrder: 0,
  expiresAt: null,
}

/** Names for the features, as the pricing table and the admin panel show them. */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  export: 'Export as PNG, SVG and PDF',
  codeFormats: 'Drizzle and SQL code',
  themes: 'All themes and table colours',
  localCopy: 'Run it on your own computer',
  setup: 'We set it up and run it for you',
}

/** `900, 'USD'` -> `$9`; `1299, 'USD'` -> `$12.99`; `50000, 'PKR'` -> `PKR 500`. Never throws on a code it does not know. */
export function formatPrice(cents: number, currency: string): string {
  const amount = cents / 100
  const digits = Number.isInteger(amount) ? 0 : 2
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount)
  } catch {
    return `${currency} ${amount.toFixed(digits)}`
  }
}

/** The big price on a plan card, and the small words after it. */
export function priceParts(plan: Pick<PlanInfo, 'kind' | 'priceCents' | 'currency'>): { amount: string; period: string } {
  if (plan.kind === 'free' || plan.priceCents === 0) return { amount: 'Free', period: plan.kind === 'free' ? 'for ever' : '' }
  return {
    amount: formatPrice(plan.priceCents, plan.currency),
    period: plan.kind === 'monthly' ? 'per month' : 'one-time payment',
  }
}

/** A short date for "your plan runs until ...". */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** True when a monthly plan's end date is still ahead (a lifetime or free plan has none and is always "running"). */
export const isRunning = (e: Pick<Entitlement, 'kind' | 'expiresAt'>, now = Date.now()) =>
  e.kind !== 'monthly' || (e.expiresAt !== null && new Date(e.expiresAt).getTime() > now)

export type ComparisonRow = {
  label: string
  /** One entry per plan: text (a number, "Unlimited") or yes / no. */
  cells: (string | boolean)[]
  /** A small second line for a cell, e.g. what applies online when the plan includes your own copy. */
  notes?: (string | undefined)[]
}

/**
 * The feature table under the plan cards: one column per plan, so the differences can be read across. Numbers come from
 * the plans, so the table changes when the admin changes a limit. A plan that includes your own copy has no limits
 * there; the numbers it has for its online account go in a small note.
 */
export function comparisonRows(plans: PlanInfo[]): ComparisonRow[] {
  const own = (p: PlanInfo) => p.features.localCopy
  const limit = (pick: (p: PlanInfo) => number): Pick<ComparisonRow, 'cells' | 'notes'> => ({
    cells: plans.map((p) => (own(p) ? 'Unlimited' : String(pick(p)))),
    notes: plans.map((p) => (own(p) ? `${pick(p)} in your online account` : undefined)),
  })
  return [
    { label: 'Diagrams', ...limit((p) => p.maxDiagrams) },
    { label: 'Tables in each diagram', ...limit((p) => p.maxTablesPerDiagram) },
    { label: 'Prisma schema code', cells: plans.map(() => true) },
    { label: FEATURE_LABELS.codeFormats, cells: plans.map((p) => p.features.codeFormats) },
    { label: FEATURE_LABELS.export, cells: plans.map((p) => p.features.export) },
    { label: FEATURE_LABELS.themes, cells: plans.map((p) => p.features.themes) },
    { label: FEATURE_LABELS.localCopy, cells: plans.map((p) => p.features.localCopy) },
    { label: FEATURE_LABELS.setup, cells: plans.map((p) => p.features.setup) },
  ]
}

/** The themes that need the `themes` feature; Midnight and Dracula are free. */
export const PREMIUM_THEMES = ['vercel', 'warm', 'eraser', 'violet'] as const
export const isPremiumTheme = (id: string) => (PREMIUM_THEMES as readonly string[]).includes(id)
