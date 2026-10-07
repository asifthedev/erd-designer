/**
 * Where relation lines run. Pure geometry, no React, so the rules can be tested:
 *  - a line leaves each table horizontally (a "stub"), then runs vertically in one lane, then enters the other table;
 *  - it never passes through either table: tables with room between them are joined across the gap, and tables
 *    that overlap in x (or sit too close) are joined by a bracket on one shared side, outside both.
 * Moving a table re-derives all of this, so lines re-route themselves.
 */
import type { Point } from './model'

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
export function routeX(sx: number, sDir: Dir, tx: number, ty: number, tDir: Dir, bend?: Point): number {
  const stub = stubLength(sx, sDir, tx, tDir)
  const ax = sx + sDir * stub
  const bx = tx + tDir * stub
  // The spread may only use the room there is between the stubs (none at all when the gap is small).
  const room = Math.abs(bx - ax) / 2
  const spread = Math.max(-room, Math.min(room, ((Math.round(ty / 42) % 5) - 2) * 14))
  const auto = sDir === tDir ? (sDir === 1 ? Math.max(ax, bx) + TURN : Math.min(ax, bx) - TURN) : (ax + bx) / 2 + spread
  return auto + (bend?.x ?? 0)
}

/** The corners of the route from the source border point to the target border point. */
export function routePoints(
  sx: number,
  sy: number,
  sDir: Dir,
  tx: number,
  ty: number,
  tDir: Dir,
  bend?: Point,
): [number, number][] {
  const x = routeX(sx, sDir, tx, ty, tDir, bend)
  return [
    [sx, sy],
    [x, sy],
    [x, ty],
    [tx, ty],
  ]
}
