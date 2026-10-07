import { useEffect } from 'react'
import { useStore } from '../store'
import { useAuth } from './store'

const DELAY_MS = 1200

/** Saves the workspace to the account shortly after each change, and when the tab is hidden or closed. */
export function useAutosave() {
  const status = useAuth((s) => s.status)
  const ready = useAuth((s) => s.ready)

  useEffect(() => {
    if (status !== 'authed' || !ready) return
    let timer: ReturnType<typeof setTimeout> | undefined

    const unsubscribe = useStore.subscribe((state, prev) => {
      // Selection / measuring also touch `nodes`; saveNow skips the request when nothing really changed.
      if (
        state.nodes === prev.nodes &&
        state.manyToMany === prev.manyToMany &&
        state.provider === prev.provider
      )
        return
      clearTimeout(timer)
      timer = setTimeout(() => void useAuth.getState().saveNow(), DELAY_MS)
    })

    const flush = () => {
      if (document.visibilityState === 'hidden') {
        clearTimeout(timer)
        void useAuth.getState().saveNow({ keepalive: true })
      }
    }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', flush)

    return () => {
      clearTimeout(timer)
      unsubscribe()
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [status, ready])
}
