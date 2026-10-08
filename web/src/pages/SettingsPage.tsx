import {
  ArrowLeft,
  Check,
  CloudAlert,
  CloudCheck,
  CloudOff,
  LoaderCircle,
  RotateCcw,
  Users,
  FileText,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useAuth } from '@/auth/store'
import { curveGeometry, roundedPolyline, routePoints } from '../core/routing'
import { link, APP_PATH } from '../lib/route'
import {
  DEFAULT_SETTINGS,
  EDGE_STYLES,
  FONT_WEIGHTS,
  TABLE_FONTS,
  THEMES,
  pickSettings,
  sameSettings,
  useSettings,
  type EdgeStyleId,
  type ThemeId,
} from '../settings'
import { retrySettingsSync, useSettingsSync } from '../settingsSync'

/**
 * The Settings page: look and feel only (theme, line style, table font and weight), with a live preview, and a
 * line saying where the choices are kept: on the account (synced to every device) or in this browser.
 */

/** A theme card. It carries data-theme itself, so it shows that theme's real colours whatever is active. */
function ThemeCard({ id, name, note, active }: { id: ThemeId; name: string; note: string; active: boolean }) {
  const setTheme = useSettings((s) => s.setTheme)
  return (
    <button
      type="button"
      data-theme={id}
      aria-pressed={active}
      onClick={() => setTheme(id)}
      className={`cursor-pointer rounded-xl border bg-canvas p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-key ${
        active ? 'border-key ring-1 ring-key' : 'border-line hover:border-edge'
      }`}
    >
      {/* A miniature table in the theme's colours. */}
      <div className="mb-2 overflow-hidden rounded-md border border-line bg-surface">
        <div className="flex items-center gap-1 bg-canvas px-2 py-1.5">
          <span className="size-1.5 rounded-full bg-key" />
          <span className="h-1 w-10 rounded-full bg-ink" />
        </div>
        <div className="flex items-center gap-1 border-t border-line bg-row px-2 py-1.5">
          <span className="h-1 w-6 rounded-full bg-key" />
          <span className="h-1 w-7 rounded-full bg-num" />
          <span className="ml-auto h-1 w-4 rounded-full bg-ok" />
        </div>
      </div>
      <div className="flex items-center gap-1 text-[14px] font-medium text-ink">
        <span className="truncate">{name}</span>
        {active && <Check size={14} className="ml-auto shrink-0 text-key" aria-label="Selected" />}
      </div>
      <div className="truncate text-[12px] text-muted">{note}</div>
    </button>
  )
}

/** Tiny drawing of each line style: two tables joined by a line with the style's own shape. */
function StyleDrawing({ id }: { id: EdgeStyleId }) {
  return (
    <svg viewBox="0 0 96 40" className="mb-2 h-10 w-full" fill="none" aria-hidden>
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

const choice = (active: boolean) =>
  `cursor-pointer rounded-xl border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-key ${
    active ? 'border-key bg-key/12 text-key' : 'border-line text-ink hover:border-edge hover:bg-hover'
  }`

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 mb-4 text-[13px] text-muted">{hint}</p>}
      {!hint && <div className="mb-4" />}
      {children}
    </section>
  )
}

/** Where the settings are kept, and whether they have reached the server. */
function SyncStatus() {
  const status = useAuth((s) => s.status)
  const sync = useSettingsSync((s) => s.state)
  const showSignIn = useAuth((s) => s.showSignIn)
  const chip = 'flex items-center gap-2 text-[13px]'

  if (status !== 'authed') {
    return (
      <div className={`${chip} text-muted`}>
        <CloudOff size={16} aria-hidden />
        <span>Saved in this browser only.</span>
        {status !== 'loading' && (
          <a
            href={APP_PATH}
            onClick={(e) => {
              showSignIn()
              link(APP_PATH)(e)
            }}
            className="font-medium text-key hover:underline"
          >
            Log in to keep them on every device
          </a>
        )}
      </div>
    )
  }
  if (sync === 'error') {
    return (
      <div className={`${chip} text-danger`} role="alert">
        <CloudAlert size={16} aria-hidden />
        <span>Couldn't sync with your account.</span>
        <button type="button" onClick={() => void retrySettingsSync()} className="cursor-pointer font-medium underline">
          Try again
        </button>
      </div>
    )
  }
  if (sync === 'saving' || sync === 'syncing') {
    return (
      <div className={`${chip} text-muted`} role="status">
        <LoaderCircle size={16} className="animate-spin" aria-hidden />
        <span>{sync === 'syncing' ? 'Syncing…' : 'Saving…'}</span>
      </div>
    )
  }
  return (
    <div className={`${chip} text-link`} role="status">
      <CloudCheck size={16} aria-hidden />
      <span>Synced to your account</span>
    </div>
  )
}

// ---- Live preview: two small tables and the line between them, drawn with the real classes and line code ----

const HEAD = 40
const ROW = 34
const VIEW = { w: 412, h: 250 }
const TABLE_W = 150
const USERS = {
  x: 6,
  y: 14,
  rows: [
    ['id', 'SERIAL'],
    ['email', 'TEXT'],
    ['name', 'VARCHAR(50)'],
  ],
}
const POSTS = {
  x: VIEW.w - TABLE_W - 6,
  y: 84,
  rows: [
    ['id', 'SERIAL'],
    ['author_id', 'INT'],
    ['title', 'TEXT'],
  ],
}
const rowY = (t: { y: number }, i: number) => t.y + HEAD + i * ROW + ROW / 2

function PreviewTable({
  table,
  name,
  color,
  icon,
}: {
  table: typeof USERS
  name: string
  color: string
  icon: ReactNode
}) {
  return (
    <div
      data-color={color}
      className="erd-table table-font absolute border bg-surface text-[13px]"
      style={{ left: table.x, top: table.y, width: TABLE_W }}
    >
      <div className="erd-header flex items-center gap-2 bg-canvas px-3" style={{ height: HEAD }}>
        <span className="erd-icon flex">
          {/* A real <button>, so the themes' icon styles (e.g. Eraser's bare white icon) apply here too. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none grid size-7 place-items-center rounded-sm border border-line text-key"
          >
            {icon}
          </button>
        </span>
        <span className="erd-title px-0.5 text-[15px] font-semibold">{name}</span>
      </div>
      {table.rows.map(([col, type], i) => (
        <div
          key={col}
          className={`flex items-center gap-3 border-t border-line bg-row px-3 ${i === table.rows.length - 1 ? 'erd-last' : ''}`}
          style={{ height: ROW }}
        >
          <span className="text-key">{col}</span>
          <span className="erd-type ml-auto text-ink">{type}</span>
        </div>
      ))}
    </div>
  )
}

/** The relation line for the chosen style, from posts.author_id (many) to users.id (one), with its end symbols. */
function PreviewLine({ edgeStyle }: { edgeStyle: EdgeStyleId }) {
  const sx = POSTS.x // line leaves the left edge of posts ...
  const sy = rowY(POSTS, 1)
  const tx = USERS.x + TABLE_W // ... and arrives at the right edge of users
  const ty = rowY(USERS, 0)
  const MANY = 24 // border to ring centre at the crow's foot end
  const ONE = 17 // border to ring centre at the bar end
  const d =
    edgeStyle === 'curved'
      ? curveGeometry(sx, sy, -1, tx, ty, 1, undefined, { s: MANY, t: ONE }).d
      : roundedPolyline(routePoints(sx, sy, -1, tx, ty, 1), 10)
  return (
    <svg className="pointer-events-none absolute inset-0" width={VIEW.w} height={VIEW.h} aria-hidden>
      <path d={d} fill="none" style={{ stroke: 'var(--color-edge)', strokeWidth: 1.5 }} />
      <g style={{ stroke: 'var(--color-edge)', strokeWidth: 1.5, fill: 'none' }}>
        <path d={`M${sx - MANY + 7},${sy}L${sx},${sy - 10}M${sx - MANY + 7},${sy}L${sx},${sy + 10}`} />
        <path d={`M${tx + 10},${ty - 10}V${ty + 10}`} />
        <circle cx={sx - MANY} cy={sy} r={6} style={{ fill: 'var(--color-canvas)' }} />
        <circle cx={tx + ONE} cy={ty} r={6} style={{ fill: 'var(--color-canvas)' }} />
      </g>
    </svg>
  )
}

function Preview({ edgeStyle }: { edgeStyle: EdgeStyleId }) {
  return (
    <div className="max-w-full overflow-x-auto rounded-xl border border-line bg-canvas">
      <div className="relative" style={{ width: VIEW.w, height: VIEW.h }}>
        <PreviewLine edgeStyle={edgeStyle} />
        <PreviewTable table={USERS} name="users" color="blue" icon={<Users size={15} />} />
        <PreviewTable table={POSTS} name="posts" color="green" icon={<FileText size={15} />} />
      </div>
    </div>
  )
}

export function SettingsPage() {
  const settings = useSettings()
  const { theme, tableFont, tableWeight, edgeStyle, setTableFont, setTableWeight, setEdgeStyle, replace } = settings
  const isDefault = sameSettings(pickSettings(settings), DEFAULT_SETTINGS)
  const fontFamily = TABLE_FONTS.find((f) => f.id === tableFont)!.family

  return (
    <div className="min-h-full bg-canvas font-ui text-ink">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-line bg-surface px-4">
        <a
          href={APP_PATH}
          onClick={link(APP_PATH)}
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[14px] text-muted outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-key"
        >
          <ArrowLeft size={16} />
          Back to editor
        </a>
        <h1 className="font-semibold">Settings</h1>
        <div className="ml-auto">
          <SyncStatus />
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8 lg:grid-cols-[minmax(0,1fr)_412px]">
        <div className="flex flex-col gap-6">
          <Section title="Theme" hint="The colours of the whole app.">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {THEMES.map((t) => (
                <ThemeCard key={t.id} id={t.id} name={t.name} note={t.note} active={theme === t.id} />
              ))}
            </div>
          </Section>

          <Section title="Line style" hint="How relations are drawn between tables.">
            <div className="grid grid-cols-2 gap-3" role="group" aria-label="Relation line style">
              {EDGE_STYLES.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  aria-pressed={edgeStyle === e.id}
                  onClick={() => setEdgeStyle(e.id)}
                  className={choice(edgeStyle === e.id)}
                >
                  <StyleDrawing id={e.id} />
                  <span className="block text-[14px] font-medium">{e.name}</span>
                  <span className="block text-[12px] text-muted">{e.note}</span>
                </button>
              ))}
            </div>
          </Section>

          <Section title="Table text" hint="Only changes the tables, not the rest of the app.">
            <div className="grid grid-cols-2 gap-3" role="group" aria-label="Table font">
              {TABLE_FONTS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={tableFont === f.id}
                  onClick={() => setTableFont(f.id)}
                  className={choice(tableFont === f.id)}
                >
                  <span
                    className="block truncate text-[18px] leading-tight"
                    style={{ fontFamily: f.family, fontWeight: tableWeight }}
                  >
                    id SERIAL
                  </span>
                  <span className="block truncate text-[12px] text-muted">{f.name}</span>
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3" role="group" aria-label="Table font weight">
              {FONT_WEIGHTS.map((w) => (
                <button
                  key={w.value}
                  type="button"
                  aria-pressed={tableWeight === w.value}
                  onClick={() => setTableWeight(w.value)}
                  className={`${choice(tableWeight === w.value)} text-center`}
                >
                  <span className="block text-[18px] leading-tight" style={{ fontFamily, fontWeight: w.value }}>
                    Aa
                  </span>
                  <span className="block text-[12px] text-muted">{w.name}</span>
                </button>
              ))}
            </div>
          </Section>

          <div>
            <button
              type="button"
              disabled={isDefault}
              onClick={() => replace(DEFAULT_SETTINGS)}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-[14px] text-muted outline-none hover:border-key hover:text-key focus-visible:ring-2 focus-visible:ring-key disabled:cursor-default disabled:opacity-40 disabled:hover:border-line disabled:hover:text-muted"
            >
              <RotateCcw size={15} />
              Reset to defaults
            </button>
          </div>
        </div>

        <aside className="order-first lg:order-none lg:sticky lg:top-[4.5rem] lg:self-start" aria-label="Preview">
          <h2 className="mb-3 text-[12px] font-semibold tracking-wider text-muted uppercase">Preview</h2>
          <Preview edgeStyle={edgeStyle} />
          <p className="mt-3 text-[13px] text-muted">Changes apply at once, everywhere in the app.</p>
        </aside>
      </main>
    </div>
  )
}
