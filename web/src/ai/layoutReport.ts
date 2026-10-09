import { routePoints, sidesForRects } from '../core/routing'
import type { Table } from '../core/model'
import type { Canvas } from './executor'
import { HEADER, ROW, tableHeight, TABLE_WIDTH } from './tableSize'

/**
 * A plain-text check of how the canvas is laid out, for the assistant to read next to the screenshot (and instead of
 * it for models that cannot see): tables that overlap, and relation lines that would run behind a third table. It
 * measures with the sizes React Flow reported when it has them, and with the usual table size otherwise. Pure.
 */

type Rect = { name: string; id: string; x: number; y: number; w: number; h: number }

const rects = (canvas: Canvas): Rect[] =>
  canvas.nodes.map((n) => ({
    id: n.id,
    name: n.data.name,
    x: n.position.x,
    y: n.position.y,
    w: n.measured?.width ?? TABLE_WIDTH,
    h: n.measured?.height ?? tableHeight(n.data),
  }))

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Liang-Barsky: does the segment (x0,y0)-(x1,y1) pass through the rectangle? */
function crosses(x0: number, y0: number, x1: number, y1: number, r: Rect, shrink = 12): boolean {
  const left = r.x + shrink
  const right = r.x + r.w - shrink
  const top = r.y + shrink
  const bottom = r.y + r.h - shrink
  if (left >= right || top >= bottom) return false
  const dx = x1 - x0
  const dy = y1 - y0
  const p = [-dx, dx, -dy, dy]
  const q = [x0 - left, right - x0, y0 - top, bottom - y0]
  let t0 = 0
  let t1 = 1
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false
    } else {
      const t = q[i] / p[i]
      if (p[i] < 0) t0 = Math.max(t0, t)
      else t1 = Math.min(t1, t)
      if (t0 > t1) return false
    }
  }
  return true
}

export type LayoutReport = { problems: string[]; text: string }

export type PlacedTable = { table: Table; x: number; y: number; w?: number; h?: number }

/** Every relation line that, drawn by the app's router, runs behind a third table: which line, and which table is in the way. */
export function linesBehindTables(placed: PlacedTable[]): { line: string; tableId: string; tableName: string }[] {
  const all: Rect[] = placed.map((p) => ({ id: p.table.id, name: p.table.name, x: p.x, y: p.y, w: p.w ?? TABLE_WIDTH, h: p.h ?? tableHeight(p.table) }))
  const byId = new Map(all.map((r) => [r.id, r]))
  const tables = new Map(placed.map((p) => [p.table.id, p.table]))
  const out: { line: string; tableId: string; tableName: string }[] = []
  // The lines are drawn by the app's own router (leave a table sideways, run in a lane, enter the other): the same
  // route is walked here, so "behind a table" means what the person would see, not a straight-line guess.
  for (const p of placed) {
    const from = byId.get(p.table.id)!
    p.table.columns.forEach((c, row) => {
      const to = c.references && byId.get(c.references.tableId)
      if (!to || to.id === from.id) return
      const targetRow = tables.get(to.id)!.columns.findIndex((x) => x.id === c.references!.columnId)
      const [sSide, tSide] = sidesForRects({ left: from.x, right: from.x + from.w }, { left: to.x, right: to.x + to.w })
      const route = routePoints(
        sSide === 'r' ? from.x + from.w : from.x,
        from.y + HEADER + ROW * row + ROW / 2,
        sSide === 'r' ? 1 : -1,
        tSide === 'r' ? to.x + to.w : to.x,
        to.y + HEADER + ROW * Math.max(targetRow, 0) + ROW / 2,
        tSide === 'r' ? 1 : -1,
        c.references?.bend,
      )
      const behind = new Set<string>()
      for (let i = 0; i + 1 < route.length; i++) {
        for (const other of all) {
          if (other.id === from.id || other.id === to.id || behind.has(other.id)) continue
          if (crosses(route[i][0], route[i][1], route[i + 1][0], route[i + 1][1], other, 6)) behind.add(other.id)
        }
      }
      for (const id of behind) out.push({ line: `${p.table.name}.${c.name} -> ${to.name}`, tableId: id, tableName: byId.get(id)!.name })
    })
  }
  return out
}

export function layoutReport(canvas: Canvas): LayoutReport {
  const all = rects(canvas)
  const problems: string[] = []
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (overlap(all[i], all[j])) problems.push(`Tables overlap: ${all[i].name} and ${all[j].name}.`)
    }
  }
  const placed = canvas.nodes.map((n, i) => ({ table: n.data, x: all[i].x, y: all[i].y, w: all[i].w, h: all[i].h }))
  for (const b of linesBehindTables(placed)) problems.push(`The line ${b.line} runs behind table ${b.tableName}.`)
  const shown = problems.slice(0, 10)
  const extent = all.length
    ? ` The tables span ${Math.round(Math.max(...all.map((r) => r.x + r.w)) - Math.min(...all.map((r) => r.x)))} x ${Math.round(Math.max(...all.map((r) => r.y + r.h)) - Math.min(...all.map((r) => r.y)))} px.`
    : ''
  return {
    problems,
    text: problems.length
      ? `Layout problems found:\n- ${shown.join('\n- ')}${problems.length > shown.length ? `\n- ...and ${problems.length - shown.length} more` : ''}${extent}`
      : `No overlapping tables and no line runs behind a table.${extent}`,
  }
}
