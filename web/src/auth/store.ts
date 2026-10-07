import { toast } from 'sonner'
import { create } from 'zustand'
import { toWorkspace, useStore, type Workspace } from '../store'
import { api, ApiError } from './api'

export type AuthUser = { id: string; email: string; name: string | null }
/** loading: asking the server; anonymous: show the sign-in screen; guest: working locally without an account. */
export type AuthStatus = 'loading' | 'anonymous' | 'authed' | 'guest'
export type SaveState = 'idle' | 'saving' | 'saved' | 'error'
/** One saved ERD as the sidebar lists it (the content is only fetched when it is opened). */
export type DiagramMeta = { id: string; title: string; updatedAt: string }

/** The server refuses more than this per account (keep in sync with MAX_DIAGRAMS_PER_USER there). */
export const MAX_DIAGRAMS = 50
const DEFAULT_TITLE = 'Untitled diagram'
const BLANK: Workspace = { provider: 'postgresql', nodes: [], manyToMany: [] }

type AuthState = {
  status: AuthStatus
  user: AuthUser | null
  /** The open ERD's content has been loaded, so autosave may start (it must not overwrite it with a sample). */
  ready: boolean
  save: SaveState
  savedAt: number | null
  /** The account's ERDs (oldest first) and which one is on the canvas. */
  diagrams: DiagramMeta[]
  currentId: string | null
  /** An ERD is being opened / created / deleted: further switches are ignored until it finishes. */
  switching: boolean

  init: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  signup: (input: { name: string; email: string; password: string }) => Promise<void>
  logout: () => Promise<void>
  continueAsGuest: () => void
  /** Back to the sign-in screen from guest mode (local work is kept). */
  showSignIn: () => void
  saveNow: (options?: { keepalive?: boolean }) => Promise<void>

  openDiagram: (id: string) => Promise<void>
  /** Creates a blank ERD and opens it. Resolves to its id, or null when it could not be created. */
  createDiagram: () => Promise<string | null>
  renameDiagram: (id: string, title: string) => Promise<void>
  deleteDiagram: (id: string) => Promise<void>
}

/** JSON of the canvas as last sent to / received from the server, to skip saves when nothing changed. */
let lastSaved = ''
const snapshot = () => JSON.stringify(toWorkspace(useStore.getState()))

const byRecent = (a: DiagramMeta, b: DiagramMeta) => b.updatedAt.localeCompare(a.updatedAt)

export const useAuth = create<AuthState>()((set, get) => {
  /** Shows a failure; an expired session sends the person back to the sign-in screen instead. */
  function fail(e: unknown, title: string, id?: string) {
    if (e instanceof ApiError && e.status === 401) {
      set({ status: 'anonymous', user: null, ready: false, save: 'idle', switching: false })
      toast.error('Your session has expired', {
        description: 'Log in again to keep saving.',
        closeButton: true,
        duration: Infinity,
      })
      return
    }
    toast.error(title, { id, description: (e as Error).message, closeButton: true, duration: Infinity })
  }

  /** Puts one ERD's saved content on the canvas and marks it as the open one. */
  async function loadInto(id: string) {
    const { diagram } = await api<{ diagram: { data: Workspace } }>(`/diagrams/${id}`)
    useStore.getState().loadWorkspace(diagram.data)
    lastSaved = snapshot()
    set({ currentId: id, ready: true, save: 'idle' })
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
    set({ status: 'authed', user, ready: false, save: 'idle', diagrams: [], currentId: null, switching: false })
    try {
      const { diagrams } = await api<{ diagrams: DiagramMeta[] }>('/diagrams')
      if (!diagrams.length) {
        const { diagram } = await api<{ diagram: DiagramMeta }>('/diagrams', {
          body: { title: 'My first ERD', data: JSON.parse(snapshot()) },
        })
        lastSaved = snapshot()
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
    diagrams: [],
    currentId: null,
    switching: false,

    init: async () => {
      try {
        const { user } = await api<{ user: AuthUser | null }>('/auth/me')
        if (user) await enter(user)
        else set({ status: 'anonymous' })
      } catch {
        // API unreachable: still let the person use the editor locally.
        set({ status: 'anonymous' })
      }
    },

    login: async (email, password) => {
      const { user } = await api<{ user: AuthUser }>('/auth/login', { body: { email, password } })
      await enter(user)
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
      set({
        status: 'anonymous',
        user: null,
        ready: false,
        save: 'idle',
        savedAt: null,
        diagrams: [],
        currentId: null,
        switching: false,
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
        const { updatedAt } = await api<{ updatedAt: string }>(`/diagrams/${currentId}`, {
          method: 'PUT',
          body: { data: JSON.parse(body) },
          keepalive: options?.keepalive,
        })
        lastSaved = body
        set((s) => ({
          save: 'saved',
          savedAt: Date.now(),
          diagrams: s.diagrams.map((d) => (d.id === currentId ? { ...d, updatedAt } : d)),
        }))
      } catch (e) {
        set({ save: 'error' })
        fail(e, 'Could not save your work', 'save-failed')
      }
    },

    openDiagram: async (id) => {
      if (get().switching || id === get().currentId) return
      set({ switching: true })
      try {
        if (!(await flush())) return
        set({ ready: false }) // the canvas is about to show another ERD: nothing may be saved onto the wrong one
        try {
          await loadInto(id)
        } catch (e) {
          set({ ready: true })
          fail(e, 'Could not open that diagram')
        }
      } finally {
        set({ switching: false })
      }
    },

    createDiagram: async () => {
      if (get().switching) return null
      set({ switching: true })
      try {
        if (!(await flush())) return null
        const { diagram } = await api<{ diagram: DiagramMeta }>('/diagrams', {
          body: { title: DEFAULT_TITLE, data: BLANK },
        })
        useStore.getState().loadWorkspace(BLANK)
        lastSaved = snapshot()
        set((s) => ({ diagrams: [...s.diagrams, diagram], currentId: diagram.id, ready: true, save: 'idle' }))
        return diagram.id
      } catch (e) {
        fail(e, 'Could not create the diagram')
        return null
      } finally {
        set({ switching: false })
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
        await api(`/diagrams/${id}`, { method: 'PUT', body: { title: next } })
      } catch (e) {
        setTitle(before.title)
        fail(e, 'Could not rename the diagram')
      }
    },

    deleteDiagram: async (id) => {
      if (get().switching) return
      set({ switching: true })
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
            set({ diagrams: [diagram], currentId: diagram.id, ready: true, save: 'idle' })
          }
        } catch (e) {
          set({ currentId: null })
          fail(e, 'Could not open another diagram')
        }
      } finally {
        set({ switching: false })
      }
    },
  }
})
