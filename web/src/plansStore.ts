import { create } from 'zustand'
import { api } from './auth/api'
import { FREE_FALLBACK, type PlanInfo } from './plans'

/** The plans on offer (public, so it works for visitors who are not logged in): the pricing page's data, and the Free plan's limits for guests. */
type PlansState = {
  plans: PlanInfo[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  load: (force?: boolean) => Promise<void>
}

export const usePlans = create<PlansState>()((set, get) => ({
  plans: [],
  status: 'idle',
  load: async (force = false) => {
    if (get().status === 'loading' || (get().status === 'ready' && !force)) return
    set({ status: get().plans.length ? 'ready' : 'loading' })
    try {
      const { plans } = await api<{ plans: PlanInfo[] }>('/plans')
      set({ plans, status: 'ready' })
    } catch {
      set({ status: get().plans.length ? 'ready' : 'error' })
    }
  },
}))

/** The Free plan from the server's list, or the built-in numbers while that has not arrived. */
export const freePlanOf = (plans: PlanInfo[]) => plans.find((p) => p.kind === 'free') ?? FREE_FALLBACK
