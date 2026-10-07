import { toast } from 'sonner'
import { create } from 'zustand'
import { toWorkspace, useStore, type Workspace } from '../store'
import { api, ApiError } from './api'

export type AuthUser = { id: string; email: string; name: string | null }
/** loading: asking the server; anonymous: show the sign-in screen; guest: working locally without an account. */
export type AuthStatus = 'loading' | 'anonymous' | 'authed' | 'guest'
export type SaveState = 'idle' | 'saving' | 'saved' | 'error'

type AuthState = {
  status: AuthStatus
  user: AuthUser | null
  /** The account's workspace has been loaded, so autosave may start (it must not overwrite it with a sample). */
  ready: boolean
  save: SaveState
  savedAt: number | null

  init: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  signup: (input: { name: string; email: string; password: string }) => Promise<void>
  logout: () => Promise<void>
  continueAsGuest: () => void
  /** Back to the sign-in screen from guest mode (local work is kept). */
  showSignIn: () => void
  saveNow: (options?: { keepalive?: boolean }) => Promise<void>
}

let lastSaved = ''
const snapshot = () => JSON.stringify(toWorkspace(useStore.getState()))

export const useAuth = create<AuthState>()((set, get) => {
  /** Signed in: pull the saved workspace (or keep and upload what is on the canvas for a new account). */
  async function enter(user: AuthUser) {
    set({ status: 'authed', user, ready: false, save: 'idle' })
    try {
      const { data } = await api<{ data: Workspace | null }>('/diagram')
      if (data) useStore.getState().loadWorkspace(data)
      lastSaved = data ? snapshot() : ''
      set({ ready: true })
      if (!data) await get().saveNow()
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
      set({ status: 'anonymous', user: null, ready: false, save: 'idle', savedAt: null })
    },

    continueAsGuest: () => set({ status: 'guest' }),
    showSignIn: () => set({ status: 'anonymous' }),

    saveNow: async (options) => {
      if (get().status !== 'authed' || !get().ready) return
      const body = snapshot()
      if (body === lastSaved) return
      set({ save: 'saving' })
      try {
        await api('/diagram', { method: 'PUT', body: JSON.parse(body), keepalive: options?.keepalive })
        lastSaved = body
        set({ save: 'saved', savedAt: Date.now() })
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          set({ status: 'anonymous', user: null, ready: false, save: 'idle' })
          toast.error('Your session has expired', {
            description: 'Log in again to keep saving.',
            closeButton: true,
            duration: Infinity,
          })
          return
        }
        set({ save: 'error' })
        toast.error('Could not save your work', {
          id: 'save-failed',
          description: (e as Error).message,
          closeButton: true,
          duration: Infinity,
        })
      }
    },
  }
})
