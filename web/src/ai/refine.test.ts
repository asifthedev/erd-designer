import { describe, expect, it } from 'vitest'
import { generateDrizzle } from '../core/drizzle'
import { generatePrisma } from '../core/prisma'
import { checkRelations, isInvalid } from '../core/relations'
import { generateSql } from '../core/sql'
import type { Provider } from '../core/model'
import { isSequentialType, runTool, unpredictableIds, UNPREDICTABLE_ID, type Canvas } from './executor'

/**
 * "Refine for production" must never leave an id that counts 1, 2, 3. The app does that part itself (not the model), so
 * it is tested the strict way: every database, every tool, the code that comes out.
 */

let n = 0
const ctx = { maxTables: 50, uid: () => `r${++n}` }
const run = (c: Canvas, name: string, args: object) => {
  const out = runTool(c, name, JSON.stringify(args), ctx)
  expect(out.ok, out.message).toBe(true)
  return out.canvas
}

function shop(provider: Provider, idType = 'SERIAL'): Canvas {
  let c: Canvas = { provider, nodes: [], manyToMany: [] }
  const fk = idType === 'SERIAL' ? 'INT' : idType === 'BIGSERIAL' ? 'BIGINT' : idType
  return run(c, 'create_tables', {
    tables: [
      { name: 'customer', columns: [{ name: 'id', type: idType, primaryKey: true }, { name: 'email', type: 'VARCHAR(255)', notNull: true, unique: true }] },
      { name: 'product', columns: [{ name: 'id', type: idType, primaryKey: true }, { name: 'name', type: 'VARCHAR(200)', notNull: true }, { name: 'price', type: 'DECIMAL(10,2)', notNull: true }] },
      { name: 'category', columns: [{ name: 'id', type: idType, primaryKey: true }, { name: 'parent_id', type: fk, references: { table: 'category' } }] },
      { name: 'order', columns: [{ name: 'id', type: idType, primaryKey: true }, { name: 'customer_id', type: fk, notNull: true, references: { table: 'customer' } }] },
      { name: 'order_item', columns: [{ name: 'order_id', type: fk, primaryKey: true, references: { table: 'order', onDelete: 'CASCADE' } }, { name: 'product_id', type: fk, primaryKey: true, references: { table: 'product' } }, { name: 'quantity', type: 'INT', notNull: true, default: '1' }] },
    ],
  })
}

const tables = (c: Canvas) => c.nodes.map((x) => x.data)
const col = (c: Canvas, t: string, name: string) => tables(c).find((x) => x.name === t)!.columns.find((x) => x.name === name)!

describe('what counts as a sequential id', () => {
  it('knows every integer spelling', () => {
    for (const t of ['INT', 'int', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'SERIAL', 'BIGSERIAL', 'SMALLSERIAL', 'INT4', 'INT8', 'INT(11)', 'INT UNSIGNED', 'bigint unsigned', ' serial ']) expect(isSequentialType(t), t).toBe(true)
    for (const t of ['UUID', 'CHAR(36)', 'TEXT', 'VARCHAR(255)', 'DECIMAL(10,2)', 'TIMESTAMP', 'BOOLEAN', 'FLOAT', 'JSONB']) expect(isSequentialType(t), t).toBe(false)
  })
})

describe.each(['postgresql', 'mysql', 'sqlite'] as const)('making every id unguessable on %s', (provider) => {
  const target = UNPREDICTABLE_ID[provider]
  const before = shop(provider)
  const { canvas: after, changed } = unpredictableIds(before)
  const diagram = { provider, tables: tables(after), manyToMany: [] }

  it('changes every single-column integer key, and nothing else', () => {
    expect(changed.sort()).toEqual(['category', 'customer', 'order', 'product'])
    for (const t of ['customer', 'product', 'category', 'order']) expect(col(after, t, 'id')).toMatchObject({ type: target.type, default: target.default, primaryKey: true, notNull: true })
    expect(col(after, 'product', 'price').type).toBe('DECIMAL(10,2)')
    expect(col(after, 'order_item', 'quantity').type).toBe('INT') // a count is not an id
  })

  it('moves every foreign key with it, including a table pointing at itself and a junction table', () => {
    for (const [t, c] of [['category', 'parent_id'], ['order', 'customer_id'], ['order_item', 'order_id'], ['order_item', 'product_id']] as const) {
      expect(col(after, t, c).type, `${t}.${c}`).toBe(target.type)
      expect(col(after, t, c).default, `${t}.${c} is not generated`).toBe('')
    }
    expect(checkRelations(diagram).filter(isInvalid)).toEqual([])
  })

  it('is safe to run again, and leaves a table that already has a UUID or text key alone', () => {
    expect(unpredictableIds(after)).toEqual({ canvas: after, changed: [] })
    const mixed = run(before, 'alter_table', { table: 'customer', updateColumns: [{ name: 'id', type: 'VARCHAR(26)' }] })
    expect(unpredictableIds(mixed).changed).not.toContain('customer')
    expect(col(unpredictableIds(mixed).canvas, 'order', 'customer_id').type).toBe('VARCHAR(26)')
  })

  it('leaves no integer id in the code of any tool, and no warning', () => {
    const prisma = generatePrisma(diagram)
    const drizzle = generateDrizzle(diagram)
    const sql = generateSql(diagram)
    expect([...prisma.warnings, ...drizzle.warnings, ...sql.warnings]).toEqual([])
    // Prisma: every model's key is a String made by uuid(); no Int @id, no autoincrement.
    expect(prisma.schema).not.toMatch(/autoincrement|Int\s+@id|BigInt\s+@id/)
    expect(prisma.schema.match(/String\s+@id @default\(uuid\(\)\)/g)).toHaveLength(4)
    // Drizzle: no serial / integer primary key.
    expect(drizzle.schema).not.toMatch(/serial\(|integer\([^)]*\)\.primaryKey|bigint\([^)]*\)\.primaryKey|autoIncrement/i)
    // SQL: no SERIAL / AUTO_INCREMENT / AUTOINCREMENT / identity.
    expect(sql.sql).not.toMatch(/SERIAL|AUTO_?INCREMENT|IDENTITY/i)
  })

  it('writes the key the way each tool recommends', () => {
    const prisma = generatePrisma(diagram).schema
    const drizzle = generateDrizzle(diagram).schema
    const sql = generateSql(diagram).sql
    if (provider === 'postgresql') {
      expect(prisma).toContain('@default(uuid()) @db.Uuid')
      expect(drizzle).toContain("uuid('id').primaryKey().defaultRandom()")
      expect(sql).toMatch(/"id"\s+UUID\s+NOT NULL DEFAULT gen_random_uuid\(\)/)
    } else if (provider === 'mysql') {
      expect(prisma).toContain('@default(uuid()) @db.Char(36)')
      expect(drizzle).toMatch(/char\('id', \{ length: 36 \}\)\.primaryKey\(\)\.default\(sql`\(UUID\(\)\)`\)/)
      expect(sql).toMatch(/`id`\s+CHAR\(36\)/)
      expect(sql).toContain('DEFAULT (UUID())')
      expect(sql).not.toContain('((UUID()))')
    } else {
      expect(prisma).toMatch(/String\s+@id @default\(uuid\(\)\)/)
      expect(drizzle).toContain("text('id').primaryKey().$defaultFn(() => crypto.randomUUID())")
      expect(sql).toContain('"id"')
      expect(sql).toMatch(/DEFAULT \(lower\(hex\(randomblob\(4\)\)/)
    }
  })
})

describe('the use_unpredictable_ids tool', () => {
  it('does it in one call, says what changed, and is a no-op when there is nothing to change', () => {
    const out = runTool(shop('postgresql'), 'use_unpredictable_ids', '{}', ctx)
    expect(out.ok).toBe(true)
    expect(out.message).toMatch(/customer, product, category, order|category|customer/)
    expect(out.summary).toBe('Ids are now UUID in 4 tables')
    expect(col(out.canvas, 'order', 'customer_id').type).toBe('UUID')
    const again = runTool(out.canvas, 'use_unpredictable_ids', '{}', ctx)
    expect(again.ok).toBe(true)
    expect(again.canvas).toBe(out.canvas)
    expect(again.summary).toBe('Ids are already unguessable')
  })
  it('also works for a MySQL BIGINT UNSIGNED key', () => {
    const c = shop('mysql', 'BIGINT UNSIGNED')
    const out = runTool(c, 'use_unpredictable_ids', '{}', ctx)
    expect(col(out.canvas, 'customer', 'id').type).toBe('CHAR(36)')
    expect(col(out.canvas, 'order', 'customer_id').type).toBe('CHAR(36)')
  })
})

describe('the rest of a refine, done the way a model does it with the tools', () => {
  it('keeps the schema valid and writable in every tool', () => {
    for (const provider of ['postgresql', 'mysql', 'sqlite'] as const) {
      let c = unpredictableIds(shop(provider)).canvas
      const stamp = provider === 'postgresql' ? 'TIMESTAMPTZ' : 'TIMESTAMP'
      c = run(c, 'alter_table', { table: 'product', updateColumns: [{ name: 'price', type: 'DECIMAL(12,2)' }], addColumns: [{ name: 'created_at', type: stamp, notNull: true, default: 'now()' }] })
      c = run(c, 'set_relation', { table: 'order', column: 'customer_id', references: { table: 'customer', onDelete: 'RESTRICT' } })
      c = run(c, 'alter_table', { table: 'order_item', addColumns: [{ name: 'unit_price', type: 'DECIMAL(12,2)', notNull: true }] })
      const diagram = { provider, tables: tables(c), manyToMany: [] }
      expect(checkRelations(diagram).filter(isInvalid)).toEqual([])
      expect([...generatePrisma(diagram).warnings, ...generateDrizzle(diagram).warnings, ...generateSql(diagram).warnings]).toEqual([])
    }
  })
})
