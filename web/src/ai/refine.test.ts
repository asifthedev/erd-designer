import { describe, expect, it } from 'vitest'
import { generateDrizzle } from '../core/drizzle'
import { checkRelations, isInvalid } from '../core/relations'
import { generatePrisma } from '../core/prisma'
import { generateSql } from '../core/sql'
import type { Provider } from '../core/model'
import { runTool, type Canvas } from './executor'

/**
 * What "Refine for production" asks the model to do (UUID keys, exact money, timezone-aware timestamps, deliberate
 * delete rules), done the way a model would do it with the tools. Whatever it does must end in a schema that the three
 * generators (Prisma, Drizzle, SQL) can write for every database, with no warning and no broken relation.
 */

let n = 0
const ctx = { maxTables: 50, uid: () => `r${++n}` }
const run = (c: Canvas, name: string, args: object) => {
  const out = runTool(c, name, JSON.stringify(args), ctx)
  expect(out.ok, out.message).toBe(true)
  return out.canvas
}

const ID: Record<Provider, { type: string; default: string }> = {
  postgresql: { type: 'UUID', default: 'gen_random_uuid()' },
  mysql: { type: 'CHAR(36)', default: '(UUID())' },
  sqlite: { type: 'TEXT', default: '(lower(hex(randomblob(16))))' },
}

function shop(provider: Provider): Canvas {
  let c: Canvas = { provider, nodes: [], manyToMany: [] }
  c = run(c, 'create_tables', {
    tables: [
      { name: 'customer', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'email', type: 'VARCHAR(255)', notNull: true, unique: true }, { name: 'created_at', type: 'TIMESTAMP', notNull: true, default: 'now()' }] },
      { name: 'product', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'name', type: 'VARCHAR(200)', notNull: true }, { name: 'price', type: 'DECIMAL(10,2)', notNull: true }] },
      { name: 'order', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'customer_id', type: 'INT', notNull: true, references: { table: 'customer' } }, { name: 'shipping_address', type: 'TEXT', notNull: true }] },
      { name: 'order_item', columns: [{ name: 'order_id', type: 'INT', primaryKey: true, references: { table: 'order', onDelete: 'CASCADE' } }, { name: 'product_id', type: 'INT', primaryKey: true, references: { table: 'product' } }, { name: 'quantity', type: 'INT', notNull: true, default: '1' }] },
    ],
  })
  return c
}

/** The refinement a good model makes: non-sequential keys everywhere, then the rest of the checklist. */
function refine(c: Canvas): Canvas {
  const { type, default: def } = ID[c.provider]
  const stamp = c.provider === 'postgresql' ? 'TIMESTAMPTZ' : 'TIMESTAMP'
  for (const table of ['customer', 'product', 'order']) c = run(c, 'alter_table', { table, updateColumns: [{ name: 'id', type, default: def }] })
  c = run(c, 'alter_table', { table: 'customer', updateColumns: [{ name: 'created_at', type: stamp }], addColumns: [{ name: 'updated_at', type: stamp, notNull: true, default: 'now()' }] })
  c = run(c, 'alter_table', { table: 'product', updateColumns: [{ name: 'price', type: 'DECIMAL(12,2)' }], addColumns: [{ name: 'created_at', type: stamp, notNull: true, default: 'now()' }] })
  c = run(c, 'alter_table', { table: 'order', addColumns: [{ name: 'created_at', type: stamp, notNull: true, default: 'now()' }, { name: 'total', type: 'DECIMAL(12,2)', notNull: true }] })
  c = run(c, 'set_relation', { table: 'order', column: 'customer_id', references: { table: 'customer', onDelete: 'RESTRICT' } })
  c = run(c, 'alter_table', { table: 'order_item', addColumns: [{ name: 'unit_price', type: 'DECIMAL(12,2)', notNull: true }] }) // a snapshot of the price at purchase time
  return c
}

const tables = (c: Canvas) => c.nodes.map((x) => x.data)
const col = (c: Canvas, t: string, name: string) => tables(c).find((x) => x.name === t)!.columns.find((x) => x.name === name)!

describe.each(['postgresql', 'mysql', 'sqlite'] as const)('a refined shop on %s', (provider) => {
  const before = shop(provider)
  const after = refine(before)
  const diagram = { provider, tables: tables(after), manyToMany: [] }

  it('has no guessable ids, and every foreign key follows its key', () => {
    for (const t of ['customer', 'product', 'order']) expect(col(after, t, 'id')).toMatchObject({ type: ID[provider].type, default: ID[provider].default, primaryKey: true })
    expect(col(after, 'order', 'customer_id').type).toBe(ID[provider].type)
    expect(col(after, 'order_item', 'order_id').type).toBe(ID[provider].type)
    expect(col(after, 'order_item', 'product_id').type).toBe(ID[provider].type)
    for (const t of tables(after)) for (const c of t.columns) expect(/serial/i.test(c.type), `${t.name}.${c.name}`).toBe(false)
  })

  it('keeps every relation valid', () => {
    expect(checkRelations(diagram).filter(isInvalid)).toEqual([])
    expect(col(after, 'order', 'customer_id').references).toMatchObject({ onDelete: 'RESTRICT' })
    expect(col(after, 'order_item', 'order_id').references).toMatchObject({ onDelete: 'CASCADE' })
  })

  it('is written by Prisma, Drizzle and SQL without a single warning', () => {
    const prisma = generatePrisma(diagram)
    const drizzle = generateDrizzle(diagram)
    const sql = generateSql(diagram)
    expect(prisma.warnings).toEqual([])
    expect(drizzle.warnings).toEqual([])
    expect(sql.warnings).toEqual([])
    expect(prisma.schema).toMatch(/model Customer \{/)
    expect(prisma.schema).toMatch(/Decimal/)
    expect(sql.sql).toMatch(/CREATE TABLE/i)
  })

  it('the id default comes out in the shape each tool expects', () => {
    const prisma = generatePrisma(diagram).schema
    const sql = generateSql(diagram).sql
    if (provider === 'postgresql') {
      expect(prisma).toMatch(/@default\(uuid\(\)\)/)
      expect(sql).toMatch(/gen_random_uuid\(\)/)
      expect(generateDrizzle(diagram).schema).toMatch(/uuid\(/)
    } else {
      expect(prisma).toMatch(/@id/)
      expect(sql).not.toMatch(/SERIAL|AUTO_INCREMENT|AUTOINCREMENT/i)
    }
  })

  it('keeps the history: the price a customer paid is stored on the order line', () => {
    expect(col(after, 'order_item', 'unit_price')).toMatchObject({ type: 'DECIMAL(12,2)', notNull: true })
  })
})
