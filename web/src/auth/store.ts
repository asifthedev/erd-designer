import { toast } from 'sonner'
import { showProblem } from '../components/problemToast'
import { planLimitProblem, tableLimitProblem } from '../core/problems'
import { onBeforeLeave } from '../lib/route'
import { FREE_FALLBACK, type Entitlement } from '../plans'
import { create } from 'zustand'
import type { Provider } from '../core/model'
import { toWorkspace, useStore, type Workspace } from '../store'
import { api, ApiError } from './api'

export type AuthUser = { id: string; email: string; name: string | null }
/** loading: asking the server; anonymous: show the sign-in screen; guest: working locally without an account. */
export type AuthStatus = 'loading' | 'anonymous' | 'authed' | 'guest'
export type SaveState = 'idle' | 'saving' | 'saved' | 'error'
/** One saved ERD as the sidebar lists it (the content is only fetched when it is opened). */
export type DiagramMeta = {
  id: string
  title: string
  updatedAt: string
  /** Shown in the sidebar's "Pinned" part. */
  pinned?: boolean
  /** How many tables it has and which database it targets, for the sidebar (the server reads them from the content). */
  tableCount?: number
  provider?: Provider
}

const DEFAULT_TITLE = 'Untitled diagram'
/** What the server round trip is for, so the UI can say so (a spinner on the row / button, a note over the canvas). */
export type Loading = {
  kind: 'open' | 'create' | 'delete'
  id?: string
  /** Only the row shows progress, not the canvas (opening an ERD already loaded this session, after a save). */
  quiet?: boolean
}
const BLANK: Workspace = { provider: 'postgresql', nodes: [], manyToMany: [] }

type AuthState = {
  status: AuthStatus
  user: AuthUser | null
  /** The open ERD's content has been loaded, so autosave may start (it must not overwrite it with a sample). */
  ready: boolean
  save: SaveState
  savedAt: number | null
  /** The account's plan: its limits (diagrams, tables per diagram) and which paid features it includes. */
  plan: Entitlement
  /** The account's ERDs (oldest first) and which one is on the canvas. */
  diagrams: DiagramMeta[]
  currentId: string | null
  /** An ERD is being opened / created / deleted: further switches are ignored until it finishes. */
  switching: boolean
  /** The same moment, with detail for the loading indicators (null when idle). */
  loading: Loading | null

  init: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  /** Emails a 6-digit code to the address. Resolves to how many seconds until another code may be requested. */
  requestSignupCode: (email: string) => Promise<number>
  /** Finishes sign-up: the account is only created when the code from that email is right. */
  signup: (input: { name: string; email: string; password: string; code: string }) => Promise<void>
  /** Forgot password: emails a reset code if the address has an account (the answer never says). */
  requestResetCode: (email: string) => Promise<number>
  /** Checks the emailed reset code on its own (it throws when wrong), before the new password is asked for. */
  verifyResetCode: (input: { email: string; code: string }) => Promise<void>
  /** Chooses a new password with the emailed code. Everyone is logged out; the person logs in afterwards. */
  resetPassword: (input: { email: string; code: string; password: string }) => Promise<void>
  logout: () => Promise<void>
  continueAsGuest: () => void
  /** Back to the sign-in screen from guest mode (local work is kept). */
  showSignIn: () => void
  saveNow: (options?: { keepalive?: boolean }) => Promise<void>

  openDiagram: (id: string) => Promise<void>
  /** Creates a blank ERD and opens it. Resolves to its id, or null when it could not be created. */
  createDiagram: () => Promise<string | null>
  renameDiagram: (id: string, title: string) => Promise<void>
  /** Asks the server for the account's plan again (after a purchase was confirmed, or a plan ran out). */
  refreshPlan: () => Promise<void>
  /** Pins or unpins an ERD in the sidebar (shown at once, rolled back if the server refuses). */
  setPinned: (id: string, pinned: boolean) => Promise<void>
  deleteDiagram: (id: string) => Promise<void>
}

/** JSON of the canvas as last sent to / received from the server, to skip saves when nothing changed. */
let lastSaved = ''

/**
 * ERDs already loaded in this page session, so going back to one is instant: no request, no loading indicator.
 * In memory only (gone on reload), and cleared on logout. `updatedAt` is the server's timestamp for that content,
 * used to notice when another device saved a newer version.
 */
type CachedDiagram = { data: Workspace; updatedAt: string }
const sessionCache = new Map<string, CachedDiagram>()
const snapshot = () => JSON.stringify(toWorkspace(useStore.getState()))

/** init() runs once per page load, even if the component that calls it mounts twice (React StrictMode in dev). */
let initPromise: Promise<void> | undefined

const byRecent = (a: DiagramMeta, b: DiagramMeta) => b.updatedAt.localeCompare(a.updatedAt)

export const useAuth = create<AuthState>()((set, get) => {
  /** Shows a failure; an expired session sends the person back to the sign-in screen instead. */
  function fail(e: unknown, title: string, id?: string) {
    if (e instanceof ApiError && e.status === 401) {
      set({ status: 'anonymous', user: null, ready: false, save: 'idle', switching: false, loading: null })
      toast.error('Your session has expired', {
        description: 'Log in again to keep saving.',
        closeButton: true,
        duration: Infinity,
      })
      return
    }
    if (e instanceof ApiError && (e.code === 'plan_limit' || e.code === 'plan_limit_tables')) {
      const { plan } = get()
      const named = { name: plan.name, free: plan.kind === 'free' }
      showProblem(
        e.code === 'plan_limit' ? planLimitProblem(plan.maxDiagrams, named) : tableLimitProblem(plan.maxTablesPerDiagram, named),
        'warning',
      )
      return
    }
    toast.error(title, { id, description: (e as Error).message, closeButton: true, duration: Infinity })
  }

  /** Puts one ERD's saved content on the canvas and marks it as the open one. */
  async function loadInto(id: string) {
    const { diagram } = await api<{ diagram: { data: Workspace; updatedAt: string } }>(`/diagrams/${id}`)
    sessionCache.set(id, { data: diagram.data, updatedAt: diagram.updatedAt })
    useStore.getState().loadWorkspace(diagram.data)
    lastSaved = snapshot()
    set({ currentId: id, ready: true, save: 'idle' })
  }

  /** Puts an already-loaded ERD on the canvas straight away, then quietly checks the server for a newer version. */
  function showCached(id: string, entry: CachedDiagram) {
    useStore.getState().loadWorkspace(entry.data)
    lastSaved = snapshot()
    set({ currentId: id, ready: true, save: 'idle' })
    void revalidate(id)
  }

  /**
   * Another device may have saved this ERD since we cached it. If the server has something newer and nothing has
   * been edited here in the meantime, take it; if the person already started editing, leave their work alone.
   */
  async function revalidate(id: string) {
    try {
      const { diagram } = await api<{ diagram: { data: Workspace; updatedAt: string } }>(`/diagrams/${id}`)
      const cached = sessionCache.get(id)
      if (!cached || diagram.updatedAt <= cached.updatedAt) return
      sessionCache.set(id, { data: diagram.data, updatedAt: diagram.updatedAt })
      if (get().currentId !== id || snapshot() !== lastSaved) return
      useStore.getState().loadWorkspace(diagram.data)
      lastSaved = snapshot()
    } catch {
      /* offline or expired: the cached copy stays, and the next save reports any real problem */
    }
  }

  /** Flushes unsaved edits of the open ERD. False when that failed (so a switch must not throw them away). */
  async function flush() {
    await get().saveNow()
    if (get().save === 'error') {
      toast.error('Your latest changes are not saved yet', {
        id: 'switch-blocked',
        description: 'Fix the saving problem first, or the changes would be lost.',
        closeButton: true,
      })
      return false
    }
    return get().status === 'authed'
  }

  /** Signed in: open the most recently edited ERD, or turn what is on the canvas into the first one. */
  async function enter(user: AuthUser) {
    sessionCache.clear() // never carry one account's diagrams over to the next
    set({
      status: 'authed',
      user,
      ready: false,
      save: 'idle',
      diagrams: [],
      currentId: null,
      switching: false,
      loading: null,
    })
    try {
      const { diagrams, plan } = await api<{ diagrams: DiagramMeta[]; plan?: Entitlement }>('/diagrams')
      if (plan) set({ plan })
      if (!diagrams.length) {
        const { diagram } = await api<{ diagram: DiagramMeta }>('/diagrams', {
          body: { title: 'My first ERD', data: JSON.parse(snapshot()) },
        })
        lastSaved = snapshot()
        sessionCache.set(diagram.id, { data: JSON.parse(lastSaved), updatedAt: diagram.updatedAt })
        set({ diagrams: [diagram], currentId: diagram.id, ready: true })
        return
      }
      set({ diagrams })
      await loadInto([...diagrams].sort(byRecent)[0].id)
    } catch (e) {
      set({ ready: true, save: 'error' })
      toast.error('Could not load your saved work', {
        description: (e as Error).message,
        closeButton: true,
        duration: Infinity,
      })
    }
  }

  return {
    status: 'loading',
    user: null,
    ready: false,
    save: 'idle',
    savedAt: null,
    plan: FREE_FALLBACK,
    diagrams: [],
    currentId: null,
    switching: false,
    loading: null,

    init: () =>
      (initPromise ??= (async () => {
        try {
          const { user } = await api<{ user: AuthUser | null }>('/auth/me')
          if (user) await enter(user)
          else set({ status: 'anonymous' })
        } catch {
          // API unreachable: still let the person use the editor locally.
          set({ status: 'anonymous' })
        }
      })()),

    login: async (email, password) => {
      const { user } = await api<{ user: AuthUser }>('/auth/login', { body: { email, password } })
      await enter(user)
    },

    requestSignupCode: async (email) => {
      const { cooldownSeconds } = await api<{ cooldownSeconds: number }>('/auth/signup/code', { body: { email } })
      return cooldownSeconds
    },

    requestResetCode: async (email) => {
      const { cooldownSeconds } = await api<{ cooldownSeconds: number }>('/auth/password/forgot', { body: { email } })
      return cooldownSeconds
    },

    verifyResetCode: async (input) => {
      await api('/auth/password/verify', { body: input })
    },

    resetPassword: async (input) => {
      await api('/auth/password/reset', { body: input })
    },

    signup: async (input) => {
      const { user } = await api<{ user: AuthUser }>('/auth/signup', { body: input })
      await enter(user)
    },

    logout: async () => {
      await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {})
      // Don't leave the account's diagram sitting in the browser for the next person.
      useStore.getState().loadSample()
      useStore.getState().setProvider('postgresql')
      lastSaved = ''
      sessionCache.clear()
      set({
        status: 'anonymous',
        user: null,
        ready: false,
        save: 'idle',
        savedAt: null,
        diagrams: [],
        currentId: null,
        switching: false,
        loading: null,
      })
    },

    continueAsGuest: () => set({ status: 'guest' }),
    showSignIn: () => set({ status: 'anonymous' }),

    saveNow: async (options) => {
      const { status, ready, currentId } = get()
      if (status !== 'authed' || !ready || !currentId) return
      const body = snapshot()
      if (body === lastSaved) return
      set({ save: 'saving' })
      try {
        const saved = await api<{ updatedAt: string; tableCount?: number; provider?: Provider }>(
          `/diagrams/${currentId}`,
          {
            method: 'PUT',
            body: { data: JSON.parse(body) },
            keepalive: options?.keepalive,
          },
        )
        const { updatedAt, tableCount, provider } = saved
        lastSaved = body
        sessionCache.set(currentId, { data: JSON.parse(body), updatedAt })
        set((s) => ({
          save: 'saved',
          savedAt: Date.now(),
          diagrams: s.diagrams.map((d) => (d.id === currentId ? { ...d, updatedAt, tableCount, provider } : d)),
        }))
      } catch (e) {
        set({ save: 'error' })
        fail(e, 'Could not save your work', 'save-failed')
      }
    },

    openDiagram: async (id) => {
      if (get().switching || id === get().currentId) return
      const cached = sessionCache.get(id)
      const unsaved = get().ready && snapshot() !== lastSaved

      // Seen already this session and nothing waiting to be saved: switch at once, with no spinner at all.
      if (cached && !unsaved) {
        showCached(id, cached)
        return
      }

      // Otherwise save first. A cached ERD only needs that wait (so the row spins, not the canvas); a new one loads.
      set({ switching: true, loading: cached ? { kind: 'open', id, quiet: true } : { kind: 'open', id } })
      try {
        if (!(await flush())) return
        if (cached) {
          showCached(id, cached)
          return
        }
        set({ ready: false }) // the canvas is about to show another ERD: nothing may be saved onto the wrong one
        try {
          await loadInto(id)
        } catch (e) {
          set({ ready: true })
          fail(e, 'Could not open that diagram')
        }
      } finally {
        set({ switching: false, loading: null })
      }
    },

    createDiagram: async () => {
      if (get().switching) return null
      // Over the plan's limit: say so at once instead of asking the server (which would refuse too).
      if (get().diagrams.length >= get().plan.maxDiagrams) {
        const { plan } = get()
        showProblem(planLimitProblem(plan.maxDiagrams, { name: plan.name, free: plan.kind === 'free' }), 'warning')
        return null
      }
      set({ switching: true, loading: { kind: 'create' } })
      try {
        if (!(await flush())) return null
        const { diagram } = await api<{ diagram: DiagramMeta }>('/diagrams', {
          body: { title: DEFAULT_TITLE, data: BLANK },
        })
        useStore.getState().loadWorkspace(BLANK)
        lastSaved = snapshot()
        sessionCache.set(diagram.id, { data: BLANK, updatedAt: diagram.updatedAt })
        set((s) => ({ diagrams: [...s.diagrams, diagram], currentId: diagram.id, ready: true, save: 'idle' }))
        return diagram.id
      } catch (e) {
        fail(e, 'Could not create the diagram')
        return null
      } finally {
        set({ switching: false, loading: null })
      }
    },

    refreshPlan: async () => {
      if (get().status !== 'authed') return
      try {
        const { plan } = await api<{ plan: Entitlement }>('/plans/mine')
        set({ plan })
      } catch {
        /* keep showing the plan we have */
      }
    },

    renameDiagram: async (id, title) => {
      const next = title.trim().slice(0, 100)
      const before = get().diagrams.find((d) => d.id === id)
      if (!before || !next || next === before.title) return
      const setTitle = (t: string) =>
        set((s) => ({ diagrams: s.diagrams.map((d) => (d.id === id ? { ...d, title: t } : d)) }))
      setTitle(next) // optimistic: the list updates at once and rolls back if the server says no
      try {
        const { updatedAt } = await api<{ updatedAt: string }>(`/diagrams/${id}`, {
          method: 'PUT',
          body: { title: next },
        })
        set((s) => ({ diagrams: s.diagrams.map((d) => (d.id === id ? { ...d, updatedAt } : d)) }))
      } catch (e) {
        setTitle(before.title)
        fail(e, 'Could not rename the diagram')
      }
    },

    setPinned: async (id, pinned) => {
      const before = get().diagrams.find((d) => d.id === id)
      if (!before || !!before.pinned === pinned) return
      const mark = (value: boolean) =>
        set((s) => ({ diagrams: s.diagrams.map((d) => (d.id === id ? { ...d, pinned: value } : d)) }))
      mark(pinned) // shown at once; the server only has to agree
      try {
        await api(`/diagrams/${id}`, { method: 'PUT', body: { pinned } })
      } catch (e) {
        mark(!!before.pinned)
        fail(e, pinned ? 'Could not pin the diagram' : 'Could not unpin the diagram')
      }
    },

    deleteDiagram: async (id) => {
      if (get().switching) return
      set({ switching: true, loading: { kind: 'delete', id } })
      try {
        const wasOpen = id === get().currentId
        if (wasOpen) set({ ready: false }) // its pending edits are going away with it
        try {
          await api(`/diagrams/${id}`, { method: 'DELETE' })
        } catch (e) {
          if (wasOpen) set({ ready: true })
          fail(e, 'Could not delete the diagram')
          return
        }
        sessionCache.delete(id)
        const remaining = get().diagrams.filter((d) => d.id !== id)
        set({ diagrams: remaining })
        if (!wasOpen) return

        // The open one was deleted: show the most recently edited of the rest, or start a fresh blank one.
        try {
          if (remaining.length) {
            await loadInto([...remaining].sort(byRecent)[0].id)
          } else {
            const { diagram } = await api<{ diagram: DiagramMeta }>('/diagrams', {
              body: { title: DEFAULT_TITLE, data: BLANK },
            })
            useStore.getState().loadWorkspace(BLANK)
            lastSaved = snapshot()
            sessionCache.set(diagram.id, { data: BLANK, updatedAt: diagram.updatedAt })
            set({ diagrams: [diagram], currentId: diagram.id, ready: true, save: 'idle' })
          }
        } catch (e) {
          set({ currentId: null })
          fail(e, 'Could not open another diagram')
        }
      } finally {
        set({ switching: false, loading: null })
      }
    },
  }
})

// Leaving the editor (for the pricing or settings page) must not lose what was just typed.
onBeforeLeave(() => void useAuth.getState().saveNow())
