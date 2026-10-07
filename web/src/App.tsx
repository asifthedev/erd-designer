/**
 * App shell: top toolbar, the React Flow canvas, and the side panel (generated code / relation settings).
 * Which of these is visible depends on the auth state (see `App` at the bottom).
 */
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeChange,
} from '@xyflow/react'
import { PanelLeftOpen, Table2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { DbIcon } from './components/DbIcon'
import { Select } from './components/Select'
import { useAuth } from '@/auth/store'
import { useAutosave } from '@/auth/useAutosave'
import { AuthScreen } from '@/components/AuthScreen'
import { ClearAllToasts } from '@/components/ClearAllToasts'
import { DiagramSidebar } from '@/components/DiagramSidebar'
import { LoadingVeil } from '@/components/LoadingVeil'
import { SettingsMenu } from '@/components/SettingsMenu'
import { UserMenu } from '@/components/UserMenu'
import { Toaster } from '@/components/ui/sonner'
import { ZoomBar } from './components/ZoomBar'
import { ContextMenu, DELETE_HINT, type MenuTarget } from './components/ContextMenu'
import { IssuesProvider } from './components/issues'
import { PrismaPanel } from './components/PrismaPanel'
import { ConnectionLine, RelationEdge } from './components/RelationEdge'
import { RelationCard } from './components/RelationCard'
import { TableNode } from './components/TableNode'
import { PROVIDERS } from './core/model'
import { deriveEdges, M2M_PREFIX, SIDEBAR_MAX, SIDEBAR_MIN, useStore } from './store'

// Registered once at module level: React Flow re-mounts every node if these objects change identity.
const nodeTypes = { table: TableNode }
const edgeTypes = { relation: RelationEdge }

/** The diagram canvas: tables as nodes, foreign keys as edges, plus keyboard shortcuts and context menus. */
function Canvas() {
  const nodes = useStore((s) => s.nodes)
  const manyToMany = useStore((s) => s.manyToMany)
  const removeManyToMany = useStore((s) => s.removeManyToMany)
  const selectedEdgeId = useStore((s) => s.selectedEdgeId)
  const hoveredTableId = useStore((s) => s.hoveredTableId)
  const onNodesChange = useStore((s) => s.onNodesChange)
  const connect = useStore((s) => s.connect)
  const selectEdge = useStore((s) => s.selectEdge)
  const removeReference = useStore((s) => s.removeReference)
  const deleteTable = useStore((s) => s.deleteTable)
  const deleteColumn = useStore((s) => s.deleteColumn)
  const selectedColumn = useStore((s) => s.selectedColumn)
  const setSelectedColumn = useStore((s) => s.setSelectedColumn)
  const copyTables = useStore((s) => s.copyTables)
  const cutTables = useStore((s) => s.cutTables)
  const duplicateTables = useStore((s) => s.duplicateTables)
  const pasteTables = useStore((s) => s.pasteTables)
  const hasClipboard = useStore((s) => s.clipboard !== null)
  const { screenToFlowPosition, fitView } = useReactFlow()
  const authed = useAuth((s) => s.status === 'authed')
  const currentId = useAuth((s) => s.currentId)
  const listOpen = useStore((s) => s.listOpen)
  const toggleList = useStore((s) => s.toggleList)
  const [showGrid, setShowGrid] = useState(true)

  // Another ERD was opened: show it from its top left at 100% instead of wherever the last one was panned to.
  useEffect(() => {
    if (!currentId) return
    const frame = requestAnimationFrame(() => void fitView({ minZoom: 1, maxZoom: 1, duration: 0 }))
    return () => cancelAnimationFrame(frame)
  }, [currentId, fitView])
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  // Edges are never stored: they are recomputed from the foreign keys on the columns (and many-to-many links).
  const edges = useMemo(
    () => deriveEdges(nodes, manyToMany, selectedEdgeId, hoveredTableId),
    [nodes, manyToMany, selectedEdgeId, hoveredTableId],
  )

  // A relation id is either `m2m:<linkId>` (many-to-many) or `<tableId>:<columnId>` (a foreign key column).
  const deleteEdge = useCallback(
    (id: string) => {
      if (id.startsWith(M2M_PREFIX)) removeManyToMany(id.slice(M2M_PREFIX.length))
      else {
        const [tableId, columnId] = id.split(':')
        removeReference(tableId, columnId)
      }
    },
    [removeReference, removeManyToMany],
  )

  // Edges are derived from foreign keys, so the only change we act on is removal.
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const c of changes) if (c.type === 'remove') deleteEdge(c.id)
    },
    [deleteEdge],
  )

  // Delete key removes the selected column row (typing in a field keeps its normal Delete behaviour).
  useEffect(() => {
    if (!selectedColumn) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if ((e.target as HTMLElement).closest('input, select, textarea, [contenteditable]')) return
      e.preventDefault()
      deleteColumn(selectedColumn.tableId, selectedColumn.columnId)
      setSelectedColumn(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedColumn, deleteColumn, setSelectedColumn])

  // Ctrl/Cmd + C / X / V on the selected tables (fields keep their own copy/paste).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if ((e.target as HTMLElement).closest('input, select, textarea, [contenteditable]')) return
      if (useStore.getState().selectedColumn) return
      const key = e.key.toLowerCase()
      const ids = useStore
        .getState()
        .nodes.filter((n) => n.selected)
        .map((n) => n.id)
      if (key === 'c' && ids.length) copyTables(ids)
      else if (key === 'x' && ids.length) cutTables(ids)
      else if (key === 'd' && ids.length) duplicateTables(ids)
      else if (key === 'v') pasteTables()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [copyTables, cutTables, duplicateTables, pasteTables])

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionLineComponent={ConnectionLine}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        onEdgeClick={(_, edge) => selectEdge(edge.id)}
        onEdgeDoubleClick={(_, edge) => deleteEdge(edge.id)}
        zoomOnDoubleClick={false}
        onPaneClick={() => selectEdge(null)}
        // While a column is selected the Delete key belongs to the column, not to its table.
        deleteKeyCode={selectedColumn ? null : ['Delete', 'Backspace']}
        onNodeClick={(e) => {
          if (!(e.target as HTMLElement).closest('[data-column-id]')) setSelectedColumn(null)
        }}
        // Right-click on a table: a column row gets "Delete column", anywhere else gets the table actions.
        onNodeContextMenu={(e, node) => {
          e.preventDefault()
          const at = { x: e.clientX, y: e.clientY }
          const row = (e.target as HTMLElement).closest<HTMLElement>('[data-column-id]')
          if (row?.dataset.columnId) {
            const columnId = row.dataset.columnId
            setSelectedColumn({ tableId: node.id, columnId })
            setMenu({
              ...at,
              items: [
                {
                  label: 'Delete column',
                  shortcut: DELETE_HINT,
                  danger: true,
                  onSelect: () => {
                    deleteColumn(node.id, columnId)
                    setSelectedColumn(null)
                  },
                },
              ],
            })
            return
          }
          setSelectedColumn(null)
          // Act on the whole selection when the clicked table is part of it, otherwise just on this table.
          const ids = node.selected ? nodes.filter((n) => n.selected).map((n) => n.id) : [node.id]
          if (!node.selected) {
            onNodesChange(
              nodes.map((n) => ({ id: n.id, type: 'select' as const, selected: n.id === node.id })),
            )
          }
          setMenu({
            ...at,
            items: [
              { label: 'Copy', shortcut: 'Ctrl C', onSelect: () => copyTables(ids) },
              { label: 'Cut', shortcut: 'Ctrl X', onSelect: () => cutTables(ids) },
              {
                label: ids.length > 1 ? `Duplicate ${ids.length} tables` : 'Duplicate',
                shortcut: 'Ctrl D',
                onSelect: () => duplicateTables(ids),
              },
              {
                label: ids.length > 1 ? `Delete ${ids.length} tables` : 'Delete',
                shortcut: DELETE_HINT,
                danger: true,
                separator: true,
                onSelect: () => ids.forEach((id) => deleteTable(id)),
              },
            ],
          })
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault()
          selectEdge(edge.id)
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              {
                label: 'Delete relation',
                shortcut: DELETE_HINT,
                danger: true,
                onSelect: () => deleteEdge(edge.id),
              },
            ],
          })
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault()
          if (!hasClipboard) return setMenu(null)
          const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [{ label: 'Paste', shortcut: 'Ctrl V', onSelect: () => pasteTables(at) }],
          })
        }}
        colorMode="dark"
        minZoom={0.2}
        // Open at exactly 100%: fitView centres the tables, and min = max = 1 pins the zoom level.
        fitView
        fitViewOptions={{ minZoom: 1, maxZoom: 1 }}
      >
        {showGrid && (
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--color-dot)" />
        )}
        {authed && !listOpen && (
          // Opens the list of ERDs. Lives on the canvas (not in the header); once open, the list has its own close button.
          <Panel position="top-left">
            <button
              type="button"
              onClick={toggleList}
              title="Show your ERDs"
              aria-label="Show the list of ERDs"
              className="grid size-9 cursor-pointer place-items-center rounded-md border border-line bg-surface text-ink shadow-lg shadow-black/30 hover:border-key hover:text-key"
            >
              <PanelLeftOpen size={18} />
            </button>
          </Panel>
        )}
        <ZoomBar showGrid={showGrid} onToggleGrid={() => setShowGrid((g) => !g)} />
        <MiniMap pannable zoomable nodeColor="var(--color-line)" />
      </ReactFlow>
      <ContextMenu menu={menu} onClose={closeMenu} />
    </>
  )
}

/** Top bar: add table / sample / clear, the database dialect picker, the code toggle and the account menu. */
function Toolbar() {
  const provider = useStore((s) => s.provider)
  const setProvider = useStore((s) => s.setProvider)
  const addTable = useStore((s) => s.addTable)
  const loadSample = useStore((s) => s.loadSample)
  const clear = useStore((s) => s.clear)
  const codeOpen = useStore((s) => s.codeOpen)
  const toggleCode = useStore((s) => s.toggleCode)
  const { screenToFlowPosition } = useReactFlow()

  const btn =
    'cursor-pointer rounded-sm border border-line px-2.5 py-1 text-muted hover:border-key hover:text-key'

  return (
    <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2">
      <h1 className="mr-4 font-semibold">
        <span className="text-key">erd</span>
        <span className="text-muted">.designer</span>
      </h1>
      <button
        type="button"
        className={`${btn} flex items-center gap-1.5`}
        title="Add a new table to the canvas"
        onClick={() =>
          // Drop the new table inside what the user is looking at, without changing the zoom level.
          addTable(
            screenToFlowPosition({
              x: window.innerWidth * 0.3,
              y: window.innerHeight * 0.3,
            }),
          )
        }
      >
        <Table2 className="size-4" aria-hidden />
        Add table
      </button>
      <button type="button" className={btn} onClick={loadSample}>
        Sample
      </button>
      <button
        type="button"
        className={`${btn} hover:border-danger! hover:text-danger!`}
        onClick={() => {
          // Destructive and not undoable, so ask first.
          if (window.confirm('Remove all tables?')) clear()
        }}
      >
        Clear
      </button>

      <div className="ml-auto flex items-center gap-2 text-muted">
        Database
        <Select
          aria-label="Database"
          value={provider}
          onValueChange={setProvider}
          options={PROVIDERS.map((p) => ({ value: p, label: p, icon: <DbIcon provider={p} /> }))}
          className="min-w-36"
        />
      </div>
      <button
        type="button"
        className={`${btn} ${codeOpen ? 'border-key/60! text-key!' : ''}`}
        aria-pressed={codeOpen}
        title={codeOpen ? 'Hide schema.prisma' : 'Show schema.prisma'}
        onClick={toggleCode}
      >
        {'{ }'} Code
      </button>
      <SettingsMenu />
      <UserMenu />
    </header>
  )
}

/** Thin draggable divider on the left edge of the side panel. */
function SidebarResizer() {
  const width = useStore((s) => s.sidebarWidth)
  const setWidth = useStore((s) => s.setSidebarWidth)

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (ev: globalThis.PointerEvent) => setWidth(startW + (startX - ev.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Keyboard resizing for accessibility: the panel is on the right, so ArrowLeft makes it wider.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setWidth(width + 24)
    if (e.key === 'ArrowRight') setWidth(width - 24)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setWidth(420)}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize outline-none hover:bg-key/40 focus-visible:bg-key/40"
    />
  )
}

/** The signed-in (or guest) workspace. Autosave is wired here so it only runs while the editor is mounted. */
function Editor() {
  const codeOpen = useStore((s) => s.codeOpen)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const hasRelation = useStore((s) => s.selectedEdgeId !== null)
  const closeSidebar = useStore((s) => s.closeSidebar)
  const listOpen = useStore((s) => s.listOpen)
  const authed = useAuth((s) => s.status === 'authed')
  const showList = listOpen && authed // guests have a single local workspace, so no list
  useAutosave()

  // The side panel (code view or relation settings) closes as soon as the canvas is clicked. Not for:
  // lines (clicking one is how its settings open), fields and buttons (editing a table keeps the live code
  // in view), the zoom bar, menus and the minimap.
  const closeOnCanvasClick = (e: PointerEvent) => {
    if (!codeOpen && !hasRelation) return
    const keep =
      'input, button, select, textarea, [role=combobox], [role=menu], [role=dialog], [data-radix-popper-content-wrapper], .react-flow__edge, .react-flow__minimap, .react-flow__panel, .react-flow__handle'
    if ((e.target as HTMLElement).closest(keep)) return
    closeSidebar()
  }
  return (
    <ReactFlowProvider>
      <IssuesProvider>
        <div className="flex h-full flex-col bg-canvas font-ui text-ink">
          <Toolbar />
          <div className="flex min-h-0 flex-1">
            {showList && <DiagramSidebar />}
            <main className="relative min-w-0 flex-1" onPointerDownCapture={closeOnCanvasClick}>
              <Canvas />
              <LoadingVeil />
            </main>
            {(codeOpen || hasRelation) && (
              <aside
                style={{ width: sidebarWidth }}
                className="relative flex max-w-[80vw] shrink-0 flex-col border-l border-line bg-surface"
              >
                <SidebarResizer />
                <RelationCard />
                {codeOpen && <PrismaPanel />}
              </aside>
            )}
          </div>
        </div>
      </IssuesProvider>
    </ReactFlowProvider>
  )
}

/** Decides what to show: a splash while the session is checked, the sign-in screen, or the editor. */
export default function App() {
  const status = useAuth((s) => s.status)
  useEffect(() => {
    void useAuth.getState().init()
  }, [])

  return (
    <>
      {/* Always mounted, so messages (e.g. "session expired") show on the sign-in screen too. */}
      <ClearAllToasts />
      <Toaster
        position="top-center"
        offset={104}
        visibleToasts={5}
        closeButton
        toastOptions={{ classNames: { toast: 'font-ui' } }}
      />
      {status === 'loading' && (
        <div className="grid h-full place-items-center bg-canvas font-mono text-muted">
          <span className="animate-pulse">erd.designer</span>
        </div>
      )}
      {status === 'anonymous' && <AuthScreen />}
      {(status === 'authed' || status === 'guest') && <Editor />}
    </>
  )
}
