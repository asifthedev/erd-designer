import { useSyncExternalStore } from 'react'

/**
 * Minimal path routing, enough for two pages: "/" is the marketing page and "/app" is the editor. No router library;
 * Vercel serves index.html for /app (see vercel.json) and the Vite dev server does so on its own.
 */
export const APP_PATH = '/app'

const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  window.addEventListener('popstate', fn)
  return () => {
    listeners.delete(fn)
    window.removeEventListener('popstate', fn)
  }
}

/** Current pathname; re-renders when it changes (navigate() or the browser's back / forward buttons). */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname)
}

export function navigate(to: string) {
  if (to === window.location.pathname) return
  window.history.pushState(null, '', to)
  window.scrollTo(0, 0)
  listeners.forEach((fn) => fn())
}

/** Click handler for plain <a href> links so they change page without a full reload (new-tab clicks still work). */
export function link(to: string) {
  return (e: { preventDefault: () => void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(to)
  }
}
