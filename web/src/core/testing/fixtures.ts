import type { Column, Diagram, Provider, Table } from '../model'

export const col = (id: string, name: string, type: string, extra: Partial<Column> = {}): Column => ({
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
export function kitchenSink(provider: Provider): Diagram {
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


// ---- Random diagrams ---------------------------------------------------------------------------------------------

/** Small seeded generator, so a failing diagram can be reproduced from its seed. */
export function rng(seed: number) {
  let state = seed >>> 0 || 1
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  }
}

/** Table names that stress the naming: plural / singular, snake / camel / Pascal, awkward English, leading digit. */
const TABLE_NAMES = [
  'users', 'user', 'posts', 'categories', 'addresses', 'status', 'order_items', 'OrderItems', 'people', 'data',
  'news', 'class', 'blog_posts', 'tags', 'quizzes', 'sessions', 'media', 'canvas', '2fa_codes', 'Account',
  'accounts', 'x', 'a', 'companies', 'buses', 'profile', 'comments', 'orderItem', 'model', 'default',
]
/** Column names, including words that are keywords in some languages and ones that mimic Prisma's own. */
const COLUMN_NAMES = [
  'name', 'email', 'title', 'body', 'status', 'data', 'class', 'type', 'default', 'model', 'order', 'select',
  'created_at', 'updatedAt', 'updated_at', 'deleted_at', '2x', 'Total', 'is_active', 'count', 'index', 'from',
  'owner', 'author', 'parent', 'posts', 'tags', 'user',
]

type TypeChoice = { sql: string; fkSql?: string }
const common: TypeChoice[] = [
  { sql: 'VARCHAR(255)' }, { sql: 'TEXT' }, { sql: 'INT' }, { sql: 'BIGINT' }, { sql: 'BOOLEAN' },
  { sql: 'DECIMAL(10, 2)' }, { sql: 'DOUBLE' }, { sql: 'DATE' }, { sql: 'TIMESTAMP' }, { sql: 'JSON' }, { sql: 'UUID' },
]

/**
 * A diagram that is valid on purpose (matching key types, unique targets, single-column keys behind every
 * many-to-many) but wild in shape: odd names, composite keys, self-references, several foreign keys to one table,
 * every ON DELETE action, enums and arrays where the database has them.
 */
export function randomDiagram(seed: number, provider: Provider): Diagram {
  const r = rng(seed)
  const names = new Set<string>()
  const count = r.int(2, 6)
  while (names.size < count) names.add(r.pick(TABLE_NAMES))

  type Plan = { table: Table; pk?: Column }
  const plans: Plan[] = [...names].map((name, ti) => {
    const id = `t${ti}`
    const columns: Column[] = []
    const used = new Set<string>()
    const add = (name: string, type: string, extra: Partial<Column> = {}) => {
      let unique = name
      for (let i = 2; used.has(unique.toLowerCase()); i++) unique = `${name}_${i}`
      used.add(unique.toLowerCase())
      const c = col(`${id}c${columns.length}`, unique, type, extra)
      columns.push(c)
      return c
    }

    // Key style: auto id, plain INT / UUID / BIGINT id, composite key, or no key but a unique column.
    const style = r.pick(['serial', 'serial', 'serial', 'int', 'uuid', 'bigserial', 'composite', 'unique-only'] as const)
    let pk: Column | undefined
    if (style === 'serial') pk = add('id', 'SERIAL', { primaryKey: true, notNull: true })
    else if (style === 'bigserial') pk = add('id', 'BIGSERIAL', { primaryKey: true, notNull: true })
    else if (style === 'int') pk = add('id', 'INT', { primaryKey: true, notNull: true })
    else if (style === 'uuid') pk = add('id', 'UUID', { primaryKey: true, notNull: true, default: 'gen_random_uuid()' })
    else if (style === 'composite') {
      add('tenant_id', 'INT', { primaryKey: true, notNull: true })
      add('code', 'VARCHAR(50)', { primaryKey: true, notNull: true })
    } else add('slug', 'VARCHAR(100)', { notNull: true, unique: true })

    for (let i = r.int(0, 5); i > 0; i--) {
      const pickName = r.pick(COLUMN_NAMES)
      const t = r.pick(common)
      const isEnum = provider !== 'sqlite' && r.chance(0.12)
      const isArray = provider === 'postgresql' && !isEnum && r.chance(0.08)
      const sql = isEnum ? "ENUM('draft', 'live', 'archived')" : t.sql + (isArray ? '[]' : '')
      const defaults: Record<string, string> = { BOOLEAN: 'false', TIMESTAMP: 'now()', INT: '0' }
      add(pickName, sql, {
        notNull: r.chance(0.5),
        unique: !isArray && t.sql === 'VARCHAR(255)' && r.chance(0.15),
        default: !isArray && !isEnum && defaults[t.sql] && r.chance(0.5) ? defaults[t.sql] : isEnum && r.chance(0.5) ? "'draft'" : '',
      })
    }
    return { table: { id, name, columns }, pk }
  })

  // Foreign keys: to any table with a single-column key, itself included. FK type mirrors the key's type.
  const targets = plans.filter((p) => p.pk)
  const fkType = (pk: Column) => (pk.type === 'SERIAL' ? 'INT' : pk.type === 'BIGSERIAL' ? 'BIGINT' : pk.type)
  const actions = ['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION', 'SET DEFAULT'] as const
  for (const p of plans) {
    if (!targets.length) break
    for (let i = r.int(0, 3); i > 0; i--) {
      const target = r.pick(targets)
      const notNull = r.chance(0.5)
      const onDelete = r.pick(actions)
      const used = new Set(p.table.columns.map((c) => c.name.toLowerCase()))
      let name = r.pick([`${target.table.name}_id`, 'owner_id', 'parent_id', 'author_id', 'ref'])
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${name}_${n}`
      p.table.columns.push(
        col(`${p.table.id}f${p.table.columns.length}`, name, fkType(target.pk!), {
          notNull,
          unique: r.chance(0.15),
          references: {
            tableId: target.table.id,
            columnId: target.pk!.id,
            onDelete,
            onUpdate: r.chance(0.3) ? r.pick(actions) : undefined,
          },
        }),
      )
    }
  }

  const manyToMany = []
  for (let i = r.int(0, 2); i > 0 && targets.length; i--) {
    manyToMany.push({ id: `m${i}`, aTableId: r.pick(targets).table.id, bTableId: r.pick(targets).table.id })
  }
  return { provider, tables: plans.map((p) => p.table), manyToMany }
}
