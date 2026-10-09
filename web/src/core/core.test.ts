import { describe, expect, it } from 'vitest'
import type { Column, Diagram } from './model'
import { generatePrisma } from './prisma'
import { checkRelations, isInvalid, sqlTypeMismatch } from './relations'
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
    expect(schema).toContain('model User {') // singular model, mapped to the real table
    expect(schema).toContain('@@map("users")')
    expect(schema).toMatch(/id\s+Int\s+@id @default\(autoincrement\(\)\)/)
    expect(schema).toContain('@unique @db.VarChar(255)')
    expect(schema).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\) @map\("created_at"\)/)
    expect(schema).toContain('@default(member)')
    expect(schema).toMatch(/blogPosts\s+BlogPost\[\]/)
    expect(schema).toContain('@relation(fields: [authorId], references: [id], onDelete: Cascade)')
    expect(schema).toMatch(/author\s+User\s+@relation/)
    expect(schema).toContain('model BlogPost {')
    expect(schema).toContain('@@map("blog_posts")')
    expect(schema).toContain('@@index([authorId])') // PostgreSQL doesn't index foreign keys by itself
    expect(schema).toContain('@default(uuid())')
    expect(schema).toContain('@default(0)')
    expect(schema).toContain('enum UserRole {')
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
    expect(schema).toMatch(/bs\s+B\[\]/)
    expect(schema).not.toContain('@@index') // a_id leads the primary key, so it is already indexed
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
    expect(schema).toContain('@relation("MessageSender"')
    expect(schema).toContain('@relation("MessageReceiver"')
    expect(schema).toMatch(/messagesBySender\s+Message\[\]\s+@relation\("MessageSender"\)/)
    expect(schema).toMatch(/messagesByReceiver\s+Message\[\]\s+@relation\("MessageReceiver"\)/)
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
    expect(schema).toMatch(/usersA\s+User\[\]\s+@relation\("UserToUser"\)/)
    expect(schema).toMatch(/usersB\s+User\[\]\s+@relation\("UserToUser"\)/)
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
    expect(generatePrisma(table(false)).schema).toMatch(/nodesByParent\s+Node\[\]/)
    expect(generatePrisma(table(true)).schema).toMatch(/nodeByParent\s+Node\?/)
  })

  describe('production conventions', () => {
    const tables = (provider: 'postgresql' | 'mysql' | 'sqlite' = 'postgresql') => ({
      provider,
      tables: [
        { id: 'u', name: 'users', columns: [col('u1', 'id', 'SERIAL', { primaryKey: true, notNull: true })] },
        { id: 'c', name: 'categories', columns: [col('c1', 'id', 'SERIAL', { primaryKey: true, notNull: true })] },
        {
          id: 'p',
          name: 'posts',
          columns: [
            col('p1', 'id', 'SERIAL', { primaryKey: true, notNull: true }),
            col('p2', 'author_id', 'INT', { notNull: true, references: { tableId: 'u', columnId: 'u1' } }),
            col('p3', 'category_id', 'INT', { references: { tableId: 'c', columnId: 'c1' } }),
            col('p4', 'updated_at', 'TIMESTAMP', { notNull: true, default: 'now()' }),
            col('p5', 'created_at', 'TIMESTAMP', { notNull: true, default: 'now()' }),
          ],
        },
        {
          id: 'pr',
          name: 'profiles',
          columns: [
            col('r1', 'id', 'SERIAL', { primaryKey: true, notNull: true }),
            col('r2', 'user_id', 'INT', { notNull: true, unique: true, references: { tableId: 'u', columnId: 'u1' } }),
          ],
        },
      ],
      manyToMany: [{ id: 'm', aTableId: 'p', bTableId: 'c' }],
    })

    it('uses singular models and plural lists, never "postss"', () => {
      const { schema } = generatePrisma(tables())
      for (const m of ['User', 'Category', 'Post', 'Profile']) expect(schema).toContain(`model ${m} {`)
      expect(schema).toMatch(/categories\s+Category\[\]\s+@relation\("PostToCategory"\)/)
      expect(schema).toMatch(/\bposts\s+Post\[\]/)
      expect(schema).toMatch(/\bprofile\s+Profile\?/) // one-to-one: a single, optional
      expect(schema).not.toMatch(/\w+ss\s+\w+\[\]/) // postss, tagss...
    })

    it('indexes foreign keys on PostgreSQL and SQLite, but not MySQL (which does it itself) or unique ones', () => {
      const pg = generatePrisma(tables('postgresql')).schema
      expect(pg).toContain('@@index([authorId])')
      expect(pg).toContain('@@index([categoryId])')
      expect(pg).not.toContain('@@index([userId])') // user_id is unique: already indexed
      expect(generatePrisma(tables('sqlite')).schema).toContain('@@index([authorId])')
      expect(generatePrisma(tables('mysql')).schema).not.toContain('@@index')
    })

    it('orders block attributes @@id, @@index, @@map and keeps updated_at current with @updatedAt', () => {
      const { schema } = generatePrisma(tables())
      const post = schema.slice(schema.indexOf('model Post {'), schema.indexOf('model Profile {'))
      expect(post).toMatch(/updatedAt\s+DateTime\s+@default\(now\(\)\) @updatedAt @map\("updated_at"\)/)
      expect(post).not.toMatch(/createdAt[^\n]*@updatedAt/)
      expect(post.indexOf('@@index([authorId])')).toBeLessThan(post.indexOf('@@map("posts")'))
    })

    it('explains Prisma 7 setup in the header and lists warnings there', () => {
      const clean = generatePrisma(tables()).schema
      expect(clean.startsWith('// Prisma schema generated by erd.designer.')).toBe(true)
      expect(clean).toContain('prisma.config.ts')
      expect(clean).not.toContain('// Note:')

      const backwards = generatePrisma({
        provider: 'postgresql',
        tables: [
          { id: 'u', name: 'users', columns: [col('u1', 'id', 'SERIAL', { primaryKey: true, notNull: true, references: { tableId: 'p', columnId: 'p1' } })] },
          { id: 'p', name: 'posts', columns: [col('p1', 'id', 'SERIAL', { primaryKey: true, notNull: true }), col('p2', 'author_id', 'INT')] },
        ],
      })
      expect(backwards.warnings.join('\n')).toMatch(/users\.id: an auto-increment primary key can't also be a foreign key to posts\.id/)
      expect(backwards.schema).toContain("// Note: users.id: an auto-increment primary key can't also be a foreign key")
    })

    it('does not warn for a legitimate shared primary key (a profile whose id IS the user id)', () => {
      const { warnings } = generatePrisma({
        provider: 'postgresql',
        tables: [
          { id: 'u', name: 'users', columns: [col('u1', 'id', 'INT', { primaryKey: true, notNull: true })] },
          { id: 'p', name: 'profiles', columns: [col('p1', 'user_id', 'INT', { primaryKey: true, notNull: true, references: { tableId: 'u', columnId: 'u1' } })] },
        ],
      })
      expect(warnings).toEqual([])
    })
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
    expect(warnings.some((w) => w.includes('UUID'))).toBe(false) // SQLite gets a real default for a UUID column
    expect(sql).toMatch(/DEFAULT \(lower\(hex\(randomblob\(4\)\)/)
  })

  it('turns many-to-many links into junction tables with a composite key', () => {
    const { sql } = generateSql(diagram('postgresql'))
    expect(sql).toContain('CREATE TABLE "posts_tags"')
    expect(sql).toContain('PRIMARY KEY ("post_id", "tag_id")')
  })
})

describe('starter workspace', () => {
  it('is a valid diagram: no broken relations, SQL generates for every database', async () => {
    const { useStore } = await import('../store')
    useStore.getState().loadSample()
    const { nodes, manyToMany } = useStore.getState()
    expect(nodes.map((n) => n.data.name).sort()).toEqual(
      ['address', 'admin', 'category', 'customer', 'order', 'order_item', 'payment', 'product', 'product_image', 'product_variant'],
    )
    expect(manyToMany).toHaveLength(0)
    for (const provider of ['postgresql', 'mysql', 'sqlite'] as const) {
      const diagram = { provider, tables: nodes.map((n) => n.data), manyToMany }
      expect(checkRelations(diagram).filter(isInvalid)).toEqual([])
      expect(generateSql(diagram).warnings).toEqual([])
    }
  })
})

describe('select all tables', () => {
  it('picks every table, and clears the picked line and column', async () => {
    const { useStore } = await import('../store')
    const st = () => useStore.getState()
    st().loadSample()
    useStore.setState({ selectedEdgeId: 't1:c1', edgePanelOpen: false })
    useStore.setState({ nodes: st().nodes.map((n, i) => ({ ...n, selected: i === 0 })) }) // only the first is picked

    st().selectAllTables()
    expect(st().nodes.length).toBeGreaterThan(1)
    expect(st().nodes.every((n) => n.selected)).toBe(true)
    expect(st().selectedEdgeId).toBeNull()
    expect(st().selectedColumn).toBeNull()
  })

  it('does nothing harmful on an empty canvas, and keeps the tables themselves untouched', async () => {
    const { useStore } = await import('../store')
    const st = () => useStore.getState()
    st().clear()
    st().selectAllTables()
    expect(st().nodes).toEqual([])
    st().loadSample()
    const before = st().nodes.map((n) => ({ id: n.id, data: n.data, position: n.position }))
    st().selectAllTables()
    expect(st().nodes.map((n) => ({ id: n.id, data: n.data, position: n.position }))).toEqual(before)
  })
})

describe('side panel', () => {
  it('shows either the code or the relation settings, never both (last opened wins)', async () => {
    const { useStore } = await import('../store')
    const st = () => useStore.getState()

    useStore.setState({ codeOpen: true, selectedEdgeId: null, edgePanelOpen: false })
    st().openEdgePanel('t1:c1') // open a relation's settings while the code is showing
    expect(st().selectedEdgeId).toBe('t1:c1')
    expect(st().codeOpen).toBe(false)

    st().toggleCode() // open the code while a relation's settings are showing
    expect(st().codeOpen).toBe(true)
    expect(st().selectedEdgeId).toBeNull()
    expect(st().edgePanelOpen).toBe(false)

    st().openEdgePanel('t1:c1')
    st().openEdgePanel('t2:c2') // switching between relations keeps the code closed
    expect(st().codeOpen).toBe(false)
    expect(st().selectedEdgeId).toBe('t2:c2')

    st().closeSidebar() // closing leaves both closed
    expect(st().codeOpen).toBe(false)
    expect(st().selectedEdgeId).toBeNull()
    expect(st().edgePanelOpen).toBe(false)
  })

  it('one click on a relation line only picks it: the settings panel does not open and the code stays', async () => {
    const { useStore } = await import('../store')
    const st = () => useStore.getState()
    useStore.setState({ codeOpen: true, selectedEdgeId: null, edgePanelOpen: false })

    st().selectEdge('t1:c1')
    expect(st().selectedEdgeId).toBe('t1:c1') // the line is picked (it lights up, Delete would remove it) ...
    expect(st().edgePanelOpen).toBe(false) // ... but its settings are not shown
    expect(st().codeOpen).toBe(true) // and the code panel was not pushed out

    st().selectEdge('t2:c2') // picking another line is still just a pick
    expect(st().edgePanelOpen).toBe(false)
    expect(st().codeOpen).toBe(true)

    st().toggleCode() // closing and reopening the code does not drop the picked line
    st().toggleCode()
    expect(st().codeOpen).toBe(true)
    expect(st().selectedEdgeId).toBe('t2:c2')
  })

  it('a double-click opens the settings; once open they follow the picked line, and clearing the pick closes them for good', async () => {
    const { useStore } = await import('../store')
    const st = () => useStore.getState()
    useStore.setState({ codeOpen: true, selectedEdgeId: null, edgePanelOpen: false })

    st().openEdgePanel('t1:c1')
    expect(st().edgePanelOpen).toBe(true)
    st().selectEdge('t2:c2') // a click on another line while the panel is open: the panel shows that one
    expect(st().selectedEdgeId).toBe('t2:c2')
    expect(st().edgePanelOpen).toBe(true)

    st().selectEdge(null) // a click on the empty canvas
    expect(st().edgePanelOpen).toBe(false)
    st().selectEdge('t1:c1') // the next single click must not bring the panel back
    expect(st().edgePanelOpen).toBe(false)
  })

  it('deselecting by any other route (deleting the line, the table, ...) also resets the panel', async () => {
    const { useStore } = await import('../store')
    const st = () => useStore.getState()
    st().openEdgePanel('t1:c1')
    useStore.setState({ selectedEdgeId: null }) // e.g. the relation was deleted
    expect(st().edgePanelOpen).toBe(false)
    st().selectEdge('t3:c3')
    expect(st().edgePanelOpen).toBe(false)
  })

  it('a relation the person has just made is the exception: its settings open at once', async () => {
    const { useStore } = await import('../store')
    const st = () => useStore.getState()
    st().loadSample()
    useStore.setState({ codeOpen: true, selectedEdgeId: null, edgePanelOpen: false })
    const [users, comments] = [st().nodes.find((n) => n.data.name === 'customer')!, st().nodes.find((n) => n.data.name === 'admin')!]
    st().pickManyToMany(users.id)
    st().pickManyToMany(comments.id) // creates a many-to-many link
    expect(st().selectedEdgeId?.startsWith('m2m:')).toBe(true)
    expect(st().edgePanelOpen).toBe(true)
    expect(st().codeOpen).toBe(false)
  })
})
