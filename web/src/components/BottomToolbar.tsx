import { Panel, useReactFlow, useViewport } from '@xyflow/react'
import { ChevronsDownUp, ChevronsUpDown, Eraser, Grid3x3, Maximize, Minus, Plus, Sparkles, Table2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useStore } from '../store'

/**
 * The tools along the bottom of the canvas, like Figma's: add a table, collapse them, load the sample, clear the
 * canvas, and then zoom, fit and the grid. Icons only (the name and shortcut are in the tooltip) to keep it small.
 */

const base =
  'grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-key disabled:cursor-not-allowed disabled:opacity-40'

const tone = {
  /** The tool people reach for most: lightly filled with the accent colour. */
  primary: 'bg-key/15 text-key hover:bg-key/25',
  plain: 'text-muted hover:bg-hover hover:text-ink',
  danger: 'text-muted hover:bg-danger/15 hover:text-danger',
} as const

function Tool({
  label,
  onClick,
  children,
  active,
  disabled,
  variant = 'plain',
}: {
  label: string
  onClick: () => void
  children: ReactNode
  active?: boolean
  disabled?: boolean
  variant?: keyof typeof tone
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${active ? 'bg-key/15 text-key' : tone[variant]}`}
    >
      {children}
    </button>
  )
}

const Divider = () => <div aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />

export function BottomToolbar({ showGrid, onToggleGrid }: { showGrid: boolean; onToggleGrid: () => void }) {
  const { zoomIn, zoomOut, zoomTo, fitView, screenToFlowPosition } = useReactFlow()
  const { zoom } = useViewport()
  const addTable = useStore((s) => s.addTable)
  const loadSample = useStore((s) => s.loadSample)
  const clear = useStore((s) => s.clear)
  const collapsed = useStore((s) => s.collapsed)
  const toggleCollapsed = useStore((s) => s.toggleCollapsed)
  const hasTables = useStore((s) => s.nodes.length > 0)

  return (
    <Panel position="bottom-center">
      <div
        role="toolbar"
        aria-label="Canvas tools"
        className="font-ui mb-3 flex items-center gap-0.5 rounded-2xl border border-line bg-surface/95 p-1 shadow-xl shadow-black/40 backdrop-blur"
      >
        <Tool
          label="Add table"
          variant="primary"
          onClick={() =>
            // Drop the new table inside what the user is looking at, without changing the zoom level.
            addTable(screenToFlowPosition({ x: window.innerWidth * 0.3, y: window.innerHeight * 0.3 }))
          }
        >
          <Table2 size={17} />
        </Tool>
        <Tool
          label={collapsed ? 'Show every table in full' : 'Collapse all tables to column names and types'}
          active={collapsed}
          onClick={toggleCollapsed}
        >
          {collapsed ? <ChevronsUpDown size={17} /> : <ChevronsDownUp size={17} />}
        </Tool>
        <Tool label="Load the sample diagram" onClick={loadSample}>
          <Sparkles size={17} />
        </Tool>
        <Tool
          label="Clear the canvas"
          variant="danger"
          disabled={!hasTables}
          onClick={() => {
            // Destructive and not undoable, so ask first.
            if (window.confirm('Remove all tables?')) clear()
          }}
        >
          <Eraser size={17} />
        </Tool>

        <Divider />

        <Tool label="Zoom out" onClick={() => zoomOut({ duration: 150 })}>
          <Minus size={16} />
        </Tool>
        <button
          type="button"
          title="Reset zoom to 100%"
          aria-label="Reset zoom"
          onClick={() => zoomTo(1, { duration: 150 })}
          className="h-8 min-w-12 shrink-0 cursor-pointer rounded-lg px-1.5 text-center text-[12.5px] font-medium text-ink tabular-nums outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-key"
        >
          {Math.round(zoom * 100)}%
        </button>
        <Tool label="Zoom in" onClick={() => zoomIn({ duration: 150 })}>
          <Plus size={16} />
        </Tool>

        <Divider />

        <Tool label="Fit all tables" onClick={() => fitView({ duration: 200, maxZoom: 1 })}>
          <Maximize size={16} />
        </Tool>
        <Tool label={showGrid ? 'Hide grid' : 'Show grid'} active={showGrid} onClick={onToggleGrid}>
          <Grid3x3 size={16} />
        </Tool>
      </div>
    </Panel>
  )
}
