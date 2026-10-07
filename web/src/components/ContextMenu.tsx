import { Delete } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type MenuItem = {
  label: string
  /** Right-aligned keyboard hint, e.g. `Ctrl C`. */
  shortcut?: ReactNode
  danger?: boolean
  /** Draw a divider above this item. */
  separator?: boolean
  onSelect: () => void
}

export type MenuTarget = { x: number; y: number; items: MenuItem[] }

/** Shortcut hint for the Delete item (a backspace glyph, like most editors). */
export const DELETE_HINT = <Delete size={16} />

/** Right-click menu. Closes on selection, outside click, Escape, scroll or resize. */
export function ContextMenu({ menu, onClose }: { menu: MenuTarget | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const away = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node))
        onClose()
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', away)
    window.addEventListener('wheel', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', away)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [menu, onClose])

  if (!menu) return null
  const height = menu.items.length * 36 + 16
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        left: Math.min(menu.x, window.innerWidth - 240),
        top: Math.min(menu.y, window.innerHeight - height),
      }}
      className="font-ui fixed z-50 w-56 rounded-md border border-line bg-surface p-1.5 text-[14px] text-ink shadow-xl shadow-black/50"
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) => (
        <div key={item.label}>
          {item.separator && i > 0 && <div role="separator" className="my-1.5 h-px bg-line" />}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              item.onSelect()
              onClose()
            }}
            className={`flex w-full cursor-pointer items-center justify-between rounded-sm px-2.5 py-1.5 text-left outline-none hover:bg-white/8 focus-visible:bg-white/8 ${
              item.danger ? 'text-danger' : ''
            }`}
          >
            <span className="font-medium">{item.label}</span>
            {item.shortcut && <span className="text-muted">{item.shortcut}</span>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}
