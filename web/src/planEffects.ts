import { useAuth } from './auth/store'
import { isRunning, type Entitlement, type PlanInfo } from './plans'
import { freePlanOf, usePlans } from './plansStore'
import { setThemesUnlocked } from './settings'
import { useStore } from './store'

/**
 * What the person may do right now: the account's plan when logged in (and still running), else the Free plan, whose
 * numbers come from the server's list (so a guest sees the same limits as a free account) or the built-in ones.
 */
export function effectivePlan(
  status: 'loading' | 'anonymous' | 'authed' | 'guest',
  accountPlan: Entitlement,
  publicPlans: PlanInfo[],
): Entitlement {
  if (status === 'authed' && isRunning(accountPlan)) return accountPlan
  return { ...freePlanOf(publicPlans), expiresAt: null }
}

/** Reads both stores and tells the canvas (table limit) and the settings (premium themes) what the plan allows. */
export function applyPlan() {
  const plan = effectivePlan(useAuth.getState().status, useAuth.getState().plan, usePlans.getState().plans)
  const next = { max: plan.maxTablesPerDiagram, name: plan.name, free: plan.kind === 'free' }
  const now = useStore.getState().tablePlan
  if (now.max !== next.max || now.name !== next.name || now.free !== next.free) useStore.setState({ tablePlan: next })
  setThemesUnlocked(plan.features.themes)
}

let installed = false
/** Keeps the canvas and the settings in step with the plan from now on. Safe to call twice. */
export function installPlanEffects() {
  if (installed) return
  installed = true
  useAuth.subscribe(applyPlan)
  usePlans.subscribe(applyPlan)
  applyPlan()
}

