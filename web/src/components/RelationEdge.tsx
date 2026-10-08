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
import type { Bend } from '../core/model'
import { curveGeometry, roundedPolyline, routeParts, routePoints, type Dir, type Pt } from '../core/routing'
import { useSettings } from '../settings'
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
/** How far the centre of the ring is from the table border: past the bar (one) or the crow's foot apex (many). */
const ringOffset = (end: End) => (end === 'one' ? BAR : FOOT) + RING_R + 1
const CORNER = 10 // radius of the rounded corners

const dirOf = (p: Position): Dir => (p === Position.Right ? 1 : -1)

/** Where the flip button sits: the middle of the vertical lane, or the middle point of a curve. */
function midpoint(
  curved: boolean,
  sx: number,
  sy: number,
  sPos: Position,
  tx: number,
  ty: number,
  tPos: Position,
  bend: Bend | undefined,
  ends: { s: number; t: number },
) {
  if (curved) {
    const [x, y] = curveGeometry(sx, sy, dirOf(sPos), tx, ty, dirOf(tPos), bend, ends).mid
    return { x, y }
  }
  const [top, bottom] = routeParts(sx, sy, dirOf(sPos), tx, ty, dirOf(tPos), bend).lane
  return { x: top[0], y: (top[1] + bottom[1]) / 2 }
}

/** Straight-edged `M x,y L x,y ...` path of a part of the route (used for the invisible grab areas). */
const polyline = (pts: Pt[]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('')

/** Which part of the line is being dragged, and so which way it can move. */
type Part = 'source' | 'lane' | 'target' | 'curve'
/** Double-headed arrows: ↔ for the vertical lane, ↕ for the two horizontal runs; a curve goes both ways (✥). */
const CURSOR: Record<Part, string> = { source: 'ns-resize', lane: 'ew-resize', target: 'ns-resize', curve: 'move' }

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
  bend?: Bend,
): string {
  return roundedPolyline(routePoints(sx, sy, dirOf(sPos), tx, ty, dirOf(tPos), bend), CORNER)
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
  const { kind = 'one-to-many', bend: savedBend, hot = false } = (data ?? {}) as { kind?: RelationKind; bend?: Bend; hot?: boolean }
  // Lit = selected, or touching the table the pointer is over: green line, glowing current.
  const lit = selected || hot
  // While dragging, the shape lives here; it is saved once, when the pointer is released.
  const [liveBend, setLiveBend] = useState<Bend | null>(null)
  const bend = liveBend ?? savedBend
  const curved = useSettings((st) => st.edgeStyle) === 'curved'
  const [src, dst] = ENDS[kind]
  // A curved line starts and ends at the centre of each ring, so it needs to know how far that is from the border.
  const ends = { s: ringOffset(src), t: ringOffset(dst) }
  const path = curved
    ? curveGeometry(sourceX, sourceY, dirOf(sourcePosition), targetX, targetY, dirOf(targetPosition), bend, ends).d
    : relationPath(sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, bend)
  const stroke = lit ? 'var(--color-link)' : 'var(--color-edge)'
  const width = lit ? 2 : 1.5
  const dir = (p: Position) => (p === Position.Right ? 1 : -1) as 1 | -1
  const { x: midX, y: midY } = midpoint(
    curved,
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    bend,
    ends,
  )

  /**
   * Drag any part of the line. Orthogonal: the vertical lane moves left / right, a horizontal run up / down.
   * Curved: the whole curve is pulled by its middle, any direction. Together that places the line anywhere (around
   * other lines or tables); the cursor shows which way it can go.
   */
  const startDrag = (part: Part) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // Dragging across the canvas must not select the text of the tables underneath, and the arrow must not flicker.
    document.body.style.userSelect = 'none'
    document.body.style.cursor = CURSOR[part]
    const origin = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const base: Bend = savedBend ?? { x: 0, y: 0 }
    let result: Bend | null = null
    const bendAt = (ev: PointerEvent): Bend => {
      const p = screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      const dx = p.x - origin.x
      const dy = p.y - origin.y
      return {
        x: Math.round(base.x + (part === 'lane' || part === 'curve' ? dx : 0)),
        y: base.y,
        ys: Math.round((base.ys ?? 0) + (part === 'source' ? dy : 0)),
        yt: Math.round((base.yt ?? 0) + (part === 'target' ? dy : 0)),
        cy: Math.round((base.cy ?? 0) + (part === 'curve' ? dy : 0)),
      }
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
      document.body.style.cursor = ''
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
  const parts = routeParts(sourceX, sourceY, dirOf(sourcePosition), targetX, targetY, dirOf(targetPosition), bend)
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
      {/* Wide invisible grab areas on top of the line, one per part (the lane last, so it wins at the corners). */}
      {(curved ? (['curve'] as const) : (['source', 'target', 'lane'] as const)).map((part) => (
        <path
          key={part}
          d={part === 'curve' ? path : polyline(parts[part])}
          fill="none"
          stroke="transparent"
          strokeWidth={22}
          pointerEvents="stroke"
          style={{ cursor: CURSOR[part] }}
          className="nodrag nopan"
          onPointerDown={startDrag(part)}
        />
      ))}
      {/* Glowing "current" running along the line; shown by CSS on hover, and always while lit (selected, or touching the hovered table). */}
      {(['relation-flow-halo-wide', 'relation-flow-halo', 'relation-flow'] as const).map((cls) => (
        <path key={cls} d={path} data-export-hide className={`${cls} ${lit ? 'is-selected' : ''}`} />
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
            data-export-hide
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
  const curved = useSettings((st) => st.edgeStyle) === 'curved'
  const path = curved
    ? curveGeometry(fromX, fromY, dirOf(fromPosition), toX, toY, dirOf(toPosition), undefined, {
        s: ringOffset('many'),
        t: ringOffset('one'),
      }).d
    : relationPath(fromX, fromY, fromPosition, toX, toY, toPosition)
  return <path d={path} fill="none" stroke="var(--color-key)" strokeWidth={2} />
}
