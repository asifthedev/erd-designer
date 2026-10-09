import type { Table } from '../core/model'

/** Tables are about this wide and this tall on the canvas (a header plus one row per column); the gap leaves a lane for the lines. */
export const TABLE_WIDTH = 680
export const COLUMN_GAP = 220
export const ROW_GAP = 80
const HEADER = 56
const ROW = 43
const MAX_COLUMN_HEIGHT = 2400

export const tableHeight = (t: Pick<Table, 'columns'>) => HEADER + ROW * t.columns.length

export type Placed = { id: string; x: number; y: number }

/**
 * Arranges tables so that referenced (parent) tables sit to the left of the tables that reference them, in columns,
 * with the order inside a column chosen so related tables sit level with each other. Only references between the
 * given tables count. Tall columns wrap into a second column. Pure: returns positions, touches nothing.
 */
export function layoutTables(tables: Table[], origin = { x: 0, y: 0 }): Placed[] {
  const byId = new Map(tables.map((t) => [t.id, t]))
  const parents = new Map<string, Set<string>>(tables.map((t) => [t.id, new Set()]))
  const children = new Map<string, Set<string>>(tables.map((t) => [t.id, new Set()]))
  for (const t of tables) {
    for (const c of t.columns) {
      const to = c.references?.tableId
      if (to && to !== t.id && byId.has(to)) {
        parents.get(t.id)!.add(to)
        children.get(to)!.add(t.id)
      }
    }
  }

  // Layer = the longest chain of parents above a table (a cycle is cut where it closes).
  const layerOf = new Map<string, number>()
  const visiting = new Set<string>()
  const layer = (id: string): number => {
    const known = layerOf.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    let l = 0
    for (const p of parents.get(id)!) l = Math.max(l, layer(p) + 1)
    visiting.delete(id)
    layerOf.set(id, l)
    return l
  }
  for (const t of tables) layer(t.id)

  const layers: Table[][] = []
  for (const t of tables) (layers[layerOf.get(t.id)!] ??= []).push(t)

  // Order inside each layer: by where the parents sit (so lines stay short), hubs and connected tables first.
  const rank = new Map<string, number>()
  layers.forEach((members) => {
    const score = (t: Table) => {
      const ps = [...parents.get(t.id)!].map((p) => rank.get(p)).filter((r): r is number => r !== undefined)
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null
    }
    members.sort((a, b) => {
      const [sa, sb] = [score(a), score(b)]
      if (sa !== null && sb !== null && sa !== sb) return sa - sb
      if ((sa === null) !== (sb === null)) return sa === null ? 1 : -1
      const [ca, cb] = [children.get(a.id)!.size + parents.get(a.id)!.size, children.get(b.id)!.size + parents.get(b.id)!.size]
      return cb - ca || a.name.localeCompare(b.name)
    })
    // Rank on a common scale (position within the layer, as a fraction) so layers of different sizes compare.
    members.forEach((t, i) => rank.set(t.id, (i + 0.5) / members.length))
  })

  const out: Placed[] = []
  let x = origin.x
  for (const members of layers) {
    if (!members) continue
    let y = origin.y
    let columnHeight = 0
    for (const t of members) {
      const h = tableHeight(t)
      if (columnHeight > 0 && columnHeight + h > MAX_COLUMN_HEIGHT) {
        x += TABLE_WIDTH + COLUMN_GAP
        y = origin.y
        columnHeight = 0
      }
      out.push({ id: t.id, x, y })
      y += h + ROW_GAP
      columnHeight += h + ROW_GAP
    }
    x += TABLE_WIDTH + COLUMN_GAP
  }
  return out
}

/** The right edge of the existing tables, so new ones can start beside them. */
export function rightEdge(nodes: { position: { x: number }; measured?: { width?: number } }[]): number {
  return nodes.reduce((max, n) => Math.max(max, n.position.x + (n.measured?.width ?? TABLE_WIDTH)), 0)
}
