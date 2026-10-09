import type { Table } from '../core/model'

/** How big a table is on the canvas: a fixed width, and a header plus one row per column. */
export const TABLE_WIDTH = 680
export const HEADER = 56
export const ROW = 43
export const tableHeight = (t: Pick<Table, 'columns'>) => HEADER + ROW * t.columns.length
