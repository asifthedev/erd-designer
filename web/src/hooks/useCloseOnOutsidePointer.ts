import { useEffect } from 'react'

/**
 * Closes a popover when the pointer goes down anywhere outside it: on the canvas, the toolbar, a table...
 *
 * Radix does this too, but the canvas (React Flow) handles pointer events itself for panning and selecting, and
 * those never reach Radix, so a click on the canvas left the menu open. This listens in the capture phase on the
 * document, before anything on the page can stop the event. Presses inside any popover (they are portalled) or on
 * its trigger are left to Radix, which handles open / close for those.
 */
export function useCloseOnOutsidePointer(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('[data-slot="popover-content"], [data-slot="popover-trigger"]')) return
      close()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, close])
}
