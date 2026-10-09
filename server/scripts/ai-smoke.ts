/**
 * Runs the assistant against a REAL model and checks what it does:  npm run ai:smoke -w server -- --model anthropic/claude-sonnet-4.5
 *
 * It uses exactly what the app uses (the server prompt, the tool list, the two wire formats, and the web app's own tool
 * executor on a canvas kept in memory), so it needs no database and no browser. It costs a few cents per model.
 *
 *   AI_GATEWAY_API_KEY=sk-or-...   the gateway key (or ANTHROPIC_API_KEY with --direct)
 *   AI_GATEWAY_BASE_URL=...        default https://openrouter.ai/api/v1
 *
 * Options:  --model <id>   --only store,paste,why,refine   --base-url <url>   --direct (Anthropic's own API)
 * Exit code 1 when a scenario fails, so it can run in CI.
 */
import 'dotenv/config'
import { parseArgs } from 'node:util'
import type { ChatMessage, FocusSnapshot, RefineRequest } from '../../shared/aiToolSpecs'
import { TOOL_SPECS } from '../../shared/aiToolSpecs'
import { runTool, type Canvas } from '../../web/src/ai/executor'
import { layoutReport } from '../../web/src/ai/layoutReport'
import { canvasSnapshot } from '../../web/src/ai/snapshot'
import { streamAnthropic } from '../src/ai/anthropic'
import { streamOpenAiCompat } from '../src/ai/openaiCompat'
import { SYSTEM_STATIC, systemDynamic } from '../src/ai/prompt'

const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: process.env.AI_SMOKE_MODEL },
    only: { type: 'string' },
    'base-url': { type: 'string' },
    direct: { type: 'boolean', default: false },
  },
})
const direct = args.direct
const apiKey = direct ? process.env.ANTHROPIC_API_KEY : process.env.AI_GATEWAY_API_KEY
const baseUrl = direct ? (process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com') : (args['base-url'] ?? process.env.AI_GATEWAY_BASE_URL ?? 'https://openrouter.ai/api/v1')
if (!apiKey || !args.model) {
  console.error('Needs a model (--model company/model) and a key (AI_GATEWAY_API_KEY, or ANTHROPIC_API_KEY with --direct).')
  process.exit(2)
}
const model = args.model

type Step = { name: string; ok: boolean; message: string }
type Result = { text: string; steps: Step[]; canvas: Canvas; inputTokens: number; outputTokens: number; costUsd: number; calls: number }

let uid = 0
const ctx = { maxTables: 25, uid: () => `s${++uid}` }
const empty = (): Canvas => ({ provider: 'postgresql', nodes: [], manyToMany: [] })

/** The same loop as the app's, minus the screen: send, run the tool calls, send the results, until the model just answers. */
async function converse(start: Canvas, user: string, extra: { focus?: FocusSnapshot; refine?: RefineRequest } = {}, rounds = 8): Promise<Result> {
  let canvas = start
  const messages: ChatMessage[] = [{ role: 'user', content: user }]
  const result: Result = { text: '', steps: [], canvas, inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 }
  for (let round = 0; round < rounds; round++) {
    const snapshot = canvasSnapshot(canvas.provider, canvas.nodes.map((n) => n.data), ctx.maxTables)
    const adapter = direct ? streamAnthropic : streamOpenAiCompat
    const events = adapter(
      { model: direct ? model.replace(/^anthropic:/, '') : model, systemStatic: SYSTEM_STATIC, systemDynamic: systemDynamic(snapshot, extra.focus, extra.refine), messages, tools: TOOL_SPECS, maxTokens: 8000 },
      { baseUrl, apiKey: apiKey!, signal: AbortSignal.timeout(120_000), firstByteMs: 60_000, idleMs: 60_000 },
    )
    let text = ''
    const calls: { id: string; name: string; arguments: string }[] = []
    result.calls++
    for await (const ev of events) {
      if (ev.type === 'text') text += ev.delta
      else if (ev.type === 'tool_call') calls.push(ev)
      else if (ev.type === 'usage') {
        result.inputTokens += ev.inputTokens
        result.outputTokens += ev.outputTokens
        result.costUsd += ev.costUsd ?? 0
      }
    }
    messages.push({ role: 'assistant', content: text, ...(calls.length ? { toolCalls: calls } : {}) })
    result.text += (result.text && text ? '\n\n' : '') + text
    if (!calls.length) break
    for (const c of calls) {
      const out = runTool(canvas, c.name, c.arguments, ctx)
      canvas = out.canvas
      result.steps.push({ name: c.name, ok: out.ok, message: out.message })
      messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: out.message })
    }
  }
  result.canvas = canvas
  return result
}

const tableNames = (c: Canvas) => c.nodes.map((n) => n.data.name.toLowerCase())
const has = (c: Canvas, ...needles: string[]) => needles.every((n) => tableNames(c).some((t) => t.includes(n)))
const fks = (c: Canvas) => c.nodes.flatMap((n) => n.data.columns).filter((col) => col.references).length
const failedCalls = (r: Result) => r.steps.filter((s) => !s.ok).length

type Scenario = { id: string; title: string; run: () => Promise<{ result: Result; checks: [string, boolean][] }> }

const PASTED = `CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  author_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  body TEXT
);
CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL
);`

async function shopCanvas(): Promise<Canvas> {
  const r = await converse(empty(), 'Design a database for an online store with customers, saved addresses, products, orders, order items and payments.')
  return r.canvas
}

const scenarios: Scenario[] = [
  {
    id: 'store',
    title: 'Designs an online store from one sentence',
    run: async () => {
      const result = await converse(empty(), 'Design a database for an online store with customers, saved addresses, products, orders, order items and payments.')
      const report = layoutReport(result.canvas)
      return {
        result,
        checks: [
          ['creates at least 6 tables', result.canvas.nodes.length >= 6],
          ['has the core tables (customer, product, order, payment)', has(result.canvas, 'customer', 'product', 'order', 'payment')],
          ['connects them (at least 5 foreign keys)', fks(result.canvas) >= 5],
          ['no tool call failed', failedCalls(result) === 0],
          ['tables do not overlap', !report.problems.some((p) => p.startsWith('Tables overlap'))],
          ['ends with a short explanation', result.text.trim().length > 40],
        ],
      }
    },
  },
  {
    id: 'paste',
    title: 'Draws a pasted SQL schema faithfully',
    run: async () => {
      const result = await converse(empty(), `Draw this schema:\n\n${PASTED}`)
      const col = (t: string, c: string) => result.canvas.nodes.find((n) => n.data.name === t)?.data.columns.find((x) => x.name === c)
      return {
        result,
        checks: [
          ['creates users, posts and comments', has(result.canvas, 'users', 'posts', 'comments') && result.canvas.nodes.length === 3],
          ['keeps the column names', Boolean(col('posts', 'author_id') && col('comments', 'post_id') && col('users', 'email'))],
          ['keeps all 3 foreign keys', fks(result.canvas) === 3],
          ['keeps ON DELETE CASCADE', col('posts', 'author_id')?.references?.onDelete === 'CASCADE'],
          ['keeps UNIQUE on email', col('users', 'email')?.unique === true],
          ['no tool call failed', failedCalls(result) === 0],
        ],
      }
    },
  },
  {
    id: 'why',
    title: 'Explains a design choice about what is picked, without changing anything',
    run: async () => {
      const canvas = await shopCanvas()
      const names = tableNames(canvas)
      const address = canvas.nodes.find((n) => /address/i.test(n.data.name))?.data.name ?? 'address'
      const order = canvas.nodes.find((n) => /^orders?$/i.test(n.data.name))?.data
      const shipping = order?.columns.find((c) => /ship|address/i.test(c.name))?.name ?? 'shipping_address'
      const before = canvas.nodes.length
      const result = await converse(
        canvas,
        `[Picked on the canvas: table ${address}; column ${order?.name ?? 'order'}.${shipping}]\nWhy do we have a separate address table and also store the shipping address on the order?`,
        { focus: { tables: [address], columns: [{ table: order?.name ?? 'order', column: shipping }], relations: [], manyToMany: [] } },
      )
      const answer = result.text.toLowerCase()
      return {
        result,
        checks: [
          ['does not change the canvas for a question', result.steps.length === 0 && result.canvas.nodes.length === before],
          ['gives the snapshot / history reason', /snapshot|history|historical|at the time|at purchase|later change|changes later|edited|deleted/.test(answer)],
          ['names real tables or columns', names.some((n) => answer.includes(n.slice(0, 5))) || answer.includes(shipping.toLowerCase())],
          ['answers at some length', result.text.trim().length > 200],
        ],
      }
    },
  },
  {
    id: 'refine',
    title: 'Refines a schema for production (Prisma, PostgreSQL)',
    run: async () => {
      const canvas = await shopCanvas()
      const result = await converse(
        canvas,
        'Refine my schema for production.\nTarget tool: Prisma\nTarget database: PostgreSQL\n\n(The schema is the one on the canvas.)',
        { refine: { tool: 'prisma', database: 'postgresql' } },
        10,
      )
      const cols = result.canvas.nodes.flatMap((n) => n.data.columns)
      const pks = cols.filter((c) => c.primaryKey && c.references === undefined)
      const money = cols.filter((c) => /price|total|amount|subtotal/i.test(c.name))
      return {
        result,
        checks: [
          ['no sequential (SERIAL / integer) primary keys left', pks.length > 0 && pks.every((c) => !/serial|^int|integer|bigint/i.test(c.type.trim()))],
          ['foreign keys follow the new key type', result.canvas.nodes.flatMap((n) => n.data.columns).filter((c) => c.references).every((c) => !/serial/i.test(c.type))],
          ['money is DECIMAL, never FLOAT', money.every((c) => /decimal|numeric/i.test(c.type))],
          ['timestamps are added', cols.some((c) => /created_at/i.test(c.name))],
          ['no tool call failed', failedCalls(result) <= 1],
          ['recommends indexes the diagram cannot show', /index/i.test(result.text)],
        ],
      }
    },
  },
]

const only = args.only?.split(',').map((s) => s.trim())
let failed = 0
let cost = 0
let tokens = 0
console.log(`Model: ${model}   Route: ${direct ? 'Anthropic direct' : baseUrl}\n`)
for (const s of scenarios.filter((x) => !only || only.includes(x.id))) {
  const started = Date.now()
  process.stdout.write(`▶ ${s.title}\n`)
  try {
    const { result, checks } = await s.run()
    for (const [name, ok] of checks) {
      console.log(`   ${ok ? '✓' : '✗'} ${name}`)
      if (!ok) failed++
    }
    const failedSteps = result.steps.filter((x) => !x.ok)
    for (const step of failedSteps.slice(0, 2)) console.log(`     (a refused call: ${step.name}: ${step.message.split('\n').slice(0, 2).join(' ').slice(0, 160)})`)
    cost += result.costUsd
    tokens += result.inputTokens + result.outputTokens
    console.log(`   ${result.calls} model calls, ${result.steps.length} tool calls, ${((Date.now() - started) / 1000).toFixed(1)} s, ${result.inputTokens + result.outputTokens} tokens${result.costUsd ? `, $${result.costUsd.toFixed(4)}` : ''}\n`)
  } catch (e) {
    failed++
    console.log(`   ✗ the run failed: ${(e as Error).message}\n`)
  }
}
console.log(`${failed ? `${failed} check(s) failed` : 'All checks passed'}.  Total ${tokens} tokens${cost ? `, $${cost.toFixed(4)}` : ''}.`)
process.exit(failed ? 1 : 0)
