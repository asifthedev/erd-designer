/**
 * Drizzle ORM schema generation: turns the diagram into a `schema.ts` for PostgreSQL (`pg-core`), MySQL
 * (`mysql-core`) or SQLite (`sqlite-core`), including foreign keys, enums, composite keys, `relations()` for the
 * relational query API and `$inferSelect` / `$inferInsert` row types.
 *
 * Pure functions only. The output is type-checked against the real `drizzle-orm` package in drizzle.test.ts, so a
 * change here that produces code Drizzle would reject fails the tests.
 */
import { isOneToOne, type Column, type Diagram, type Provider, type ReferentialAction, type Table } from './model'
import { checkRelations } from './relations'
import { toCamel, toPascal } from './prisma'
import { withJunctionTables } from './sql'
import { parseSqlType, type ParsedType } from './sqlType'

export type DrizzleResult = { schema: string; warnings: string[] }

const CORE = { postgresql: 'drizzle-orm/pg-core', mysql: 'drizzle-orm/mysql-core', sqlite: 'drizzle-orm/sqlite-core' }
const TABLE_FN = { postgresql: 'pgTable', mysql: 'mysqlTable', sqlite: 'sqliteTable' }
const ANY_COLUMN = { postgresql: 'AnyPgColumn', mysql: 'AnyMySqlColumn', sqlite: 'AnySQLiteColumn' }
const LABEL = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' }

const ACTIONS: Record<ReferentialAction, string> = {
  CASCADE: 'cascade',
  'SET NULL': 'set null',
  RESTRICT: 'restrict',
  'NO ACTION': 'no action',
  'SET DEFAULT': 'set default',
}

/** Words a variable can't be called, or that would shadow something the generated file imports. */
const RESERVED = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends false finally for ' +
    'function if import in instanceof new null return super switch this throw true try typeof var void while with ' +
    'yield let static await async of undefined NaN Infinity eval arguments sql relations one many customType ' +
    'primaryKey AnyPgColumn AnyMySqlColumn AnySQLiteColumn pgTable mysqlTable sqliteTable pgEnum mysqlEnum ' +
    'integer smallint bigint serial bigserial text varchar char uuid boolean numeric doublePrecision real date time ' +
    'timestamp json jsonb int tinyint mediumint decimal float double datetime mediumtext longtext blob bytea'
  ).split(' '),
)

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

/** Text for a `sql` tagged template: backslashes, backticks and `${` must not end the template early. */
const tpl = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

/** How a column's default value has to be written, which depends on what the builder accepts. */
type Kind = 'string' | 'number' | 'decimal' | 'boolean' | 'datetime' | 'temporal' | 'uuid' | 'json' | 'enum' | 'other'

type Built = {
  /** `varchar('email', { length: 255 })` */
  expr: string
  kind: Kind
  autoIncrement: boolean
  array: boolean
}

type Draft = {
  table: Table
  /** The `export const` identifier. */
  varName: string
  /** column id -> object key */
  keys: Map<string, string>
}

/** Collects what the file needs to import, so the import lines list exactly what is used. */
class Imports {
  core = new Set<string>()
  orm = new Set<string>()
  use(name: string) {
    this.core.add(name)
    return name
  }
}

function safeIdent(raw: string, fallback: string, taken: Set<string>, avoidReserved: boolean): string {
  let base = toCamel(raw)
  if (!base || !/^[A-Za-z_$]/.test(base)) base = `${fallback}${base ? base[0].toUpperCase() + base.slice(1) : ''}`
  if (avoidReserved && RESERVED.has(base)) base += 'Table'
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`
  taken.add(name)
  return name
}

const opts = (o: Record<string, string | number | boolean | undefined>) => {
  const parts = Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' && !v.startsWith("'") ? q(v) : v}`)
  return parts.length ? `{ ${parts.join(', ')} }` : ''
}

/** `fn('name', { ... })` with the options object left out when it is empty. */
const call = (fn: string, name: string, o: Record<string, string | number | boolean | undefined> = {}) => {
  const o2 = opts(o)
  return `${fn}(${q(name)}${o2 ? `, ${o2}` : ''})`
}

/** Builder expression for one column in one dialect. Returns an error text when the type can't be expressed. */
function buildColumn(
  col: Column,
  parsed: ParsedType,
  provider: Provider,
  imp: Imports,
  enumVar?: string,
): Built | { error: string } {
  const { base, args, unsigned, array } = parsed
  const name = col.name
  const b = (expr: string, kind: Kind, autoIncrement = false): Built => ({ expr, kind, autoIncrement, array })
  const f = (n: string) => imp.use(n)

  if (array && provider !== 'postgresql') return { error: 'Array types are only supported on PostgreSQL' }
  if (unsigned && provider !== 'mysql') return { error: 'UNSIGNED is only supported on MySQL integer types' }

  if (base === 'ENUM') {
    if (provider === 'sqlite') return { error: 'SQLite does not support enums' }
    if (provider === 'postgresql') return b(`${enumVar}(${q(name)})`, 'enum')
    const values = (parsed.enumValues ?? []).map(q).join(', ')
    return b(`${f('mysqlEnum')}(${q(name)}, [${values}])`, 'enum')
  }

  switch (provider) {
    case 'postgresql': {
      switch (base) {
        case 'INT':
        case 'MEDIUMINT':
          return b(call(f('integer'), name), 'number')
        case 'SMALLINT':
        case 'TINYINT':
          return b(call(f('smallint'), name), 'number')
        case 'BIGINT':
          return b(call(f('bigint'), name, { mode: 'number' }), 'number')
        case 'SERIAL':
          return b(call(f('serial'), name), 'number', true)
        case 'BIGSERIAL':
          return b(call(f('bigserial'), name, { mode: 'number' }), 'number', true)
        case 'VARCHAR':
          return b(call(f('varchar'), name, { length: args[0] }), 'string')
        case 'CHAR':
          return b(call(f('char'), name, { length: args[0] }), 'string')
        case 'TEXT':
        case 'MEDIUMTEXT':
        case 'LONGTEXT':
          return b(call(f('text'), name), 'string')
        case 'UUID':
          return b(call(f('uuid'), name), 'uuid')
        case 'BOOLEAN':
          return b(call(f('boolean'), name), 'boolean')
        case 'DECIMAL':
          return b(call(f('numeric'), name, { precision: args[0], scale: args[1] }), 'decimal')
        case 'FLOAT':
        case 'DOUBLE':
          return b(call(f('doublePrecision'), name), 'number')
        case 'REAL':
          return b(call(f('real'), name), 'number')
        case 'DATE':
          return b(call(f('date'), name), 'temporal')
        case 'TIME':
          return b(call(f('time'), name, { precision: args[0] }), 'temporal')
        case 'TIMESTAMP':
        case 'DATETIME':
          return b(call(f('timestamp'), name, { precision: args[0] }), 'datetime')
        case 'TIMESTAMPTZ':
          return b(call(f('timestamp'), name, { precision: args[0], withTimezone: true }), 'datetime')
        case 'JSON':
          return b(call(f('json'), name), 'json')
        case 'JSONB':
          return b(call(f('jsonb'), name), 'json')
        case 'BLOB':
          // Neither pg-core nor mysql-core ships a binary column that maps to Buffer: a customType is emitted.
          imp.use('customType')
          return b(`bytea(${q(name)})`, 'other')
      }
      break
    }
    case 'mysql': {
      const u = unsigned ? { unsigned: true } : {}
      switch (base) {
        case 'INT':
          return b(call(f('int'), name, u), 'number')
        case 'MEDIUMINT':
          return b(call(f('mediumint'), name, u), 'number')
        case 'SMALLINT':
          return b(call(f('smallint'), name, u), 'number')
        case 'TINYINT':
          return b(call(f('tinyint'), name, u), 'number')
        case 'BIGINT':
          return b(call(f('bigint'), name, { mode: 'number', ...u }), 'number')
        case 'SERIAL':
          return b(call(f('int'), name), 'number', true)
        case 'BIGSERIAL':
          return b(call(f('bigint'), name, { mode: 'number' }), 'number', true)
        case 'VARCHAR':
          // MySQL needs a length on VARCHAR (the SQL export uses the same 255 default).
          return b(call(f('varchar'), name, { length: args[0] ?? 255 }), 'string')
        case 'CHAR':
          return b(call(f('char'), name, { length: args[0] }), 'string')
        case 'TEXT':
          return b(call(f('text'), name), 'string')
        case 'MEDIUMTEXT':
          return b(call(f('mediumtext'), name), 'string')
        case 'LONGTEXT':
          return b(call(f('longtext'), name), 'string')
        case 'UUID':
          return b(call(f('char'), name, { length: 36 }), 'uuid')
        case 'BOOLEAN':
          return b(call(f('boolean'), name), 'boolean')
        case 'DECIMAL':
          return b(call(f('decimal'), name, { precision: args[0], scale: args[1] }), 'decimal')
        case 'FLOAT':
          return b(call(f('float'), name), 'number')
        case 'REAL':
        case 'DOUBLE':
          return b(call(f('double'), name), 'number')
        case 'DATE':
          return b(call(f('date'), name), 'temporal')
        case 'TIME':
          return b(call(f('time'), name), 'temporal')
        case 'TIMESTAMP':
        case 'TIMESTAMPTZ':
          return b(call(f('timestamp'), name), 'datetime')
        case 'DATETIME':
          return b(call(f('datetime'), name), 'datetime')
        case 'JSON':
        case 'JSONB':
          return b(call(f('json'), name), 'json')
        case 'BLOB':
          imp.use('customType')
          return b(`blob(${q(name)})`, 'other')
      }
      break
    }
    case 'sqlite': {
      switch (base) {
        case 'INT':
        case 'MEDIUMINT':
        case 'SMALLINT':
        case 'TINYINT':
        case 'BIGINT':
          return b(call(f('integer'), name), 'number')
        case 'SERIAL':
        case 'BIGSERIAL':
          return b(call(f('integer'), name), 'number', true)
        case 'VARCHAR':
        case 'CHAR':
          return b(call(f('text'), name, { length: args[0] }), 'string')
        case 'TEXT':
        case 'MEDIUMTEXT':
        case 'LONGTEXT':
          return b(call(f('text'), name), 'string')
        case 'UUID':
          return b(call(f('text'), name), 'uuid')
        case 'BOOLEAN':
          return b(call(f('integer'), name, { mode: 'boolean' }), 'boolean')
        case 'DECIMAL':
          return b(call(f('numeric'), name), 'decimal')
        case 'FLOAT':
        case 'REAL':
        case 'DOUBLE':
          return b(call(f('real'), name), 'number')
        // SQLite has no date type; like the SQL export, dates are stored as text (ISO strings).
        case 'DATE':
        case 'TIME':
        case 'TIMESTAMP':
        case 'DATETIME':
        case 'TIMESTAMPTZ':
          return b(call(f('text'), name), 'datetime')
        case 'JSON':
        case 'JSONB':
          return b(call(f('text'), name, { mode: 'json' }), 'json')
        case 'BLOB':
          return b(call(f('blob'), name), 'other')
      }
      break
    }
  }
  return { error: `Unknown type "${base}"` }
}

/** `.default(...)` modifier for a column's default, or undefined when there is none / it can't be expressed. */
function defaultModifier(
  col: Column,
  built: Built,
  provider: Provider,
  imp: Imports,
): string | undefined {
  const raw = col.default.trim()
  if (!raw || /^null$/i.test(raw) || built.autoIncrement) return undefined

  const viaSql = (expr: string) => {
    imp.orm.add('sql')
    // PostgreSQL takes an expression as is; MySQL / SQLite need it in parentheses.
    return `.default(sql\`${tpl(provider === 'postgresql' ? expr : `(${expr})`)}\`)`
  }
  const viaSqlLiteral = (literal: string) => {
    imp.orm.add('sql')
    return `.default(sql\`${tpl(literal)}\`)`
  }

  if (/^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp(\(\d*\))?)$/i.test(raw)) {
    if (built.kind === 'datetime' && provider !== 'sqlite') return '.defaultNow()'
    imp.orm.add('sql')
    return `.default(sql\`${provider === 'postgresql' ? 'now()' : '(CURRENT_TIMESTAMP)'}\`)`
  }
  if (/^(uuid\(\)|gen_random_uuid\(\)|uuid_generate_v4\(\))$/i.test(raw)) {
    if (provider === 'postgresql') return built.kind === 'uuid' ? '.defaultRandom()' : viaSql('gen_random_uuid()')
    if (provider === 'mysql') return viaSql('UUID()')
    return '.$defaultFn(() => crypto.randomUUID())' // SQLite has no UUID function: Drizzle makes the id in the app
  }
  // Arrays, JSON and temporal values are typed (string[], objects, Date), so literals go through sql``.
  if (built.array || built.kind === 'json' || built.kind === 'temporal' || built.kind === 'datetime') {
    const str = /^'((?:[^']|'')*)'$/.exec(raw)
    return str ? viaSqlLiteral(`'${str[1]}'`) : viaSql(raw)
  }
  if (/^(true|false)$/i.test(raw)) return built.kind === 'boolean' ? `.default(${raw.toLowerCase()})` : viaSql(raw)
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    if (built.kind === 'number') return `.default(${raw})`
    if (built.kind === 'decimal') return `.default(${q(raw)})` // numeric / decimal values are strings in Drizzle
    return viaSql(raw)
  }
  const str = /^'((?:[^']|'')*)'$/.exec(raw)
  if (str) {
    const value = str[1].replace(/''/g, "'")
    if (built.kind === 'string' || built.kind === 'uuid' || built.kind === 'enum') return `.default(${q(value)})`
    return viaSqlLiteral(raw)
  }
  return viaSql(raw)
}

export function generateDrizzle(diagram: Diagram): DrizzleResult {
  const { provider } = diagram
  const warnings: string[] = []
  const tables = withJunctionTables(diagram, warnings)
  const imp = new Imports()
  const tableFn = imp.use(TABLE_FN[provider])

  // ---- Names first: references and relations point at tables / columns that are declared later ---------
  const varNames = new Set<string>()
  const drafts: Draft[] = tables.map((table) => {
    const keys = new Map<string, string>()
    const taken = new Set<string>()
    for (const c of table.columns) keys.set(c.id, safeIdent(c.name, 'col', taken, false))
    return { table, varName: safeIdent(table.name, 'table', varNames, true), keys }
  })
  const byId = new Map(drafts.map((d) => [d.table.id, d]))

  const enumDefs: string[] = []
  const tableBlocks: string[] = []

  // ---- Tables -----------------------------------------------------------------------------------------
  for (const d of drafts) {
    const { table } = d
    const pk = table.columns.filter((c) => c.primaryKey)
    const lines: string[] = []

    for (const col of table.columns) {
      const where = `${table.name}.${col.name}`
      const key = d.keys.get(col.id)!
      const parsed = parseSqlType(col.type)

      let built: Built | { error: string }
      if (!parsed.ok) built = { error: parsed.error }
      else {
        let enumVar: string | undefined
        if (parsed.value.base === 'ENUM' && provider === 'postgresql') {
          enumVar = safeIdent(`${table.name}_${col.name}_enum`, 'enum', varNames, true)
          const values = (parsed.value.enumValues ?? []).map(q).join(', ')
          enumDefs.push(`export const ${enumVar} = ${imp.use('pgEnum')}(${q(`${table.name}_${col.name}`)}, [${values}])`)
        }
        built = buildColumn(col, parsed.value, provider, imp, enumVar)
      }

      if ('error' in built) {
        warnings.push(`${where}: ${built.error}, emitted as text`)
        built = { expr: call(imp.use('text'), col.name), kind: 'string', autoIncrement: false, array: false }
      }

      let expr = built.expr
      if (built.array) expr += '.array()'

      // Primary key. SQLite auto-increment is a property of the key itself.
      if (col.primaryKey && pk.length === 1) {
        if (built.autoIncrement && provider === 'sqlite') expr += '.primaryKey({ autoIncrement: true })'
        else expr += '.primaryKey()'
      } else if (col.notNull || col.primaryKey) {
        expr += '.notNull()'
      }
      if (built.autoIncrement) {
        if (provider === 'mysql') {
          expr += '.autoincrement()'
          if (!col.primaryKey && !col.unique) warnings.push(`${where}: MySQL needs an AUTO_INCREMENT column to be a key`)
        } else if (provider === 'sqlite' && !(col.primaryKey && pk.length === 1)) {
          warnings.push(`${where}: SQLite can only auto-increment a table's single primary key`)
        }
      }
      if (col.unique && !(col.primaryKey && pk.length === 1)) expr += '.unique()'

      const def = defaultModifier(col, built, provider, imp)
      if (def) expr += def

      const ref = col.references
      if (ref) {
        const target = byId.get(ref.tableId)
        const targetKey = target?.keys.get(ref.columnId)
        if (target && targetKey) {
          const selfRef = target === d
          const actions = opts({
            onDelete: ref.onDelete ? q(ACTIONS[ref.onDelete]) : undefined,
            onUpdate: ref.onUpdate ? q(ACTIONS[ref.onUpdate]) : undefined,
          })
          // A table referencing itself needs an explicit return type, or TypeScript can't infer the table's type.
          const fn = selfRef ? `(): ${imp.use(ANY_COLUMN[provider])} => ` : '() => '
          expr += `.references(${fn}${target.varName}.${targetKey}${actions ? `, ${actions}` : ''})`
        }
      }

      lines.push(`  ${key}: ${expr},`)
    }

    if (!pk.length && !table.columns.some((c) => c.unique)) {
      warnings.push(`${table.name}: this table has no primary key`)
    }

    if (pk.length > 1) {
      const cols = pk.map((c) => `t.${d.keys.get(c.id)}`).join(', ')
      tableBlocks.push(
        `export const ${d.varName} = ${tableFn}(\n  ${q(table.name)},\n  {\n${lines.map((l) => `  ${l}`).join('\n')}\n  },\n` +
          `  (t) => [${imp.use('primaryKey')}({ columns: [${cols}] })],\n)`,
      )
    } else {
      tableBlocks.push(`export const ${d.varName} = ${tableFn}(${q(table.name)}, {\n${lines.join('\n')}\n})`)
    }
  }

  // ---- Relations (for db.query.*.findMany({ with: ... })) ---------------------------------------------
  for (const i of checkRelations(diagram)) warnings.push(`${i.label}: ${i.message}`)

  type Rel = { name: string; code: string; helper: 'one' | 'many' }
  const rels = new Map<Draft, Rel[]>()
  const relKeys = new Map<Draft, Set<string>>(drafts.map((d) => [d, new Set(d.keys.values())]))
  const pairCount = new Map<string, number>()
  const pair = (a: Draft, b: Draft) => [a.varName, b.varName].sort().join('|')
  for (const d of drafts)
    for (const col of d.table.columns) {
      const target = col.references && byId.get(col.references.tableId)
      if (target) pairCount.set(pair(d, target), (pairCount.get(pair(d, target)) ?? 0) + 1)
    }

  for (const d of drafts) {
    for (const col of d.table.columns) {
      const ref = col.references
      const target = ref && byId.get(ref.tableId)
      const targetKey = target?.keys.get(ref!.columnId)
      if (!ref || !target || !targetKey) continue
      const fk = d.keys.get(col.id)!

      // Several relations between the same two tables (or a self-reference) must be told apart by name.
      const ambiguous = target === d || (pairCount.get(pair(d, target)) ?? 0) > 1
      const relationName = ambiguous ? `${d.varName}_${fk}` : undefined
      const nameOpt = relationName ? `, relationName: ${q(relationName)}` : ''

      const stripped = fk.replace(/_?[iI]d$/, '')
      const forward = uniqueIn(stripped && stripped !== fk ? stripped : toCamel(target.table.name), relKeys.get(d)!)
      push(rels, d, {
        name: forward,
        helper: 'one',
        code: `${forward}: one(${target.varName}, { fields: [${d.varName}.${fk}], references: [${target.varName}.${targetKey}]${nameOpt} }),`,
      })

      const oneToOne = isOneToOne(d.table, col)
      const back = uniqueIn(
        ambiguous ? `${toCamel(d.table.name)}By${toPascal(forward)}` : toCamel(d.table.name),
        relKeys.get(target)!,
      )
      const backOpts = relationName ? `, { relationName: ${q(relationName)} }` : ''
      push(rels, target, {
        name: back,
        helper: oneToOne ? 'one' : 'many',
        code: `${back}: ${oneToOne ? 'one' : 'many'}(${d.varName}${backOpts}),`,
      })
    }
  }

  const relationBlocks: string[] = []
  for (const d of drafts) {
    const list = rels.get(d)
    if (!list?.length) continue
    imp.orm.add('relations')
    const helpers = (['one', 'many'] as const).filter((h) => list.some((r) => r.helper === h))
    relationBlocks.push(
      `export const ${d.varName}Relations = relations(${d.varName}, ({ ${helpers.join(', ')} }) => ({\n` +
        `${list.map((r) => `  ${r.code}`).join('\n')}\n}))`,
    )
  }

  // ---- Row types: `User` (a selected row) and `NewUser` (what insert() accepts) ------------------------
  const typeNames = new Set<string>()
  const typeBlocks = drafts.map((d) => {
    const singular = d.table.name.replace(/ies$/i, 'y').replace(/(?<!s)s$/i, '')
    let base = toPascal(singular) || 'Row'
    if (!/^[A-Za-z]/.test(base)) base = `T${base}`
    let name = base
    for (let i = 2; typeNames.has(name) || typeNames.has(`New${name}`); i++) name = `${base}${i}`
    typeNames.add(name)
    typeNames.add(`New${name}`)
    return `export type ${name} = typeof ${d.varName}.$inferSelect\nexport type New${name} = typeof ${d.varName}.$inferInsert`
  })

  // ---- Assemble ---------------------------------------------------------------------------------------
  const out: string[] = [`// Drizzle ORM schema for ${LABEL[provider]}, generated by erd.designer`, '// npm i drizzle-orm && npm i -D drizzle-kit']
  if (warnings.length) out.push(...warnings.map((w) => `// Note: ${w}`))

  if (!drafts.length) return { schema: out.join('\n') + '\n\n// No tables yet.\n', warnings }

  const imports: string[] = []
  if (imp.orm.size) imports.push(`import { ${[...imp.orm].sort().join(', ')} } from 'drizzle-orm'`)
  imports.push(`import { ${[...imp.core].sort((a, b) => a.localeCompare(b)).join(', ')} } from '${CORE[provider]}'`)

  const helpers: string[] = []
  if (imp.core.has('customType')) {
    const [fn, sqlName] = provider === 'postgresql' ? ['bytea', 'bytea'] : ['blob', 'blob']
    helpers.push(`// ${LABEL[provider]} has no built-in binary column in Drizzle, so define one.\nconst ${fn} = customType<{ data: Buffer }>({\n  dataType: () => '${sqlName}',\n})`)
  }

  const sections = [out.join('\n'), imports.join('\n'), ...helpers, ...enumDefs, ...tableBlocks, ...relationBlocks, typeBlocks.join('\n\n')]
  return { schema: sections.filter(Boolean).join('\n\n') + '\n', warnings }
}

function push(map: Map<Draft, { name: string; code: string; helper: 'one' | 'many' }[]>, key: Draft, rel: { name: string; code: string; helper: 'one' | 'many' }) {
  const list = map.get(key) ?? []
  list.push(rel)
  map.set(key, list)
}

function uniqueIn(base: string, taken: Set<string>): string {
  let name = base || 'item'
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`
  taken.add(name)
  return name
}
