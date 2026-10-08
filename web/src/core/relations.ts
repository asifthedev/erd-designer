import type { Diagram, Provider } from './model'
import { resolveSqlType, type ResolvedType } from './sqlType'

export type RelationIssueKind = 'type' | 'unique' | 'nullable'

/** A logical problem with one foreign key, tied to the two columns involved. */
export type RelationIssue = {
  kind: RelationIssueKind
  tableId: string
  columnId: string
  targetTableId: string
  targetColumnId: string
  /** `users.id → posts.user_id`, for display. */
  label: string
  message: string
  /** The plain names and SQL types behind the issue, for friendly messages (see problems.ts). */
  names: {
    table: string
    column: string
    columnType: string
    targetTable: string
    targetColumn: string
    targetColumnType: string
  }
}

const typeLabel = (t: ResolvedType) => t.scalar + (t.array ? '[]' : '')

/**
 * Why a foreign key between these two column types can't work, or null when it can. Prisma needs the same
 * scalar on both sides (even where the database would accept e.g. INT -> BIGINT), and MySQL additionally
 * needs identical integer sizes / signedness.
 */
export function typeMismatch(a: ResolvedType, b: ResolvedType, provider: Provider): string | null {
  if (a.scalar !== b.scalar || a.array !== b.array) {
    return `column types differ (${typeLabel(a)} vs ${typeLabel(b)})`
  }
  if (provider === 'mysql' && (a.scalar === 'Int' || a.scalar === 'BigInt') && (a.native ?? '') !== (b.native ?? '')) {
    return `MySQL needs identical integer types (${a.native ?? 'Int'} vs ${b.native ?? 'Int'})`
  }
  return null
}

/** Mismatch between two raw SQL type strings; null when either doesn't parse (reported elsewhere). */
export function sqlTypeMismatch(a: string, b: string, provider: Provider): string | null {
  const ra = resolveSqlType(a, provider)
  const rb = resolveSqlType(b, provider)
  return ra.ok && rb.ok ? typeMismatch(ra.value, rb.value, provider) : null
}

/** Pure check of every foreign key in the diagram. */
export function checkRelations(diagram: Diagram): RelationIssue[] {
  const issues: RelationIssue[] = []
  for (const table of diagram.tables) {
    for (const col of table.columns) {
      const ref = col.references
      if (!ref) continue
      const target = diagram.tables.find((t) => t.id === ref.tableId)
      const targetCol = target?.columns.find((c) => c.id === ref.columnId)
      if (!target || !targetCol) continue

      const base = {
        tableId: table.id,
        columnId: col.id,
        targetTableId: target.id,
        targetColumnId: targetCol.id,
        label: `${table.name}.${col.name} → ${target.name}.${targetCol.name}`,
        names: {
          table: table.name,
          column: col.name,
          columnType: col.type,
          targetTable: target.name,
          targetColumn: targetCol.name,
          targetColumnType: targetCol.type,
        },
      }

      const mismatch = sqlTypeMismatch(col.type, targetCol.type, diagram.provider)
      if (mismatch) issues.push({ ...base, kind: 'type', message: mismatch })
      if (!targetCol.primaryKey && !targetCol.unique) {
        issues.push({
          ...base,
          kind: 'unique',
          message: 'referenced column should be a primary key or unique',
        })
      }
      if (ref.onDelete === 'SET NULL' && col.notNull) {
        issues.push({
          ...base,
          kind: 'nullable',
          message: 'ON DELETE SET NULL requires a nullable foreign key',
        })
      }
    }
  }
  return issues
}

/** Problems that make a foreign key impossible (as opposed to merely questionable): such relations are removed. */
export const INVALID_KINDS: RelationIssueKind[] = ['type', 'unique']

export const isInvalid = (i: RelationIssue) => INVALID_KINDS.includes(i.kind)
