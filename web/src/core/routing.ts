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

/** `x,y` rounded to 2 decimals, so the path text stays short and stable. */
const n2 = (v: number) => Math.round(v * 100) / 100
const at = ([x, y]: Pt) => `${n2(x)},${n2(y)}`

/**
 * The Curved line style. Same start and end as the orthogonal route (a short straight stub out of each table keeps
 * the cardinality glyph clean), but between the stubs the line flows through one middle point M in smooth curves:
 *  - tables side by side: an S-curve, level where it leaves, passes M and arrives (it never leaves the gap)
 *  - tables stacked (both ends on the same side): a wide C-curve that bulges out beyond both, M at its outer edge
 * M starts halfway and is moved by the drag: bend.x sideways, bend.cy up / down. Nothing else is stored.
 */
export function curveGeometry(
  sx: number,
  sy: number,
  sDir: Dir,
  tx: number,
  ty: number,
  tDir: Dir,
  bend?: Bend,
): { d: string; mid: Pt } {
  const stub = stubLength(sx, sDir, tx, tDir)
  const A: Pt = [sx + sDir * stub, sy]
  const B: Pt = [tx + tDir * stub, ty]
  const M: Pt = [routeX(sx, sDir, tx, ty, tDir, bend), (sy + ty) / 2 + (bend?.cy ?? 0)]
  const head = `M${at([sx, sy])}L${at(A)}`
  const tail = `L${at([tx, ty])}`

  if (sDir !== tDir) {
    // S-curves with a level tangent at A, M and B: control points sit halfway along x, at the height of their end.
    const half = (p: Pt, q: Pt) => (p[0] + q[0]) / 2
    const x1 = half(A, M)
    const x2 = half(M, B)
    return {
      d: `${head}C${n2(x1)},${n2(A[1])} ${n2(x1)},${n2(M[1])} ${at(M)}C${n2(x2)},${n2(M[1])} ${n2(x2)},${n2(B[1])} ${at(B)}${tail}`,
      mid: M,
    }
  }
  // Same side: out to the lane, round its outer edge (vertical tangent at M), and back in.
  const y1 = (A[1] + M[1]) / 2
  const y2 = (M[1] + B[1]) / 2
  return {
    d: `${head}C${n2(M[0])},${n2(A[1])} ${n2(M[0])},${n2(y1)} ${at(M)}C${n2(M[0])},${n2(y2)} ${n2(M[0])},${n2(B[1])} ${at(B)}${tail}`,
    mid: M,
  }
}
