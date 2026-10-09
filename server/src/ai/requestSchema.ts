import { z } from 'zod'
import { DATABASES, REFINE_TOOLS, type ChatMessage } from '../../../shared/aiToolSpecs'

/** Every limit here exists so one request can never cost more than a few cents or tie the server up. */
export const LIMITS = {
  messages: 80,
  userChars: 40_000, // a pasted schema can be long
  assistantChars: 20_000,
  toolResultChars: 8_000,
  toolCallsPerTurn: 8,
  argumentChars: 60_000,
  tables: 300,
  columns: 200,
  /** A screenshot of the canvas (data URL) and how many ride along with one message. */
  imageChars: 2_500_000,
  imagesPerMessage: 2,
  /** Names in the picked objects. */
  focusItems: 60,
  /** Model calls in a row after one user message (each tool result starts another). */
  toolRounds: 12,
} as const

const short = (max: number) => z.string().max(max)

const columnSnapshot = z.object({
  name: short(200),
  type: short(200),
  primaryKey: z.boolean().optional(),
  notNull: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: short(300).optional(),
  references: z.object({ table: short(200), column: short(200), onDelete: short(20).optional() }).optional(),
})

const canvasSnapshot = z.object({
  provider: z.enum(DATABASES),
  tables: z
    .array(z.object({ name: short(200), icon: short(60).optional(), color: short(20).optional(), columns: z.array(columnSnapshot).max(LIMITS.columns) }))
    .max(LIMITS.tables),
  maxTables: z.number().int().min(1).max(1000),
  title: short(200).optional(),
})

const toolCall = z.object({ id: short(100).min(1), name: short(60).min(1), arguments: short(LIMITS.argumentChars) })

const image = z.string().max(LIMITS.imageChars).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Images must be base64 PNG, JPEG or WebP')

const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: short(LIMITS.userChars).min(1), images: z.array(image).max(LIMITS.imagesPerMessage).optional() }),
  z.object({ role: z.literal('assistant'), content: short(LIMITS.assistantChars), toolCalls: z.array(toolCall).max(LIMITS.toolCallsPerTurn).optional() }),
  z.object({ role: z.literal('tool'), toolCallId: short(100).min(1), name: short(60), content: short(LIMITS.toolResultChars) }),
])

const name = short(200)
const focus = z.object({
  tables: z.array(name).max(LIMITS.focusItems),
  columns: z.array(z.object({ table: name, column: name })).max(LIMITS.focusItems),
  relations: z.array(z.object({ table: name, column: name })).max(LIMITS.focusItems),
  manyToMany: z.array(z.object({ a: name, b: name })).max(LIMITS.focusItems),
})

export const chatRequestSchema = z.object({
  /** A model id from GET /api/ai/models. Omitted: the default. */
  model: short(160).optional(),
  canvas: canvasSnapshot,
  /** What the person has picked on the canvas: their message is about it. */
  focus: focus.optional(),
  /** "Refine for production": the tool and database the schema is written for. */
  refine: z.object({ tool: z.enum(REFINE_TOOLS), database: z.enum(DATABASES) }).optional(),
  messages: z.array(message).min(1).max(LIMITS.messages),
})
export type ChatRequest = z.infer<typeof chatRequestSchema>

/**
 * The conversation must be something every provider accepts: it starts with and ends on a user message or a tool
 * result, and every tool result answers a call of the assistant message just before it. Also caps the tool rounds.
 */
export function checkConversation(messages: ChatMessage[]): string | null {
  if (messages[0].role !== 'user') return 'The conversation must start with a message from you.'
  const last = messages[messages.length - 1]
  if (last.role === 'assistant') return 'The conversation must end with your message or a tool result.'
  let pending = new Set<string>()
  let rounds = 0
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (pending.size) return 'A tool call was not answered.'
      pending = new Set((m.toolCalls ?? []).map((c) => c.id))
      if (pending.size !== (m.toolCalls ?? []).length) return 'Tool call ids must be unique.'
      rounds += pending.size ? 1 : 0
    } else if (m.role === 'tool') {
      if (!pending.delete(m.toolCallId)) return 'A tool result does not match a tool call.'
    } else {
      if (pending.size) return 'A tool call was not answered.'
      rounds = 0
    }
  }
  if (pending.size) return 'A tool call was not answered.'
  if (rounds > LIMITS.toolRounds) return 'The assistant made too many changes in a row. Send a new message to continue.'
  return null
}
