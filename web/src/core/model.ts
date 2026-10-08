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

/**
 * Hand-dragged shape of a relation line, as offsets from its default route:
 *  - x:  the vertical lane moved sideways
 *  - ys: the horizontal run on the source side moved up (negative) or down
 *  - yt: the horizontal run on the target side moved up or down
 *  - cy: Curved lines only: the middle of the curve moved up (negative) or down (x moves it sideways)
 * (`y` is not used by the route any more; it is kept so lines saved earlier still load.)
 */
export type Bend = Point & { ys?: number; yt?: number; cy?: number }

export type Reference = {
  tableId: string
  columnId: string
  onDelete?: ReferentialAction
  onUpdate?: ReferentialAction
  /** User-dragged shape of the relation line (see Bend). */
  bend?: Bend
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
  /** Table colour id (see tableColors.ts); only the Eraser theme shows it. Unset = picked automatically from the id. */
  color?: string
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
  bend?: Bend
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
