import { LoaderCircle, PanelLeftClose, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { MAX_DIAGRAMS, useAuth, type DiagramMeta, type Loading } from '@/auth/store'
import { useStore } from '../store'

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
      className="min-w-0 flex-1 rounded-sm border border-key bg-canvas px-1.5 py-0.5 outline-none"
    />
  )
}

function Row({
  diagram,
  active,
  editing,
  loading,
  onEdit,
}: {
  diagram: DiagramMeta
  active: boolean
  editing: boolean
  /** What the server is doing right now (null when idle). Clicks are ignored meanwhile. */
  loading: Loading | null
  onEdit: (editing: boolean) => void
}) {
  const openDiagram = useAuth((s) => s.openDiagram)
  const renameDiagram = useAuth((s) => s.renameDiagram)
  const deleteDiagram = useAuth((s) => s.deleteDiagram)

  // This very row is being opened or deleted: it gets the spinner, the others just wait quietly.
  const working = loading?.id === diagram.id
  const iconBtn =
    'grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-muted opacity-0 outline-none hover:bg-hover-strong hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'

  return (
    <li
      aria-busy={working || undefined}
      className={`group flex items-center gap-1 rounded-md px-1.5 py-1 ${
        active || (working && loading?.kind === 'open') ? 'bg-key/15 text-key' : 'text-ink hover:bg-hover'
      } ${loading ? 'pointer-events-none' : ''} ${loading && !working ? 'opacity-60' : ''}`}
    >
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
            className="min-w-0 flex-1 cursor-pointer truncate rounded-sm px-1 py-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-key"
          >
            {diagram.title}
          </button>
          {working ? (
            <LoaderCircle
              size={15}
              className="mr-1 shrink-0 animate-spin"
              aria-label={loading?.kind === 'delete' ? 'Deleting' : 'Opening'}
            />
          ) : (
            <>
              <button type="button" title="Rename" aria-label={`Rename ${diagram.title}`} className={iconBtn} onClick={() => onEdit(true)}>
                <Pencil size={13} />
              </button>
              <button
                type="button"
                title="Delete"
                aria-label={`Delete ${diagram.title}`}
                className={`${iconBtn} hover:text-danger!`}
                onClick={() => {
                  if (window.confirm(`Delete "${diagram.title}"? This can't be undone.`)) void deleteDiagram(diagram.id)
                }}
              >
                <Trash2 size={13} />
              </button>
            </>
          )}
        </>
      )}
    </li>
  )
}

/** Grey pulsing bars shown until the list arrives from the server. */
function ListSkeleton() {
  return (
    <ul className="flex flex-col gap-1.5 p-1" aria-label="Loading your ERDs" aria-busy="true">
      {[70, 52, 62].map((w) => (
        <li key={w} className="h-7 animate-pulse rounded-md bg-hover" style={{ width: `${w + 20}%` }} />
      ))}
    </ul>
  )
}

/** Left panel with the account's ERDs: open one, create, rename (double-click) or delete. Collapses with «. */
export function DiagramSidebar() {
  const diagrams = useAuth((s) => s.diagrams)
  const currentId = useAuth((s) => s.currentId)
  const loading = useAuth((s) => s.loading)
  const createDiagram = useAuth((s) => s.createDiagram)
  const toggleList = useStore((s) => s.toggleList)
  const [editingId, setEditingId] = useState<string | null>(null)

  const full = diagrams.length >= MAX_DIAGRAMS
  const creating = loading?.kind === 'create'

  const create = async () => {
    const id = await createDiagram()
    if (id) setEditingId(id) // name it straight away
  }

  return (
    <aside aria-label="Your ERDs" className="flex w-64 shrink-0 flex-col border-r border-line bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="mr-auto font-semibold">Your ERDs</h2>
        <button
          type="button"
          onClick={toggleList}
          title="Hide the list"
          aria-label="Hide the list of ERDs"
          className="grid size-7 cursor-pointer place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink"
        >
          <PanelLeftClose size={17} />
        </button>
      </header>

      <div className="px-2 pt-2">
        <button
          type="button"
          disabled={!!loading || full}
          aria-busy={creating || undefined}
          onClick={() => void create()}
          title={full ? `You can keep up to ${MAX_DIAGRAMS} diagrams` : 'Create a new, blank ERD'}
          className={`flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 hover:border-key hover:text-key disabled:cursor-not-allowed ${
            creating ? 'border-key text-key' : 'border-line text-muted disabled:opacity-50'
          }`}
        >
          {creating ? <LoaderCircle size={15} className="animate-spin" aria-hidden /> : <Plus size={15} />}
          {creating ? 'Creating…' : 'New ERD'}
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2">
        {diagrams.length === 0 ? (
          <ListSkeleton />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {diagrams.map((d) => (
              <Row
                key={d.id}
                diagram={d}
                active={d.id === currentId}
                editing={editingId === d.id}
                loading={loading}
                onEdit={(on) => setEditingId(on ? d.id : null)}
              />
            ))}
          </ul>
        )}
      </nav>

      <footer className="border-t border-line px-3 py-1.5 text-[12px] text-muted">
        {diagrams.length} / {MAX_DIAGRAMS} · double-click a name to rename
      </footer>
    </aside>
  )
}
