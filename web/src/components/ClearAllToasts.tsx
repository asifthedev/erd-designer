import { toast, useSonner } from 'sonner'

/** Appears above the toast stack once two or more messages are open, and closes them all at once. */
export function ClearAllToasts() {
  const { toasts } = useSonner()
  if (toasts.length < 2) return null
  return (
    <button
      type="button"
      onClick={() => toast.dismiss()}
      className="font-ui fixed top-16 left-1/2 z-[999999] -translate-x-1/2 cursor-pointer rounded-full border border-border bg-popover px-3.5 py-1 text-[13px] font-medium text-popover-foreground shadow-lg shadow-black/40 hover:border-link hover:text-link"
    >
      Clear all ({toasts.length})
    </button>
  )
}
