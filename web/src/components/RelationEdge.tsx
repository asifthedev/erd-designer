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
const TURN = 24 // how far a line leaves a table before turning, when both ends are on the same side
const CORNER = 10 // radius of the rounded corners

/**
 * X of the vertical segment of the route. Lines are orthogonal (horizontal out of each table, one vertical run
 * between them), the way ER tools draw them. By default that run sits halfway between the two stubs; when both
 * ends leave the same side it goes just outside both (a neat bracket). A drag moves it left or right, but never
 * into a stub, so the glyphs always sit on straight line.
 *
 * Lines between the same two columns would otherwise share one vertical run and read as a single line, so each
 * gets a small offset derived from its target row (stable across renders, different per relation).
 */
function routeX(sx: number, sPos: Position, tx: number, ty: number, tPos: Position, bend?: Point) {
  const sDir = sPos === Position.Right ? 1 : -1
  const tDir = tPos === Position.Right ? 1 : -1
  const ax = sx + sDir * STUB
  const bx = tx + tDir * STUB
  const spread = ((Math.round(ty / 42) % 5) - 2) * 14
  let x = sDir === tDir ? (sDir === 1 ? Math.max(ax, bx) + TURN : Math.min(ax, bx) - TURN) : (ax + bx) / 2 + spread
  x += bend?.x ?? 0
  x = sDir === 1 ? Math.max(x, ax) : Math.min(x, ax)
  return tDir === 1 ? Math.max(x, bx) : Math.min(x, bx)
}

/** Where the line passes halfway (the flip button sits here): on the vertical run, midway between the two ends. */
function midpoint(sx: number, sy: number, sPos: Position, tx: number, ty: number, tPos: Position, bend?: Point) {
  return { x: routeX(sx, sPos, tx, ty, tPos, bend), y: (sy + ty) / 2 }
}

/** Polyline through `pts` with each corner rounded by up to `radius` (less on short segments). */
function roundedPolyline(pts: [number, number][], radius: number): string {
  // Drop repeated points so zero-length segments can't produce NaN directions.
  const p = pts.filter((pt, i) => i === 0 || pt[0] !== pts[i - 1][0] || pt[1] !== pts[i - 1][1])
  let d = `M${p[0][0]},${p[0][1]}`
  for (let i = 1; i < p.length - 1; i++) {
    const [px, py] = p[i - 1]
    const [cx, cy] = p[i]
    const [nx, ny] = p[i + 1]
    const inLen = Math.hypot(cx - px, cy - py)
    const outLen = Math.hypot(nx - cx, ny - cy)
    const r = Math.min(radius, inLen / 2, outLen / 2)
    d +=
      `L${cx - ((cx - px) / inLen) * r},${cy - ((cy - py) / inLen) * r}` +
      `Q${cx},${cy} ${cx + ((nx - cx) / outLen) * r},${cy + ((ny - cy) / outLen) * r}`
  }
  const last = p[p.length - 1]
  return `${d}L${last[0]},${last[1]}`
}

/**
 * Path between two table borders: out of the source straight for STUB px, a horizontal run to the vertical
 * segment (see routeX), vertical to the target's height, then horizontal into the target's stub. Corners are
 * softly rounded.
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
  const x = routeX(sx, sPos, tx, ty, tPos, bend)
  return roundedPolyline(
    [
      [sx, sy],
      [x, sy],
      [x, ty],
      [tx, ty],
    ],
    CORNER,
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
    e.preventDefault()
    // Dragging across the canvas must not select the text of the tables underneath.
    document.body.style.userSelect = 'none'
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
      document.body.style.userSelect = ''
      if (result) {
        // After a drag the pointer is released over empty canvas, so the browser's follow-up `click` lands on the
        // pane and would deselect the relation (closing its panel). Swallow that one click.
        const swallow = (ev: MouseEvent) => ev.stopPropagation()
        window.addEventListener('click', swallow, { capture: true, once: true })
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
        setRelationBend(id, result)
      }
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
