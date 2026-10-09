import {
  ArrowLeftRight,
  ArrowRight,
  Info,
  Link2,
  Sparkles,
  Lock,
  RefreshCw,
  Split,
  Table2,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react'
import { createElement, type ReactNode } from 'react'
import { isOneToOne, REFERENTIAL_ACTIONS, type ReferentialAction } from '../core/model'
import { M2M_PREFIX, useStore } from '../store'
import { Select } from './Select'
import { tableIcon } from './tableIcons'

// Radix Select items can't have an empty value, so "no explicit action" gets a placeholder value.
const DEFAULT_ACTION = 'default'
type ActionValue = ReferentialAction | typeof DEFAULT_ACTION

/** One plain-language sentence for what an ON DELETE / ON UPDATE action does to this relation. */
function describeAction(
  kind: 'onDelete' | 'onUpdate',
  action: ActionValue,
  parent: string,
  child: string,
  col: string,
): string {
  const del = kind === 'onDelete'
  switch (action) {
    case 'CASCADE':
      return del
        ? `Deleting a row in ${parent} also deletes the matching rows in ${child}.`
        : `Changing a key in ${parent} updates ${child}.${col} too.`
    case 'SET NULL':
      return del
        ? `Deleting a row in ${parent} clears ${child}.${col}.`
        : `Changing a key in ${parent} clears ${child}.${col}.`
    case 'RESTRICT':
      return del
        ? `A row in ${parent} that is still used by ${child} can't be deleted.`
        : `A key in ${parent} that is still used by ${child} can't be changed.`
    case 'NO ACTION':
      return 'Like Restrict, but checked at the end of the statement.'
    case 'SET DEFAULT':
      return `${child}.${col} falls back to its default value.`
    default:
      return 'Uses the database default (usually blocks the change).'
  }
}

/** The table's chosen icon (or the default one). */
function TableGlyph({ icon, size = 14 }: { icon?: string; size?: number }) {
  return createElement(tableIcon(icon), { size, className: 'shrink-0 text-muted' })
}

/** A table + column shown as a small labelled chip. */
function Chip({
  label,
  table,
  column,
  icon,
}: {
  label: string
  table: string
  column: string
  icon?: string
}) {
  return (
    <div className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2.5 py-1.5">
      <div className="text-[11px] tracking-wide text-muted uppercase">{label}</div>
      <div className="flex min-w-0 items-center gap-1.5">
        <TableGlyph icon={icon} />
        <span className="truncate">
          <span className="font-semibold text-key">{table}</span>
          <span className="text-muted">.</span>
          <span>{column}</span>
        </span>
      </div>
    </div>
  )
}

function Header({
  badge,
  onDelete,
  onResetShape,
  children,
}: {
  badge: string
  onDelete: () => void
  /** Only given when the user has dragged the line away from its default route. */
  onResetShape?: () => void
  children?: ReactNode
}) {
  const edgeId = useStore((s) => s.selectedEdgeId)
  const askAbout = useStore((s) => s.askAbout)
  return (
    <header className="flex items-center gap-2">
      <Link2 size={18} className="text-key" />
      <h2 className="font-semibold">Relation</h2>
      <span className="rounded-full border border-key/40 bg-key/10 px-2 py-0.5 text-[12px] font-medium text-key">
        {badge}
      </span>
      {children}
      {edgeId && (
        <button
          type="button"
          title="Ask the AI about this relation"
          aria-label="Ask the AI about this relation"
          onClick={() => askAbout({ kind: 'relation', id: edgeId })}
          className="ml-auto flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 text-[12.5px] text-muted hover:border-key hover:text-key"
        >
          <Sparkles size={13} /> Ask AI
        </button>
      )}
      {onResetShape && (
        <button
          type="button"
          title="Reset line shape (it was moved by hand)"
          aria-label="Reset line shape"
          onClick={onResetShape}
          className="grid size-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"
        >
          <Undo2 size={16} />
        </button>
      )}
      <button
        type="button"
        title="Remove relation"
        aria-label="Remove relation"
        onClick={onDelete}
        className="grid size-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-danger/15 hover:text-danger"
      >
        <Trash2 size={16} />
      </button>
    </header>
  )
}

function Choice({
  icon: Icon,
  label,
  note,
  active,
  locked,
  title,
  onClick,
}: {
  icon: LucideIcon
  label: string
  note: string
  active: boolean
  locked?: boolean
  title: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={locked}
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-45 ${
        active
          ? 'border-key/60 bg-key/10 text-key'
          : 'border-line text-muted hover:border-muted hover:text-ink'
      }`}
    >
      <Icon size={17} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block leading-tight font-medium">{label}</span>
        <span className="block text-[12px] leading-tight opacity-70">{note}</span>
      </span>
      {locked && <Lock size={13} className="shrink-0" />}
    </button>
  )
}

/** Settings for the selected relation (foreign key or many-to-many link). */
export function RelationCard() {
  const selectedEdgeId = useStore((s) => s.selectedEdgeId)
  const panelOpen = useStore((s) => s.edgePanelOpen)
  const nodes = useStore((s) => s.nodes)
  const manyToMany = useStore((s) => s.manyToMany)
  const updateColumn = useStore((s) => s.updateColumn)
  const updateReference = useStore((s) => s.updateReference)
  const removeReference = useStore((s) => s.removeReference)
  const removeManyToMany = useStore((s) => s.removeManyToMany)
  const convertToJunction = useStore((s) => s.convertToJunction)
  const setRelationBend = useStore((s) => s.setRelationBend)

  if (!selectedEdgeId || !panelOpen) return null // a picked line only shows its settings once asked (double-click)

  if (selectedEdgeId.startsWith(M2M_PREFIX)) {
    const id = selectedEdgeId.slice(M2M_PREFIX.length)
    const link = manyToMany.find((l) => l.id === id)
    const a = nodes.find((n) => n.id === link?.aTableId)?.data
    const b = nodes.find((n) => n.id === link?.bTableId)?.data
    if (!link || !a || !b) return null
    return (
      <section className="space-y-4 border-b border-line px-4 py-4">
        <Header
          badge="Many to many"
          onDelete={() => removeManyToMany(id)}
          onResetShape={link.bend ? () => setRelationBend(selectedEdgeId, undefined) : undefined}
        >
          {a === b && <span className="text-[12px] text-muted">self</span>}
        </Header>
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-canvas px-2.5 py-2">
            <TableGlyph icon={a.icon} />
            <span className="truncate font-semibold text-key">{a.name}</span>
          </div>
          <ArrowLeftRight size={16} className="shrink-0 text-muted" />
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-canvas px-2.5 py-2">
            <TableGlyph icon={b.icon} />
            <span className="truncate font-semibold text-key">{b.name}</span>
          </div>
        </div>
        <p className="flex gap-2 text-[13px] leading-snug text-muted">
          <Info size={15} className="mt-0.5 shrink-0" />
          Prisma creates a hidden join table for this link.
        </p>
        <button
          type="button"
          onClick={() => convertToJunction(id)}
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border border-line px-3 py-2 text-ink hover:border-key hover:text-key"
        >
          <Table2 size={16} />
          Convert to junction table
        </button>
      </section>
    )
  }

  const [tableId, columnId] = selectedEdgeId.split(':')
  const table = nodes.find((n) => n.id === tableId)?.data
  const column = table?.columns.find((c) => c.id === columnId)
  const ref = column?.references
  const target = nodes.find((n) => n.id === ref?.tableId)?.data
  const targetCol = target?.columns.find((c) => c.id === ref?.columnId)
  if (!table || !column || !ref || !target || !targetCol) return null

  const oneToOne = isOneToOne(table, column)
  // A sole primary key is unique by definition, so the toggle can't change it.
  const locked = column.primaryKey && table.columns.filter((c) => c.primaryKey).length === 1

  const actionRow = (label: string, key: 'onDelete' | 'onUpdate', Icon: LucideIcon) => {
    const value: ActionValue = ref[key] ?? DEFAULT_ACTION
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-muted">
            <Icon size={15} />
            {label}
          </span>
          <Select<ActionValue>
            aria-label={label}
            className="min-w-40"
            value={value}
            onValueChange={(v) =>
              updateReference(tableId, columnId, { [key]: v === DEFAULT_ACTION ? undefined : v })
            }
            options={[
              { value: DEFAULT_ACTION, label: '(default)' },
              ...REFERENTIAL_ACTIONS.map((a) => ({ value: a, label: a })),
            ]}
          />
        </div>
        <p className="pl-[23px] text-[13px] leading-snug text-muted/80">
          {describeAction(key, value, target.name, table.name, column.name)}
        </p>
      </div>
    )
  }

  return (
    <section className="space-y-4 border-b border-line px-4 py-4">
      <Header
        badge={oneToOne ? 'One to one' : 'One to many'}
        onDelete={() => removeReference(tableId, columnId)}
        onResetShape={ref.bend ? () => setRelationBend(selectedEdgeId, undefined) : undefined}
      >
        {table === target && <span className="text-[12px] text-muted">self</span>}
      </Header>

      <div className="flex items-stretch gap-2">
        <Chip label="Foreign key" table={table.name} column={column.name} icon={table.icon} />
        <ArrowRight size={16} className="shrink-0 self-center text-muted" />
        <Chip label="References" table={target.name} column={targetCol.name} icon={target.icon} />
      </div>

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Choice
            icon={Split}
            label="One to many"
            note="1 : N"
            active={!oneToOne}
            locked={locked}
            title={
              locked
                ? `${column.name} is ${table.name}'s primary key, so it is unique: always one-to-one`
                : `Many ${table.name} rows per ${target.name}`
            }
            onClick={() => updateColumn(tableId, columnId, { unique: false })}
          />
          <Choice
            icon={ArrowLeftRight}
            label="One to one"
            note="1 : 1"
            active={oneToOne}
            title={`At most one ${table.name} row per ${target.name} (adds UNIQUE)`}
            onClick={() => updateColumn(tableId, columnId, { unique: true })}
          />
        </div>
        {locked && (
          <p className="flex gap-2 rounded-md border border-line bg-canvas/60 p-2.5 text-[13px] leading-snug text-muted">
            <Info size={15} className="mt-0.5 shrink-0" />
            <span>
              <span className="text-ink">{column.name}</span> is the primary key of {table.name}, so it is
              always unique. For one to many, use a separate column as the foreign key.
            </span>
          </p>
        )}
      </div>

      <div className="space-y-3 border-t border-line pt-4">
        {actionRow('On delete', 'onDelete', Trash2)}
        {actionRow('On update', 'onUpdate', RefreshCw)}
      </div>
    </section>
  )
}
