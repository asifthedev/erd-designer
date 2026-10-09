import { applyNodeChanges, type Connection, type Edge, type Node, type NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { refusedProblem, removedProblem, tableLimitProblem, type Problem } from './core/problems'
import { FREE_FALLBACK } from './plans'
import { checkRelations, isInvalid, type RelationIssue } from './core/relations'
import { showNote, showProblem } from './components/problemToast'
import { sidesForRects, type Side } from './core/routing'
import {
  isOneToOne,
  type Column,
  type Diagram,
  type ManyToMany,
  type Bend,
  type Provider,
  type Reference,
  type ReferentialAction,
  type Table,
} from './core/model'

export type CodeFormat = 'prisma' | 'drizzle' | 'sql'

/** What is saved to the account: the diagram model plus where each table sits on the canvas. */
export type Workspace = {
  provider: Provider
  nodes: { id: string; position: { x: number; y: number }; data: Table }[]
  manyToMany: ManyToMany[]
}

export type TableNodeType = Node<Table, 'table'>

/** Handle ids on the table header, used to draw many-to-many links between whole tables. */
export const SIDEBAR_MIN = 280
export const SIDEBAR_MAX = 960

export const M2M_HANDLE = 'm2m'

/** Every column / header has a connection point on each side: handle ids are `<columnId>.l` and `<columnId>.r`. */
export const handleId = (columnId: string, side: Side) => `${columnId}.${side}`
const columnOf = (handle: string) => handle.split('.')[0]

/**
 * Which side of each table a line uses (see sidesForRects): across the gap when the tables have room between them,
 * otherwise a bracket on one shared side so the line never passes behind a table; both on the right for a self-loop.
 */
function sidesFor(a: TableNodeType, b: TableNodeType): [Side, Side] {
  if (a.id === b.id) return ['r', 'r']
  const rect = (n: TableNodeType) => ({ left: n.position.x, right: n.position.x + (n.measured?.width ?? 680) })
  return sidesForRects(rect(a), rect(b))
}
export const M2M_PREFIX = 'm2m:'

type State = {
  provider: Provider
  nodes: TableNodeType[]
  manyToMany: ManyToMany[]
  /** Table whose "m:n" button was clicked first; the next table clicked completes the link. */
  pendingM2m: string | null
  /** Columns currently blinking red because a relation was refused or broken. */
  flashing: string[]
  /** Shows a problem as a toast and blinks the columns involved. `warning` is for things that need attention. */
  notify: (problem: Problem, columnIds?: string[], kind?: 'error' | 'warning') => void
  /** Tables copied or cut, with their canvas positions. Not persisted. */
  clipboard: { table: Table; position: { x: number; y: number } }[] | null
  /** How many times the current clipboard was pasted (each paste is nudged further). */
  pasteCount: number
  /** The clipboard came from Cut: pasting moves the tables, so they keep their names. */
  clipboardIsCut: boolean
  /** Picks every table (Ctrl/Cmd + A); a following Delete removes them all. */
  selectAllTables: () => void
  copyTables: (ids: string[]) => void
  /** Copy the given tables in place (offset a little), without touching the clipboard. */
  duplicateTables: (ids: string[]) => void
  cutTables: (ids: string[]) => void
  /** Paste the clipboard; `at` is the flow position for the top-left of the pasted group. */
  pasteTables: (at?: { x: number; y: number }) => void
  /** Column row last clicked; the Delete key removes it. Not persisted. */
  selectedColumn: { tableId: string; columnId: string } | null
  /** The table the pointer is over: its relation lines glow. Not persisted. */
  hoveredTableId: string | null
  setSelectedColumn: (c: { tableId: string; columnId: string } | null) => void
  /** Whether the schema.prisma side panel is shown. */
  codeOpen: boolean
  /** The AI assistant panel is shown (it takes the place of the code panel; not remembered between visits). */
  aiOpen: boolean
  toggleAi: () => void
  /** Replaces the canvas content with what an assistant tool call produced (the tool already checked it). */
  applyAiCanvas: (c: { provider: Provider; nodes: TableNodeType[]; manyToMany: ManyToMany[] }) => void
  /** The left sidebar listing the account's ERDs is expanded. */
  listOpen: boolean
  /** The plan's limit on tables in a diagram (the plan planEffects.ts reports); adding beyond it shows the upgrade note. */
  tablePlan: { max: number; name: string; free: boolean }
  /** Compact view: every table shows only its name and each column's name and type. A view setting, not part of the diagram. */
  collapsed: boolean
  toggleCollapsed: () => void
  /** Which export the code panel shows. */
  codeFormat: CodeFormat
  setCodeFormat: (f: CodeFormat) => void
  /** Width in px of the right-hand side panel. */
  sidebarWidth: number
  /** Edge id (`tableId:columnId` of the foreign key) currently selected. */
  /** The relation line that is picked (drawn highlighted). Picking one does NOT open its settings panel. */
  selectedEdgeId: string | null
  /** The picked relation's settings panel is showing in the side panel (see openEdgePanel). */
  edgePanelOpen: boolean

  setProvider: (p: Provider) => void
  onNodesChange: (changes: NodeChange<TableNodeType>[]) => void
  addTable: (position?: { x: number; y: number }) => void
  renameTable: (tableId: string, name: string) => void
  setTableIcon: (tableId: string, icon: string | undefined) => void
  /** Colour of one table (Eraser theme); undefined goes back to the automatic colour. */
  setTableColor: (tableId: string, color: string | undefined) => void
  deleteTable: (tableId: string) => void
  addColumn: (tableId: string) => void
  updateColumn: (tableId: string, columnId: string, patch: Partial<Omit<Column, 'id'>>) => void
  deleteColumn: (tableId: string, columnId: string) => void
  /** Remove every relation that can't work (mismatched types, non-unique target), with a warning each. */
  purgeInvalid: () => void
  connect: (c: Connection) => void
  updateReference: (tableId: string, columnId: string, patch: Partial<Reference>) => void
  removeReference: (tableId: string, columnId: string) => void
  /** Save (or, with undefined, reset) the dragged shape of a relation line. `edgeId` is the id of the edge. */
  setRelationBend: (edgeId: string, bend: Bend | undefined) => void
  /** Add a foreign key to the table's own primary key (a tree / parent-child relation). */
  addSelfReference: (tableId: string) => void
  /**
   * Switch which table is the parent. The foreign key column moves from the child to the old parent and
   * now points back at the child's primary key. Refused (with a message) when that isn't possible.
   */
  flipRelation: (tableId: string, columnId: string) => void
  /** First click picks the source table, second click picks the target (the same table = self-referencing). */
  pickManyToMany: (tableId: string) => void
  removeManyToMany: (id: string) => void
  /** Replace a many-to-many link by an explicit junction table with two foreign keys. */
  convertToJunction: (id: string) => void
  toggleCode: () => void
  toggleList: () => void
  setHoveredTable: (id: string | null) => void
  /** Close the whole side panel: the code view and the relation settings. */
  closeSidebar: () => void
  setSidebarWidth: (w: number) => void
  /** Picks a relation line (or clears the pick). If its settings panel is already open, it follows the pick; otherwise nothing opens. */
  selectEdge: (id: string | null) => void
  /** Picks a relation line AND opens its settings panel: what a double-click on the line does. */
  openEdgePanel: (id: string) => void
  loadSample: () => void
  /** Replace the canvas with a workspace loaded from the server. */
  loadWorkspace: (w: Workspace) => void
  clear: () => void
}

const uid = () => crypto.randomUUID()

const newColumn = (name = 'column', type = 'INT'): Column => ({
  id: uid(),
  name,
  type,
  primaryKey: false,
  notNull: false,
  unique: false,
  default: '',
})

function makeNode(table: Table, position: { x: number; y: number }): TableNodeType {
  return { id: table.id, type: 'table', position, data: table }
}

/**
 * The starter workspace a new user lands on: a small online shop (customers, catalogue, orders, payments) that shows
 * the main features at a glance: primary keys, unique / not-null flags, defaults, foreign keys (with ON DELETE
 * CASCADE where the child cannot outlive its parent), a self-reference (category tree) and per-table icons and colours.
 */
function sampleWorkspace(): { nodes: TableNodeType[]; manyToMany: ManyToMany[] } {
  const pk = (): Column => ({ ...newColumn('id', 'SERIAL'), primaryKey: true, notNull: true })
  const col = (name: string, type: string, extra: Partial<Column> = {}): Column => ({ ...newColumn(name, type), ...extra })
  const required = { notNull: true }
  const createdAt = () => col('createdAt', 'TIMESTAMP', { notNull: true, default: 'now()' })
  const table = (name: string, icon: string, color: string, columns: Column[]): Table => ({
    id: uid(),
    name,
    icon,
    color,
    columns,
  })
  const fk = (name: string, to: Table, extra: Partial<Column> = {}, onDelete?: ReferentialAction): Column =>
    col(name, 'INT', { ...extra, references: { tableId: to.id, columnId: to.columns[0].id, onDelete } })

  // Customers
  const customer = table('customer', 'User', 'blue', [
    pk(),
    col('fullName', 'VARCHAR(120)', required),
    col('phone', 'VARCHAR(30)'),
    col('email', 'VARCHAR(255)', { notNull: true, unique: true }),
    col('passwordHash', 'VARCHAR(255)', required),
    createdAt(),
  ])
  const address = table('address', 'MapPin', 'blue', [
    pk(),
    fk('customerId', customer, required, 'CASCADE'),
    col('recipientName', 'VARCHAR(120)', required),
    col('phone', 'VARCHAR(30)', required),
    col('addressLine', 'VARCHAR(255)', required),
    col('city', 'VARCHAR(80)', required),
    col('province', 'VARCHAR(80)'),
    col('postalCode', 'VARCHAR(20)'),
    col('isDefault', 'BOOLEAN', { notNull: true, default: 'false' }),
  ])

  // Catalogue
  const category = table('category', 'Tag', 'green', [pk()])
  category.columns.push(
    fk('parentId', category, {}, 'SET NULL'),
    col('name', 'VARCHAR(100)', required),
    col('slug', 'VARCHAR(120)', { notNull: true, unique: true }),
    col('isActive', 'BOOLEAN', { notNull: true, default: 'true' }),
  )
  const product = table('product', 'Package', 'green', [
    pk(),
    fk('categoryId', category, required),
    col('name', 'VARCHAR(200)', required),
    col('slug', 'VARCHAR(220)', { notNull: true, unique: true }),
    col('description', 'TEXT'),
    col('basePrice', 'DECIMAL(10,2)', required),
    col('salePrice', 'DECIMAL(10,2)'),
    col('isActive', 'BOOLEAN', { notNull: true, default: 'true' }),
    createdAt(),
  ])
  const variant = table('product_variant', 'Layers', 'green', [
    pk(),
    fk('productId', product, required, 'CASCADE'),
    col('sku', 'VARCHAR(60)', { notNull: true, unique: true }),
    col('size', 'VARCHAR(20)'),
    col('color', 'VARCHAR(40)'),
    col('price', 'DECIMAL(10,2)', required),
    col('stockQty', 'INT', { notNull: true, default: '0' }),
    col('isActive', 'BOOLEAN', { notNull: true, default: 'true' }),
  ])
  const image = table('product_image', 'Image', 'green', [
    pk(),
    fk('productId', product, required, 'CASCADE'),
    col('color', 'VARCHAR(40)'),
    col('imageUrl', 'VARCHAR(500)', required),
    col('sortOrder', 'INT', { notNull: true, default: '0' }),
  ])

  // Orders and payments
  const order = table('order', 'ShoppingCart', 'orange', [
    pk(),
    col('orderNumber', 'VARCHAR(30)', { notNull: true, unique: true }),
    fk('customerId', customer, {}, 'SET NULL'),
    col('customerName', 'VARCHAR(120)', required),
    col('customerPhone', 'VARCHAR(30)', required),
    col('shippingAddress', 'VARCHAR(255)', required),
    col('shippingCity', 'VARCHAR(80)', required),
    col('status', 'VARCHAR(30)', { notNull: true, default: "'pending'" }),
    col('subtotal', 'DECIMAL(10,2)', required),
    col('shippingFee', 'DECIMAL(10,2)', { notNull: true, default: '0' }),
    col('total', 'DECIMAL(10,2)', required),
    col('notes', 'TEXT'),
    col('courier', 'VARCHAR(60)'),
    col('trackingNumber', 'VARCHAR(80)'),
    createdAt(),
  ])
  const orderItem = table('order_item', 'ListChecks', 'orange', [
    pk(),
    fk('orderId', order, required, 'CASCADE'),
    fk('variantId', variant, {}, 'SET NULL'),
    col('productName', 'VARCHAR(200)', required),
    col('size', 'VARCHAR(20)'),
    col('color', 'VARCHAR(40)'),
    col('unitPrice', 'DECIMAL(10,2)', required),
    col('quantity', 'INT', { notNull: true, default: '1' }),
  ])
  const payment = table('payment', 'CreditCard', 'purple', [
    pk(),
    fk('orderId', order, required, 'CASCADE'),
    col('method', 'VARCHAR(30)', required),
    col('amount', 'DECIMAL(10,2)', required),
    col('status', 'VARCHAR(30)', { notNull: true, default: "'pending'" }),
    col('referenceNo', 'VARCHAR(80)'),
    col('paidAt', 'TIMESTAMP'),
  ])

  const admin = table('admin', 'Shield', 'red', [
    pk(),
    col('name', 'VARCHAR(100)', required),
    col('email', 'VARCHAR(255)', { notNull: true, unique: true }),
    col('passwordHash', 'VARCHAR(255)', required),
  ])

  return {
    // Four columns, left to right: customers, orders, catalogue, product images. Every relation runs between
    // neighbouring columns (or straight up / down inside one), so no line crosses a table or another line.
    // Tables are ~680px wide, so a 900px step leaves a 220px lane for the lines.
    nodes: [
      makeNode(address, { x: 0, y: 0 }),
      makeNode(customer, { x: 0, y: 520 }),
      makeNode(admin, { x: 0, y: 900 }),
      makeNode(payment, { x: 900, y: 0 }),
      makeNode(order, { x: 900, y: 440 }),
      makeNode(orderItem, { x: 900, y: 1230 }),
      makeNode(category, { x: 1800, y: 0 }),
      makeNode(product, { x: 1800, y: 350 }),
      makeNode(variant, { x: 1800, y: 870 }),
      makeNode(image, { x: 2700, y: 350 }),
    ],
    manyToMany: [],
  }
}

/** Apply `fn` to one table's data, leaving every other node untouched. */
function mapTable(nodes: TableNodeType[], tableId: string, fn: (t: Table) => Table): TableNodeType[] {
  return nodes.map((n) => (n.id === tableId ? { ...n, data: fn(n.data) } : n))
}

/** Drop foreign keys that point at tables or columns that no longer exist. */
function pruneManyToMany(nodes: TableNodeType[], links: ManyToMany[]): ManyToMany[] {
  const ids = new Set(nodes.map((n) => n.id))
  return links.filter((l) => ids.has(l.aTableId) && ids.has(l.bTableId))
}

/** SERIAL-style types are generated, so a foreign key to one is a plain integer. */
function fkTypeFor(type: string): string {
  if (/^bigserial$/i.test(type.trim())) return 'BIGINT'
  if (/^smallserial$/i.test(type.trim())) return 'SMALLINT'
  if (/^serial$/i.test(type.trim())) return 'INT'
  return type
}

function pkOf(table: Table): Column | undefined {
  const pks = table.columns.filter((c) => c.primaryKey)
  return pks.length === 1 ? pks[0] : undefined
}

/** Drop every foreign key that is impossible (see isInvalid) and report which ones were dropped. */
function purgeInvalid(
  nodes: TableNodeType[],
  provider: Provider,
): { nodes: TableNodeType[]; removed: RelationIssue[] } {
  const removed = checkRelations(toDiagram(provider, nodes)).filter(isInvalid)
  if (!removed.length) return { nodes, removed }
  const dead = new Set(removed.map((i) => i.columnId))
  return {
    removed,
    nodes: nodes.map((n) =>
      n.data.columns.some((c) => dead.has(c.id))
        ? {
            ...n,
            data: {
              ...n.data,
              columns: n.data.columns.map((c) => (dead.has(c.id) ? { ...c, references: undefined } : c)),
            },
          }
        : n,
    ),
  }
}

function announceRemoved(notify: State['notify'], removed: RelationIssue[]) {
  for (const i of removed) notify(removedProblem(i), [i.columnId, i.targetColumnId], 'warning')
}

function pruneReferences(nodes: TableNodeType[]): TableNodeType[] {
  const cols = new Map(nodes.map((n) => [n.id, new Set(n.data.columns.map((c) => c.id))]))
  return nodes.map((n) => {
    if (
      !n.data.columns.some((c) => c.references && !cols.get(c.references.tableId)?.has(c.references.columnId))
    ) {
      return n
    }
    return {
      ...n,
      data: {
        ...n.data,
        columns: n.data.columns.map((c) =>
          c.references && !cols.get(c.references.tableId)?.has(c.references.columnId)
            ? { ...c, references: undefined }
            : c,
        ),
      },
    }
  })
}

/**
 * Copies of tables, with new ids, a unique name (`users_copy`, `users_copy2`...) and a nudged position (or placed
 * at `at`). Relations between the copied tables follow the copies; relations to other tables still point at the
 * originals. A cut table (`keepNames`) keeps its name, since it only moved.
 */
function cloneTables(
  items: { table: Table; position: { x: number; y: number } }[],
  existing: TableNodeType[],
  opts: { count: number; at?: { x: number; y: number }; keepNames?: boolean },
): TableNodeType[] {
  const minX = Math.min(...items.map((c) => c.position.x))
  const minY = Math.min(...items.map((c) => c.position.y))
  const tableIds = new Map(items.map((c) => [c.table.id, uid()]))
  const columnIds = new Map(items.flatMap((c) => c.table.columns.map((col) => [col.id, uid()])))
  const taken = new Set(existing.map((n) => n.data.name))

  return items.map(({ table, position }) => {
    let name = opts.keepNames && !taken.has(table.name) ? table.name : `${table.name}_copy`
    for (let i = 2; taken.has(name); i++) name = `${table.name}_copy${i}`
    taken.add(name)
    const copy: Table = {
      ...structuredClone(table),
      id: tableIds.get(table.id)!,
      name,
      columns: table.columns.map((col) => {
        const ref = col.references
        const internal = ref && tableIds.has(ref.tableId)
        return {
          ...structuredClone(col),
          id: columnIds.get(col.id)!,
          references: internal
            ? { ...ref, tableId: tableIds.get(ref.tableId)!, columnId: columnIds.get(ref.columnId)! }
            : ref && structuredClone(ref),
        }
      }),
    }
    const pos = opts.at
      ? { x: opts.at.x + position.x - minX, y: opts.at.y + position.y - minY }
      : { x: position.x + 40 * opts.count, y: position.y + 40 * opts.count }
    return { ...makeNode(copy, pos), selected: true }
  })
}

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      provider: 'postgresql',
      ...sampleWorkspace(),
      pendingM2m: null,
      selectedColumn: null,
      hoveredTableId: null,
      clipboard: null,
      pasteCount: 0,
      clipboardIsCut: false,
      flashing: [],
      codeOpen: true,
      aiOpen: false,
      listOpen: true,
      collapsed: false,
      tablePlan: { max: FREE_FALLBACK.maxTablesPerDiagram, name: FREE_FALLBACK.name, free: true },
      codeFormat: 'prisma',
      sidebarWidth: 420,
      selectedEdgeId: null,
      edgePanelOpen: false,

      setProvider: (provider) => {
        // Other databases have other rules (e.g. MySQL integer sizes): drop relations that stop being valid.
        const { nodes: cleaned, removed } = purgeInvalid(get().nodes, provider)
        set({ provider, nodes: cleaned, ...(removed.length ? { selectedEdgeId: null } : {}) })
        announceRemoved(get().notify, removed)
      },

      notify: (problem, columnIds = [], kind = 'error') => {
        // The toast id comes from the content, so repeating a mistake updates the toast instead of stacking copies.
        showProblem(problem, kind)
        if (!columnIds.length) return
        set({ flashing: columnIds })
        // Only clear if nothing newer started blinking in the meantime.
        setTimeout(() => {
          if (get().flashing === columnIds) set({ flashing: [] })
        }, 3000)
      },

      onNodesChange: (changes) =>
        set((s) => {
          const nodes = applyNodeChanges(changes, s.nodes)
          if (!changes.some((c) => c.type === 'remove')) return { nodes }
          return { nodes: pruneReferences(nodes), manyToMany: pruneManyToMany(nodes, s.manyToMany) }
        }),

      addTable: (position) => {
        if (!hasRoom(1)) return
        set((s) => {
          const names = new Set(s.nodes.map((n) => n.data.name))
          let i = s.nodes.length + 1
          while (names.has(`table_${i}`)) i++
          const table: Table = {
            id: uid(),
            name: `table_${i}`,
            columns: [{ ...newColumn('id', 'SERIAL'), primaryKey: true, notNull: true }],
          }
          const fallback = { x: 60 + (s.nodes.length % 4) * 40, y: 60 + s.nodes.length * 40 }
          return { nodes: [...s.nodes, makeNode(table, position ?? fallback)] }
        })
      },

      setTableIcon: (tableId, icon) =>
        set((s) => ({ nodes: mapTable(s.nodes, tableId, (t) => ({ ...t, icon })) })),
      setTableColor: (tableId, color) =>
        set((s) => ({ nodes: mapTable(s.nodes, tableId, (t) => ({ ...t, color })) })),
      renameTable: (tableId, name) =>
        set((s) => ({ nodes: mapTable(s.nodes, tableId, (t) => ({ ...t, name })) })),

      deleteTable: (tableId) =>
        set((s) => {
          const nodes = s.nodes.filter((n) => n.id !== tableId)
          return { nodes: pruneReferences(nodes), manyToMany: pruneManyToMany(nodes, s.manyToMany) }
        }),

      addColumn: (tableId) =>
        set((s) => ({
          nodes: mapTable(s.nodes, tableId, (t) => ({
            ...t,
            columns: [...t.columns, newColumn(`column_${t.columns.length + 1}`)],
          })),
        })),

      updateColumn: (tableId, columnId, patch) => {
        const { provider, nodes } = get()
        const edited = mapTable(nodes, tableId, (t) => ({
          ...t,
          columns: t.columns.map((c) => (c.id === columnId ? { ...c, ...patch } : c)),
        }))
        // An edit (type, PK, UNIQUE...) that makes a relation impossible removes it, and says why.
        const { nodes: cleaned, removed } = purgeInvalid(edited, provider)
        set({ nodes: cleaned, ...(removed.length ? { selectedEdgeId: null } : {}) })
        announceRemoved(get().notify, removed)
      },

      purgeInvalid: () => {
        const { nodes, provider } = get()
        const { nodes: cleaned, removed } = purgeInvalid(nodes, provider)
        if (!removed.length) return
        set({ nodes: cleaned, selectedEdgeId: null })
        announceRemoved(get().notify, removed)
      },

      deleteColumn: (tableId, columnId) =>
        set((s) => ({
          nodes: pruneReferences(
            mapTable(s.nodes, tableId, (t) => ({
              ...t,
              columns: t.columns.filter((c) => c.id !== columnId),
            })),
          ),
        })),

      // Dragging from a foreign-key column (source) to the referenced column (target).
      connect: (c) => {
        if (!c.sourceHandle || !c.targetHandle) return
        if (c.sourceHandle.startsWith(M2M_HANDLE) || c.targetHandle.startsWith(M2M_HANDLE)) return
        const sourceCol = columnOf(c.sourceHandle)
        const targetCol = columnOf(c.targetHandle)
        if (c.source === c.target && sourceCol === targetCol) return

        const { nodes, provider } = get()
        const source = nodes.find((n) => n.id === c.source)?.data
        const target = nodes.find((n) => n.id === c.target)?.data
        const from = source?.columns.find((x) => x.id === sourceCol)
        const to = target?.columns.find((x) => x.id === targetCol)
        if (!source || !target || !from || !to) return

        // Refuse a relation that can't work, rather than creating one that fails later.
        const reference: Reference = { tableId: c.target, columnId: targetCol }
        const candidate = mapTable(nodes, c.source, (t) => ({
          ...t,
          columns: t.columns.map((col) => (col.id === sourceCol ? { ...col, references: reference } : col)),
        }))
        const refused = checkRelations(toDiagram(provider, candidate)).find(
          (i) => isInvalid(i) && i.columnId === sourceCol && i.targetColumnId === targetCol,
        )
        if (refused) {
          get().notify(refusedProblem(refused), [from.id, to.id])
          return
        }

        set((s) => ({
          nodes: mapTable(s.nodes, c.source, (t) => ({
            ...t,
            columns: t.columns.map((col) => (col.id === sourceCol ? { ...col, references: reference } : col)),
          })),
          selectedEdgeId: `${c.source}:${sourceCol}`,
          edgePanelOpen: true, // just drawn: its settings are the next thing wanted
        }))
      },

      updateReference: (tableId, columnId, patch) =>
        set((s) => ({
          nodes: mapTable(s.nodes, tableId, (t) => ({
            ...t,
            columns: t.columns.map((c) =>
              c.id === columnId && c.references ? { ...c, references: { ...c.references, ...patch } } : c,
            ),
          })),
        })),

      setRelationBend: (edgeId, bend) => {
        // A bend that is back at the default route is stored as "no bend".
        const moved = (n: number | undefined) => Math.abs(n ?? 0) >= 1
        const value = bend && (moved(bend.x) || moved(bend.ys) || moved(bend.yt) || moved(bend.cy)) ? bend : undefined
        if (edgeId.startsWith(M2M_PREFIX)) {
          const id = edgeId.slice(M2M_PREFIX.length)
          set((s) => ({ manyToMany: s.manyToMany.map((l) => (l.id === id ? { ...l, bend: value } : l)) }))
          return
        }
        const [tableId, columnId] = edgeId.split(':')
        set((s) => ({
          nodes: mapTable(s.nodes, tableId, (t) => ({
            ...t,
            columns: t.columns.map((c) =>
              c.id === columnId && c.references ? { ...c, references: { ...c.references, bend: value } } : c,
            ),
          })),
        }))
      },

      removeReference: (tableId, columnId) =>
        set((s) => ({
          selectedEdgeId: null,
          nodes: mapTable(s.nodes, tableId, (t) => ({
            ...t,
            columns: t.columns.map((c) => (c.id === columnId ? { ...c, references: undefined } : c)),
          })),
        })),

      addSelfReference: (tableId) =>
        set((s) => {
          const table = s.nodes.find((n) => n.id === tableId)?.data
          const pk = table && pkOf(table)
          if (!table || !pk) return s
          const taken = new Set(table.columns.map((c) => c.name))
          let name = 'parent_id'
          for (let i = 2; taken.has(name); i++) name = `parent_id_${i}`
          const col: Column = {
            ...newColumn(name, fkTypeFor(pk.type)),
            references: { tableId, columnId: pk.id, onDelete: 'SET NULL' },
          }
          return {
            nodes: mapTable(s.nodes, tableId, (t) => ({ ...t, columns: [...t.columns, col] })),
            selectedEdgeId: `${tableId}:${col.id}`,
            edgePanelOpen: true,
          }
        }),

      flipRelation: (tableId, columnId) => {
        const { nodes } = get()
        const child = nodes.find((n) => n.id === tableId)?.data
        const col = child?.columns.find((c) => c.id === columnId)
        const ref = col?.references
        const parent = nodes.find((n) => n.id === ref?.tableId)?.data
        if (!child || !col || !ref || !parent || child.id === parent.id) return

        const label = `${child.name}.${col.name} → ${parent.name}`
        const childPk = pkOf(child)
        const refuse = (reason: string, fix: string) =>
          get().notify({ title: "Can't flip this relation", where: label, reason, fix }, [col.id, ref.columnId])
        if (col.primaryKey) {
          return refuse(`${col.name} is part of the primary key of ${child.name}.`, 'Only a regular foreign key column can be flipped.')
        }
        if (!childPk) {
          return refuse(
            `${child.name} has no single primary key column for the other table to point to.`,
            `Give ${child.name} one primary key column first.`,
          )
        }

        // The new foreign key lives on the old parent, named after the old child (users -> user_id).
        const taken = new Set(parent.columns.map((c) => c.name))
        const base = `${child.name.replace(/s$/, '')}_id`
        let name = base
        for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
        const moved: Column = {
          ...newColumn(name, fkTypeFor(childPk.type)),
          notNull: col.notNull,
          unique: col.unique,
          references: {
            tableId: child.id,
            columnId: childPk.id,
            onDelete: ref.onDelete,
            onUpdate: ref.onUpdate,
          },
        }

        set((s) => ({
          nodes: pruneReferences(
            mapTable(
              mapTable(s.nodes, child.id, (t) => ({
                ...t,
                columns: t.columns.filter((c) => c.id !== col.id),
              })),
              parent.id,
              (t) => ({ ...t, columns: [...t.columns, moved] }),
            ),
          ),
          selectedEdgeId: `${parent.id}:${moved.id}`,
        }))
        showNote(
          {
            title: 'Relation flipped',
            where: `${parent.name}.${name} → ${child.name}.${childPk.name}`,
            reason: `${child.name}.${col.name} was removed, and ${parent.name}.${name} now holds the foreign key.`,
          },
          `flip-${col.id}`,
        )
      },

      pickManyToMany: (tableId) =>
        set((s) => {
          if (!s.pendingM2m) return { pendingM2m: tableId }
          if (s.manyToMany.some((l) => l.aTableId === s.pendingM2m && l.bTableId === tableId)) {
            return { pendingM2m: null }
          }
          const link: ManyToMany = { id: uid(), aTableId: s.pendingM2m, bTableId: tableId }
          return {
            manyToMany: [...s.manyToMany, link],
            pendingM2m: null,
            selectedEdgeId: M2M_PREFIX + link.id,
            edgePanelOpen: true,
          }
        }),

      removeManyToMany: (id) =>
        set((s) => ({ selectedEdgeId: null, manyToMany: s.manyToMany.filter((l) => l.id !== id) })),

      convertToJunction: (id) => {
        if (!hasRoom(1)) return
        set((s) => {
          const link = s.manyToMany.find((l) => l.id === id)
          const a = s.nodes.find((n) => n.id === link?.aTableId)
          const b = s.nodes.find((n) => n.id === link?.bTableId)
          const pkA = a && pkOf(a.data)
          const pkB = b && pkOf(b.data)
          if (!link || !a || !b || !pkA || !pkB) return s

          const names = new Set(s.nodes.map((n) => n.data.name))
          const base = `${a.data.name}_${b.data.name}`
          let name = base
          for (let i = 2; names.has(name); i++) name = `${base}_${i}`

          const fk = (t: Table, pk: Column, taken: Set<string>): Column => {
            const single = t.name.replace(/s$/, '')
            let colName = `${single}_id`
            for (let i = 2; taken.has(colName); i++) colName = `${single}_id_${i}`
            taken.add(colName)
            return {
              ...newColumn(colName, fkTypeFor(pk.type)),
              primaryKey: true,
              notNull: true,
              references: { tableId: t.id, columnId: pk.id, onDelete: 'CASCADE' },
            }
          }
          const taken = new Set<string>()
          const table: Table = {
            id: uid(),
            name,
            columns: [fk(a.data, pkA, taken), fk(b.data, pkB, taken)],
          }
          const x = (a.position.x + b.position.x) / 2
          const y = Math.max(a.position.y, b.position.y) + 320
          return {
            nodes: [
              ...s.nodes,
              makeNode(table, { x: a === b ? a.position.x + 560 : x, y: a === b ? a.position.y : y }),
            ],
            manyToMany: s.manyToMany.filter((l) => l.id !== id),
            selectedEdgeId: null,
          }
        })
      },

      setSidebarWidth: (w) =>
        set({ sidebarWidth: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w))) }),
      setCodeFormat: (codeFormat) => set({ codeFormat }),
      closeSidebar: () => set({ codeOpen: false, selectedEdgeId: null }),
      toggleCode: () => set((s) => ({ codeOpen: !s.codeOpen, aiOpen: s.codeOpen ? s.aiOpen : false })),
      toggleAi: () =>
        set((s) => ({ aiOpen: !s.aiOpen, codeOpen: s.aiOpen ? s.codeOpen : false, selectedEdgeId: s.aiOpen ? s.selectedEdgeId : null })),
      applyAiCanvas: (c) =>
        set({ provider: c.provider, nodes: c.nodes, manyToMany: c.manyToMany, selectedEdgeId: null, selectedColumn: null, pendingM2m: null }),
      toggleList: () => set((s) => ({ listOpen: !s.listOpen })),
      toggleCollapsed: () => set((s) => ({ collapsed: !s.collapsed })),
      setHoveredTable: (hoveredTableId) => set({ hoveredTableId }),
      selectAllTables: () =>
        set((s) => ({
          nodes: s.nodes.map((n) => (n.selected ? n : { ...n, selected: true })),
          selectedEdgeId: null,
          selectedColumn: null,
        })),
      copyTables: (ids) => {
        const picked = get().nodes.filter((n) => ids.includes(n.id))
        if (!picked.length) return
        set({
          clipboard: picked.map((n) => ({ table: structuredClone(n.data), position: { ...n.position } })),
          pasteCount: 0,
          clipboardIsCut: false,
        })
      },

      cutTables: (ids) => {
        get().copyTables(ids)
        if (!get().clipboard) return
        set((s) => {
          const nodes = s.nodes.filter((n) => !ids.includes(n.id))
          // Cut tables come back where they were, so the first paste isn't nudged.
          return {
            nodes: pruneReferences(nodes),
            manyToMany: pruneManyToMany(nodes, s.manyToMany),
            selectedEdgeId: null,
            pasteCount: -1,
            clipboardIsCut: true,
          }
        })
      },

      pasteTables: (at) => {
        const { clipboard, pasteCount, clipboardIsCut } = get()
        if (!clipboard?.length || !hasRoom(clipboard.length)) return
        const count = pasteCount + 1
        set((s) => ({
          nodes: pruneReferences([
            ...s.nodes.map((n) => ({ ...n, selected: false })),
            ...cloneTables(clipboard, s.nodes, { count, at, keepNames: clipboardIsCut }),
          ]),
          pasteCount: count,
          selectedEdgeId: null,
        }))
      },

      duplicateTables: (ids) => {
        const wanted = get().nodes.filter((n) => ids.includes(n.id)).length
        if (wanted && !hasRoom(wanted)) return
        set((s) => {
          const picked = s.nodes
            .filter((n) => ids.includes(n.id))
            .map((n) => ({ table: n.data, position: n.position }))
          if (!picked.length) return s
          return {
            nodes: pruneReferences([
              ...s.nodes.map((n) => ({ ...n, selected: false })),
              ...cloneTables(picked, s.nodes, { count: 1 }),
            ]),
            selectedEdgeId: null,
          }
        })
      },

      setSelectedColumn: (selectedColumn) => set({ selectedColumn }),
      selectEdge: (selectedEdgeId) =>
        set((s) => ({
          selectedEdgeId,
          edgePanelOpen: selectedEdgeId === null ? false : s.edgePanelOpen,
          pendingM2m: null,
          selectedColumn: null,
        })),
      openEdgePanel: (selectedEdgeId) =>
        set({ selectedEdgeId, edgePanelOpen: true, pendingM2m: null, selectedColumn: null }),
      loadWorkspace: (w) =>
        set({
          provider: w.provider,
          nodes: w.nodes.map((n) => makeNode(n.data, n.position)),
          manyToMany: w.manyToMany,
          selectedEdgeId: null,
          selectedColumn: null,
          hoveredTableId: null,
          pendingM2m: null,
        }),
      loadSample: () => set({ ...sampleWorkspace(), selectedEdgeId: null }),
      clear: () => set({ nodes: [], manyToMany: [], selectedEdgeId: null }),
    }),
    {
      name: 'erd-designer',
      version: 2,
      migrate: (persisted) => ({ manyToMany: [], ...(persisted as object) }) as unknown as State,
      partialize: (s) => ({
        provider: s.provider,
        nodes: s.nodes,
        manyToMany: s.manyToMany,
        codeOpen: s.codeOpen,
        listOpen: s.listOpen,
        collapsed: s.collapsed,
        codeFormat: s.codeFormat,
        sidebarWidth: s.sidebarWidth,
      }),
    },
  ),
)

/** True when `adding` more tables fit in the plan's limit; otherwise says so (with an upgrade button on the Free plan). */
function hasRoom(adding: number): boolean {
  const { nodes, tablePlan } = useStore.getState()
  if (nodes.length + adding <= tablePlan.max) return true
  showProblem(tableLimitProblem(tablePlan.max, tablePlan), 'warning')
  return false
}

// The side panel shows ONE thing at a time: the generated code or the picked relation's settings. Whichever the
// user opens last wins. Done as a subscription (not in each action) because the relation panel is opened from several
// places: a double-click on a line, drawing a new relation, adding a foreign key from the table, picking a many-to-many.
const relationPanelShown = (s: Pick<State, 'selectedEdgeId' | 'edgePanelOpen'>) => s.selectedEdgeId !== null && s.edgePanelOpen
useStore.subscribe((state, prev) => {
  if (state.selectedEdgeId === null && state.edgePanelOpen) {
    useStore.setState({ edgePanelOpen: false }) // nothing is picked any more: the next pick must not pop the panel open
  } else if (relationPanelShown(state) && !relationPanelShown(prev) && state.codeOpen) {
    useStore.setState({ codeOpen: false }) // a relation's settings were opened: hide the code
  } else if (state.codeOpen && !prev.codeOpen && relationPanelShown(state)) {
    useStore.setState({ selectedEdgeId: null, edgePanelOpen: false }) // the code was opened: close the relation's panel
  }
})

export function toDiagram(
  provider: Provider,
  nodes: TableNodeType[],
  manyToMany: ManyToMany[] = [],
): Diagram {
  return { provider, tables: nodes.map((n) => n.data), manyToMany }
}

export function deriveEdges(
  nodes: TableNodeType[],
  manyToMany: ManyToMany[],
  selectedEdgeId: string | null,
  hoveredTableId: string | null = null,
): Edge[] {
  const edges: Edge[] = []
  /** `hot` edges glow: the ones touching the hovered table. They are also drawn above the others. */
  const hotness = (source: string, target: string) => {
    const hot = hoveredTableId !== null && (source === hoveredTableId || target === hoveredTableId)
    return { hot, zIndex: hot ? 10 : undefined }
  }
  for (const l of manyToMany) {
    const id = M2M_PREFIX + l.id
    const a = nodes.find((n) => n.id === l.aTableId)
    const b = nodes.find((n) => n.id === l.bTableId)
    if (!a || !b) continue
    const [sa, sb] = sidesFor(a, b)
    edges.push({
      id,
      type: 'relation',
      source: l.aTableId,
      sourceHandle: handleId(M2M_HANDLE, sa),
      target: l.bTableId,
      targetHandle: handleId(M2M_HANDLE, sb),
      selected: id === selectedEdgeId,
      zIndex: hotness(l.aTableId, l.bTableId).zIndex,
      data: { kind: 'many-to-many', bend: l.bend, hot: hotness(l.aTableId, l.bTableId).hot },
    })
  }
  for (const n of nodes) {
    for (const c of n.data.columns) {
      if (!c.references) continue
      const target = nodes.find((t) => t.id === c.references!.tableId)
      if (!target) continue
      const [ss, ts] = sidesFor(n, target)
      const id = `${n.id}:${c.id}`
      edges.push({
        id,
        type: 'relation',
        zIndex: hotness(n.id, c.references.tableId).zIndex,
        data: {
          kind: isOneToOne(n.data, c) ? 'one-to-one' : 'one-to-many',
          bend: c.references.bend,
          hot: hotness(n.id, c.references.tableId).hot,
        },
        source: n.id,
        sourceHandle: handleId(c.id, ss),
        target: c.references.tableId,
        targetHandle: handleId(c.references.columnId, ts),
        selected: id === selectedEdgeId,
      })
    }
  }
  return edges
}

/** The part of the state that is saved to the account (no selection / measurement noise). */
export function toWorkspace(s: Pick<State, 'provider' | 'nodes' | 'manyToMany'>): Workspace {
  return {
    provider: s.provider,
    nodes: s.nodes.map((n) => ({ id: n.id, position: { x: n.position.x, y: n.position.y }, data: n.data })),
    manyToMany: s.manyToMany,
  }
}
