import type { FocusSnapshot } from '../../../shared/aiToolSpecs'
import type { ManyToMany, Table } from '../core/model'
import { M2M_PREFIX } from '../store'

/**
 * What the person has picked on the canvas, as the assistant is told about it: every picked table, the column row
 * last clicked, and the picked relation line (or many-to-many link). Selecting IS the way to say "I mean this one":
 * the chips above the message box show it, and the question that is sent is about exactly these.
 */

export type FocusItem = {
  /** Stable across renders: what a chip is keyed and removed by. */
  key: string
  kind: 'table' | 'column' | 'relation' | 'many-to-many'
  label: string
}

type PickState = {
  nodes: { id: string; selected?: boolean; data: Table }[]
  manyToMany: ManyToMany[]
  selectedColumn: { tableId: string; columnId: string } | null
  selectedEdgeId: string | null
}

/** More than this many picked tables is "everything", not a question about specific tables. */
export const MAX_FOCUS_TABLES = 25

export function pickedItems(s: PickState): { items: FocusItem[]; snapshot: FocusSnapshot } {
  const items: FocusItem[] = []
  const snapshot: FocusSnapshot = { tables: [], columns: [], relations: [], manyToMany: [] }
  const table = (id: string) => s.nodes.find((n) => n.id === id)?.data

  const picked = s.nodes.filter((n) => n.selected)
  for (const n of picked.slice(0, MAX_FOCUS_TABLES)) {
    snapshot.tables.push(n.data.name)
    items.push({ key: `table:${n.id}`, kind: 'table', label: n.data.name })
  }
  if (picked.length > MAX_FOCUS_TABLES) items.push({ key: 'table:more', kind: 'table', label: `+${picked.length - MAX_FOCUS_TABLES} more tables` })

  if (s.selectedColumn) {
    const t = table(s.selectedColumn.tableId)
    const c = t?.columns.find((x) => x.id === s.selectedColumn!.columnId)
    if (t && c) {
      snapshot.columns.push({ table: t.name, column: c.name })
      items.push({ key: `column:${c.id}`, kind: 'column', label: `${t.name}.${c.name}` })
    }
  }

  const edge = s.selectedEdgeId
  if (edge?.startsWith(M2M_PREFIX)) {
    const link = s.manyToMany.find((l) => l.id === edge.slice(M2M_PREFIX.length))
    const [a, b] = [link && table(link.aTableId), link && table(link.bTableId)]
    if (a && b) {
      snapshot.manyToMany.push({ a: a.name, b: b.name })
      items.push({ key: edge, kind: 'many-to-many', label: `${a.name} ↔ ${b.name}` })
    }
  } else if (edge) {
    const [tableId, columnId] = edge.split(':')
    const t = table(tableId)
    const c = t?.columns.find((x) => x.id === columnId)
    const target = c?.references && table(c.references.tableId)
    const to = target?.columns.find((x) => x.id === c!.references!.columnId)
    if (t && c && target && to) {
      snapshot.relations.push({ table: t.name, column: c.name })
      items.push({ key: edge, kind: 'relation', label: `${t.name}.${c.name} → ${target.name}.${to.name}` })
    }
  }
  return { items, snapshot }
}

/** Questions worth asking about what is picked: shown as buttons so the person need not think of the words. */
export function suggestionsFor(items: FocusItem[]): string[] {
  const kinds = new Set(items.map((i) => i.kind))
  const tables = items.filter((i) => i.kind === 'table').length
  if (tables > 1 || items.length > 1) {
    return ['Why are these separate? How do they relate?', 'Is there anything redundant or missing between them?', 'Review them for problems']
  }
  if (kinds.has('table')) return ['Why is this table here?', 'What would break if I removed it?', 'Is it designed well? What would you improve?']
  if (kinds.has('column')) return ['Why is this column here?', 'Is this the right type and are the constraints right?', 'Could this be stored differently?']
  if (kinds.has('relation') || kinds.has('many-to-many')) return ['Explain this relation', 'Why is it this way round, and why this ON DELETE rule?', 'Is this relation modelled correctly?']
  return []
}
