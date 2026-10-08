/** Plan vocabulary shared by the database code (plans.ts) and the input checks (schemas.ts); nothing here touches the database. */

/** The paid features a plan can include. The web app knows these names too (see web/src/plans.ts). */
export const FEATURE_KEYS = ['export', 'codeFormats', 'themes', 'localCopy', 'setup'] as const
export type FeatureKey = (typeof FEATURE_KEYS)[number]
export type PlanFeatures = Record<FeatureKey, boolean>

export const PLAN_KINDS = ['free', 'monthly', 'lifetime'] as const
export type PlanKind = (typeof PLAN_KINDS)[number]

/** No plan can go beyond these, whatever its row says: they protect the database. */
export const HARD_MAX_DIAGRAMS = 50
export const HARD_MAX_TABLES = 300
