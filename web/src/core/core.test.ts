import { describe, expect, it } from 'vitest'
import type { Column, Diagram } from './model'
import { generatePrisma } from './prisma'
import { checkRelations, sqlTypeMismatch } from './relations'
import { generateSql } from './sql'
import { parseSqlType, resolveSqlType } from './sqlType'

const col = (id: string, name: string, type: string, extra: Partial<Column> = {}): Column => ({
  id,
  name,
  type,
  primaryKey: false,
  notNull: false,
  unique: false,
  default: '',
  ...extra,
})

describe('parseSqlType', () => {
  it('normalises aliases and arguments', () => {
    expect(parseSqlType('character varying(20)')).toMatchObject({
      ok: true,
      value: { base: 'VARCHAR', args: [20] },
    })
    expect(parseSqlType('Numeric(10, 2)')).toMatchObject({
      ok: true,
      value: { base: 'DECIMAL', args: [10, 2] },
    })
    expect(parseSqlType('int[]')).toMatchObject({ ok: true, value: { base: 'INT', array: true } })
    expect(parseSqlType('INT UNSIGNED')).toMatchObject({ ok: true, value: { unsigned: true } })
  })

  it('parses enum values', () => {
    expect(parseSqlType("ENUM('a', 'it''s')")).toMatchObject({
      ok: true,
      value: { base: 'ENUM', enumValues: ['a', "it's"] },
    })
  })

  it('rejects malformed input', () => {
    expect(parseSqlType('')).toMatchObject({ ok: false })
    expect(parseSqlType('VARCHAR(20')).toMatchObject({ ok: false })
    expect(parseSqlType('VARCHAR(x)')).toMatchObject({ ok: false })
    expect(parseSqlType('ENUM()')).toMatchObject({ ok: false })
  })
})

describe('resolveSqlType', () => {
  it('maps to Prisma scalars with native types per provider', () => {
    expect(resolveSqlType('VARCHAR(255)', 'postgresql')).toMatchObject({
      ok: true,
      value: { scalar: 'String', native: 'VarChar(255)' },
    })
    expect(resolveSqlType('TEXT', 'postgresql')).toMatchObject({ ok: true, value: { native: undefined } })
    expect(resolveSqlType('TEXT', 'mysql')).toMatchObject({ ok: true, value: { native: 'Text' } })
    expect(resolveSqlType('VARCHAR(5)', 'sqlite')).toMatchObject({ ok: true, value: { native: undefined } })
    expect(resolveSqlType('SERIAL', 'postgresql')).toMatchObject({ ok: true, value: { autoIncrement: true } })
    expect(resolveSqlType('INT UNSIGNED', 'mysql')).toMatchObject({
      ok: true,
      value: { native: 'UnsignedInt' },
    })
  })

  it('reports unsupported combinations', () => {
    expect(resolveSqlType('FOO', 'postgresql')).toMatchObject({ ok: false })
    expect(resolveSqlType('INT UNSIGNED', 'postgresql')).toMatchObject({ ok: false })
    expect(resolveSqlType('INT[]', 'mysql')).toMatchObject({ ok: false })
    expect(resolveSqlType("ENUM('a')", 'sqlite')).toMatchObject({ ok: false })
  })
})

describe('generatePrisma', () => {
  const diagram: Diagram = {
    provider: 'postgresql',
    tables: [
      {
        id: 't1',
        name: 'users',
        columns: [
          col('c1', 'id', 'SERIAL', { primaryKey: true, notNull: true }),
          col('c2', 'email', 'VARCHAR(255)', { notNull: true, unique: true }),
          col('c3', 'created_at', 'TIMESTAMP', { notNull: true, default: 'now()' }),
          col('c4', 'role', "ENUM('admin', 'member')", { notNull: true, default: "'member'" }),
        ],
      },
      {
        id: 't2',
        name: 'blog_posts',
        columns: [
          col('c5', 'id', 'UUID', { primaryKey: true, notNull: true, default: 'gen_random_uuid()' }),
          col('c6', 'author_id', 'INT', {
            notNull: true,
            references: { tableId: 't1', columnId: 'c1', onDelete: 'CASCADE' },
          }),
          col('c7', 'views', 'INT', { notNull: true, default: '0' }),
        ],
      },
    ],
  }

  it('generates models, relations and enums', () => {
    const { schema, warnings } = generatePrisma(diagram)
    expect(warnings).toEqual([])
    expect(schema).toContain('provider = "postgresql"')
    expect(schema).toContain('model Users {')
    expect(schema).toContain('@@map("users")')
    expect(schema).toMatch(/id\s+Int\s+@id @default\(autoincrement\(\)\)/)
    expect(schema).toContain('@unique @db.VarChar(255)')
    expect(schema).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\) @map\("created_at"\)/)
    expect(schema).toContain('@default(member)')
    expect(schema).toMatch(/blogPosts\s+BlogPosts\[\]/)
    expect(schema).toContain('@relation(fields: [authorId], references: [id], onDelete: Cascade)')
    expect(schema).toMatch(/author\s+Users\s+@relation/)
    expect(schema).toContain('model BlogPosts {')
    expect(schema).toContain('@default(uuid())')
    expect(schema).toContain('@default(0)')
    expect(schema).toContain('enum UsersRole {')
  })

  it('uses one-to-one for unique foreign keys and composite ids', () => {
    const { schema } = generatePrisma({
      provider: 'postgresql',
      tables: [
        { id: 'a', name: 'a', columns: [col('a1', 'id', 'INT', { primaryKey: true, notNull: true })] },
        {
          id: 'b',
          name: 'b',
          columns: [
            col('b1', 'a_id', 'INT', {
              primaryKey: true,
              notNull: true,
              references: { tableId: 'a', columnId: 'a1' },
            }),
            col('b2', 'k', 'INT', { primaryKey: true, notNull: true }),
          ],
        },
      ],
    })
    expect(schema).toContain('@@id([aId, k])')
    expect(schema).toMatch(/b\s+B\[\]/)
  })

  it('names relations when two foreign keys point at the same model', () => {
    const { schema } = generatePrisma({
      provider: 'postgresql',
      tables: [
        { id: 'u', name: 'user', columns: [col('u1', 'id', 'INT', { primaryKey: true, notNull: true })] },
        {
          id: 'm',
          name: 'message',
          columns: [
            col('m1', 'id', 'INT', { primaryKey: true, notNull: true }),
            col('m2', 'sender_id', 'INT', { notNull: true, references: { tableId: 'u', columnId: 'u1' } }),
            col('m3', 'receiver_id', 'INT', { notNull: true, references: { tableId: 'u', columnId: 'u1' } }),
          ],
        },
      ],
    })
    expect(schema).toContain('@relation("MessageSenderId"')
    expect(schema).toContain('@relation("MessageReceiverId"')
  })

  it('emits implicit many-to-many relations, including self-referencing ones', () => {
    const pk = (id: string) => col(id, 'id', 'INT', { primaryKey: true, notNull: true })
    const { schema, warnings } = generatePrisma({
      provider: 'postgresql',
      tables: [
        { id: 'p', name: 'post', columns: [pk('p1')] },
        { id: 't', name: 'tag', columns: [pk('t1')] },
        { id: 'u', name: 'user', columns: [pk('u1')] },
      ],
      manyToMany: [
        { id: '1', aTableId: 'p', bTableId: 't' },
        { id: '2', aTableId: 'u', bTableId: 'u' },
      ],
    })
    expect(warnings).toEqual([])
    expect(schema).toMatch(/tags\s+Tag\[\]\s+@relation\("PostToTag"\)/)
    expect(schema).toMatch(/posts\s+Post\[\]\s+@relation\("PostToTag"\)/)
    expect(schema).toMatch(/userA\s+User\[\]\s+@relation\("UserToUser"\)/)
    expect(schema).toMatch(/userB\s+User\[\]\s+@relation\("UserToUser"\)/)
  })

  it('skips many-to-many without a single primary key', () => {
    const { schema, warnings } = generatePrisma({
      provider: 'postgresql',
      tables: [
        { id: 'a', name: 'a', columns: [col('a1', 'x', 'INT')] },
        { id: 'b', name: 'b', columns: [col('b1', 'id', 'INT', { primaryKey: true })] },
      ],
      manyToMany: [{ id: '1', aTableId: 'a', bTableId: 'b' }],
    })
    expect(warnings.some((w) => w.includes('many-to-many'))).toBe(true)
    expect(schema).not.toContain('@relation("AToB")')
  })

  it('handles self-referencing foreign keys (one-to-many and one-to-one)', () => {
    const table = (unique: boolean) => ({
      provider: 'postgresql' as const,
      tables: [
        {
          id: 'n',
          name: 'node',
          columns: [
            col('n1', 'id', 'INT', { primaryKey: true, notNull: true }),
            col('n2', 'parent_id', 'INT', { unique, references: { tableId: 'n', columnId: 'n1' } }),
          ],
        },
      ],
    })
    expect(generatePrisma(table(false)).schema).toMatch(/nodeByParent\s+Node\[\]/)
    expect(generatePrisma(table(true)).schema).toMatch(/nodeByParent\s+Node\?/)
  })

  it('warns instead of throwing on bad input', () => {
    const { schema, warnings } = generatePrisma({
      provider: 'postgresql',
      tables: [{ id: 'a', name: 'a', columns: [col('a1', 'weird', 'NOPE')] }],
    })
    expect(schema).toContain('Unsupported("NOPE")')
    expect(warnings.length).toBe(2)
  })
})

describe('checkRelations', () => {
  const diagram = (fk: Partial<Column>, ref: Partial<Column> = {}): Diagram => ({
    provider: 'postgresql',
    tables: [
      {
        id: 'u',
        name: 'users',
        columns: [col('u1', 'id', 'INT', { primaryKey: true, notNull: true, ...ref })],
      },
      {
        id: 'p',
        name: 'posts',
        columns: [col('p1', 'user_id', 'INT', { references: { tableId: 'u', columnId: 'u1' }, ...fk })],
      },
    ],
  })

  it('is quiet for a consistent relation', () => {
    expect(checkRelations(diagram({}))).toEqual([])
    expect(checkRelations(diagram({ type: 'SERIAL' }))).toEqual([])
  })

  it('flags mismatched types with both columns', () => {
    const [issue] = checkRelations(diagram({ type: 'TIMESTAMP' }))
    expect(issue).toMatchObject({ kind: 'type', columnId: 'p1', targetColumnId: 'u1' })
    expect(issue.message).toContain('DateTime')
  })

  it('flags a non-unique target and SET NULL on NOT NULL', () => {
    expect(checkRelations(diagram({}, { primaryKey: false })).map((i) => i.kind)).toContain('unique')
    const bad = diagram({ notNull: true, references: { tableId: 'u', columnId: 'u1', onDelete: 'SET NULL' } })
    expect(checkRelations(bad).map((i) => i.kind)).toContain('nullable')
  })
})

describe('sqlTypeMismatch', () => {
  it('allows same scalar, rejects different ones', () => {
    expect(sqlTypeMismatch('INT', 'SERIAL', 'postgresql')).toBeNull()
    expect(sqlTypeMismatch('VARCHAR(20)', 'TEXT', 'postgresql')).toBeNull()
    expect(sqlTypeMismatch('INT', 'BIGINT', 'postgresql')).toContain('Int vs BigInt')
    expect(sqlTypeMismatch('UUID', 'INT', 'postgresql')).toContain('differ')
  })

  it('is stricter about integer sizes on MySQL and ignores unparsable types', () => {
    expect(sqlTypeMismatch('INT', 'SMALLINT', 'postgresql')).toBeNull()
    expect(sqlTypeMismatch('INT', 'SMALLINT', 'mysql')).toContain('MySQL')
    expect(sqlTypeMismatch('INT', 'INT UNSIGNED', 'mysql')).toContain('MySQL')
    expect(sqlTypeMismatch('INT', 'NOPE', 'postgresql')).toBeNull()
  })
})

describe('generateSql', () => {
  const diagram = (provider: Diagram['provider']): Diagram => ({
    provider,
    tables: [
      {
        id: 'u',
        name: 'users',
        columns: [
          col('u1', 'id', 'SERIAL', { primaryKey: true, notNull: true }),
          col('u2', 'email', 'VARCHAR(255)', { notNull: true, unique: true }),
          col('u3', 'created_at', 'TIMESTAMP', { notNull: true, default: 'now()' }),
          col('u4', 'role', "ENUM('a', 'b')", { default: "'a'" }),
          col('u5', 'public_id', 'UUID', { default: 'uuid()' }),
        ],
      },
      {
        id: 'p',
        name: 'posts',
        columns: [
          col('p1', 'id', 'INT', { primaryKey: true, notNull: true }),
          col('p2', 'author_id', 'INT', {
            notNull: true,
            references: { tableId: 'u', columnId: 'u1', onDelete: 'CASCADE' },
          }),
        ],
      },
      { id: 't', name: 'tags', columns: [col('t1', 'id', 'INT', { primaryKey: true, notNull: true })] },
    ],
    manyToMany: [{ id: '1', aTableId: 'p', bTableId: 't' }],
  })

  it('writes PostgreSQL DDL with enum types and ALTER TABLE foreign keys', () => {
    const { sql } = generateSql(diagram('postgresql'))
    expect(sql).toContain("CREATE TYPE \"users_role\" AS ENUM ('a', 'b');")
    expect(sql).toMatch(/"id"\s+SERIAL\s+NOT NULL/)
    expect(sql).toMatch(/"created_at"\s+TIMESTAMP\s+NOT NULL DEFAULT CURRENT_TIMESTAMP/)
    expect(sql).toContain('DEFAULT gen_random_uuid()')
    expect(sql).toContain(
      'ADD CONSTRAINT "fk_posts_author_id" FOREIGN KEY ("author_id") REFERENCES "users" ("id") ON DELETE CASCADE;',
    )
  })

  it('writes MySQL DDL with backticks, AUTO_INCREMENT and inline enums', () => {
    const { sql } = generateSql(diagram('mysql'))
    expect(sql).toMatch(/`id`\s+INT\s+NOT NULL AUTO_INCREMENT/)
    expect(sql).toContain("ENUM('a', 'b')")
    expect(sql).toContain('DEFAULT (UUID())')
    expect(sql).not.toContain('CREATE TYPE')
  })

  it('writes SQLite DDL with inline foreign keys, AUTOINCREMENT and a CHECK for enums', () => {
    const { sql, warnings } = generateSql(diagram('sqlite'))
    expect(sql).toMatch(/"id"\s+INTEGER\s+PRIMARY KEY AUTOINCREMENT/)
    expect(sql).toContain("CHECK (\"role\" IN ('a', 'b'))")
    expect(sql).toContain('CONSTRAINT "fk_posts_author_id" FOREIGN KEY')
    expect(sql).not.toContain('ALTER TABLE')
    expect(warnings.some((w) => w.includes('UUID'))).toBe(true)
  })

  it('turns many-to-many links into junction tables with a composite key', () => {
    const { sql } = generateSql(diagram('postgresql'))
    expect(sql).toContain('CREATE TABLE "posts_tags"')
    expect(sql).toContain('PRIMARY KEY ("post_id", "tag_id")')
  })
})
