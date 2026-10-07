/**
 * One table on the canvas: an editable header (icon + name) and one row per column (name, type, default,
 * PK / NN / UQ flags). Each row has connection handles on both sides so relation lines can start or end there.
 */
import { Handle, Position, useConnection, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import type { Column } from '../core/model'
import { IconPicker } from './IconPicker'
import { TypeCombobox } from './TypeCombobox'
import { useColumnIssues } from './issuesContext'
import { resolveSqlType } from '../core/sqlType'
import { handleId, M2M_HANDLE, useStore, type TableNodeType } from '../store'

// Connection points live just inside each border, so a relation line and its crow's foot end exactly on it.
const dot =
  'size-2.5! transform-none! -translate-y-1/2 border-0! bg-edge! opacity-0 transition-opacity ' +
  'group-hover:opacity-100 hover:bg-key!'

// Target handles are two invisible half-row hit areas, so a line can be dropped anywhere on a row (even on
// another column of the same table). The visible dot comes from the source handle at the same spot.
const target = 'top-0! h-full! w-1/2! min-w-0! transform-none! rounded-none! border-0! bg-transparent!'

const inputBase =
  'nodrag min-w-0 rounded-sm border border-transparent bg-transparent px-1 py-0.5 outline-none ' +
  'hover:border-line focus:border-key focus:bg-canvas'

// The three per-column constraint toggles, in the order they appear in each row.
type FlagKey = 'primaryKey' | 'notNull' | 'unique'
const FLAGS: { key: FlagKey; label: string; title: string }[] = [
  { key: 'primaryKey', label: 'PK', title: 'PRIMARY KEY' },
  { key: 'notNull', label: 'NN', title: 'NOT NULL' },
  { key: 'unique', label: 'UQ', title: 'UNIQUE' },
]

/** A single column row. Reads only the store slices it needs, so unrelated edits do not re-render it. */
function ColumnRow({ tableId, column }: { tableId: string; column: Column }) {
  const provider = useStore((s) => s.provider)
  const updateColumn = useStore((s) => s.updateColumn)

  const issues = useColumnIssues(column.id)
  const flashing = useStore((s) => s.flashing.includes(column.id))
  const isSelected = useStore((s) => s.selectedColumn?.columnId === column.id)
  const setSelectedColumn = useStore((s) => s.setSelectedColumn)
  const issueText = issues.map((i) => `${i.label}: ${i.message}`).join('\n')
  const connecting = useConnection((c) => c.inProgress)
  // The row under the dragged line (either of its two half-row drop areas) lights up as a whole.
  const dropTarget = useConnection(
    (c) => c.inProgress && c.toNode?.id === tableId && !!c.toHandle?.id?.startsWith(column.id),
  )
  const typeCheck = resolveSqlType(column.type, provider)
  const patch = (p: Partial<Omit<Column, 'id'>>) => updateColumn(tableId, column.id, p)

  return (
    <div
      data-column-id={column.id}
      data-table-id={tableId}
      onPointerDown={() => setSelectedColumn({ tableId, columnId: column.id })}
      title={issueText || undefined}
      className={`group relative flex items-center gap-1.5 border-t border-line ${issues.length || flashing ? 'issue-row' : ''} ${dropTarget ? 'bg-key/15' : 'bg-row'} ${isSelected ? 'outline outline-1 -outline-offset-1 outline-key' : ''} px-3 py-1.5 ${
        // While a line is being dragged, let it land on the row instead of on the inputs inside it.
        connecting ? '*:not-[.react-flow__handle]:pointer-events-none' : ''
      }`}
    >
      {(['l', 'r'] as const).map((side) => (
        <Handle
          key={`t${side}`}
          type="target"
          position={side === 'l' ? Position.Left : Position.Right}
          id={handleId(column.id, side)}
          isConnectableStart={false}
          className={`${target} ${side === 'l' ? 'left-0!' : 'right-0!'} ${
            connecting ? 'pointer-events-auto!' : 'pointer-events-none!'
          }`}
        />
      ))}
      <input
        aria-label="Column name"
        className={`${inputBase} w-40 text-key`}
        value={column.name}
        spellCheck={false}
        onChange={(e) => patch({ name: e.target.value })}
      />
      <TypeCombobox
        provider={provider}
        title={typeCheck.ok ? undefined : typeCheck.error}
        className={`${inputBase} w-44 ${typeCheck.ok ? 'text-ink' : 'text-danger'}`}
        value={column.type}
        onChange={(type) => patch({ type })}
      />
      <input
        aria-label="Default value"
        placeholder="default"
        className={`${inputBase} w-32 text-num placeholder:text-muted/50`}
        value={column.default}
        spellCheck={false}
        onChange={(e) => patch({ default: e.target.value })}
      />
      <div className="ml-auto flex items-center gap-1.5 pl-2">
        {FLAGS.map((f) => (
          <button
            key={f.key}
            type="button"
            title={f.title}
            aria-pressed={column[f.key]}
            onClick={() => patch({ [f.key]: !column[f.key] })}
            className={`nodrag cursor-pointer rounded-sm border px-1.5 py-1 text-[12px] leading-none font-semibold ${
              column[f.key]
                ? 'border-key/60 bg-key/15 text-key'
                : 'border-line text-muted/60 hover:text-muted'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {(['l', 'r'] as const).map((side) => (
        <Handle
          key={`s${side}`}
          type="source"
          position={side === 'l' ? Position.Left : Position.Right}
          id={handleId(column.id, side)}
          // While dragging a line, these edge dots must not catch the drop: the row's target area underneath should.
          className={`${dot} ${side === 'l' ? 'left-0!' : 'right-0!'} ${connecting ? 'pointer-events-none!' : ''}`}
        />
      ))}
    </div>
  )
}

/** The table card itself. `selected` comes from React Flow and drives the highlighted border. */
function TableNodeView({ id, data, selected }: NodeProps<TableNodeType>) {
  const renameTable = useStore((s) => s.renameTable)
  const setTableIcon = useStore((s) => s.setTableIcon)
  const addColumn = useStore((s) => s.addColumn)

  return (
    <div
      className={`group/table min-w-[680px] rounded-sm border bg-surface font-mono text-[16px] shadow-lg shadow-black/30 ${
        selected ? 'border-key' : 'border-line'
      }`}
    >
      <div className="relative flex items-center gap-2 rounded-t-sm bg-canvas px-3 py-2">
        {/* Invisible anchors where many-to-many lines attach for existing links. */}
        {(['l', 'r'] as const).flatMap((side) =>
          (['source', 'target'] as const).map((type) => (
            <Handle
              key={`${type}${side}`}
              type={type}
              position={side === 'l' ? Position.Left : Position.Right}
              id={handleId(M2M_HANDLE, side)}
              isConnectable={false}
              className={`${side === 'l' ? 'left-0!' : 'right-0!'} transform-none! -translate-y-1/2 opacity-0!`}
            />
          )),
        )}
        <IconPicker value={data.icon} onChange={(icon) => setTableIcon(id, icon)} />
        <input
          aria-label="Table name"
          className={`${inputBase} text-[18px] font-semibold`}
          // Monospace font, so the text is exactly `ch` per character wide; add the input's padding + border.
          style={{ width: `calc(${Math.max(data.name.length, 4)}ch + 1.1rem)` }}
          value={data.name}
          spellCheck={false}
          onChange={(e) => renameTable(id, e.target.value)}
        />
        {/* Empty header space: click to select the table, drag to move it. */}
        <div className="flex-1" />
      </div>
      {data.columns.map((c) => (
        <ColumnRow key={c.id} tableId={id} column={c} />
      ))}
      <button
        type="button"
        onClick={() => addColumn(id)}
        className="nodrag w-full cursor-pointer border-t border-line px-3 py-2 hidden text-left text-muted group-hover/table:block hover:bg-row hover:text-key"
      >
        + add column
      </button>
    </div>
  )
}

export const TableNode = memo(TableNodeView)
