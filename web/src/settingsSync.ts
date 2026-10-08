import { create } from 'zustand'
import { api } from './auth/api'
import { DEFAULT_SETTINGS, pickSettings, sameSettings, sanitize, useSettings, type Settings } from './settings'

/**
 * Keeps the Settings page's choices on the account, so they follow the person to every device. Only runs while
 * someone is logged in; a guest's settings stay in this browser, as before.
 *
 *  - on login: the settings saved on the account win and are applied here. An account with none yet adopts this
 *    browser's choices (unless they are all the defaults, which is nothing worth saving).
 *  - afterwards: every change is sent to the server a moment after the last one (one request for a burst of clicks).
 *    The server merges what it gets into what it has, so two devices changing different settings don't undo each other.
 */
export type SyncState =
  | 'off' // not logged in: nothing is synced
  | 'syncing' // fetching the account's settings
  | 'saving' // a change is waiting to be sent, or on its way
  | 'saved'
  | 'error' // the server could not be reached or refused; the settings are still applied here

export const useSettingsSync = create<{ state: SyncState; savedAt: number | null }>(() => ({
  state: 'off',
  savedAt: null,
}))
const setSync = (state: SyncState, savedAt?: number) =>
  useSettingsSync.setState((s) => ({ state, savedAt: savedAt ?? s.savedAt }))

/** How long to wait after the last change before sending (a burst of clicks becomes one request). */
export const SYNC_DELAY_MS = 600

type ServerSettings = { settings: Partial<Settings> | null }

let generation = 0 // bumped on every start / stop, so a late reply from an earlier session is ignored
let unsubscribe: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** Sends the current settings. Returns false when it failed. */
async function push(keepalive = false): Promise<boolean> {
  const mine = generation
  const now = pickSettings(useSettings.getState())
  try {
    await api('/settings', { method: 'PUT', body: now, keepalive })
    if (mine !== generation) return true
    // Something changed while this was on its way: the next send is already scheduled, so stay on "saving".
    if (sameSettings(now, pickSettings(useSettings.getState()))) setSync('saved', Date.now())
    return true
  } catch {
    if (mine === generation) setSync('error')
    return false
  }
}

function schedulePush() {
  if (timer) clearTimeout(timer)
  setSync('saving')
  timer = setTimeout(() => {
    timer = null
    void push()
  }, SYNC_DELAY_MS)
}

/** Sends right away what is still waiting (the page is being closed). */
function flush() {
  if (!timer) return
  clearTimeout(timer)
  timer = null
  void push(true)
}

export function stopSettingsSync() {
  generation++
  unsubscribe?.()
  unsubscribe = null
  if (timer) clearTimeout(timer)
  timer = null
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush)
  setSync('off')
}

/** Pulls the account's settings, applies them, and starts sending changes. Safe to call again (it restarts). */
export async function startSettingsSync() {
  stopSettingsSync()
  const mine = generation
  setSync('syncing')
  let failed = false
  try {
    const { settings } = await api<ServerSettings>('/settings')
    if (mine !== generation) return
    const local = pickSettings(useSettings.getState())
    if (settings) {
      // The account wins; anything it has not stored yet keeps this browser's value.
      const merged = sanitize({ ...local, ...settings })
      if (!sameSettings(merged, local)) useSettings.getState().replace(merged)
      // Keys the server was missing are filled in from here, so every device ends up with the same complete set.
      if (Object.keys(settings).length < Object.keys(DEFAULT_SETTINGS).length) schedulePush()
    } else if (!sameSettings(local, DEFAULT_SETTINGS)) {
      schedulePush() // a first-time account adopts what this browser already uses
    }
  } catch {
    failed = true
  }
  if (mine !== generation) return

  unsubscribe = useSettings.subscribe((state, prev) => {
    if (!sameSettings(pickSettings(state), pickSettings(prev))) schedulePush()
  })
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flush)
  if (failed) setSync('error')
  else if (!timer) setSync('saved', Date.now())
}

/** "Try again" after an error: syncs the current settings (fetching first if the start-up pull had failed). */
export async function retrySettingsSync() {
  if (useSettingsSync.getState().state !== 'error') return
  if (!unsubscribe) {
    await startSettingsSync()
    return
  }
  setSync('saving')
  if (timer) clearTimeout(timer)
  timer = null
  await push()
}
