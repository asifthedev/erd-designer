import { config } from './config'
import { MAX_DIAGRAMS_PER_USER } from './schemas'

/** What an account's plan allows. */
export type Plan = { name: 'free'; maxDiagrams: number }

/**
 * The plan of an account. There is only the Free plan today, so every account gets it; this is the one place to
 * change when paid plans exist (read the plan off the user, and return its own limits).
 */
export function planOf(_user: { id: string }): Plan {
  return { name: 'free', maxDiagrams: Math.min(config.FREE_PLAN_MAX_DIAGRAMS, MAX_DIAGRAMS_PER_USER) }
}

/** The message shown when an account is at its plan's diagram limit. */
export function planLimitMessage(plan: Plan): string {
  const what = plan.maxDiagrams === 1 ? 'one diagram' : `${plan.maxDiagrams} diagrams`
  return `You can only create ${what} on the Free plan. Please upgrade your plan.`
}
