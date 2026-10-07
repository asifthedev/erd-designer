import { LoaderCircle } from 'lucide-react'
import { useAuth } from '@/auth/store'

/**
 * Covers the canvas while the server is busy with an ERD (opening, creating, deleting the open one, or the first
 * load after signing in), so the app never looks frozen. It also blocks clicks on the old diagram, which is about
 * to be replaced, and fades in after a beat so a fast response doesn't flash it.
 */
export function LoadingVeil() {
  const authed = useAuth((s) => s.status === 'authed')
  const ready = useAuth((s) => s.ready)
  const loading = useAuth((s) => s.loading)
  const currentId = useAuth((s) => s.currentId)

  // Deleting some other ERD doesn't touch the canvas, so only its sidebar row shows progress.
  // A quiet open (an ERD already loaded this session) only spins its sidebar row.
  const coversCanvas = loading && !loading.quiet && (loading.kind !== 'delete' || loading.id === currentId)
  if (!authed || !(coversCanvas || (!ready && !loading))) return null

  const text =
    loading?.kind === 'create'
      ? 'Creating a new ERD…'
      : loading?.kind === 'delete'
        ? 'Deleting…'
        : loading?.kind === 'open'
          ? 'Opening ERD…'
          : 'Loading your ERDs…'

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-30 grid animate-in place-items-center bg-canvas/70 backdrop-blur-[2px] duration-200 fade-in [animation-delay:120ms] [animation-fill-mode:backwards]"
    >
      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-xl shadow-black/40">
        <LoaderCircle className="animate-spin text-key" size={20} aria-hidden />
        <span>{text}</span>
      </div>
    </div>
  )
}
