import {
  BaseEdge,
  EdgeLabelRenderer,
  Position,
  useReactFlow,
  type ConnectionLineComponentProps,
  type EdgeProps,
} from '@xyflow/react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Point } from '../core/model'
import { useStore } from '../store'

export type RelationKind = 'one-to-many' | 'one-to-one' | 'many-to-many'

type End = 'one' | 'many'

/** Cardinality at the (source, target) end of the edge. The source end holds the foreign key. */
const ENDS: Record<RelationKind, [End, End]> = {
  'one-to-many': ['many', 'one'],
  'one-to-one': ['one', 'one'],
  'many-to-many': ['many', 'many'],
}

const HALF = 10 // half-height of the bar / crow's foot spread
const BAR = 10 // distance of the "one" bar from the table border
const FOOT = 17 // distance of the crow's foot apex from the table border
const RING_R = 6
const STUB = 48 // straight run out of each table, long enough to hold the glyph

/** Where the line passes halfway: between the two straight stubs, unless the user dragged it elsewhere. */
function midpoint(
  sx: number,
  sy: number,
  sPos: Position,
  tx: number,
  ty: number,
  tPos: Position,
  bend?: Point,
) {
  const sDir = sPos === Position.Right ? 1 : -1
  const tDir = tPos === Position.Right ? 1 : -1
  return {
    x: (sx + sDir * STUB + tx + tDir * STUB) / 2 + (bend?.x ?? 0),
    y: (sy + ty) / 2 + (bend?.y ?? 0),
  }
}

/**
 * Path between two table borders: leave each border straight for STUB px (so the glyph sits on a straight
 * piece of line, facing the right way), and join the two stub ends with a smooth S-curve. With a `bend` the
 * curve is routed through the dragged middle point instead (two smooth halves that meet there).
 */
function relationPath(
  sx: number,
  sy: number,
  sPos: Position,
  tx: number,
  ty: number,
  tPos: Position,
  bend?: Point,
): string {
  const sDir = sPos === Position.Right ? 1 : -1
  const tDir = tPos === Position.Right ? 1 : -1
  const ax = sx + sDir * STUB
  const bx = tx + tDir * STUB

  if (!bend || (Math.abs(bend.x) < 1 && Math.abs(bend.y) < 1)) {
    // Control handles scale with the distance, so short hops stay tight and long ones stay smooth.
    const reach = Math.max(40, Math.min(220, Math.hypot(bx - ax, ty - sy) * 0.4))
    return (
      `M${sx},${sy}L${ax},${sy}` +
      `C${ax + sDir * reach},${sy} ${bx + tDir * reach},${ty} ${bx},${ty}` +
      `L${tx},${ty}`
    )
  }

  const m = midpoint(sx, sy, sPos, tx, ty, tPos, bend)
  // At the dragged point the line runs along the straight direction between the two stub ends: that keeps the
  // route a smooth arch whichever way the point is pulled, instead of twisting into a loop.
  const len = Math.hypot(bx - ax, ty - sy)
  const tan = len ? { x: (bx - ax) / len, y: (ty - sy) / len } : { x: sDir, y: 0 }
  const reach = (px: number, py: number, qx: number, qy: number) =>
    Math.max(30, Math.min(200, Math.hypot(qx - px, qy - py) * 0.4))
  const r1 = reach(ax, sy, m.x, m.y)
  const r2 = reach(m.x, m.y, bx, ty)
  return (
    `M${sx},${sy}L${ax},${sy}` +
    `C${ax + sDir * r1},${sy} ${m.x - tan.x * r1},${m.y - tan.y * r1} ${m.x},${m.y}` +
    `C${m.x + tan.x * r2},${m.y + tan.y * r2} ${bx + tDir * r2},${ty} ${bx},${ty}` +
    `L${tx},${ty}`
  )
}

/**
 * Cardinality glyph at one end of a line: a bar (one) or crow's foot (many), touching the table border,
 * with a ring beyond it, and a small "1" / "n" label. `dir` is +1 when the line
 * leaves the node to the right and -1 when it arrives from the left.
 */
function Glyph({ x, y, dir, end, label }: { x: number; y: number; dir: 1 | -1; end: End; label: string }) {
  const inner = end === 'one' ? BAR : FOOT
  const d =
    end === 'one'
      ? `M${x + dir * BAR},${y - HALF}V${y + HALF}`
      : `M${x + dir * FOOT},${y}L${x},${y - HALF}M${x + dir * FOOT},${y}L${x},${y}M${x + dir * FOOT},${y}L${x},${y + HALF}`
  const ringX = x + dir * (inner + RING_R + 1)
  return (
    <g pointerEvents="none">
      <path d={d} fill="none" className="relation-end" />
      <circle cx={ringX} cy={y} r={RING_R} className="relation-end relation-ring" />
      <text x={ringX} y={y - HALF - 7} textAnchor="middle" className="relation-label">
        {label}
      </text>
    </g>
  )
}

export function RelationEdge(props: EdgeProps) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } = props
  const { selected, data } = props
  const flipRelation = useStore((s) => s.flipRelation)
  const setRelationBend = useStore((s) => s.setRelationBend)
  const selectEdge = useStore((s) => s.selectEdge)
  const { screenToFlowPosition } = useReactFlow()
  const { kind = 'one-to-many', bend: savedBend } = (data ?? {}) as { kind?: RelationKind; bend?: Point }
  // While dragging, the shape lives here; it is saved once, when the pointer is released.
  const [liveBend, setLiveBend] = useState<Point | null>(null)
  const bend = liveBend ?? savedBend
  const path = relationPath(sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, bend)
  const [src, dst] = ENDS[kind]
  const stroke = selected ? 'var(--color-link)' : 'var(--color-edge)'
  const width = selected ? 2 : 1.5
  const dir = (p: Position) => (p === Position.Right ? 1 : -1) as 1 | -1
  const { x: midX, y: midY } = midpoint(
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    bend,
  )

  /** Drag anywhere on the line to move its middle (so it can be routed around other lines or tables). */
  const startDrag = (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const origin = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const base = savedBend ?? { x: 0, y: 0 }
    let result: Point | null = null
    const bendAt = (ev: PointerEvent): Point => {
      const p = screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      return { x: Math.round(base.x + p.x - origin.x), y: Math.round(base.y + p.y - origin.y) }
    }
    const move = (ev: PointerEvent) => {
      // A few pixels of wobble is still a click, not a drag.
      if (!result && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
      result = bendAt(ev)
      setLiveBend(result)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (result) setRelationBend(id, result)
      // Either way the relation is now the selected one (its panel shows the reset button).
      selectEdge(id)
      setLiveBend(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  // Flipping swaps which table is the parent; meaningless for many-to-many links and self-references.
  const canFlip = kind !== 'many-to-many' && source !== target
  const [tableId, columnId] = id.split(':')

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke, strokeWidth: width, strokeDasharray: kind === 'many-to-many' ? '6 4' : undefined }}
        interactionWidth={20}
      />
      {/* Wide invisible hit area on top of the line: dragging it reshapes the route. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={22}
        pointerEvents="stroke"
        className="nodrag nopan cursor-grab active:cursor-grabbing"
        onPointerDown={startDrag}
      />
      {/* Glowing "current" running along the line; shown by CSS on hover, and always while selected. */}
      {(['relation-flow-halo-wide', 'relation-flow-halo', 'relation-flow'] as const).map((cls) => (
        <path key={cls} d={path} className={`${cls} ${selected ? 'is-selected' : ''}`} />
      ))}
      <g style={{ color: stroke, strokeWidth: width }} className="relation-glyphs">
        <Glyph
          x={sourceX}
          y={sourceY}
          dir={dir(sourcePosition)}
          end={src}
          label={src === 'many' ? 'n' : '1'}
        />
        <Glyph
          x={targetX}
          y={targetY}
          dir={dir(targetPosition)}
          end={dst}
          label={dst === 'many' ? 'n' : '1'}
        />
      </g>
      {canFlip && (
        <EdgeLabelRenderer>
          <button
            type="button"
            title="Switch direction (swap parent and child table)"
            aria-label="Switch relation direction"
            onClick={(e) => {
              e.stopPropagation()
              flipRelation(tableId, columnId)
            }}
            style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)` }}
            className={`nodrag nopan pointer-events-auto absolute grid size-6 cursor-pointer place-items-center rounded-full border bg-canvas transition-colors hover:border-link hover:text-link ${
              selected ? 'border-link text-link' : 'border-edge text-muted'
            }`}
          >
            {/* The arrow points from the foreign key table to the table it references. */}
            {targetX >= sourceX ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/**
 * The line shown while dragging. When it hovers a column, React Flow snaps it to the middle of the (wide)
 * drop area, across the row's text. Snap it to the row's border instead, where the final line will end.
 */
export function ConnectionLine(props: ConnectionLineComponentProps) {
  const { fromX, fromY, fromPosition, fromNode, toNode, toHandle } = props
  let { toX, toY, toPosition } = props
  if (toNode && toHandle) {
    // toHandle's x/y are already the handle's centre in flow coordinates. Its width is half a row.
    const rowLeft =
      toHandle.position === Position.Left
        ? toHandle.x - toHandle.width / 2
        : toHandle.x - 1.5 * toHandle.width
    if (fromNode?.id === toNode.id) {
      // A table linked to itself loops around its right side (see sidesFor in the store).
      toX = rowLeft + 2 * toHandle.width
      toPosition = Position.Right
    } else {
      toX = toHandle.position === Position.Left ? rowLeft : rowLeft + 2 * toHandle.width
    }
    toY = toHandle.y
  }
  const path = relationPath(fromX, fromY, fromPosition, toX, toY, toPosition)
  return <path d={path} fill="none" stroke="var(--color-key)" strokeWidth={2} />
}
