import type { ReactFlowInstance } from '@xyflow/react'
import { renderDiagramImage } from '../export/exportDiagram'
import { useStore } from '../store'

const nextFrames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

/**
 * A picture of the whole canvas for the assistant to check its work against. Which tables are picked only matters
 * on screen, so that is taken out of the picture and put back afterwards. Resolves to null when it cannot be drawn
 * (nothing is lost: the assistant then relies on the layout report alone).
 */
export async function captureCanvas(flow: Pick<ReactFlowInstance, 'getNodes' | 'getNodesBounds'>): Promise<string | null> {
  const nodes = flow.getNodes()
  if (!nodes.length) return null
  const before = useStore.getState()
  const pickedTables = new Set(before.nodes.filter((n) => n.selected).map((n) => n.id))
  const pickedLine = before.selectedEdgeId
  useStore.setState({ nodes: before.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), selectedEdgeId: null })
  try {
    await nextFrames()
    return await renderDiagramImage(flow.getNodesBounds(flow.getNodes()))
  } catch {
    return null
  } finally {
    useStore.setState((s) => ({
      nodes: s.nodes.map((n) => (pickedTables.has(n.id) ? { ...n, selected: true } : n)),
      selectedEdgeId: pickedLine,
    }))
  }
}
