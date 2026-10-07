import { PanelLeftClose, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { MAX_DIAGRAMS, useAuth, type DiagramMeta } from '@/auth/store'
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
  disabled,
  onEdit,
}: {
  diagram: DiagramMeta
  active: boolean
  editing: boolean
  disabled: boolean
  onEdit: (editing: boolean) => void
}) {
  const openDiagram = useAuth((s) => s.openDiagram)
  const renameDiagram = useAuth((s) => s.renameDiagram)
  const deleteDiagram = useAuth((s) => s.deleteDiagram)

  const iconBtn =
    'grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-muted opacity-0 outline-none hover:bg-hover-strong hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100'

  return (
    <li
      className={`group flex items-center gap-1 rounded-md px-1.5 py-1 ${
        active ? 'bg-key/15 text-key' : 'text-ink hover:bg-hover'
      } ${disabled ? 'pointer-events-none opacity-60' : ''}`}
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
    </li>
  )
}

/** Left panel with the account's ERDs: open one, create, rename (double-click) or delete. Collapses with ». */
export function DiagramSidebar() {
  const diagrams = useAuth((s) => s.diagrams)
  const currentId = useAuth((s) => s.currentId)
  const switching = useAuth((s) => s.switching)
  const createDiagram = useAuth((s) => s.createDiagram)
  const toggleList = useStore((s) => s.toggleList)
  const [editingId, setEditingId] = useState<string | null>(null)

  const full = diagrams.length >= MAX_DIAGRAMS

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
          disabled={switching || full}
          onClick={() => void create()}
          title={full ? `You can keep up to ${MAX_DIAGRAMS} diagrams` : 'Create a new, blank ERD'}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-muted hover:border-key hover:text-key disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={15} />
          New ERD
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2">
        {diagrams.length === 0 ? (
          <p className="px-2 py-1 text-muted">Loading…</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {diagrams.map((d) => (
              <Row
                key={d.id}
                diagram={d}
                active={d.id === currentId}
                editing={editingId === d.id}
                disabled={switching}
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
