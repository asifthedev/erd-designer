import { describe, expect, it } from 'vitest'
import { TOOL_NAMES, TOOL_SPECS } from '../../../shared/aiToolSpecs'
import { checkRelations, isInvalid } from '../core/relations'
import { runTool, type Canvas } from './executor'
import { layoutTables, tableHeight, TABLE_WIDTH } from './layout'
import { canvasSnapshot } from './snapshot'

let n = 0
const ctx = { maxTables: 50, uid: () => `id${++n}` }
const empty = (provider: Canvas['provider'] = 'postgresql'): Canvas => ({ provider, nodes: [], manyToMany: [] })
const run = (c: Canvas, name: string, args: object, maxTables = 50) => runTool(c, name, JSON.stringify(args), { ...ctx, maxTables })
const tables = (c: Canvas) => c.nodes.map((x) => x.data)
const table = (c: Canvas, name: string) => tables(c).find((t) => t.name === name)!
const col = (c: Canvas, t: string, name: string) => table(c, t).columns.find((x) => x.name === name)!
const broken = (c: Canvas) => checkRelations({ provider: c.provider, tables: tables(c), manyToMany: [] }).filter(isInvalid)

const shop = {
  tables: [
    { name: 'customer', icon: 'User', color: 'blue', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'email', type: 'VARCHAR(255)', notNull: true, unique: true }] },
    { name: 'order', color: 'orange', columns: [
      { name: 'id', type: 'SERIAL', primaryKey: true },
      { name: 'customer_id', type: 'INT', notNull: true, references: { table: 'customer', onDelete: 'CASCADE' } },
      { name: 'total', type: 'DECIMAL(10,2)', notNull: true },
    ] },
    { name: 'order_item', columns: [
      { name: 'order_id', type: 'INT', primaryKey: true, references: { table: 'order', column: 'id', onDelete: 'CASCADE' } },
      { name: 'sku', type: 'VARCHAR(40)', primaryKey: true },
    ] },
  ],
}

describe('the tool contract', () => {
  it('has a spec for every tool name, and the executor knows every one of them', () => {
    expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const spec of TOOL_SPECS) {
      expect(spec.description.length).toBeGreaterThan(20)
      expect(spec.parameters.type).toBe('object')
      const out = run(empty(), spec.name, {})
      expect(out.message).not.toMatch(/no tool called/) // routed, even if the (empty) arguments are refused
    }
  })
})

describe('create_tables', () => {
  it('creates tables, keys and relations in one call, with a result the model can read', () => {
    const out = run(empty(), 'create_tables', shop)
    expect(out.ok).toBe(true)
    expect(out.canvas.nodes).toHaveLength(3)
    expect(col(out.canvas, 'order', 'customer_id').references).toMatchObject({ onDelete: 'CASCADE' })
    expect(col(out.canvas, 'order', 'customer_id').references!.tableId).toBe(table(out.canvas, 'customer').id)
    expect(col(out.canvas, 'order_item', 'order_id').references!.columnId).toBe(col(out.canvas, 'order', 'id').id)
    expect(table(out.canvas, 'customer')).toMatchObject({ icon: 'User', color: 'blue' })
    expect(col(out.canvas, 'order', 'id')).toMatchObject({ primaryKey: true, notNull: true })
    expect(broken(out.canvas)).toEqual([])
    expect(out.message).toContain('order_item(order_id INT PK -> order.id')
    expect(out.summary).toBe('Created 3 tables: customer, order, order_item')
  })

  it('places new tables so none overlap, parents on the left, and beside what is already there', () => {
    const first = run(empty(), 'create_tables', shop).canvas
    const second = run(first, 'create_tables', { tables: [{ name: 'note', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }] }] }).canvas
    const right = Math.max(...first.nodes.map((x) => x.position.x)) + TABLE_WIDTH
    expect(second.nodes.at(-1)!.position.x).toBeGreaterThan(right)
    const x = (name: string) => first.nodes.find((q) => q.data.name === name)!.position.x
    expect(x('customer')).toBeLessThan(x('order'))
    expect(x('order')).toBeLessThan(x('order_item'))
  })

  it('aligns a foreign key with the type of the key it points at, and says so', () => {
    const out = run(empty(), 'create_tables', {
      tables: [
        { name: 'a', columns: [{ name: 'id', type: 'BIGSERIAL', primaryKey: true }] },
        { name: 'b', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'a_id', type: 'INT', references: { table: 'a' } }, { name: 'self', type: 'SERIAL', references: { table: 'b' } }] },
      ],
    })
    expect(out.ok).toBe(true)
    expect(col(out.canvas, 'b', 'a_id').type).toBe('BIGINT')
    expect(col(out.canvas, 'b', 'self').type).toBe('INT') // never SERIAL: a foreign key is not generated
    expect(out.message).toMatch(/b\.a_id was INT; changed to BIGINT/)
    expect(broken(out.canvas)).toEqual([])
  })

  it('is all or nothing, and tells the model exactly what to fix', () => {
    const out = run(empty(), 'create_tables', {
      tables: [
        { name: 'ok', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }] },
        { name: 'bad', columns: [{ name: 'z', type: 'NOPE(' }, { name: 'x_id', type: 'INT', references: { table: 'ghost' } }, { name: 'id', type: 'INT' }, { name: 'ID', type: 'INT' }] },
      ],
    })
    expect(out.ok).toBe(false)
    expect(out.canvas.nodes).toHaveLength(0)
    expect(out.message).toContain('Nothing was created')
    expect(out.message).toMatch(/bad\.z: type "NOPE\(" is not valid for postgresql/)
    expect(out.message).toMatch(/bad\.x_id: references unknown table "ghost"/)
    expect(out.message).toMatch(/two columns named "ID"/)
  })

  it('refuses a relation that cannot work (target not unique) and an existing name', () => {
    const base = run(empty(), 'create_tables', { tables: [{ name: 't', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'code', type: 'TEXT' }] }] }).canvas
    const bad = run(base, 'create_tables', { tables: [{ name: 'u', columns: [{ name: 'c', type: 'TEXT', references: { table: 't', column: 'code' } }] }] })
    expect(bad.ok).toBe(false)
    expect(bad.message).toMatch(/t\.code|unique|primary/i)
    const dup = run(base, 'create_tables', { tables: [{ name: 'T', columns: [{ name: 'id', type: 'INT' }] }] })
    expect(dup.message).toMatch(/already exists/)
  })

  it('respects the plan limit', () => {
    const out = run(empty(), 'create_tables', shop, 2)
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/plan allows 2 tables/)
    expect(out.summary).toBe('Table limit reached')
  })

  it('survives garbage arguments', () => {
    expect(runTool(empty(), 'create_tables', 'not json', ctx).message).toMatch(/not valid JSON/)
    expect(runTool(empty(), 'create_tables', '[1]', ctx).message).toMatch(/not valid JSON/)
    expect(run(empty(), 'create_tables', { tables: [1, null, { name: 5 }] }).ok).toBe(false)
    expect(run(empty(), 'nope', {}).message).toMatch(/no tool called/)
    expect(run(empty(), 'create_tables', { tables: [{ name: 'x', columns: [{ name: 'a', type: 'INT', references: 'users' }] }] }).ok).toBe(false)
  })

  it('ignores an icon or colour that does not exist instead of failing the whole call', () => {
    const out = run(empty(), 'create_tables', { tables: [{ name: 'x', icon: 'NotAnIcon', color: 'chartreuse', columns: [{ name: 'id', type: 'INT', primaryKey: true }] }] })
    expect(out.ok).toBe(true)
    expect(table(out.canvas, 'x').icon).toBeUndefined()
    expect(table(out.canvas, 'x').color).toBeUndefined()
  })
})

describe('alter_table', () => {
  const start = () => run(empty(), 'create_tables', shop).canvas

  it('renames, adds, changes and drops in one call', () => {
    const out = run(start(), 'alter_table', {
      table: 'customer',
      rename: 'client',
      addColumns: [{ name: 'created_at', type: 'TIMESTAMP', notNull: true, default: 'now()' }],
      updateColumns: [{ name: 'email', rename: 'mail', unique: true, type: 'TEXT' }],
    })
    expect(out.ok).toBe(true)
    expect(table(out.canvas, 'client').columns.map((c) => c.name)).toEqual(['id', 'mail', 'created_at'])
    expect(col(out.canvas, 'client', 'created_at')).toMatchObject({ default: 'now()', notNull: true })
    // The order table still points at it: references follow ids, not names.
    expect(col(out.canvas, 'order', 'customer_id').references!.tableId).toBe(table(out.canvas, 'client').id)
    expect(broken(out.canvas)).toEqual([])
  })

  it('moves foreign keys along when a key changes type, and prunes keys of a dropped column', () => {
    const retyped = run(start(), 'alter_table', { table: 'customer', updateColumns: [{ name: 'id', type: 'BIGSERIAL' }] })
    expect(retyped.ok).toBe(true)
    expect(col(retyped.canvas, 'order', 'customer_id').type).toBe('BIGINT')
    expect(retyped.message).toMatch(/order\.customer_id was changed to BIGINT/)
    expect(broken(retyped.canvas)).toEqual([])

    const dropped = run(start(), 'alter_table', { table: 'order', dropColumns: ['id'] })
    // order_item.order_id pointed at order.id; it is cut loose, not left dangling.
    expect(col(dropped.canvas, 'order_item', 'order_id').references).toBeUndefined()
    expect(dropped.message).toMatch(/order_item\.order_id no longer references/)
  })

  it('adds a foreign key through a column spec', () => {
    const c = run(start(), 'alter_table', { table: 'order_item', addColumns: [{ name: 'by', type: 'INT', references: { table: 'customer' } }] })
    expect(c.ok).toBe(true)
    expect(col(c.canvas, 'order_item', 'by').references!.tableId).toBe(table(c.canvas, 'customer').id)
  })

  it('is case-insensitive, suggests names, and leaves the canvas alone on any problem', () => {
    const c = start()
    expect(run(c, 'alter_table', { table: 'CUSTOMER', icon: 'Users' }).ok).toBe(true)
    const miss = run(c, 'alter_table', { table: 'custmer' })
    expect(miss.ok).toBe(false)
    expect(miss.message).toMatch(/Existing tables: customer, order, order_item/)
    const sugg = run(c, 'alter_table', { table: 'orders' })
    expect(sugg.message).toMatch(/Did you mean "order"/)
    const half = run(c, 'alter_table', { table: 'customer', rename: 'x', updateColumns: [{ name: 'ghost', unique: true }], addColumns: [{ name: 'id', type: 'INT' }] })
    expect(half.ok).toBe(false)
    expect(half.canvas).toBe(c)
    expect(half.message).toMatch(/ghost/)
    expect(half.message).toMatch(/already has a column "id"/)
    const clash = run(c, 'alter_table', { table: 'customer', rename: 'order' })
    expect(clash.message).toMatch(/exists/)
  })

  it('refuses to break a relation (making a referenced key non-unique)', () => {
    const out = run(start(), 'alter_table', { table: 'customer', updateColumns: [{ name: 'id', primaryKey: false }] })
    expect(out.ok).toBe(false)
    expect(out.canvas.nodes.map((x) => x.data)).toEqual(tables(start()).map((t) => ({ ...t, id: expect.any(String), columns: expect.any(Array) })))
  })
})

describe('the other tools', () => {
  const start = () => run(empty(), 'create_tables', shop).canvas

  it('drop_tables removes tables and the keys that pointed at them, nothing else', () => {
    const out = run(start(), 'drop_tables', { tables: ['order'] })
    expect(out.ok).toBe(true)
    expect(out.canvas.nodes.map((x) => x.data.name)).toEqual(['customer', 'order_item'])
    expect(col(out.canvas, 'order_item', 'order_id').references).toBeUndefined()
    expect(out.message).toMatch(/order_item\.order_id/)
    expect(run(start(), 'drop_tables', { tables: ['order', 'nope'] }).canvas.nodes).toHaveLength(3)
  })

  it('set_relation creates the column when missing, with the parent key type, and replaces an existing key', () => {
    const c = run(start(), 'create_tables', { tables: [{ name: 'tag', columns: [{ name: 'id', type: 'BIGSERIAL', primaryKey: true }] }] }).canvas
    const out = run(c, 'set_relation', { table: 'order', column: 'tag_id', references: { table: 'tag', onDelete: 'SET NULL' } })
    expect(out.ok).toBe(true)
    expect(col(out.canvas, 'order', 'tag_id')).toMatchObject({ type: 'BIGINT', references: { onDelete: 'SET NULL' } })
    const again = run(out.canvas, 'set_relation', { table: 'order', column: 'customer_id', references: { table: 'tag' } })
    expect(col(again.canvas, 'order', 'customer_id').references!.tableId).toBe(table(again.canvas, 'tag').id)
    expect(col(again.canvas, 'order', 'customer_id').type).toBe('BIGINT')
    expect(run(c, 'set_relation', { table: 'order', column: 'x', references: { table: 'ghost' } }).ok).toBe(false)
  })

  it('remove_relation clears one key and keeps the column', () => {
    const out = run(start(), 'remove_relation', { table: 'order', column: 'customer_id' })
    expect(out.ok).toBe(true)
    expect(col(out.canvas, 'order', 'customer_id').references).toBeUndefined()
    expect(run(start(), 'remove_relation', { table: 'order', column: 'total' }).message).toMatch(/not a foreign key/)
  })

  it('set_database switches and reports what no longer fits', () => {
    const c = run(empty(), 'create_tables', { tables: [{ name: 'x', columns: [{ name: 'id', type: 'UUID', primaryKey: true }, { name: 'meta', type: 'JSONB' }] }] }).canvas
    const out = run(c, 'set_database', { database: 'sqlite' })
    expect(out.canvas.provider).toBe('sqlite')
    expect(out.ok).toBe(true)
    expect(run(c, 'set_database', { database: 'oracle' }).ok).toBe(false)
  })

  it('auto_layout rearranges, create_diagram asks the caller to do it', () => {
    const c = start()
    const messy = { ...c, nodes: c.nodes.map((x) => ({ ...x, position: { x: 0, y: 0 } })) }
    const out = run(messy, 'auto_layout', {})
    expect(new Set(out.canvas.nodes.map((x) => `${x.position.x},${x.position.y}`)).size).toBe(3)
    expect(run(empty(), 'auto_layout', {}).ok).toBe(false)
    expect(run(c, 'create_diagram', { title: ' Online shop ' }).effect).toEqual({ type: 'create_diagram', title: 'Online shop' })
    expect(run(c, 'create_diagram', {}).ok).toBe(false)
  })
})

describe('layout', () => {
  const T = (id: string, rows: number, ...refs: string[]) => ({
    id,
    name: id,
    columns: [
      { id: `${id}.id`, name: 'id', type: 'INT', primaryKey: true, notNull: true, unique: false, default: '' },
      ...refs.map((r) => ({ id: `${id}.${r}`, name: r, type: 'INT', primaryKey: false, notNull: false, unique: false, default: '', references: { tableId: r, columnId: `${r}.id` } })),
      ...Array.from({ length: Math.max(0, rows - 1 - refs.length) }, (_, i) => ({ id: `${id}.c${i}`, name: `c${i}`, type: 'INT', primaryKey: false, notNull: false, unique: false, default: '' })),
    ],
  })
  const overlaps = (a: { x: number; y: number; h: number }, b: { x: number; y: number; h: number }) =>
    a.x < b.x + TABLE_WIDTH && b.x < a.x + TABLE_WIDTH && a.y < b.y + b.h && b.y < a.y + a.h

  it('never overlaps tables, even with cycles, self references and many tables', () => {
    const many = Array.from({ length: 40 }, (_, i) => T(`t${i}`, 6 + (i % 9), ...(i > 2 ? [`t${(i * 7) % i}`] : [])))
    const cyc = [T('a', 4, 'b'), T('b', 4, 'c'), T('c', 4, 'a'), T('s', 3, 's')]
    for (const set of [many, cyc, [], [T('only', 3)]]) {
      const placed = layoutTables(set)
      expect(placed).toHaveLength(set.length)
      const boxes = placed.map((p) => ({ x: p.x, y: p.y, h: tableHeight(set.find((t) => t.id === p.id)!) }))
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false)
    }
  })

  it('puts a parent to the left of its children', () => {
    const set = [T('child', 4, 'parent'), T('parent', 3), T('grandchild', 3, 'child')]
    const x = Object.fromEntries(layoutTables(set).map((p) => [p.id, p.x]))
    expect(x.parent).toBeLessThan(x.child)
    expect(x.child).toBeLessThan(x.grandchild)
  })
})

describe('canvas snapshot', () => {
  it('lists names and relations, never ids', () => {
    const c = run(empty(), 'create_tables', shop).canvas
    const snap = canvasSnapshot('postgresql', tables(c), 25, 'Shop')
    expect(snap.tables.map((t) => t.name)).toEqual(['customer', 'order', 'order_item'])
    expect(snap.tables[1].columns[1]).toEqual({ name: 'customer_id', type: 'INT', notNull: true, references: { table: 'customer', column: 'id', onDelete: 'CASCADE' } })
    expect(JSON.stringify(snap)).not.toMatch(/"id\d+"|tableId/)
    expect(snap.title).toBe('Shop')
  })
})
