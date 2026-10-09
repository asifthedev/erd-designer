import type { RefineTool } from '../../../shared/aiToolSpecs'
import { generateDrizzle } from '../core/drizzle'
import type { Provider } from '../core/model'
import { generatePrisma } from '../core/prisma'
import { generateSql } from '../core/sql'
import { toDiagram, useStore } from '../store'
import { runTool, unpredictableIds, type Canvas } from './executor'

/** The tools a schema can be refined for, with the file the code goes in. */
export const REFINE_TOOLS: { id: RefineTool; label: string; file: string; fence: string }[] = [
  { id: 'prisma', label: 'Prisma', file: 'schema.prisma', fence: 'prisma' },
  { id: 'drizzle', label: 'Drizzle', file: 'schema.ts', fence: 'ts' },
  { id: 'sql', label: 'SQL', file: 'schema.sql', fence: 'sql' },
]
export const DB_LABEL: Record<Provider, string> = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' }
/** A schema longer than this is cut in the message: the model reads the canvas itself, the code is there to show the tool's own shape. */
const MAX_CODE_CHARS = 30_000

export const toolInfo = (tool: RefineTool) => REFINE_TOOLS.find((t) => t.id === tool)!

/** The canvas as the code of one tool. */
export function generateCode(tool: RefineTool, state: Pick<ReturnType<typeof useStore.getState>, 'provider' | 'nodes' | 'manyToMany'>): string {
  const diagram = toDiagram(state.provider, state.nodes, state.manyToMany)
  return tool === 'sql' ? generateSql(diagram).sql : tool === 'drizzle' ? generateDrizzle(diagram).schema : generatePrisma(diagram).schema
}

const ctx = { maxTables: 1000, uid: () => crypto.randomUUID() }

/**
 * Starts a refine: the parts that must not depend on a model are done first, on the canvas itself (switching to the
 * chosen database, and replacing every sequential id with a random UUID), so the model refines what it will really be
 * shipped as. Returns the message that carries the schema as the chosen tool writes it, and how many changes were made
 * (so the whole refine can be undone as one).
 */
export function prepareRefine(tool: RefineTool, database: Provider): { text: string; changes: number } {
  const state = useStore.getState()
  let canvas: Canvas = { provider: state.provider, nodes: state.nodes, manyToMany: state.manyToMany }
  let changes = 0
  if (database !== canvas.provider) {
    canvas = runTool(canvas, 'set_database', JSON.stringify({ database }), ctx).canvas
    changes++
  }
  const ids = unpredictableIds(canvas)
  if (ids.changed.length) {
    canvas = ids.canvas
    changes++
  }
  if (changes) useStore.getState().applyAiCanvas(canvas)
  const info = toolInfo(tool)
  const generated = generateCode(tool, canvas)
  const code = generated.length > MAX_CODE_CHARS ? `${generated.slice(0, MAX_CODE_CHARS)}\n... (cut: ${generated.length - MAX_CODE_CHARS} more characters; the canvas has everything)` : generated
  return {
    changes,
    text:
      `Refine my schema for production.\nTarget tool: ${info.label}\nTarget database: ${DB_LABEL[database]}\n` +
      (ids.changed.length
        ? `The app has already replaced the sequential integer ids of ${ids.changed.join(', ')} with random UUIDs (and the foreign keys to them). Keep every id non-sequential.\n`
        : 'Every id is already non-sequential. Keep it that way.\n') +
      `\nThis is the schema as ${info.label} generates it now (${info.file}):\n\`\`\`${info.fence}\n${code}\n\`\`\``,
  }
}
