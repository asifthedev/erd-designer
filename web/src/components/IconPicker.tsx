import { X } from 'lucide-react'
import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TABLE_ICON_NAMES, TABLE_ICONS, tableIcon } from './tableIcons'

type Props = { value: string | undefined; onChange: (icon: string | undefined) => void }

const POPOVER_W = 308

/** Button showing the table's icon; opens a searchable grid of icons to pick from. */
export function IconPicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)

  const names = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? TABLE_ICON_NAMES.filter((n) => n.toLowerCase().includes(q)) : TABLE_ICON_NAMES
  }, [query])

  useEffect(() => {
    if (!open) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !popover.current?.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const toggle = () => {
    const r = button.current?.getBoundingClientRect()
    if (r) setPos({ x: Math.min(r.left, window.innerWidth - POPOVER_W - 8), y: r.bottom + 6 })
    setQuery('')
    setOpen((o) => !o)
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        title="Change table icon"
        aria-label="Change table icon"
        aria-expanded={open}
        onClick={toggle}
        className="nodrag grid size-8 shrink-0 cursor-pointer place-items-center rounded-sm border border-line text-key hover:border-key"
      >
        {createElement(tableIcon(value), { size: 18 })}
      </button>
      {open &&
        // Portal: table nodes stack on top of each other, so an in-node popover could be covered.
        createPortal(
          <div
            ref={popover}
            style={{ left: pos.x, top: pos.y, width: POPOVER_W }}
            className="fixed z-50 rounded-sm border border-line bg-surface p-2 font-ui text-[14px] text-ink shadow-xl shadow-black/50"
          >
            <div className="mb-2 flex items-center gap-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search icons…"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-sm border border-line bg-canvas px-2 py-1 outline-none focus:border-key"
              />
              <button
                type="button"
                title="Use the default icon"
                onClick={() => {
                  onChange(undefined)
                  setOpen(false)
                }}
                className="cursor-pointer rounded-sm border border-line px-2 py-1 text-muted hover:border-key hover:text-key"
              >
                <X size={14} />
              </button>
            </div>
            <div className="grid max-h-64 grid-cols-8 gap-1 overflow-auto">
              {names.map((name) => {
                const Icon = TABLE_ICONS[name]
                return (
                  <button
                    key={name}
                    type="button"
                    title={name}
                    aria-label={name}
                    onClick={() => {
                      onChange(name)
                      setOpen(false)
                    }}
                    className={`grid aspect-square cursor-pointer place-items-center rounded-sm border ${
                      name === value
                        ? 'border-key/60 bg-key/15 text-key'
                        : 'border-transparent text-muted hover:border-line hover:text-ink'
                    }`}
                  >
                    <Icon size={18} />
                  </button>
                )
              })}
            </div>
            {names.length === 0 && <p className="px-1 py-2 text-muted">No icon matches “{query}”.</p>}
          </div>,
          document.body,
        )}
    </>
  )
}
