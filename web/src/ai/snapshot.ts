import type { CanvasSnapshot } from '../../../shared/aiToolSpecs'
import type { Provider, Table } from '../core/model'

/** The canvas as the assistant sees it: names only (no ids, no positions), references spelled `table.column`. */
export function canvasSnapshot(provider: Provider, tables: Table[], maxTables: number, title?: string): CanvasSnapshot {
  const nameOf = new Map(tables.map((t) => [t.id, t]))
  return {
    provider,
    maxTables,
    title,
    tables: tables.map((t) => ({
      name: t.name,
      icon: t.icon,
      color: t.color,
      columns: t.columns.map((c) => {
        const target = c.references && nameOf.get(c.references.tableId)
        const targetCol = target?.columns.find((x) => x.id === c.references!.columnId)
        return {
          name: c.name,
          type: c.type,
          ...(c.primaryKey ? { primaryKey: true } : {}),
          ...(c.notNull ? { notNull: true } : {}),
          ...(c.unique ? { unique: true } : {}),
          ...(c.default ? { default: c.default } : {}),
          ...(target && targetCol
            ? { references: { table: target.name, column: targetCol.name, ...(c.references!.onDelete ? { onDelete: c.references!.onDelete } : {}) } }
            : {}),
        }
      }),
    })),
  }
}
