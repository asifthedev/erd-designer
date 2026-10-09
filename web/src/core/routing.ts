/**
 * Where relation lines run. Pure geometry, no React, so the rules can be tested:
 *  - a line leaves each table horizontally (a "stub"), then runs vertically in one lane, then enters the other table;
 *  - it never passes through either table: tables with room between them are joined across the gap, and tables
 *    that overlap in x (or sit too close) are joined by a bracket on one shared side, outside both.
 * Moving a table re-derives all of this, so lines re-route themselves.
 */
import type { Bend } from './model'

/** Straight run out of each table, long enough to hold the cardinality glyph. */
export const STUB = 48
/** How far a bracket line goes out beyond the outer table edge before turning. */
export const TURN = 24

/** +1: the line leaves a table's right side; -1: its left side. */
export type Dir = 1 | -1
export type Side = 'l' | 'r'
export type Rect = { left: number; right: number }

/**
 * Which side of each table a line uses. Tables side by side (any gap at all) are joined across the gap; the line
 * has to, because going round would pass through one of them. Tables that overlap in x are stacked above one
 * another, so both ends use the same side, whichever needs the shorter detour, and the line runs outside both.
 */
export function sidesForRects(a: Rect, b: Rect): [Side, Side] {
  if (a.right < b.left) return ['r', 'l']
  if (b.right < a.left) return ['l', 'r']
  const outerRight = Math.max(a.right, b.right)
  const outerLeft = Math.min(a.left, b.left)
  const costRight = outerRight - a.right + (outerRight - b.right)
  const costLeft = a.left - outerLeft + (b.left - outerLeft)
  return costRight <= costLeft ? ['r', 'r'] : ['l', 'l']
}

/**
 * Length of the straight run out of each table. Normally STUB; tables that are close together share the gap
 * between them instead (half each), so the lane always fits between the tables and never cuts into one.
 */
export function stubLength(sx: number, sDir: Dir, tx: number, tDir: Dir): number {
  const gap = (tx - sx) * sDir
  return sDir !== tDir && gap > 0 ? Math.min(STUB, gap / 2) : STUB
}

/**
 * X of the vertical lane. By default halfway between the two stubs; for a bracket, just outside both. A drag
 * (`bend`) moves it sideways by exactly that much, wherever the user puts it: the automatic route is the
 * default, never a limit. (Only the automatic route is guaranteed to keep clear of the tables.)
 *
 * Lines between the same two columns would otherwise share one lane and read as a single line, so each gets a small
 * offset derived from its target row (stable across renders, different per relation).
 */
export function routeX(sx: number, sDir: Dir, tx: number, ty: number, tDir: Dir, bend?: Bend): number {
  const stub = stubLength(sx, sDir, tx, tDir)
  const ax = sx + sDir * stub
  const bx = tx + tDir * stub
  // The spread may only use the room there is between the stubs (none at all when the gap is small).
  const room = Math.abs(bx - ax) / 2
  const spread = Math.max(-room, Math.min(room, ((Math.round(ty / 42) % 5) - 2) * 14))
  const auto = sDir === tDir ? (sDir === 1 ? Math.max(ax, bx) + TURN : Math.min(ax, bx) - TURN) : (ax + bx) / 2 + spread
  return auto + (bend?.x ?? 0)
}

export type Pt = [number, number]

/**
 * The route in its three movable parts, so each can be grabbed on its own:
 *  - source: out of the source table (the stub), then the horizontal run towards the lane
 *  - lane:   the vertical segment, which moves left / right (bend.x)
 *  - target: the horizontal run from the lane, then into the target table
 * A run moves up / down (bend.ys, bend.yt); the stub stays level with its column, so the line always starts and ends
 * exactly on the column, and a small vertical step joins the stub to a moved run. Consecutive parts share a point.
 */
export function routeParts(
  sx: number,
  sy: number,
  sDir: Dir,
  tx: number,
  ty: number,
  tDir: Dir,
  bend?: Bend,
): { source: Pt[]; lane: Pt[]; target: Pt[] } {
  const stub = stubLength(sx, sDir, tx, tDir)
  const ax = sx + sDir * stub // end of the source stub
  const bx = tx + tDir * stub // end of the target stub
  const lane = routeX(sx, sDir, tx, ty, tDir, bend)
  const y1 = sy + (bend?.ys ?? 0)
  const y2 = ty + (bend?.yt ?? 0)
  return {
    source: [
      [sx, sy],
      [ax, sy],
      [ax, y1],
      [lane, y1],
    ],
    lane: [
      [lane, y1],
      [lane, y2],
    ],
    target: [
      [lane, y2],
      [bx, y2],
      [bx, ty],
      [tx, ty],
    ],
  }
}

/** Drops repeated points and points in the middle of a straight run, so a route has only its real corners. */
export function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && last[0] === p[0] && last[1] === p[1]) continue
    out.push(p)
  }
  return out.filter((p, i) => {
    if (i === 0 || i === out.length - 1) return true
    const [a, b] = [out[i - 1], out[i + 1]]
    return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]))
  })
}

/** The corners of the route from the source border point to the target border point. */
export function routePoints(
  sx: number,
  sy: number,
  sDir: Dir,
  tx: number,
  ty: number,
  tDir: Dir,
  bend?: Bend,
): Pt[] {
  const { source, lane, target } = routeParts(sx, sy, sDir, tx, ty, tDir, bend)
  return simplify([...source, ...lane.slice(1), ...target.slice(1)])
}

/** Orthogonal line style as SVG path text: a polyline through `pts` with each corner rounded by up to `radius` (less on short segments). */
export function roundedPolyline(pts: Pt[], radius: number): string {
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

/** `x,y` rounded to 2 decimals, so the path text stays short and stable. */
const n2 = (v: number) => Math.round(v * 100) / 100
const at = ([x, y]: Pt) => `${n2(x)},${n2(y)}`

/**
 * The Curved line style: one smooth Bezier from the column on one table to the column on the other, leaving and
 * arriving level, like the default curve of React Flow (so side-by-side tables get a plain S-curve). Tables whose
 * lines leave the same side get a C-curve that bulges out beyond both; the bulge never gets smaller than MIN_LOOP,
 * so a table linked to itself still draws a visible loop.
 *
 * The curve itself starts and ends at the centre of the ring of each cardinality glyph (`ends` = how far that is
 * from the table border), and the short run between the border and the ring is straight. So the line always
 * comes out of the middle of the ring, level with the column, however far apart the tables are vertically; a curve
 * starting at the border would already have turned away by the time it reached the ring.
 *
 * Moving the line: the curve is drawn as two halves meeting at its middle point M, with the tangent the single
 * curve has there. Un-moved, the two halves ARE the single curve (splitting a Bezier at t = 0.5 changes nothing).
 * A drag moves M by exactly the pointer's movement (bend.x sideways, bend.cy up / down); the ends stay put and
 * level, and the curve stays smooth through M.
 */
const MIN_LOOP = 60
const CURVATURE = 0.25 // React Flow's default
/** Distance from the table border to the ring centre when nothing more is known (a crow's foot end). */
const DEFAULT_RING = 24

/** React Flow's handle length: half the distance, or (when the other end is behind) a root-shaped bulge. */
const handleLength = (distance: number) => (distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance))

export function curveGeometry(
  sx: number,
  sy: number,
  sDir: Dir,
  tx: number,
  ty: number,
  tDir: Dir,
  bend?: Bend,
  /** Border-to-ring-centre distance at the source and at the target end (they differ for a "1" and an "n" end). */
  ends: { s: number; t: number } = { s: DEFAULT_RING, t: DEFAULT_RING },
): { d: string; mid: Pt; tan: Pt } {
  const loop = sDir === tDir ? (v: number) => Math.max(v, MIN_LOOP) : (v: number) => v
  // The curve runs between the two ring centres; the stretch from each table border to its ring is a straight line.
  const p0: Pt = [sx + sDir * ends.s, sy]
  const p3: Pt = [tx + tDir * ends.t, ty]
  const p1: Pt = [p0[0] + sDir * loop(handleLength((p3[0] - p0[0]) * sDir)), p0[1]]
  const p2: Pt = [p3[0] + tDir * loop(handleLength((p0[0] - p3[0]) * tDir)), p3[1]]

  // The single curve's middle point and tangent there, then M = that point moved by the drag.
  const mid0: Pt = [(p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8, (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8]
  const tan: Pt = [0.75 * (p3[0] + p2[0] - p1[0] - p0[0]), 0.75 * (p3[1] + p2[1] - p1[1] - p0[1])]
  const m: Pt = [mid0[0] + (bend?.x ?? 0), mid0[1] + (bend?.cy ?? 0)]

  // De Casteljau split at t = 0.5, with the middle point and tangent as the join.
  const c1: Pt = [p0[0] + (p1[0] - p0[0]) / 2, p0[1] + (p1[1] - p0[1]) / 2]
  const c2: Pt = [m[0] - tan[0] / 6, m[1] - tan[1] / 6]
  const c3: Pt = [m[0] + tan[0] / 6, m[1] + tan[1] / 6]
  const c4: Pt = [p3[0] - (p3[0] - p2[0]) / 2, p3[1] - (p3[1] - p2[1]) / 2]
  return {
    d: `M${at([sx, sy])}L${at(p0)}C${at(c1)} ${at(c2)} ${at(m)}C${at(c3)} ${at(c4)} ${at(p3)}L${at([tx, ty])}`,
    mid: m,
    tan, // direction of travel (source to target) at the middle point
  }
}
