/// <reference types="node" />
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateDrizzle } from './drizzle'
import type { Column, Diagram, Provider, Table } from './model'

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

/** A diagram that leans on everything the generator handles; `provider` decides the dialect-only columns. */
function kitchenSink(provider: Provider): Diagram {
  const users: Table = {
    id: 'users',
    name: 'users',
    columns: [
      col('u_id', 'id', 'SERIAL', { primaryKey: true, notNull: true }),
      col('u_email', 'email', 'VARCHAR(255)', { notNull: true, unique: true }),
      col('u_bio', 'bio', 'TEXT'),
      col('u_active', 'is_active', 'BOOLEAN', { notNull: true, default: 'true' }),
      col('u_score', 'score', 'DECIMAL(10, 2)', { default: '0' }),
      col('u_created', 'created_at', 'TIMESTAMP', { notNull: true, default: 'now()' }),
      col('u_prefs', 'prefs', 'JSON'),
      col('u_avatar', 'avatar', 'BLOB'),
      col('u_manager', 'manager_id', 'INT', { references: { tableId: 'users', columnId: 'u_id', onDelete: 'SET NULL' } }),
      ...(provider === 'postgresql'
        ? [
            col('u_role', 'role', "ENUM('admin', 'member')", { notNull: true, default: "'member'" }),
            col('u_tags', 'tags', 'TEXT[]'),
            col('u_ref', 'ref', 'UUID', { default: 'gen_random_uuid()' }),
          ]
        : []),
      ...(provider === 'mysql'
        ? [col('u_role', 'role', "ENUM('admin', 'member')", { notNull: true }), col('u_age', 'age', 'INT UNSIGNED')]
        : []),
    ],
  }
  const posts: Table = {
    id: 'posts',
    name: 'posts',
    columns: [
      col('p_id', 'id', 'SERIAL', { primaryKey: true, notNull: true }),
      col('p_title', 'title', 'VARCHAR(200)', { notNull: true }),
      col('p_author', 'author_id', 'INT', {
        notNull: true,
        references: { tableId: 'users', columnId: 'u_id', onDelete: 'CASCADE', onUpdate: 'RESTRICT' },
      }),
      // A second foreign key to the same table: the relations need names to be told apart.
      col('p_editor', 'editor_id', 'INT', { references: { tableId: 'users', columnId: 'u_id' } }),
      col('p_views', 'views', 'BIGINT', { notNull: true, default: '0' }),
    ],
  }
  const profiles: Table = {
    id: 'profiles',
    name: 'profiles',
    columns: [
      col('f_id', 'id', 'SERIAL', { primaryKey: true, notNull: true }),
      col('f_user', 'user_id', 'INT', {
        notNull: true,
        unique: true,
        references: { tableId: 'users', columnId: 'u_id', onDelete: 'CASCADE' },
      }),
    ],
  }
  const tags: Table = {
    id: 'tags',
    name: 'tags',
    columns: [col('t_id', 'id', 'SERIAL', { primaryKey: true, notNull: true }), col('t_name', 'name', 'VARCHAR(50)', { unique: true })],
  }
  // Composite primary key, and names that collide with Drizzle's own exports.
  const links: Table = {
    id: 'links',
    name: 'text',
    columns: [
      col('l_a', 'post_id', 'INT', { primaryKey: true, references: { tableId: 'posts', columnId: 'p_id', onDelete: 'CASCADE' } }),
      col('l_b', 'select', 'INT', { primaryKey: true }),
    ],
  }
  return {
    provider,
    tables: [users, posts, profiles, tags, links],
    manyToMany: [{ id: 'm1', aTableId: 'posts', bTableId: 'tags' }],
  }
}

const dir = path.resolve(import.meta.dirname, '../../.drizzle-test')
const PROVIDERS: Provider[] = ['postgresql', 'mysql', 'sqlite']
const files = new Map<Provider, string>()

beforeAll(() => {
  mkdirSync(dir, { recursive: true })
  for (const p of PROVIDERS) {
    const file = path.join(dir, `${p}.ts`)
    writeFileSync(file, generateDrizzle(kitchenSink(p)).schema)
    files.set(p, file)
  }
})
// Set KEEP_DRIZZLE_TEST=1 to inspect the generated files afterwards.
afterAll(() => {
  if (!process.env.KEEP_DRIZZLE_TEST) rmSync(dir, { recursive: true, force: true })
})

describe('generateDrizzle', () => {
  it('produces code the TypeScript compiler accepts against the real drizzle-orm types', () => {
    const program = ts.createProgram([...files.values()], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: ['node'],
      noUnusedLocals: true,
    })
    const problems = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file && [...files.values()].includes(path.resolve(d.file.fileName)))
      .map((d) => `${path.basename(d.file!.fileName)}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
    expect(problems).toEqual([])
  }, 120_000)

  it('PostgreSQL: maps types, keys, defaults and foreign keys', async () => {
    const { getTableConfig } = await import('drizzle-orm/pg-core')
    const mod = await import(/* @vite-ignore */ files.get('postgresql')!)
    const users = getTableConfig(mod.users)
    const byName = Object.fromEntries(users.columns.map((c) => [c.name, c]))
    expect(users.name).toBe('users')
    expect(byName.id.primary).toBe(true)
    expect(byName.id.getSQLType()).toBe('serial')
    expect(byName.email.getSQLType()).toBe('varchar(255)')
    expect(byName.email.notNull && byName.email.isUnique).toBe(true)
    expect(byName.is_active.default).toBe(true)
    expect(byName.created_at.hasDefault).toBe(true)
    expect(byName.tags.getSQLType()).toBe('text[]')
    expect(byName.role.getSQLType()).toBe('users_role')
    expect(byName.avatar.getSQLType()).toBe('bytea')
    expect(byName.ref.hasDefault).toBe(true)
    expect(users.foreignKeys).toHaveLength(1) // manager_id -> users.id
    expect(users.foreignKeys[0].onDelete).toBe('set null')

    const posts = getTableConfig(mod.posts)
    const fk = posts.foreignKeys.find((f) => f.reference().columns[0].name === 'author_id')!
    expect(fk.onDelete).toBe('cascade')
    expect(fk.onUpdate).toBe('restrict')
    expect(fk.reference().foreignTable).toBe(mod.users)

    // composite key, and a table named like a Drizzle export got a safe variable name
    expect(getTableConfig(mod.textTable).primaryKeys[0].columns.map((c) => c.name)).toEqual(['post_id', 'select'])
    // many-to-many became a real junction table with a composite key
    const junction = getTableConfig(mod.postsTags)
    expect(junction.name).toBe('posts_tags')
    expect(junction.primaryKeys[0].columns.map((c) => c.name)).toEqual(['post_id', 'tag_id'])
    expect(junction.foreignKeys).toHaveLength(2)
  })

  it('MySQL: unsigned ints, enums, auto-increment', async () => {
    const { getTableConfig } = await import('drizzle-orm/mysql-core')
    const mod = await import(/* @vite-ignore */ files.get('mysql')!)
    const users = getTableConfig(mod.users)
    const byName = Object.fromEntries(users.columns.map((c) => [c.name, c]))
    expect((byName.id as unknown as { autoIncrement: boolean }).autoIncrement).toBe(true)
    expect(byName.age.getSQLType()).toBe('int unsigned')
    expect(byName.role.getSQLType()).toBe("enum('admin','member')")
    expect(byName.email.getSQLType()).toBe('varchar(255)')
  })

  it('SQLite: autoincrement key, booleans, json text', async () => {
    const { getTableConfig } = await import('drizzle-orm/sqlite-core')
    const mod = await import(/* @vite-ignore */ files.get('sqlite')!)
    const users = getTableConfig(mod.users)
    const byName = Object.fromEntries(users.columns.map((c) => [c.name, c]))
    expect(byName.id.primary).toBe(true)
    expect((byName.id as unknown as { autoIncrement: boolean }).autoIncrement).toBe(true)
    expect(byName.is_active.getSQLType()).toBe('integer')
    expect(byName.prefs.getSQLType()).toBe('text')
    expect(byName.created_at.hasDefault).toBe(true)
  })

  it('exports relations for the query API, with names where two foreign keys point at one table', () => {
    const { schema } = generateDrizzle(kitchenSink('postgresql'))
    expect(schema).toContain('export const postsRelations = relations(posts, ({ one, many }) => ({')
    expect(schema).toContain('author: one(users, { fields: [posts.authorId], references: [users.id]')
    expect(schema).toContain("relationName: 'posts_authorId'")
    expect(schema).toContain("relationName: 'posts_editorId'")
    // a unique foreign key (profiles.user_id) is a one-to-one: the other side is `one`, not `many`
    expect(schema).toMatch(/profiles: one\(profiles\)/)
    expect(schema).toContain('export type User = typeof users.$inferSelect')
    expect(schema).toContain('export type NewUser = typeof users.$inferInsert')
  })

  it('warns instead of emitting broken code for types a dialect cannot express', () => {
    const d: Diagram = {
      provider: 'sqlite',
      tables: [
        {
          id: 't',
          name: 't',
          columns: [col('a', 'id', 'SERIAL', { primaryKey: true }), col('b', 'kind', "ENUM('a')"), col('c', 'x', 'WIBBLE')],
        },
      ],
    }
    const { schema, warnings } = generateDrizzle(d)
    expect(warnings.join('\n')).toMatch(/SQLite does not support enums/)
    expect(warnings.join('\n')).toMatch(/Unknown type "WIBBLE"/)
    expect(schema).toContain("kind: text('kind')")
  })

  it('handles an empty diagram', () => {
    const { schema } = generateDrizzle({ provider: 'postgresql', tables: [] })
    expect(schema).toContain('No tables yet')
  })

  it('treats awkward text in defaults as data (no code injection through a default value)', () => {
    const d: Diagram = {
      provider: 'postgresql',
      tables: [
        {
          id: 't',
          name: "o'brien",
          columns: [
            col('a', 'id', 'SERIAL', { primaryKey: true }),
            col('b', 'note', 'TEXT', { default: "'it''s'" }),
            col('c', 'expr', 'TEXT', { default: '`; process.exit(1); `${x}' }),
          ],
        },
      ],
    }
    const { schema } = generateDrizzle(d)
    expect(schema).toContain("pgTable('o\\'brien'")
    expect(schema).toContain(".default('it\\'s')")
    expect(schema).toContain('\\`; process.exit(1); \\`\\${x}')
  })
})
