import { describe, expect, it } from 'vitest'
import type { Table } from '../core/model'
import { MAX_FOCUS_TABLES, pickedItems, suggestionsFor } from './focus'

const col = (id: string, name: string, extra: object = {}) => ({ id, name, type: 'INT', primaryKey: false, notNull: false, unique: false, default: '', ...extra })
const customer: Table = { id: 't1', name: 'customer', columns: [col('c1', 'id', { primaryKey: true }), col('c2', 'email')] }
const order: Table = { id: 't2', name: 'order', columns: [col('o1', 'id', { primaryKey: true }), col('o2', 'customer_id', { references: { tableId: 't1', columnId: 'c1' } })] }
const node = (t: Table, selected = false) => ({ id: t.id, selected, data: t })
const state = (over: object = {}) => ({ nodes: [node(customer), node(order)], manyToMany: [], selectedColumn: null, selectedEdgeId: null, ...over })

describe('what is picked on the canvas', () => {
  it('is nothing until something is picked', () => {
    const p = pickedItems(state())
    expect(p.items).toEqual([])
    expect(p.snapshot).toEqual({ tables: [], columns: [], relations: [], manyToMany: [] })
  })
  it('names every picked table, so several can be asked about together', () => {
    const p = pickedItems(state({ nodes: [node(customer, true), node(order, true)] }))
    expect(p.snapshot.tables).toEqual(['customer', 'order'])
    expect(p.items.map((i) => i.label)).toEqual(['customer', 'order'])
  })
  it('names the column row last clicked', () => {
    const p = pickedItems(state({ selectedColumn: { tableId: 't2', columnId: 'o2' } }))
    expect(p.snapshot.columns).toEqual([{ table: 'order', column: 'customer_id' }])
    expect(p.items[0]).toMatchObject({ kind: 'column', label: 'order.customer_id' })
  })
  it('names a picked relation line by the foreign key and both ends', () => {
    const p = pickedItems(state({ selectedEdgeId: 't2:o2' }))
    expect(p.snapshot.relations).toEqual([{ table: 'order', column: 'customer_id' }])
    expect(p.items[0]).toMatchObject({ kind: 'relation', label: 'order.customer_id → customer.id' })
  })
  it('names a picked many-to-many link', () => {
    const p = pickedItems(state({ manyToMany: [{ id: 'l1', aTableId: 't1', bTableId: 't2' }], selectedEdgeId: 'm2m:l1' }))
    expect(p.snapshot.manyToMany).toEqual([{ a: 'customer', b: 'order' }])
    expect(p.items[0].kind).toBe('many-to-many')
  })
  it('combines a table, a column and a line', () => {
    const p = pickedItems(state({ nodes: [node(customer, true), node(order)], selectedColumn: { tableId: 't2', columnId: 'o1' }, selectedEdgeId: 't2:o2' }))
    expect(p.items.map((i) => i.kind)).toEqual(['table', 'column', 'relation'])
  })
  it('ignores a pick that no longer exists (deleted table, removed key)', () => {
    expect(pickedItems(state({ selectedColumn: { tableId: 'gone', columnId: 'x' }, selectedEdgeId: 'gone:x' })).items).toEqual([])
    expect(pickedItems(state({ selectedEdgeId: 't1:c2' })).items).toEqual([]) // a column without a foreign key is not a line
    expect(pickedItems(state({ selectedEdgeId: 'm2m:nope' })).items).toEqual([])
  })
  it('does not send everything as "the question is about these"', () => {
    const many = Array.from({ length: MAX_FOCUS_TABLES + 10 }, (_, i) => node({ id: `x${i}`, name: `t${i}`, columns: [col(`k${i}`, 'id')] }, true))
    const p = pickedItems(state({ nodes: many }))
    expect(p.snapshot.tables).toHaveLength(MAX_FOCUS_TABLES)
    expect(p.items.at(-1)?.label).toBe('+10 more tables')
  })
})

describe('suggested questions', () => {
  const kinds = (...k: string[]) => k.map((kind, i) => ({ key: `${kind}${i}`, kind: kind as 'table', label: kind }))
  it('fit what is picked', () => {
    expect(suggestionsFor(kinds('table'))[0]).toMatch(/Why is this table here/)
    expect(suggestionsFor(kinds('column'))[0]).toMatch(/Why is this column here/)
    expect(suggestionsFor(kinds('relation'))[0]).toMatch(/Explain this relation/)
    expect(suggestionsFor(kinds('table', 'table'))[0]).toMatch(/Why are these separate/)
    expect(suggestionsFor(kinds('table', 'column'))[0]).toMatch(/Why are these separate/)
    expect(suggestionsFor([])).toEqual([])
  })
})
