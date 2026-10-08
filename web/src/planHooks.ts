import { useMemo } from 'react'
import { useAuth } from './auth/store'
import { effectivePlan } from './planEffects'
import type { Entitlement, FeatureKey } from './plans'
import { usePlans } from './plansStore'

/** The plan in force right now (see effectivePlan), for components. */
export function useEffectivePlan(): Entitlement {
  const status = useAuth((s) => s.status)
  const account = useAuth((s) => s.plan)
  const plans = usePlans((s) => s.plans)
  return useMemo(() => effectivePlan(status, account, plans), [status, account, plans])
}

/** True when the current plan includes the paid feature. */
export const useFeature = (key: FeatureKey): boolean => useEffectivePlan().features[key]
