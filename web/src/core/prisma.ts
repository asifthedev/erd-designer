import { isOneToOne, type Column, type Diagram, type ReferentialAction, type Table } from './model'
import { pluralizeName, singularizeName } from './naming'
import { checkRelations } from './relations'
import { resolveSqlType, type ResolvedType } from './sqlType'

export type GenerateResult = { schema: string; warnings: string[] }

type Field = {
  name: string
  type: string
  optional: boolean
  list: boolean
  attrs: string[]
}

type EnumDef = { name: string; values: { name: string; map?: string }[] }

type ModelDraft = {
  table: Table
  name: string
  fields: Field[]
  fieldNames: Set<string>
  /** column id -> field name */
  columnField: Map<string, string>
  /** column id -> resolved SQL type */
  columnType: Map<string, ResolvedType>
  /** `@@id([...])` for composite primary keys. */
  idAttrs: string[]
  /** `@@index([fk])` for foreign keys that nothing else already indexes. */
  indexAttrs: string[]
  /** `@@map("table_name")` when the model name differs from the table name. */
  mapAttr?: string
}

const ACTIONS: Record<ReferentialAction, string> = {
  CASCADE: 'Cascade',
  'SET NULL': 'SetNull',
  RESTRICT: 'Restrict',
  'NO ACTION': 'NoAction',
  'SET DEFAULT': 'SetDefault',
}

function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
}

export const toPascal = (s: string) =>
  words(s)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')

export const toCamel = (s: string) => {
  const p = toPascal(s)
  return p ? p[0].toLowerCase() + p.slice(1) : p
}

/** Prisma identifiers must start with a letter. */
const safeIdent = (s: string, fallback: string) => {
  if (!s) return fallback
  return /^[A-Za-z]/.test(s) ? s : `${fallback}${s}`
}

function unique(base: string, taken: Set<string>): string {
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`
  taken.add(name)
  return name
}

const q = (s: string) => JSON.stringify(s)

function convertDefault(col: Column, type: ResolvedType, enumDef?: EnumDef): string | undefined {
  const raw = col.default.trim()
  if (!raw || /^null$/i.test(raw)) return undefined

  if (/^(now\(\)|current_timestamp(\(\d*\))?|localtimestamp(\(\d*\))?)$/i.test(raw)) return 'now()'
  if (/^(uuid\(\)|gen_random_uuid\(\)|uuid_generate_v4\(\))$/i.test(raw)) return 'uuid()'

  if (!type.array) {
    if (type.scalar === 'Boolean' && /^(true|false)$/i.test(raw)) return raw.toLowerCase()
    if (/^-?\d+(\.\d+)?$/.test(raw) && ['Int', 'BigInt', 'Float', 'Decimal'].includes(type.scalar)) return raw
    const str = /^'((?:[^']|'')*)'$/.exec(raw)
    if (str) {
      const value = str[1].replace(/''/g, "'")
      if (enumDef) {
        const hit = enumDef.values.find((v) => (v.map ?? v.name) === value)
        if (hit) return hit.name
      } else if (type.scalar === 'String') {
        return q(value)
      }
    }
  }
  return `dbgenerated(${q(raw)})`
}

export function generatePrisma(diagram: Diagram): GenerateResult {
  const { provider, tables } = diagram
  const warnings: string[] = []
  const enums: EnumDef[] = []
  const enumNames = new Set<string>()
  const modelNames = new Set<string>()

  // ---- Pass 1: models and scalar fields -------------------------------------------------
  const drafts: ModelDraft[] = tables.map((table) => {
    // Prisma convention: models are singular PascalCase (`User`), mapped to the real table (`users`) with @@map.
    const name = unique(safeIdent(toPascal(singularizeName(table.name)), 'Model'), modelNames)
    const draft: ModelDraft = {
      table,
      name,
      fields: [],
      fieldNames: new Set(),
      columnField: new Map(),
      columnType: new Map(),
      idAttrs: [],
      indexAttrs: [],
    }

    const pkCols = table.columns.filter((c) => c.primaryKey)

    for (const col of table.columns) {
      const fieldName = unique(safeIdent(toCamel(col.name), 'field'), draft.fieldNames)
      draft.columnField.set(col.id, fieldName)

      const resolved = resolveSqlType(col.type, provider)
      const attrs: string[] = []
      let typeName: string
      let list = false
      let enumDef: EnumDef | undefined

      if (!resolved.ok) {
        warnings.push(`${table.name}.${col.name}: ${resolved.error} — emitted as Unsupported`)
        typeName = `Unsupported(${q(col.type.trim())})`
        draft.columnType.set(col.id, { scalar: 'String', autoIncrement: false, array: false })
      } else {
        const t = resolved.value
        draft.columnType.set(col.id, t)
        list = t.array
        if (t.scalar === 'Enum') {
          const enumName = unique(`${name}${toPascal(fieldName)}`, enumNames)
          enumDef = {
            name: enumName,
            values: (t.enumValues ?? []).map((v) => {
              const id = safeIdent(v.replace(/[^A-Za-z0-9_]/g, '_'), 'V_')
              return id === v ? { name: id } : { name: id, map: v }
            }),
          }
          enums.push(enumDef)
          typeName = enumName
        } else {
          typeName = t.scalar
        }

        if (col.primaryKey && pkCols.length === 1) attrs.push('@id')
        if (t.autoIncrement) attrs.push('@default(autoincrement())')
        else {
          const def = convertDefault(col, t, enumDef)
          if (def) attrs.push(`@default(${def})`)
        }
        if (col.unique && !(col.primaryKey && pkCols.length === 1)) attrs.push('@unique')
        // `updated_at` columns are kept current by Prisma itself (it sets them on every update).
        if (t.scalar === 'DateTime' && !t.array && /^updated_?at$/i.test(col.name)) attrs.push('@updatedAt')
        if (fieldName !== col.name) attrs.push(`@map(${q(col.name)})`)
        if (t.native) attrs.push(`@db.${t.native}`)
      }

      if (!resolved.ok) {
        if (col.primaryKey && pkCols.length === 1) attrs.push('@id')
        if (col.unique && !col.primaryKey) attrs.push('@unique')
        if (fieldName !== col.name) attrs.push(`@map(${q(col.name)})`)
      }

      draft.fields.push({
        name: fieldName,
        type: typeName,
        optional: !col.notNull && !col.primaryKey && !list,
        list,
        attrs,
      })
    }

    if (pkCols.length > 1) {
      draft.idAttrs.push(`@@id([${pkCols.map((c) => draft.columnField.get(c.id)).join(', ')}])`)
    }
    if (name !== table.name) draft.mapAttr = `@@map(${q(table.name)})`
    if (!pkCols.length && !table.columns.some((c) => c.unique)) {
      warnings.push(`${table.name}: Prisma models need a primary key or a unique column`)
    }
    return draft
  })

  // ---- Pass 2: relations ------------------------------------------------------------------
  type Link = { source: ModelDraft; col: Column; target: ModelDraft; targetCol: Column }
  const links: Link[] = []
  for (const source of drafts) {
    for (const col of source.table.columns) {
      if (!col.references) continue
      const target = drafts.find((d) => d.table.id === col.references!.tableId)
      const targetCol = target?.table.columns.find((c) => c.id === col.references!.columnId)
      if (target && targetCol) links.push({ source, col, target, targetCol })
    }
  }

  for (const i of checkRelations(diagram)) warnings.push(`${i.label}: ${i.message}`)

  const pairKey = (a: ModelDraft, b: ModelDraft) => [a.name, b.name].sort().join('|')
  const pairCount = new Map<string, number>()
  for (const l of links) {
    const key = pairKey(l.source, l.target)
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
  }
  // A many-to-many between the same two models is one more relation between them (it is always named), so Prisma
  // can only tell the foreign-key relations from it if those are named as well.
  for (const m of diagram.manyToMany ?? []) {
    const a = drafts.find((d) => d.table.id === m.aTableId)
    const b = drafts.find((d) => d.table.id === m.bTableId)
    if (a && b) pairCount.set(pairKey(a, b), (pairCount.get(pairKey(a, b)) ?? 0) + 1)
  }

  for (const { source, col, target, targetCol } of links) {
    const fkField = source.columnField.get(col.id)!
    const refField = target.columnField.get(targetCol.id)!
    const action = col.references!

    // A key that is both auto-generated and a foreign key contradicts itself: the usual cause is a relation drawn
    // backwards (from the parent's id to the child), which also leaves the real foreign key column unrelated.
    if (col.primaryKey && source.columnType.get(col.id)?.autoIncrement) {
      warnings.push(
        `${source.table.name}.${col.name}: an auto-increment primary key can't also be a foreign key to ` +
          `${target.table.name}.${targetCol.name}. The relation is probably drawn backwards: the foreign key belongs ` +
          `on the table that refers to the other one.`,
      )
    }

    const ambiguous = source === target || (pairCount.get(pairKey(source, target)) ?? 0) > 1

    // forward field (on the table holding the foreign key): `authorId` -> `author`
    const stripped = fkField.replace(/_?[iI]d$/, '')
    const forwardBase = stripped && stripped !== fkField ? stripped : toCamel(target.name)
    const forwardName = unique(forwardBase, source.fieldNames)
    // Several relations between the same two models (or a self-reference) must be told apart by name.
    const relName = ambiguous ? `${source.name}${toPascal(forwardName)}` : undefined
    // SET NULL can't apply to a required column: Prisma rejects the whole schema, so leave the action out (the
    // foreign key then uses the default for a required relation) and say so.
    const required = col.notNull || col.primaryKey
    const onDelete = required && action.onDelete === 'SET NULL' ? undefined : action.onDelete
    const onUpdate = required && action.onUpdate === 'SET NULL' ? undefined : action.onUpdate
    if (required && (action.onDelete === 'SET NULL' || action.onUpdate === 'SET NULL')) {
      warnings.push(
        `${source.table.name}.${col.name}: SET NULL needs an optional (nullable) column, so it was left out of the Prisma relation`,
      )
    }
    const relArgs = [
      relName && q(relName),
      `fields: [${fkField}]`,
      `references: [${refField}]`,
      onDelete && `onDelete: ${ACTIONS[onDelete]}`,
      onUpdate && `onUpdate: ${ACTIONS[onUpdate]}`,
    ].filter(Boolean)
    source.fields.push({
      name: forwardName,
      type: target.name,
      optional: !col.notNull && !col.primaryKey,
      list: false,
      attrs: [`@relation(${relArgs.join(', ')})`],
    })

    // back-relation (on the referenced table): a list is plural (`posts`), a one-to-one is a single (`profile`)
    const oneToOne = isOneToOne(source.table, col)
    const backRoot = oneToOne ? toCamel(source.name) : pluralizeName(toCamel(source.name))
    const backBase = ambiguous ? `${backRoot}By${toPascal(forwardName)}` : backRoot
    target.fields.push({
      name: unique(backBase, target.fieldNames),
      type: source.name,
      optional: oneToOne,
      list: !oneToOne,
      attrs: relName ? [`@relation(${q(relName)})`] : [],
    })

    // PostgreSQL and SQLite don't index a foreign key by themselves (MySQL does), so joins and cascading deletes
    // would scan the whole table. Skip it when the column is already covered by the primary key or a unique.
    if (provider !== 'mysql') {
      const pks = source.table.columns.filter((c) => c.primaryKey)
      const covered = col.unique || (col.primaryKey && pks[0]?.id === col.id)
      if (!covered) source.indexAttrs.push(`@@index([${fkField}])`)
    }
  }

  // ---- Pass 3: many-to-many (implicit relations) ------------------------------------------
  const relNames = new Set<string>()
  for (const m of diagram.manyToMany ?? []) {
    const a = drafts.find((d) => d.table.id === m.aTableId)
    const b = drafts.find((d) => d.table.id === m.bTableId)
    if (!a || !b) continue
    const label = `${a.table.name} ↔ ${b.table.name}`
    const single = (d: ModelDraft) => d.table.columns.filter((c) => c.primaryKey).length === 1
    if (!single(a) || !single(b)) {
      warnings.push(`${label}: many-to-many needs a single-column primary key on both tables — skipped`)
      continue
    }
    const relName = unique(`${a.name}To${b.name}`, relNames)
    // `tags` on Post, `posts` on Tag. A table related to itself needs two different names (`usersA`, `usersB`).
    const aField = unique(`${pluralizeName(toCamel(b.name))}${a === b ? 'A' : ''}`, a.fieldNames)
    const bField = unique(`${pluralizeName(toCamel(a.name))}${a === b ? 'B' : ''}`, b.fieldNames)
    a.fields.push({
      name: aField,
      type: b.name,
      optional: false,
      list: true,
      attrs: [`@relation(${q(relName)})`],
    })
    b.fields.push({
      name: bField,
      type: a.name,
      optional: false,
      list: true,
      attrs: [`@relation(${q(relName)})`],
    })
  }

  // ---- Render -----------------------------------------------------------------------------
  const out: string[] = [
    '// Prisma schema generated by erd.designer.',
    '// Prisma 7 keeps the database URL out of this file: set it in prisma.config.ts (datasource.url = env("DATABASE_URL")).',
    ...warnings.map((w) => `// Note: ${w}`),
    '',
    'generator client {',
    '  provider = "prisma-client"',
    '  output   = "../generated/prisma"',
    '}',
    '',
    'datasource db {',
    `  provider = "${provider}"`,
    '}',
  ]

  for (const d of drafts) {
    out.push('', `model ${d.name} {`)
    const nameW = Math.max(0, ...d.fields.map((f) => f.name.length))
    const typeStrs = d.fields.map((f) => `${f.type}${f.list ? '[]' : ''}${f.optional ? '?' : ''}`)
    const typeW = Math.max(0, ...typeStrs.map((t) => t.length))
    d.fields.forEach((f, i) => {
      const line = [
        f.name.padEnd(nameW),
        f.attrs.length ? typeStrs[i].padEnd(typeW) : typeStrs[i],
        ...f.attrs,
      ]
      out.push(`  ${line.join(' ')}`.trimEnd())
    })
    const blockAttrs = [...d.idAttrs, ...[...new Set(d.indexAttrs)], ...(d.mapAttr ? [d.mapAttr] : [])]
    if (blockAttrs.length) out.push('', ...blockAttrs.map((a) => `  ${a}`))
    out.push('}')
  }

  for (const e of enums) {
    out.push('', `enum ${e.name} {`)
    for (const v of e.values) out.push(`  ${v.name}${v.map ? ` @map(${q(v.map)})` : ''}`)
    out.push('}')
  }

  return { schema: out.join('\n') + '\n', warnings }
}
