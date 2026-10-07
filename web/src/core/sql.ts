/**
 * SQL generation: turns the diagram into `CREATE TABLE` statements for PostgreSQL, MySQL or SQLite.
 * Pure functions only (no React, no I/O), so every dialect rule is unit-tested in core.test.ts.
 * Anything that can't be expressed in the chosen dialect is reported in `warnings` instead of being dropped silently.
 */
import type { Column, Diagram, Provider, Table } from './model'
import { parseSqlType, type ParsedType } from './sqlType'

export type SqlResult = { sql: string; warnings: string[] }

/** Identifier quote character per dialect (MySQL uses backticks, the others double quotes). */
const QUOTE: Record<Provider, string> = { postgresql: '"', sqlite: '"', mysql: '`' }

/** Quote an identifier for the target database. */
const ident = (provider: Provider, name: string) => {
  const c = QUOTE[provider]
  return `${c}${name.replaceAll(c, c + c)}${c}`
}

/** SQL string literal: single quotes doubled, so user text can never break out of the literal. */
const str = (v: string) => `'${v.replaceAll("'", "''")}'`

/** A resolved column type; `autoIncrement` is dialect-specific syntax added later (AUTO_INCREMENT / AUTOINCREMENT). */
type SqlType = { type: string; autoIncrement: boolean; enumValues?: string[] }

/** `(10, 2)`-style type arguments, or nothing when the type has none. */
const args = (p: ParsedType) => (p.args.length ? `(${p.args.join(', ')})` : '')

/** Native column type for one database; the diagram's type names are a superset of all three. */
function nativeType(p: ParsedType, provider: Provider): SqlType {
  const plain = (type: string): SqlType => ({ type, autoIncrement: false })
  const unsigned = provider === 'mysql' && p.unsigned ? ' UNSIGNED' : ''
  const arr = provider === 'postgresql' && p.array ? '[]' : ''

  if (p.base === 'ENUM') {
    if (provider === 'mysql')
      return { type: `ENUM(${(p.enumValues ?? []).map(str).join(', ')})`, autoIncrement: false }
    // PostgreSQL gets a CREATE TYPE (named later); SQLite stores text with a CHECK.
    return { type: provider === 'sqlite' ? 'TEXT' : 'ENUM', autoIncrement: false, enumValues: p.enumValues }
  }

  switch (provider) {
    case 'postgresql': {
      // Types PostgreSQL spells differently (or lacks): MySQL-style integers/text collapse to the nearest equivalent.
      const map: Record<string, string> = {
        INT: 'INTEGER',
        MEDIUMINT: 'INTEGER',
        SMALLINT: 'SMALLINT',
        TINYINT: 'SMALLINT',
        BIGINT: 'BIGINT',
        SERIAL: 'SERIAL',
        BIGSERIAL: 'BIGSERIAL',
        TEXT: 'TEXT',
        MEDIUMTEXT: 'TEXT',
        LONGTEXT: 'TEXT',
        UUID: 'UUID',
        BOOLEAN: 'BOOLEAN',
        FLOAT: 'DOUBLE PRECISION',
        DOUBLE: 'DOUBLE PRECISION',
        REAL: 'REAL',
        DATE: 'DATE',
        TIME: 'TIME',
        DATETIME: 'TIMESTAMP',
        TIMESTAMPTZ: 'TIMESTAMPTZ',
        JSON: 'JSON',
        JSONB: 'JSONB',
        BLOB: 'BYTEA',
      }
      if (p.base === 'VARCHAR' || p.base === 'CHAR') return plain(`${p.base}${args(p)}${arr}`)
      if (p.base === 'DECIMAL') return plain(`NUMERIC${args(p)}${arr}`)
      if (p.base === 'TIMESTAMP') return plain(`TIMESTAMP${args(p)}${arr}`)
      return { type: `${map[p.base] ?? p.base}${arr}`, autoIncrement: false }
    }
    case 'mysql': {
      // PostgreSQL-only types fall back to the closest MySQL type (UUID -> CHAR(36), JSONB -> JSON, ...).
      const map: Record<string, string> = {
        INT: 'INT',
        MEDIUMINT: 'MEDIUMINT',
        SMALLINT: 'SMALLINT',
        TINYINT: 'TINYINT',
        BIGINT: 'BIGINT',
        TEXT: 'TEXT',
        MEDIUMTEXT: 'MEDIUMTEXT',
        LONGTEXT: 'LONGTEXT',
        UUID: 'CHAR(36)',
        BOOLEAN: 'BOOLEAN',
        FLOAT: 'FLOAT',
        REAL: 'DOUBLE',
        DOUBLE: 'DOUBLE',
        DATE: 'DATE',
        TIME: 'TIME',
        DATETIME: 'DATETIME',
        TIMESTAMPTZ: 'TIMESTAMP',
        JSON: 'JSON',
        JSONB: 'JSON',
        BLOB: 'BLOB',
      }
      if (p.base === 'SERIAL') return { type: 'INT', autoIncrement: true }
      if (p.base === 'BIGSERIAL') return { type: 'BIGINT', autoIncrement: true }
      // MySQL needs a length on VARCHAR.
      if (p.base === 'VARCHAR') return plain(`VARCHAR${p.args.length ? args(p) : '(255)'}`)
      if (p.base === 'CHAR') return plain(`CHAR${args(p)}`)
      if (p.base === 'DECIMAL') return plain(`DECIMAL${args(p)}`)
      if (p.base === 'TIMESTAMP') return plain(`TIMESTAMP${args(p)}`)
      return plain(`${map[p.base] ?? p.base}${unsigned}`)
    }
    case 'sqlite': {
      // SQLite has only a few storage classes, so most types map to INTEGER / TEXT / REAL / NUMERIC.
      if (p.base === 'SERIAL' || p.base === 'BIGSERIAL') return { type: 'INTEGER', autoIncrement: true }
      const map: Record<string, string> = {
        INT: 'INTEGER',
        MEDIUMINT: 'INTEGER',
        SMALLINT: 'INTEGER',
        TINYINT: 'INTEGER',
        BIGINT: 'INTEGER',
        VARCHAR: 'TEXT',
        CHAR: 'TEXT',
        TEXT: 'TEXT',
        MEDIUMTEXT: 'TEXT',
        LONGTEXT: 'TEXT',
        UUID: 'TEXT',
        BOOLEAN: 'BOOLEAN',
        DECIMAL: 'NUMERIC',
        FLOAT: 'REAL',
        REAL: 'REAL',
        DOUBLE: 'REAL',
        DATE: 'DATE',
        TIME: 'TIME',
        TIMESTAMP: 'DATETIME',
        DATETIME: 'DATETIME',
        TIMESTAMPTZ: 'DATETIME',
        JSON: 'JSON',
        JSONB: 'JSON',
        BLOB: 'BLOB',
      }
      return plain(map[p.base] ?? p.base)
    }
  }
}

/** Translate a default expression typed in SQL style into one the target database accepts. */
function sqlDefault(raw: string, provider: Provider, where: string, warnings: string[]): string | undefined {
  const v = raw.trim()
  if (!v || /^null$/i.test(v)) return undefined
  if (/^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp(\(\d*\))?)$/i.test(v)) return 'CURRENT_TIMESTAMP'
  if (/^(uuid\(\)|gen_random_uuid\(\)|uuid_generate_v4\(\))$/i.test(v)) {
    if (provider === 'postgresql') return 'gen_random_uuid()'
    if (provider === 'mysql') return '(UUID())'
    warnings.push(`${where}: SQLite has no built-in UUID function, default left out`)
    return undefined
  }
  if (/^(true|false)$/i.test(v)) {
    const on = v.toLowerCase() === 'true'
    return provider === 'sqlite' ? (on ? '1' : '0') : on ? 'TRUE' : 'FALSE'
  }
  if (/^-?\d+(\.\d+)?$/.test(v) || /^'(?:[^']|'')*'$/.test(v)) return v
  // Any other expression: PostgreSQL takes it as is, MySQL / SQLite need it in parentheses.
  return provider === 'postgresql' ? v : `(${v})`
}

/** SERIAL-style columns are plain integers when they only reference a generated key. */
function plainIntType(type: string): string {
  if (/^bigserial$/i.test(type.trim())) return 'BIGINT'
  if (/^smallserial$/i.test(type.trim())) return 'SMALLINT'
  if (/^serial$/i.test(type.trim())) return 'INT'
  return type
}

/**
 * Many-to-many links become explicit junction tables (SQL has no hidden join table like Prisma's implicit
 * relations): two foreign keys that together form the primary key.
 */
export function withJunctionTables(diagram: Diagram, warnings: string[]): Table[] {
  const tables = [...diagram.tables]
  const taken = new Set(tables.map((t) => t.name))
  const singlePk = (t: Table) => {
    const pks = t.columns.filter((c) => c.primaryKey)
    return pks.length === 1 ? pks[0] : undefined
  }
  for (const link of diagram.manyToMany ?? []) {
    const a = diagram.tables.find((t) => t.id === link.aTableId)
    const b = diagram.tables.find((t) => t.id === link.bTableId)
    if (!a || !b) continue
    const pkA = singlePk(a)
    const pkB = singlePk(b)
    if (!pkA || !pkB) {
      warnings.push(
        `${a.name} ↔ ${b.name}: many-to-many needs a single-column primary key on both tables, skipped`,
      )
      continue
    }
    let name = `${a.name}_${b.name}`
    for (let i = 2; taken.has(name); i++) name = `${a.name}_${b.name}_${i}`
    taken.add(name)
    const single = (t: Table) => t.name.replace(/s$/, '')
    const self = a === b
    const col = (id: string, colName: string, t: Table, pk: Column): Column => ({
      id,
      name: colName,
      type: plainIntType(pk.type),
      primaryKey: true,
      notNull: true,
      unique: false,
      default: '',
      references: { tableId: t.id, columnId: pk.id, onDelete: 'CASCADE' },
    })
    tables.push({
      id: `m2m:${link.id}`,
      name,
      columns: [
        col(`m2m:${link.id}:a`, self ? 'from_id' : `${single(a)}_id`, a, pkA),
        col(`m2m:${link.id}:b`, self ? 'to_id' : `${single(b)}_id`, b, pkB),
      ],
    })
  }
  return tables
}

/** Referential actions are already the SQL keywords; the map keeps the generator from emitting unchecked text. */
const ACTION_SQL = {
  CASCADE: 'CASCADE',
  'SET NULL': 'SET NULL',
  RESTRICT: 'RESTRICT',
  'NO ACTION': 'NO ACTION',
  'SET DEFAULT': 'SET DEFAULT',
} as const

/** Diagram -> `CREATE TABLE` statements for the diagram's database (PostgreSQL, MySQL or SQLite). */
export function generateSql(diagram: Diagram): SqlResult {
  const { provider } = diagram
  const warnings: string[] = []
  const q = (name: string) => ident(provider, name)
  const tables = withJunctionTables(diagram, warnings)

  // Output is assembled in three groups so dependencies resolve: enum types first, then tables, then foreign
  // keys as ALTER TABLE (a table can reference one defined later, or itself). SQLite can't ALTER, so it inlines them.
  const enumTypes: string[] = []
  const tableSql: string[] = []
  const fkSql: string[] = []

  for (const table of tables) {
    const where = (c: Column) => `${table.name}.${c.name}`
    const pk = table.columns.filter((c) => c.primaryKey)
    const lines: { name: string; type: string; rest: string }[] = []
    const tail: string[] = []

    for (const col of table.columns) {
      const parsed = parseSqlType(col.type)
      let type: SqlType
      if (parsed.ok) type = nativeType(parsed.value, provider)
      else {
        warnings.push(`${where(col)}: ${parsed.error}, type written as typed`)
        type = { type: col.type.trim() || 'TEXT', autoIncrement: false }
      }

      if (type.type === 'ENUM' && provider === 'postgresql') {
        const typeName = `${table.name}_${col.name}`
        enumTypes.push(`CREATE TYPE ${q(typeName)} AS ENUM (${(type.enumValues ?? []).map(str).join(', ')});`)
        type = { ...type, type: q(typeName) }
      }

      const soleAuto = type.autoIncrement && provider === 'sqlite' && pk.length === 1 && col.primaryKey
      if (type.autoIncrement && provider === 'sqlite' && !soleAuto) {
        warnings.push(`${where(col)}: SQLite can only auto-increment a table's single primary key`)
      }
      if (type.autoIncrement && provider === 'mysql' && !col.primaryKey && !col.unique) {
        warnings.push(`${where(col)}: MySQL needs an AUTO_INCREMENT column to be a key`)
      }

      const rest: string[] = []
      if (soleAuto) rest.push('PRIMARY KEY AUTOINCREMENT')
      else {
        if (col.notNull || col.primaryKey || type.autoIncrement) rest.push('NOT NULL')
        if (type.autoIncrement && provider === 'mysql') rest.push('AUTO_INCREMENT')
        if (!type.autoIncrement) {
          const def = sqlDefault(col.default, provider, where(col), warnings)
          if (def !== undefined) rest.push(`DEFAULT ${def}`)
        }
        if (col.unique && !(col.primaryKey && pk.length === 1)) rest.push('UNIQUE')
      }
      if (provider === 'sqlite' && parsed.ok && parsed.value.base === 'ENUM') {
        const values = (parsed.value.enumValues ?? []).map(str).join(', ')
        rest.push(`CHECK (${q(col.name)} IN (${values}))`)
      }
      lines.push({ name: q(col.name), type: type.type, rest: rest.join(' ') })

      const ref = col.references
      if (!ref) continue
      const target = tables.find((t) => t.id === ref.tableId)
      const targetCol = target?.columns.find((c) => c.id === ref.columnId)
      if (!target || !targetCol) continue
      const actions = [
        ref.onDelete && `ON DELETE ${ACTION_SQL[ref.onDelete]}`,
        ref.onUpdate && `ON UPDATE ${ACTION_SQL[ref.onUpdate]}`,
      ].filter(Boolean)
      const fk =
        `FOREIGN KEY (${q(col.name)}) REFERENCES ${q(target.name)} (${q(targetCol.name)})` +
        (actions.length ? ' ' + actions.join(' ') : '')
      const constraint = `fk_${table.name}_${col.name}`
      if (provider === 'sqlite') tail.push(`CONSTRAINT ${q(constraint)} ${fk}`)
      else fkSql.push(`ALTER TABLE ${q(table.name)}\n  ADD CONSTRAINT ${q(constraint)} ${fk};`)
    }

    const soleAutoPk =
      provider === 'sqlite' && pk.length === 1 && lines.some((l) => l.rest.includes('AUTOINCREMENT'))
    if (pk.length && !soleAutoPk) tail.unshift(`PRIMARY KEY (${pk.map((c) => q(c.name)).join(', ')})`)

    // Pad names and types into aligned columns so the generated SQL reads like hand-written SQL.
    const nameW = Math.max(0, ...lines.map((l) => l.name.length))
    const typeW = Math.max(0, ...lines.map((l) => l.type.length))
    const body = [
      ...lines.map(
        (l) =>
          `  ${l.name.padEnd(nameW)} ${l.rest ? l.type.padEnd(typeW) : l.type}${l.rest ? ' ' + l.rest : ''}`,
      ),
      ...tail.map((t) => `  ${t}`),
    ]
    tableSql.push(`CREATE TABLE ${q(table.name)} (\n${body.join(',\n')}\n);`)
  }

  const label = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' }[provider]
  const out = [`-- Generated by erd.designer for ${label}`]
  if (warnings.length) out.push(...warnings.map((w) => `-- Note: ${w}`))
  const blocks = [...enumTypes, ...tableSql, ...fkSql]
  return { sql: out.join('\n') + '\n\n' + blocks.join('\n\n') + '\n', warnings }
}
