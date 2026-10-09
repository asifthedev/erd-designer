import { DATABASES, REFERENTIAL_ACTIONS, TABLE_COLOR_IDS, type ToolName } from '../../../shared/aiToolSpecs'
import type { Column, ManyToMany, Provider, Reference, ReferentialAction, Table } from '../core/model'
import { checkRelations, isInvalid } from '../core/relations'
import { resolveSqlType } from '../core/sqlType'
import { TABLE_ICON_NAMES } from '../components/tableIcons'
import type { TableNodeType } from '../store'
import { layoutReport } from './layoutReport'
import { layoutTables, rightEdge, tableHeight, TABLE_WIDTH } from './layout'

/**
 * Runs one assistant tool call against the canvas. Pure: it takes the canvas and returns the new canvas plus a message
 * for the model. A call is all-or-nothing: if any part is wrong the canvas is returned untouched and the message says
 * what to fix, so the model can correct itself. Nothing here touches the store, the network or the DOM.
 */

export type Canvas = { provider: Provider; nodes: TableNodeType[]; manyToMany: ManyToMany[] }
export type Ctx = { maxTables: number; uid: () => string }
export type Outcome = {
  ok: boolean
  /** Told to the model. */
  message: string
  /** What the person sees on the chip under the answer. */
  summary: string
  canvas: Canvas
  /** Work only the caller can do (it needs the account, not just the canvas). */
  effect?: { type: 'create_diagram'; title: string }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined)
const flag = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** A refused call: the summary (what the person sees) carries the first reason, so a red chip explains itself. */
const fail = (canvas: Canvas, message: string, summary?: string): Outcome => {
  const reason = (message.split('\n').find((l) => l.startsWith('- '))?.slice(2) ?? message).replace(/\s+/g, ' ')
  return { ok: false, message, summary: summary ?? `Could not apply: ${reason.length > 140 ? `${reason.slice(0, 137)}...` : reason}`, canvas }
}

/** A serial key is generated; a foreign key to it is the plain integer of the same size. */
export function fkTypeFor(type: string): string {
  const t = type.trim()
  if (/^bigserial$/i.test(t)) return 'BIGINT'
  if (/^smallserial$/i.test(t)) return 'SMALLINT'
  if (/^serial$/i.test(t)) return 'INT'
  return type
}

const lower = (s: string) => s.toLowerCase()
const findTable = (nodes: TableNodeType[], name: string) => nodes.find((n) => lower(n.data.name) === lower(name))
const findColumn = (t: Table, name: string) => t.columns.find((c) => lower(c.name) === lower(name))
const names = (nodes: TableNodeType[]) => (nodes.length ? nodes.map((n) => n.data.name).join(', ') : '(none)')

function noTable(nodes: TableNodeType[], name: string) {
  const near = nodes.map((n) => n.data.name).filter((n) => lower(n).includes(lower(name)) || lower(name).includes(lower(n)))
  return `There is no table "${name}". ${near.length ? `Did you mean ${near.map((n) => `"${n}"`).join(' or ')}? ` : ''}Existing tables: ${names(nodes)}.`
}

const problemsText = (problems: string[]) => problems.slice(0, 8).join('\n- ') + (problems.length > 8 ? `\n- ...and ${problems.length - 8} more` : '')

// ---- Building columns --------------------------------------------------------------------------------------------

type ColumnDraft = { column: Column; ref?: { table: string; column?: string; onDelete?: ReferentialAction; onUpdate?: ReferentialAction } }

const action = (v: unknown): ReferentialAction | undefined => ((REFERENTIAL_ACTIONS as readonly unknown[]).includes(v) ? (v as ReferentialAction) : undefined)

function parseRef(v: unknown, where: string, problems: string[]): ColumnDraft['ref'] {
  if (v === undefined || v === null) return undefined
  if (!isObj(v) || !text(v.table)) {
    problems.push(`${where}: "references" needs a "table".`)
    return undefined
  }
  return { table: text(v.table)!, column: text(v.column), onDelete: action(v.onDelete), onUpdate: action(v.onUpdate) }
}

function draftColumn(spec: unknown, where: string, provider: Provider, ctx: Ctx, problems: string[]): ColumnDraft | null {
  if (!isObj(spec)) {
    problems.push(`${where}: each column must be an object with "name" and "type".`)
    return null
  }
  const name = text(spec.name, 128)
  const type = text(spec.type, 100)
  const label = `${where}${name ? `.${name}` : ''}`
  if (!name) problems.push(`${label}: a column needs a "name".`)
  if (!type) problems.push(`${label}: a column needs a "type" (for example INT, VARCHAR(255), TIMESTAMP).`)
  if (!name || !type) return null
  const resolved = resolveSqlType(type, provider)
  if (!resolved.ok) {
    problems.push(`${label}: type "${type}" is not valid for ${provider}: ${resolved.error}`)
    return null
  }
  const primaryKey = flag(spec.primaryKey) ?? false
  return {
    column: {
      id: ctx.uid(),
      name,
      type,
      primaryKey,
      notNull: primaryKey ? true : (flag(spec.notNull) ?? false),
      unique: flag(spec.unique) ?? false,
      default: typeof spec.default === 'string' ? spec.default : '',
    },
    ref: parseRef(spec.references, label, problems),
  }
}

const pkOf = (t: Table) => {
  const pks = t.columns.filter((c) => c.primaryKey)
  return pks.length === 1 ? pks[0] : undefined
}

/**
 * Turns the foreign keys the model asked for (by name) into real references, aligning the column type with the key it
 * points at. Returns what was adjusted; problems go into `problems`.
 */
function resolveRefs(
  drafts: { table: Table; col: Column; ref: NonNullable<ColumnDraft['ref']> }[],
  tables: Table[],
  problems: string[],
  notes: string[],
) {
  for (const { table, col, ref } of drafts) {
    const where = `${table.name}.${col.name}`
    const target = tables.find((t) => lower(t.name) === lower(ref.table))
    if (!target) {
      problems.push(`${where}: references unknown table "${ref.table}". Known tables: ${tables.map((t) => t.name).join(', ')}.`)
      continue
    }
    const to = ref.column ? findColumn(target, ref.column) : pkOf(target)
    if (!to) {
      problems.push(
        ref.column
          ? `${where}: table "${target.name}" has no column "${ref.column}". Its columns: ${target.columns.map((c) => c.name).join(', ')}.`
          : `${where}: table "${target.name}" has no single primary key, so say which "column" it references.`,
      )
      continue
    }
    const reference: Reference = { tableId: target.id, columnId: to.id, ...(ref.onDelete ? { onDelete: ref.onDelete } : {}), ...(ref.onUpdate ? { onUpdate: ref.onUpdate } : {}) }
    col.references = reference
    // A foreign key is never itself generated, and has the type of the key it points at.
    const wanted = fkTypeFor(to.type)
    if (col.type.trim().toLowerCase() !== wanted.trim().toLowerCase()) {
      const before = col.type
      col.type = wanted
      if (!/^(big|small)?serial$/i.test(before.trim())) notes.push(`${where} was ${before}; changed to ${wanted} to match ${target.name}.${to.name}`)
    }
  }
}

/** Every foreign key must work; returns the explanations of those that don't. */
function relationProblems(provider: Provider, tables: Table[]): string[] {
  return checkRelations({ provider, tables, manyToMany: [] })
    .filter(isInvalid)
    .map((i) => `${i.label}: ${i.message}`)
}

const duplicates = (items: string[]) => items.filter((n, i) => items.findIndex((m) => lower(m) === lower(n)) !== i)

function describeTable(t: Table, tables: Table[]): string {
  const cols = t.columns.map((c) => {
    const target = c.references && tables.find((x) => x.id === c.references!.tableId)
    const to = target?.columns.find((x) => x.id === c.references!.columnId)
    return `${c.name} ${c.type}${c.primaryKey ? ' PK' : ''}${target && to ? ` -> ${target.name}.${to.name}` : ''}`
  })
  return `${t.name}(${cols.join(', ')})`
}

const withNodes = (canvas: Canvas, nodes: TableNodeType[], manyToMany = canvas.manyToMany): Canvas => ({ ...canvas, nodes, manyToMany })
const tablesOf = (nodes: TableNodeType[]) => nodes.map((n) => n.data)
const mkNode = (table: Table, position: { x: number; y: number }): TableNodeType => ({ id: table.id, type: 'table', position, data: table })

// ---- The tools ---------------------------------------------------------------------------------------------------

function createTables(canvas: Canvas, args: Obj, ctx: Ctx): Outcome {
  const specs = list(args.tables)
  if (!specs.length) return fail(canvas, 'create_tables needs a non-empty "tables" array.')
  if (specs.length > 60) return fail(canvas, 'Create at most 60 tables per call; split the rest into another call.')
  if (canvas.nodes.length + specs.length > ctx.maxTables) {
    return fail(canvas, `The plan allows ${ctx.maxTables} tables in a diagram and the canvas already has ${canvas.nodes.length}, so ${specs.length} more do not fit. Create fewer tables or tell the person to upgrade.`, 'Table limit reached')
  }
  const problems: string[] = []
  const notes: string[] = []
  const built: { table: Table; refs: { table: Table; col: Column; ref: NonNullable<ColumnDraft['ref']> }[] }[] = []
  const seen = names(canvas.nodes)
  for (const [i, spec] of specs.entries()) {
    if (!isObj(spec)) {
      problems.push(`tables[${i}] must be an object.`)
      continue
    }
    const name = text(spec.name, 128)
    if (!name) {
      problems.push(`tables[${i}] needs a "name".`)
      continue
    }
    if (findTable(canvas.nodes, name)) problems.push(`Table "${name}" already exists (existing: ${seen}). Use alter_table to change it.`)
    if (built.some((b) => lower(b.table.name) === lower(name))) problems.push(`Table "${name}" appears twice in this call.`)
    const drafts = list(spec.columns).map((c) => draftColumn(c, name, canvas.provider, ctx, problems))
    if (!list(spec.columns).length) problems.push(`Table "${name}" needs at least one column.`)
    const cols = drafts.filter((d): d is ColumnDraft => d !== null)
    for (const d of duplicates(cols.map((c) => c.column.name))) problems.push(`Table "${name}" has two columns named "${d}".`)
    const icon = text(spec.icon, 60)
    const color = text(spec.color, 20)
    const table: Table = {
      id: ctx.uid(),
      name,
      ...(icon && (TABLE_ICON_NAMES as readonly string[]).includes(icon) ? { icon } : {}),
      ...(color && (TABLE_COLOR_IDS as readonly string[]).includes(color) ? { color } : {}),
      columns: cols.map((c) => c.column),
    }
    if (table.columns.length && !table.columns.some((c) => c.primaryKey)) notes.push(`${name} has no primary key; add one with alter_table.`)
    built.push({ table, refs: cols.filter((c) => c.ref).map((c) => ({ table, col: c.column, ref: c.ref! })) })
  }
  const all = [...tablesOf(canvas.nodes), ...built.map((b) => b.table)]
  resolveRefs(built.flatMap((b) => b.refs), all, problems, notes)
  if (!problems.length) problems.push(...relationProblems(canvas.provider, all))
  if (problems.length) return fail(canvas, `Nothing was created. Fix these and call create_tables again:\n- ${problemsText(problems)}`)

  const fresh = built.map((b) => b.table)
  const origin = { x: canvas.nodes.length ? rightEdge(canvas.nodes) + 220 : 0, y: 0 }
  const place = new Map(layoutTables(fresh, origin).map((p) => [p.id, p]))
  const nodes = [...canvas.nodes, ...fresh.map((t) => mkNode(t, { x: place.get(t.id)!.x, y: place.get(t.id)!.y }))]
  const fks = fresh.flatMap((t) => t.columns.filter((c) => c.references).map((c) => `${t.name}.${c.name}`))
  return {
    ok: true,
    summary: `Created ${fresh.length} table${fresh.length === 1 ? '' : 's'}: ${fresh.map((t) => t.name).join(', ')}`,
    message: `Created ${fresh.length} table(s): ${fresh.map((t) => describeTable(t, all)).join('; ')}.${fks.length ? ` Foreign keys: ${fks.join(', ')}.` : ''}${notes.length ? `\nNotes:\n- ${notes.join('\n- ')}` : ''}`,
    canvas: withNodes(canvas, nodes),
  }
}

function alterTable(canvas: Canvas, args: Obj, ctx: Ctx): Outcome {
  const tableName = text(args.table)
  if (!tableName) return fail(canvas, 'alter_table needs "table" (the current table name).')
  const node = findTable(canvas.nodes, tableName)
  if (!node) return fail(canvas, noTable(canvas.nodes, tableName))
  const problems: string[] = []
  const notes: string[] = []
  const done: string[] = []
  let table: Table = { ...node.data, columns: node.data.columns.map((c) => ({ ...c })) }
  let others = canvas.nodes.filter((n) => n.id !== node.id).map((n) => ({ ...n, data: { ...n.data, columns: n.data.columns.map((c) => ({ ...c })) } }))

  const rename = text(args.rename, 128)
  if (rename && lower(rename) !== lower(table.name)) {
    if (findTable(others, rename)) problems.push(`Cannot rename to "${rename}": a table with that name exists.`)
    else {
      done.push(`renamed ${table.name} to ${rename}`)
      table.name = rename
    }
  }
  const icon = text(args.icon, 60)
  if (icon) {
    if ((TABLE_ICON_NAMES as readonly string[]).includes(icon)) table.icon = icon
    else notes.push(`Icon "${icon}" does not exist; left unchanged.`)
  }
  const color = text(args.color, 20)
  if (color && (TABLE_COLOR_IDS as readonly string[]).includes(color)) table.color = color

  const drop = list(args.dropColumns).map((n) => text(n)).filter((n): n is string => !!n)
  for (const name of drop) {
    const col = findColumn(table, name)
    if (!col) {
      problems.push(`Cannot drop column "${name}": ${table.name} has ${table.columns.map((c) => c.name).join(', ')}.`)
      continue
    }
    table.columns = table.columns.filter((c) => c.id !== col.id)
    // Foreign keys elsewhere that pointed at it are removed with it.
    others = others.map((o) => ({
      ...o,
      data: {
        ...o.data,
        columns: o.data.columns.map((c) => {
          if (c.references?.columnId !== col.id) return c
          notes.push(`${o.data.name}.${c.name} no longer references anything (the column it pointed at was dropped).`)
          return { ...c, references: undefined }
        }),
      },
    }))
    done.push(`dropped ${col.name}`)
  }

  const refs: { table: Table; col: Column; ref: NonNullable<ColumnDraft['ref']> }[] = []
  const retyped: { id: string; type: string }[] = []
  for (const u of list(args.updateColumns)) {
    if (!isObj(u)) continue
    const name = text(u.name)
    const col = name ? findColumn(table, name) : undefined
    if (!name || !col) {
      problems.push(`Cannot update column "${name ?? '?'}": ${table.name} has ${table.columns.map((c) => c.name).join(', ')}.`)
      continue
    }
    const newName = text(u.rename, 128)
    if (newName && lower(newName) !== lower(col.name)) {
      if (findColumn(table, newName)) problems.push(`Cannot rename ${col.name} to "${newName}": that column exists.`)
      else {
        col.name = newName
        done.push(`renamed column ${name} to ${newName}`)
      }
    }
    const type = text(u.type, 100)
    if (type && type !== col.type) {
      const resolved = resolveSqlType(type, canvas.provider)
      if (!resolved.ok) problems.push(`${table.name}.${col.name}: type "${type}" is not valid for ${canvas.provider}: ${resolved.error}`)
      else {
        col.type = type
        retyped.push({ id: col.id, type })
        done.push(`${col.name} is now ${type}`)
      }
    }
    const pk = flag(u.primaryKey)
    if (pk !== undefined) {
      col.primaryKey = pk
      if (pk) col.notNull = true
    }
    const nn = flag(u.notNull)
    if (nn !== undefined) col.notNull = nn || col.primaryKey
    const uq = flag(u.unique)
    if (uq !== undefined) col.unique = uq
    if (typeof u.default === 'string') col.default = u.default
    const ref = parseRef(u.references, `${table.name}.${col.name}`, problems)
    if (ref) refs.push({ table, col, ref })
  }

  for (const spec of list(args.addColumns)) {
    const d = draftColumn(spec, table.name, canvas.provider, ctx, problems)
    if (!d) continue
    if (findColumn(table, d.column.name)) {
      problems.push(`${table.name} already has a column "${d.column.name}". Use updateColumns to change it.`)
      continue
    }
    table.columns.push(d.column)
    if (d.ref) refs.push({ table, col: d.column, ref: d.ref })
    done.push(`added ${d.column.name}`)
  }
  if (!table.columns.length) problems.push(`${table.name} would have no columns left.`)

  // Children of a re-typed key follow its type, instead of leaving the foreign keys broken.
  for (const { id, type } of retyped) {
    others = others.map((o) => ({
      ...o,
      data: {
        ...o.data,
        columns: o.data.columns.map((c) => {
          if (c.references?.columnId !== id) return c
          notes.push(`${o.data.name}.${c.name} was changed to ${fkTypeFor(type)} to follow the new type of ${table.name}.`)
          return { ...c, type: fkTypeFor(type) }
        }),
      },
    }))
    table.columns.forEach((c) => {
      if (c.references?.columnId === id) c.type = fkTypeFor(type)
    })
  }

  const all = [...others.map((n) => n.data), table]
  resolveRefs(refs, all, problems, notes)
  if (!problems.length) problems.push(...relationProblems(canvas.provider, all))
  if (problems.length) return fail(canvas, `Nothing was changed. Fix these and call alter_table again:\n- ${problemsText(problems)}`)

  const nodes = canvas.nodes.map((n) => (n.id === node.id ? { ...n, data: table } : (others.find((o) => o.id === n.id) ?? n)))
  const result = done.length ? done.join('; ') : 'no change'
  return {
    ok: true,
    summary: `${table.name}: ${result}`,
    message: `${table.name}: ${result}. Now ${describeTable(table, all)}.${notes.length ? `\nNotes:\n- ${notes.join('\n- ')}` : ''}`,
    canvas: withNodes(canvas, nodes),
  }
}

function dropTables(canvas: Canvas, args: Obj): Outcome {
  const wanted = list(args.tables).map((n) => text(n)).filter((n): n is string => !!n)
  if (!wanted.length) return fail(canvas, 'drop_tables needs a non-empty "tables" array of names.')
  const problems: string[] = []
  const gone = new Set<string>()
  for (const name of wanted) {
    const t = findTable(canvas.nodes, name)
    if (t) gone.add(t.id)
    else problems.push(noTable(canvas.nodes, name))
  }
  if (problems.length) return fail(canvas, `Nothing was deleted:\n- ${problemsText(problems)}`)
  const removed: string[] = []
  const nodes = canvas.nodes
    .filter((n) => !gone.has(n.id))
    .map((n) =>
      n.data.columns.some((c) => c.references && gone.has(c.references.tableId))
        ? {
            ...n,
            data: {
              ...n.data,
              columns: n.data.columns.map((c) => {
                if (!c.references || !gone.has(c.references.tableId)) return c
                removed.push(`${n.data.name}.${c.name}`)
                return { ...c, references: undefined }
              }),
            },
          }
        : n,
    )
  const links = canvas.manyToMany.filter((l) => !gone.has(l.aTableId) && !gone.has(l.bTableId))
  const deleted = canvas.nodes.filter((n) => gone.has(n.id)).map((n) => n.data.name)
  return {
    ok: true,
    summary: `Deleted ${deleted.join(', ')}`,
    message: `Deleted ${deleted.join(', ')}.${removed.length ? ` Foreign keys that pointed at them were removed: ${removed.join(', ')} (the columns stay).` : ''}`,
    canvas: withNodes(canvas, nodes, links),
  }
}

function setRelation(canvas: Canvas, args: Obj, ctx: Ctx): Outcome {
  const tableName = text(args.table)
  const columnName = text(args.column, 128)
  if (!tableName || !columnName) return fail(canvas, 'set_relation needs "table", "column" and "references".')
  const node = findTable(canvas.nodes, tableName)
  if (!node) return fail(canvas, noTable(canvas.nodes, tableName))
  const problems: string[] = []
  const ref = parseRef(args.references, `${node.data.name}.${columnName}`, problems)
  if (!ref) return fail(canvas, problems[0] ?? 'set_relation needs "references".')
  const notes: string[] = []
  const table: Table = { ...node.data, columns: node.data.columns.map((c) => ({ ...c })) }
  let col = findColumn(table, columnName)
  const created = !col
  if (!col) {
    col = { id: ctx.uid(), name: columnName, type: 'INT', primaryKey: false, notNull: false, unique: false, default: '' }
    table.columns.push(col)
  }
  const all = [...canvas.nodes.filter((n) => n.id !== node.id).map((n) => n.data), table]
  resolveRefs([{ table, col, ref }], all, problems, notes)
  if (!problems.length) problems.push(...relationProblems(canvas.provider, all))
  if (problems.length) return fail(canvas, `Nothing was changed:\n- ${problemsText(problems)}`)
  const target = all.find((t) => t.id === col!.references!.tableId)!
  const nodes = canvas.nodes.map((n) => (n.id === node.id ? { ...n, data: table } : n))
  const text_ = `${table.name}.${col.name} -> ${target.name}.${target.columns.find((c) => c.id === col!.references!.columnId)!.name}`
  return {
    ok: true,
    summary: created ? `Added ${text_}` : `Linked ${text_}`,
    message: `${created ? 'Created column and set' : 'Set'} foreign key ${text_}.${notes.length ? `\nNotes:\n- ${notes.join('\n- ')}` : ''}`,
    canvas: withNodes(canvas, nodes),
  }
}

function removeRelation(canvas: Canvas, args: Obj): Outcome {
  const tableName = text(args.table)
  const columnName = text(args.column, 128)
  if (!tableName || !columnName) return fail(canvas, 'remove_relation needs "table" and "column".')
  const node = findTable(canvas.nodes, tableName)
  if (!node) return fail(canvas, noTable(canvas.nodes, tableName))
  const col = findColumn(node.data, columnName)
  if (!col) return fail(canvas, `${node.data.name} has no column "${columnName}". Its columns: ${node.data.columns.map((c) => c.name).join(', ')}.`)
  if (!col.references) return fail(canvas, `${node.data.name}.${col.name} is not a foreign key.`)
  const nodes = canvas.nodes.map((n) =>
    n.id === node.id ? { ...n, data: { ...n.data, columns: n.data.columns.map((c) => (c.id === col.id ? { ...c, references: undefined } : c)) } } : n,
  )
  return { ok: true, summary: `Removed ${node.data.name}.${col.name} relation`, message: `${node.data.name}.${col.name} no longer references another table.`, canvas: withNodes(canvas, nodes) }
}

function setDatabase(canvas: Canvas, args: Obj): Outcome {
  const database = args.database
  if (!(DATABASES as readonly unknown[]).includes(database)) return fail(canvas, `"database" must be one of ${DATABASES.join(', ')}.`)
  const provider = database as Provider
  const bad: string[] = []
  for (const n of canvas.nodes) {
    for (const c of n.data.columns) {
      const r = resolveSqlType(c.type, provider)
      if (!r.ok) bad.push(`${n.data.name}.${c.name} (${c.type}): ${r.error}`)
    }
  }
  const issues = relationProblems(provider, tablesOf(canvas.nodes))
  return {
    ok: true,
    summary: `Database set to ${provider}`,
    message:
      `The database is now ${provider}.` +
      (bad.length ? `\nThese types are not valid there, fix them with alter_table:\n- ${problemsText(bad)}` : '') +
      (issues.length ? `\nThese relations no longer work:\n- ${problemsText(issues)}` : ''),
    canvas: { ...canvas, provider },
  }
}

function autoLayout(canvas: Canvas): Outcome {
  if (!canvas.nodes.length) return fail(canvas, 'The canvas is empty; there is nothing to arrange.')
  const place = new Map(layoutTables(tablesOf(canvas.nodes)).map((p) => [p.id, p]))
  const nodes = canvas.nodes.map((n) => ({ ...n, position: { x: place.get(n.id)!.x, y: place.get(n.id)!.y } }))
  const next = withNodes(canvas, nodes)
  return { ok: true, summary: 'Arranged the tables', message: `Arranged ${nodes.length} tables. ${layoutReport(next).text}`, canvas: next }
}

const coordinate = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100_000 ? Math.round(v) : undefined)
const sizeOf = (n: TableNodeType) => ({ w: n.measured?.width ?? TABLE_WIDTH, h: n.measured?.height ?? tableHeight(n.data) })

function moveTables(canvas: Canvas, args: Obj): Outcome {
  const moves = list(args.moves)
  if (!moves.length) return fail(canvas, 'move_tables needs a non-empty "moves" array.')
  const problems: string[] = []
  let nodes = canvas.nodes
  const moved: string[] = []
  for (const mv of moves) {
    if (!isObj(mv)) {
      problems.push('Each move must be an object with "table".')
      continue
    }
    const name = text(mv.table)
    const node = name ? findTable(nodes, name) : undefined
    if (!name || !node) {
      problems.push(name ? noTable(nodes, name) : 'A move needs "table".')
      continue
    }
    let position: { x: number; y: number } | undefined
    if (isObj(mv.nextTo)) {
      const anchorName = text(mv.nextTo.table)
      const anchor = anchorName ? findTable(nodes, anchorName) : undefined
      const side = mv.nextTo.side
      if (!anchor || anchor.id === node.id) {
        problems.push(anchorName ? `Cannot place ${node.data.name} next to ${anchorName}.` : `${node.data.name}: "nextTo" needs a "table".`)
        continue
      }
      if (side !== 'right' && side !== 'left' && side !== 'below' && side !== 'above') {
        problems.push(`${node.data.name}: "side" must be right, left, below or above.`)
        continue
      }
      const gap = coordinate(mv.nextTo.gap) ?? (side === 'right' || side === 'left' ? 200 : 80)
      const a = sizeOf(anchor)
      const me = sizeOf(node)
      position =
        side === 'right' ? { x: anchor.position.x + a.w + gap, y: anchor.position.y }
        : side === 'left' ? { x: anchor.position.x - me.w - gap, y: anchor.position.y }
        : side === 'below' ? { x: anchor.position.x, y: anchor.position.y + a.h + gap }
        : { x: anchor.position.x, y: anchor.position.y - me.h - gap }
    } else {
      const x = coordinate(mv.x)
      const y = coordinate(mv.y)
      if (x === undefined && y === undefined) {
        problems.push(`${node.data.name}: give "x" and / or "y", or "nextTo".`)
        continue
      }
      position = { x: x ?? node.position.x, y: y ?? node.position.y }
    }
    const target = position
    nodes = nodes.map((n) => (n.id === node.id ? { ...n, position: target } : n))
    moved.push(`${node.data.name} -> (${target.x}, ${target.y})`)
  }
  if (problems.length) return fail(canvas, `Nothing was moved:\n- ${problemsText(problems)}`)
  const next = withNodes(canvas, nodes)
  return { ok: true, summary: `Moved ${moved.length} table${moved.length === 1 ? '' : 's'}`, message: `Moved: ${moved.join('; ')}.\n${layoutReport(next).text}`, canvas: next }
}

function manyToManyLink(canvas: Canvas, args: Obj, ctx: Ctx, remove: boolean): Outcome {
  const [aName, bName] = [text(args.tableA), text(args.tableB)]
  if (!aName || !bName) return fail(canvas, `${remove ? 'remove_many_to_many' : 'add_many_to_many'} needs "tableA" and "tableB".`)
  const a = findTable(canvas.nodes, aName)
  const b = findTable(canvas.nodes, bName)
  if (!a) return fail(canvas, noTable(canvas.nodes, aName))
  if (!b) return fail(canvas, noTable(canvas.nodes, bName))
  const same = (l: ManyToMany) => (l.aTableId === a.id && l.bTableId === b.id) || (l.aTableId === b.id && l.bTableId === a.id)
  const existing = canvas.manyToMany.find(same)
  if (remove) {
    if (!existing) return fail(canvas, `There is no many-to-many link between ${a.data.name} and ${b.data.name}.`)
    return { ok: true, summary: `Removed the many-to-many link ${a.data.name} - ${b.data.name}`, message: `Removed the link between ${a.data.name} and ${b.data.name}.`, canvas: { ...canvas, manyToMany: canvas.manyToMany.filter((l) => l !== existing) } }
  }
  if (existing) return fail(canvas, `${a.data.name} and ${b.data.name} are already linked many-to-many.`)
  const link: ManyToMany = { id: ctx.uid(), aTableId: a.id, bTableId: b.id }
  return { ok: true, summary: `Linked ${a.data.name} and ${b.data.name} many-to-many`, message: `Linked ${a.data.name} and ${b.data.name} many-to-many (implicit join table).`, canvas: { ...canvas, manyToMany: [...canvas.manyToMany, link] } }
}

function createDiagram(canvas: Canvas, args: Obj): Outcome {
  const title = text(args.title, 100)
  if (!title) return fail(canvas, 'create_diagram needs a "title".')
  return { ok: true, summary: `Started a new diagram "${title}"`, message: '', canvas, effect: { type: 'create_diagram', title } }
}

/** Parses the model's JSON arguments, runs the tool, and never throws: a broken call becomes an error message the model can act on. */
export function runTool(canvas: Canvas, name: string, rawArguments: string, ctx: Ctx): Outcome {
  let args: Obj
  try {
    const parsed: unknown = JSON.parse(rawArguments || '{}')
    if (!isObj(parsed)) throw new Error('not an object')
    args = parsed
  } catch {
    return fail(canvas, `The arguments of ${name} are not valid JSON. Send one JSON object.`)
  }
  try {
    switch (name as ToolName) {
      case 'create_tables':
        return createTables(canvas, args, ctx)
      case 'alter_table':
        return alterTable(canvas, args, ctx)
      case 'drop_tables':
        return dropTables(canvas, args)
      case 'set_relation':
        return setRelation(canvas, args, ctx)
      case 'remove_relation':
        return removeRelation(canvas, args)
      case 'set_database':
        return setDatabase(canvas, args)
      case 'auto_layout':
        return autoLayout(canvas)
      case 'move_tables':
        return moveTables(canvas, args)
      case 'add_many_to_many':
        return manyToManyLink(canvas, args, ctx, false)
      case 'remove_many_to_many':
        return manyToManyLink(canvas, args, ctx, true)
      case 'create_diagram':
        return createDiagram(canvas, args)
      default:
        return fail(canvas, `There is no tool called "${name}".`)
    }
  } catch (e) {
    return fail(canvas, `The tool failed unexpectedly (${(e as Error).message}). Nothing was changed.`)
  }
}
