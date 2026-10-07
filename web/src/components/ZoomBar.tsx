import { Panel, useReactFlow, useViewport } from '@xyflow/react'
import { Grid3x3, Maximize, Minus, Plus } from 'lucide-react'
import type { ReactNode } from 'react'

const btn =
  'grid size-9 cursor-pointer place-items-center rounded-md text-ink hover:bg-white/8 focus-visible:bg-white/8 outline-none'

function Divider() {
  return <div className="mx-1 h-6 w-px bg-line" />
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`${btn} ${active ? 'text-key' : ''}`}
    >
      {children}
    </button>
  )
}

/** Zoom controls floating at the bottom centre of the canvas: zoom out / level / zoom in, fit, grid. */
export function ZoomBar({ showGrid, onToggleGrid }: { showGrid: boolean; onToggleGrid: () => void }) {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow()
  const { zoom } = useViewport()

  return (
    <Panel position="bottom-center">
      <div className="font-ui mb-3 flex items-center gap-0.5 rounded-xl border border-line bg-surface/95 p-1.5 shadow-xl shadow-black/40 backdrop-blur">
        <IconButton label="Zoom out" onClick={() => zoomOut({ duration: 150 })}>
          <Minus size={18} />
        </IconButton>
        <button
          type="button"
          title="Reset zoom to 100%"
          aria-label="Reset zoom"
          onClick={() => zoomTo(1, { duration: 150 })}
          className="h-9 min-w-16 cursor-pointer rounded-md px-2 text-center text-[15px] font-medium text-ink tabular-nums outline-none hover:bg-white/8 focus-visible:bg-white/8"
        >
          {Math.round(zoom * 100)}%
        </button>
        <IconButton label="Zoom in" onClick={() => zoomIn({ duration: 150 })}>
          <Plus size={18} />
        </IconButton>
        <Divider />
        <IconButton label="Fit all tables" onClick={() => fitView({ duration: 200, maxZoom: 1 })}>
          <Maximize size={18} />
        </IconButton>
        <IconButton label={showGrid ? 'Hide grid' : 'Show grid'} active={showGrid} onClick={onToggleGrid}>
          <Grid3x3 size={18} />
        </IconButton>
      </div>
    </Panel>
  )
}
