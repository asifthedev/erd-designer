import {
  Database,
  Ellipsis,
  LoaderCircle,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Workflow,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { MAX_DIAGRAMS, useAuth, type DiagramMeta, type Loading } from '@/auth/store'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useCloseOnOutsidePointer } from '../hooks/useCloseOnOutsidePointer'
import { initials, tableCountLabel, timeAgo } from '../lib/time'
import type { Provider } from '../core/model'
import { SettingsMenu } from './SettingsMenu'
import { useStore } from '../store'

const PROVIDER_LABEL: Record<Provider, string> = { postgresql: 'PG', mysql: 'MySQL', sqlite: 'SQLite' }

/** Inline title editor: Enter or leaving the field saves, Escape cancels. */
function TitleInput({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  // Enter / Escape also blur the field, so remember that the answer was already given.
  const finished = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (title: string | null) => {
    if (finished.current) return
    finished.current = true
    onDone(title)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') finish(e.currentTarget.value)
    else if (e.key === 'Escape') finish(null)
  }
  return (
    <input
      ref={ref}
      aria-label="Diagram name"
      defaultValue={initial}
      maxLength={100}
      spellCheck={false}
      onKeyDown={onKeyDown}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="min-w-0 flex-1 rounded-md border border-key bg-canvas px-2 py-1.5 text-[14px] font-semibold outline-none"
    />
  )
}

/** The "..." of a row: rename and delete, kept out of sight until they are wanted. */
function RowMenu({ diagram, onRename }: { diagram: DiagramMeta; onRename: () => void }) {
  const deleteDiagram = useAuth((s) => s.deleteDiagram)
  const [open, setOpen] = useState(false)
  useCloseOnOutsidePointer(open, () => setOpen(false))
  const item =
    'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13.5px] outline-none hover:bg-hover focus-visible:bg-hover'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="More"
          aria-label={`More for ${diagram.title}`}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted outline-none hover:bg-hover-strong hover:text-ink focus-visible:ring-1 focus-visible:ring-key"
        >
          <Ellipsis size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="font-ui w-40 p-1">
        <button
          type="button"
          className={item}
          onClick={() => {
            setOpen(false)
            onRename()
          }}
        >
          <Pencil size={14} /> Rename
        </button>
        <button
          type="button"
          className={`${item} text-danger`}
          onClick={() => {
            setOpen(false)
            if (window.confirm(`Delete "${diagram.title}"? This can't be undone.`)) void deleteDiagram(diagram.id)
          }}
        >
          <Trash2 size={14} /> Delete
        </button>
      </PopoverContent>
    </Popover>
  )
}

function Row({
  diagram,
  active,
  editing,
  loading,
  now,
  onEdit,
}: {
  diagram: DiagramMeta
  active: boolean
  editing: boolean
  /** What the server is doing right now (null when idle). Clicks are ignored meanwhile. */
  loading: Loading | null
  /** The current time, so every row counts "2h ago" from the same moment. */
  now: number
  onEdit: (editing: boolean) => void
}) {
  const openDiagram = useAuth((s) => s.openDiagram)
  const renameDiagram = useAuth((s) => s.renameDiagram)
  const setPinned = useAuth((s) => s.setPinned)
  // The open diagram is being edited right now, so its numbers come from the canvas, not from the saved list.
  const liveCount = useStore((s) => s.nodes.length)
  const liveProvider = useStore((s) => s.provider)

  // This very row is being opened or deleted: it gets the spinner, the others just wait quietly.
  const working = loading?.id === diagram.id
  const count = active ? liveCount : diagram.tableCount
  const provider = active ? liveProvider : diagram.provider
  const subtitle = [tableCountLabel(count), `edited ${timeAgo(diagram.updatedAt, now)}`].filter(Boolean).join(' · ')

  return (
    <li
      aria-busy={working || undefined}
      className={`group relative flex items-center gap-3 rounded-xl border p-2 ${
        active || (working && loading?.kind === 'open')
          ? 'border-key/40 bg-key/12'
          : 'border-transparent hover:bg-hover'
      } ${loading ? 'pointer-events-none' : ''} ${loading && !working ? 'opacity-60' : ''}`}
    >
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-lg ${
          active ? 'bg-key text-primary-foreground' : 'bg-hover-strong text-muted'
        }`}
      >
        {working ? <LoaderCircle size={16} className="animate-spin" aria-label="Working" /> : <Database size={16} />}
      </span>

      {editing ? (
        <TitleInput
          initial={diagram.title}
          onDone={(title) => {
            onEdit(false)
            if (title !== null) void renameDiagram(diagram.id, title)
          }}
        />
      ) : (
        <>
          <button
            type="button"
            title={diagram.title}
            aria-current={active ? 'true' : undefined}
            onClick={() => void openDiagram(diagram.id)}
            onDoubleClick={() => onEdit(true)}
            className="min-w-0 flex-1 cursor-pointer text-left outline-none focus-visible:ring-1 focus-visible:ring-key"
          >
            <span className="block truncate text-[14px] font-semibold">{diagram.title}</span>
            <span className="block truncate text-[12px] text-muted">{subtitle}</span>
          </button>

          {/* The database badge; the pin and "..." take its place while the row is hovered or focused. */}
          <span className="grid shrink-0 justify-items-end *:col-start-1 *:row-start-1">
            {provider && (
              <span className="rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted group-focus-within:invisible group-hover:invisible">
                {PROVIDER_LABEL[provider]}
              </span>
            )}
            <span className="invisible flex items-center gap-0.5 group-focus-within:visible group-hover:visible">
              <button
                type="button"
                title={diagram.pinned ? 'Unpin' : 'Pin to the top'}
                aria-label={diagram.pinned ? `Unpin ${diagram.title}` : `Pin ${diagram.title}`}
                aria-pressed={!!diagram.pinned}
                onClick={() => void setPinned(diagram.id, !diagram.pinned)}
                className="grid size-7 cursor-pointer place-items-center rounded-md text-muted outline-none hover:bg-hover-strong hover:text-ink focus-visible:ring-1 focus-visible:ring-key"
              >
                {diagram.pinned ? <PinOff size={15} /> : <Pin size={15} />}
              </button>
              <RowMenu diagram={diagram} onRename={() => onEdit(true)} />
            </span>
          </span>
        </>
      )}
    </li>
  )
}

/** Grey pulsing rows shown until the list arrives from the server. */
function ListSkeleton() {
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Loading your diagrams" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-3 p-2">
          <span className="size-9 animate-pulse rounded-lg bg-hover" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-3 w-3/5 animate-pulse rounded bg-hover" />
            <span className="h-2.5 w-4/5 animate-pulse rounded bg-hover" />
          </span>
        </li>
      ))}
    </ul>
  )
}

const sectionTitle = 'px-2 pt-3 pb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase'
const byRecent = (a: DiagramMeta, b: DiagramMeta) => b.updatedAt.localeCompare(a.updatedAt)

/** True when the key press is going into a text field, where letters must stay letters. */
const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return (
    !!el &&
    (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.getAttribute('role') === 'combobox')
  )
}

/**
 * Left panel with the account's diagrams: a workspace header, a "New diagram" button (key N), a search box (key
 * Ctrl/⌘ K), the pinned diagrams and the recent ones, and at the foot how many diagrams are used and the account.
 * Collapses with the « button.
 */
export function DiagramSidebar() {
  const diagrams = useAuth((s) => s.diagrams)
  const currentId = useAuth((s) => s.currentId)
  const loading = useAuth((s) => s.loading)
  const user = useAuth((s) => s.user)
  const createDiagram = useAuth((s) => s.createDiagram)
  const toggleList = useStore((s) => s.toggleList)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const search = useRef<HTMLInputElement>(null)

  // "edited 2h ago" keeps counting while the page stays open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const full = diagrams.length >= MAX_DIAGRAMS
  const creating = loading?.kind === 'create'

  const create = async () => {
    const id = await createDiagram()
    if (id) setEditingId(id) // name it straight away
  }
  // The shortcuts below are registered once, so they reach the latest `create` through a ref.
  const createRef = useRef(create)
  createRef.current = create
  const canCreate = !loading && !full

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        search.current?.focus()
        search.current?.select()
      } else if (e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
        if (!canCreate) return
        e.preventDefault()
        void createRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canCreate])

  const { pinned, recent } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = [...diagrams].filter((d) => !q || d.title.toLowerCase().includes(q)).sort(byRecent)
    return { pinned: shown.filter((d) => d.pinned), recent: shown.filter((d) => !d.pinned) }
  }, [diagrams, query])

  const label = user?.name || user?.email || ''
  const accountName = user?.name || (user?.email ?? '').split('@')[0]
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const kbd = 'rounded-md bg-hover-strong px-1.5 py-0.5 font-mono text-[11px] text-muted'

  const rows = (list: DiagramMeta[]) => (
    <ul className="flex flex-col gap-1">
      {list.map((d) => (
        <Row
          key={d.id}
          diagram={d}
          active={d.id === currentId}
          editing={editingId === d.id}
          loading={loading}
          now={now}
          onEdit={(on) => setEditingId(on ? d.id : null)}
        />
      ))}
    </ul>
  )

  return (
    <aside aria-label="Your diagrams" className="flex w-80 shrink-0 flex-col border-r border-line bg-surface">
      <header className="flex items-center gap-3 px-4 pt-4 pb-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-key text-primary-foreground">
          <Workflow size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">erd.designer</div>
          <div className="truncate text-[12.5px] text-muted">Personal workspace</div>
        </div>
        <button
          type="button"
          onClick={toggleList}
          title="Hide the list"
          aria-label="Hide the list of diagrams"
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted hover:bg-hover hover:text-ink"
        >
          <PanelLeftClose size={17} />
        </button>
      </header>

      <div className="flex flex-col gap-3 px-3">
        <button
          type="button"
          disabled={!canCreate}
          aria-busy={creating || undefined}
          onClick={() => void create()}
          title={full ? `You can keep up to ${MAX_DIAGRAMS} diagrams` : 'Create a new, blank diagram (N)'}
          className="flex h-11 w-full cursor-pointer items-center gap-2 rounded-xl bg-primary px-4 font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? <LoaderCircle size={18} className="animate-spin" aria-hidden /> : <Plus size={18} />}
          {creating ? 'Creating…' : 'New diagram'}
          <kbd className="ml-auto rounded-md bg-black/20 px-1.5 py-0.5 font-mono text-[11px]">N</kbd>
        </button>

        <label className="flex h-10 items-center gap-2 rounded-xl border border-line bg-canvas px-3 text-muted focus-within:border-key">
          <Search size={16} className="shrink-0" aria-hidden />
          <input
            ref={search}
            type="text"
            aria-label="Search diagrams"
            placeholder="Search diagrams"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                e.currentTarget.blur()
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-muted"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear the search"
              onClick={() => setQuery('')}
              className="grid size-5 cursor-pointer place-items-center rounded text-muted hover:text-ink"
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className={kbd}>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          )}
        </label>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {diagrams.length === 0 ? (
          <div className="pt-4">
            <ListSkeleton />
          </div>
        ) : pinned.length === 0 && recent.length === 0 ? (
          <p className="px-2 pt-6 text-center text-[13.5px] text-muted">No diagrams match “{query.trim()}”.</p>
        ) : (
          <>
            {pinned.length > 0 && (
              <section aria-label="Pinned diagrams">
                <h2 className={sectionTitle}>Pinned</h2>
                {rows(pinned)}
              </section>
            )}
            {recent.length > 0 && (
              <section aria-label="Recent diagrams">
                <h2 className={sectionTitle}>Recent</h2>
                {rows(recent)}
              </section>
            )}
          </>
        )}
      </nav>

      <footer className="flex flex-col gap-4 border-t border-line p-4">
        <div>
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-muted">Diagrams</span>
            <span className="font-mono font-medium">
              {diagrams.length} / {MAX_DIAGRAMS}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Diagrams used"
            aria-valuemin={0}
            aria-valuemax={MAX_DIAGRAMS}
            aria-valuenow={diagrams.length}
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover-strong"
          >
            <div
              className={`h-full rounded-full ${full ? 'bg-danger' : 'bg-key'}`}
              style={{ width: `${Math.min(100, (diagrams.length / MAX_DIAGRAMS) * 100)}%` }}
            />
          </div>
        </div>
        {user && (
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-full bg-key/20 text-[14px] font-semibold text-key"
            >
              {initials(label)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{accountName}</div>
              <div className="truncate text-[12.5px] text-muted">{user.email}</div>
            </div>
            <SettingsMenu inSidebar />
          </div>
        )}
      </footer>
    </aside>
  )
}
