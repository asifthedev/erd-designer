import { Check, RotateCcw, Settings } from 'lucide-react'
import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCloseOnOutsidePointer } from '../hooks/useCloseOnOutsidePointer'
import {
  DEFAULT_SETTINGS,
  EDGE_STYLES,
  FONT_WEIGHTS,
  TABLE_FONTS,
  THEMES,
  useSettings,
  type EdgeStyleId,
  type ThemeId,
} from '../settings'

const heading = 'mb-2 text-[12px] font-semibold tracking-wide text-muted uppercase'

/** A theme card. It carries data-theme itself, so it shows that theme's real colours whatever is active. */
function ThemeCard({ id, name, note, active }: { id: ThemeId; name: string; note: string; active: boolean }) {
  const setTheme = useSettings((s) => s.setTheme)
  return (
    <button
      type="button"
      data-theme={id}
      aria-pressed={active}
      onClick={() => setTheme(id)}
      className={`cursor-pointer rounded-md border bg-canvas p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-key ${
        active ? 'border-key ring-1 ring-key' : 'border-line hover:border-edge'
      }`}
    >
      {/* A miniature table in the theme's colours. */}
      <div className="mb-1.5 overflow-hidden rounded-sm border border-line bg-surface">
        <div className="flex items-center gap-1 bg-canvas px-1.5 py-1">
          <span className="size-1.5 rounded-full bg-key" />
          <span className="h-1 w-8 rounded-full bg-ink" />
        </div>
        <div className="flex items-center gap-1 border-t border-line bg-row px-1.5 py-1">
          <span className="h-1 w-5 rounded-full bg-key" />
          <span className="h-1 w-6 rounded-full bg-num" />
          <span className="ml-auto h-1 w-3 rounded-full bg-ok" />
        </div>
      </div>
      <div className="flex items-center gap-1 text-[13px] font-medium text-ink">
        <span className="truncate">{name}</span>
        {active && <Check size={13} className="ml-auto shrink-0 text-key" aria-label="Selected" />}
      </div>
      <div className="truncate text-[11px] text-muted">{note}</div>
    </button>
  )
}

/** Tiny drawing of each line style for the switch: two tables joined by a line, with the style's own shape. */
function StylePreview({ id }: { id: EdgeStyleId }) {
  return (
    <svg viewBox="0 0 96 40" className="mb-1.5 h-9 w-full" fill="none" aria-hidden>
      <rect x="2" y="5" width="22" height="10" rx="2.5" className="fill-row stroke-edge" strokeWidth="1" />
      <rect x="72" y="25" width="22" height="10" rx="2.5" className="fill-row stroke-edge" strokeWidth="1" />
      <path
        d={id === 'orthogonal' ? 'M24 10H48V30H72' : 'M24 10C48 10 48 30 72 30'}
        className="stroke-key"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const segment = (active: boolean) =>
  `cursor-pointer rounded-sm border px-2 py-1.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-key ${
    active ? 'border-key bg-key/15 text-key' : 'border-line text-ink hover:border-edge hover:bg-hover'
  }`

/**
 * Button + popover with the look settings: theme, line style, and the font / weight used inside the tables.
 * `inSidebar` is the quiet gear at the foot of the diagram list (the menu opens beside it); the default is the toolbar one.
 */
export function SettingsMenu({ inSidebar = false }: { inSidebar?: boolean }) {
  const { theme, tableFont, tableWeight, edgeStyle, setTableFont, setTableWeight, setEdgeStyle, reset } = useSettings()
  const [open, setOpen] = useState(false)
  useCloseOnOutsidePointer(open, () => setOpen(false)) // a click on the canvas (or anywhere else) closes the menu
  const isDefault =
    theme === DEFAULT_SETTINGS.theme &&
    tableFont === DEFAULT_SETTINGS.tableFont &&
    tableWeight === DEFAULT_SETTINGS.tableWeight &&
    edgeStyle === DEFAULT_SETTINGS.edgeStyle

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Settings"
          aria-label="Settings"
          className={
            inSidebar
              ? 'grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted hover:bg-hover hover:text-ink'
              : 'grid size-8 cursor-pointer place-items-center rounded-md border border-line text-muted hover:border-key hover:text-key'
          }
        >
          <Settings size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent side={inSidebar ? 'right' : 'bottom'} align="end" className="font-ui w-[22rem] p-3">
        <div className="mb-3 flex items-center">
          <h2 className="mr-auto font-semibold">Settings</h2>
          <button
            type="button"
            disabled={isDefault}
            onClick={reset}
            className="flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-[12px] text-muted hover:text-key disabled:cursor-default disabled:opacity-40 disabled:hover:text-muted"
          >
            <RotateCcw size={12} />
            Reset
          </button>
        </div>

        <section>
          <h3 className={heading}>Theme</h3>
          <div className="grid grid-cols-2 gap-2">
            {THEMES.map((t) => (
              <ThemeCard key={t.id} id={t.id} name={t.name} note={t.note} active={theme === t.id} />
            ))}
          </div>
        </section>

        <section className="mt-4">
          <h3 className={heading}>Line style</h3>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Relation line style">
            {EDGE_STYLES.map((e) => (
              <button
                key={e.id}
                type="button"
                aria-pressed={edgeStyle === e.id}
                onClick={() => setEdgeStyle(e.id)}
                className={`${segment(edgeStyle === e.id)} text-left`}
              >
                <StylePreview id={e.id} />
                <span className="block text-[13px] font-medium">{e.name}</span>
                <span className="block truncate text-[11px] text-muted">{e.note}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-4">
          <h3 className={heading}>Table font</h3>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Table font">
            {TABLE_FONTS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={tableFont === f.id}
                onClick={() => setTableFont(f.id)}
                className={segment(tableFont === f.id)}
              >
                <span className="block truncate text-[17px] leading-tight" style={{ fontFamily: f.family, fontWeight: tableWeight }}>
                  id SERIAL
                </span>
                <span className="block truncate text-[11px] text-muted">{f.name}</span>
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted">Only changes the tables, not the rest of the app.</p>
        </section>

        <section className="mt-4">
          <h3 className={heading}>Font weight</h3>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Table font weight">
            {FONT_WEIGHTS.map((w) => (
              <button
                key={w.value}
                type="button"
                aria-pressed={tableWeight === w.value}
                onClick={() => setTableWeight(w.value)}
                className={segment(tableWeight === w.value)}
              >
                <span
                  className="block text-[17px] leading-tight"
                  style={{
                    fontFamily: TABLE_FONTS.find((f) => f.id === tableFont)!.family,
                    fontWeight: w.value,
                  }}
                >
                  Aa
                </span>
                <span className="block text-[11px] text-muted">{w.name}</span>
              </button>
            ))}
          </div>
        </section>
      </PopoverContent>
    </Popover>
  )
}
