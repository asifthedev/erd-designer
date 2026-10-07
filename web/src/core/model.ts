export type Provider = 'postgresql' | 'mysql' | 'sqlite'

export const PROVIDERS: Provider[] = ['postgresql', 'mysql', 'sqlite']

export type ReferentialAction = 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' | 'SET DEFAULT'

export const REFERENTIAL_ACTIONS: ReferentialAction[] = [
  'CASCADE',
  'SET NULL',
  'RESTRICT',
  'NO ACTION',
  'SET DEFAULT',
]

/** A point / offset on the canvas, in flow coordinates. */
export type Point = { x: number; y: number }

export type Reference = {
  tableId: string
  columnId: string
  onDelete?: ReferentialAction
  onUpdate?: ReferentialAction
  /** User-dragged shape of the relation line: how far its middle was moved from the default route. */
  bend?: Point
}

export type Column = {
  id: string
  name: string
  /** Raw SQL type exactly as the user typed it, e.g. `VARCHAR(255)`. */
  type: string
  primaryKey: boolean
  notNull: boolean
  unique: boolean
  /** Raw SQL default expression, e.g. `now()`, `0`, `'draft'`. */
  default: string
  /** This column is a foreign key to another column. */
  references?: Reference
}

export type Table = {
  id: string
  name: string
  /** Lucide icon name chosen for the table header (display only; not exported to Prisma). */
  icon?: string
  columns: Column[]
}

/** Many-to-many link between two tables (may be the same table). Emitted as a Prisma implicit relation. */
export type ManyToMany = {
  id: string
  /** Table at the drag source. */
  aTableId: string
  /** Table at the drag target. */
  bTableId: string
  /** User-dragged shape of the line (see Reference.bend). */
  bend?: Point
}

export type Diagram = {
  provider: Provider
  tables: Table[]
  manyToMany?: ManyToMany[]
}

/** A foreign key on a unique (or sole primary key) column can match at most one row: one-to-one. */
export function isOneToOne(table: Table, col: Column): boolean {
  return col.unique || (col.primaryKey && table.columns.filter((c) => c.primaryKey).length === 1)
}
