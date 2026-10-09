import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../auth/api'
import { useStore } from '../store'
import type { ServerEvent } from './api'

/** What the stand-in model does on its n-th call: events to stream, or a failure. */
type Round = ServerEvent[] | Error | ((signal: AbortSignal) => AsyncGenerator<ServerEvent>)
const model = { rounds: [] as Round[], bodies: [] as any[], vision: false }

vi.mock('./api', () => ({
  fetchModels: vi.fn(async () => ({
    enabled: true,
    models: [{ id: 'm/one', label: 'One', maker: 'M', tier: 'smart', vision: model.vision }],
    defaultModel: 'm/one',
    quota: { used: 1, limit: 10 },
    locked: [],
  })),
  async *streamChat(body: any, signal: AbortSignal) {
    model.bodies.push(structuredClone(body))
    const round = model.rounds.shift()
    if (!round) throw new Error('the test did not script this call')
    if (round instanceof Error) throw round
    if (typeof round === 'function') yield* round(signal)
    else yield* round
  },
}))

const authState = {
  status: 'authed' as 'authed' | 'guest',
  currentId: 'd1' as string | null,
  diagrams: [{ id: 'd1', title: 'Shop', updatedAt: '' }],
  createDiagram: vi.fn(async () => {
    authState.currentId = 'd2'
    return 'd2'
  }),
  renameDiagram: vi.fn(async () => {}),
  showSignIn: vi.fn(),
}
vi.mock('../auth/store', () => ({ useAuth: { getState: () => authState } }))

const { useAi, setCanvasCapture } = await import('./agent')

const tool = (id: string, name: string, args: object): ServerEvent => ({ type: 'tool_call', id, name, arguments: JSON.stringify(args) })
const text = (delta: string): ServerEvent => ({ type: 'text', delta })
const done = (finishReason = 'stop'): ServerEvent => ({ type: 'done', finishReason })
const makeTable = (name: string) => ({ name, columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }] })
const names = () => useStore.getState().nodes.map((n) => n.data.name)
const last = () => useAi.getState().messages.at(-1)!

const SHOT = 'data:image/jpeg;base64,/9j/AAAA'
const sendWith = async (text: string, options?: Parameters<ReturnType<typeof useAi.getState>['send']>[1]) => {
  await useAi.getState().loadModels() // the model's vision flag is read from the list
  await useAi.getState().send(text, options)
}

beforeEach(() => {
  model.rounds = []
  model.bodies = []
  model.vision = false
  setCanvasCapture(null)
  authState.status = 'authed'
  authState.currentId = 'd1'
  authState.createDiagram.mockClear()
  useStore.getState().clear()
  useAi.setState({ messages: [], busy: false, undo: null, modelId: 'm/one', enabled: true, undone: false, switching: false })
  useAi.getState().newChat()
})

describe('the assistant loop', () => {
  it('runs tool calls on the canvas, sends the results back, and ends on the model\'s answer', async () => {
    model.rounds = [[text('Creating. '), tool('c1', 'create_tables', { tables: [makeTable('user'), makeTable('post')] }), done('tool_calls')], [text('Done.'), done()]]
    await useAi.getState().send('make a blog')
    expect(names()).toEqual(['user', 'post'])
    // The second call carries the first answer, its tool call and the result, and the canvas as it is NOW.
    const second = model.bodies[1]
    expect(second.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(second.messages[1].toolCalls[0]).toMatchObject({ id: 'c1', name: 'create_tables' })
    expect(second.messages[2]).toMatchObject({ toolCallId: 'c1', name: 'create_tables' })
    expect(second.messages[2].content).toMatch(/Created 2 table/)
    expect(second.canvas.tables.map((t: any) => t.name)).toEqual(['user', 'post'])
    expect(model.bodies[0].canvas.tables).toEqual([])
    const m = last()
    expect(m.role).toBe('assistant')
    expect(m.streaming).toBe(false)
    expect(m.text).toBe('Creating. \n\nDone.')
    expect(m.tools).toEqual([{ id: 'c1', name: 'create_tables', ok: true, summary: 'Created 2 tables: user, post' }])
    expect(useAi.getState().busy).toBe(false)
    expect(useAi.getState().undo?.changes).toBe(1)
  })

  it('shows a refused call as a failed chip and lets the model correct itself', async () => {
    model.rounds = [
      [tool('a', 'create_tables', { tables: [{ name: 't', columns: [{ name: 'id', type: 'SERIALL' }] }] }), done('tool_calls')],
      [tool('b', 'create_tables', { tables: [makeTable('t')] }), done('tool_calls')],
      [text('Fixed.'), done()],
    ]
    await useAi.getState().send('x')
    expect(names()).toEqual(['t'])
    expect(last().tools!.map((t) => t.ok)).toEqual([false, true])
    expect(last().tools![0].summary).toMatch(/SERIALL/)
    expect(model.bodies[1].messages.at(-1).content).toMatch(/Nothing was created/)
  })

  it('undo restores the canvas, and the next message tells the model', async () => {
    model.rounds = [[tool('c1', 'create_tables', { tables: [makeTable('a')] }), done('tool_calls')], [text('ok'), done()]]
    await useAi.getState().send('add a')
    useAi.getState().undoLast()
    expect(names()).toEqual([])
    expect(useAi.getState().undo).toBeNull()
    model.rounds = [[text('noted'), done()]]
    await useAi.getState().send('what now?')
    expect(model.bodies.at(-1).messages.at(-1).content).toMatch(/undid your last changes/)
  })

  it('stops after too many rounds, and after repeated failures', async () => {
    model.rounds = Array.from({ length: 16 }, (_, i) => [tool(`c${i}`, 'auto_layout', {}), done('tool_calls')])
    useStore.getState().addTable()
    await useAi.getState().send('loop')
    expect(model.bodies).toHaveLength(14)
    expect(last().notice).toMatch(/Stopped after many steps/)

    model.rounds = Array.from({ length: 6 }, (_, i) => [tool(`f${i}`, 'drop_tables', { tables: ['nothing'] }), done('tool_calls')])
    await useAi.getState().send('fail')
    expect(last().notice).toMatch(/could not make that change/)
    expect(useAi.getState().busy).toBe(false)
  })

  it('reports a failure, keeps the conversation valid, and offers the way forward for a daily limit', async () => {
    model.rounds = [new ApiError('You used all 30 free AI requests for today.', 429, undefined, undefined, 'daily_limit')]
    await useAi.getState().send('hi')
    expect(last()).toMatchObject({ role: 'error', action: 'plans' })
    model.rounds = [[text('back'), done()]]
    await useAi.getState().send('again')
    // The failed first message does not stay behind as a dangling turn.
    const roles = model.bodies.at(-1).messages.map((m: any) => m.role)
    expect(roles.at(-1)).toBe('user')
    expect(roles).not.toContain('tool')
  })

  it('an error in the middle of the loop drops the unfinished round', async () => {
    model.rounds = [[tool('c1', 'create_tables', { tables: [makeTable('a')] }), done('tool_calls')], new ApiError('The model took too long to answer.', 502, undefined, undefined, 'timeout')]
    await useAi.getState().send('go')
    expect(names()).toEqual(['a']) // what was done stays
    expect(last().role).toBe('error')
    model.rounds = [[text('ok'), done()]]
    await useAi.getState().send('continue')
    const roles = model.bodies.at(-1).messages.map((m: any) => m.role)
    expect(roles).toEqual(['user', 'user'].slice(0, roles.length)) // never a tool call without its result
  })

  it('an error event in the stream is shown, not swallowed', async () => {
    model.rounds = [[text('partial'), { type: 'error', code: 'busy', message: 'The AI service is busy.' }]]
    await useAi.getState().send('x')
    expect(last()).toMatchObject({ role: 'error', text: 'The AI service is busy.' })
  })

  it('Stop ends the turn cleanly, even in the middle of an answer', async () => {
    model.rounds = [
      async function* (signal) {
        yield text('thinking')
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      },
    ]
    const sending = useAi.getState().send('long one')
    await vi.waitFor(() => expect(useAi.getState().messages.at(-1)?.text).toBe('thinking'))
    useAi.getState().stop()
    await sending
    expect(last()).toMatchObject({ notice: 'Stopped.', streaming: false })
    expect(useAi.getState().busy).toBe(false)
  })

  it('does not run without an account', async () => {
    authState.status = 'guest'
    await useAi.getState().send('hello')
    expect(model.bodies).toHaveLength(0)
    expect(last()).toMatchObject({ role: 'error', action: 'login' })
  })

  it('does not apply changes to a diagram the person switched to meanwhile', async () => {
    model.rounds = [
      async function* () {
        authState.currentId = 'other' // the person clicked another diagram while the model was answering
        yield tool('c1', 'create_tables', { tables: [makeTable('a')] })
        yield done('tool_calls')
      },
    ]
    await useAi.getState().send('x')
    expect(names()).toEqual([])
    expect(last().notice).toMatch(/opened another diagram/)
  })

  it('starts a new diagram on request and keeps working in it', async () => {
    model.rounds = [
      [tool('n', 'create_diagram', { title: 'Blog' }), done('tool_calls')],
      [tool('t', 'create_tables', { tables: [makeTable('post')] }), done('tool_calls')],
      [text('Ready'), done()],
    ]
    await useAi.getState().send('new diagram')
    expect(authState.createDiagram).toHaveBeenCalled()
    expect(authState.renameDiagram).toHaveBeenCalledWith('d2', 'Blog')
    expect(names()).toEqual(['post'])
    expect(useAi.getState().undo).toBeNull() // undoing would restore the old diagram's canvas onto the new one
    expect(last().tools!.map((t) => t.ok)).toEqual([true, true])
  })

  it('tells the model when a new diagram could not be made', async () => {
    authState.createDiagram.mockResolvedValueOnce(null as unknown as string)
    model.rounds = [[tool('n', 'create_diagram', { title: 'X' }), done('tool_calls')], [text('sorry'), done()]]
    await useAi.getState().send('new diagram')
    expect(last().tools![0].ok).toBe(false)
    expect(model.bodies[1].messages.at(-1).content).toMatch(/could not be created/)
  })
})

describe('models', () => {
  it('loads the list, remembers nothing it cannot use, and sends the chosen model', async () => {
    await useAi.getState().loadModels()
    expect(useAi.getState()).toMatchObject({ enabled: true, modelId: 'm/one', quota: { used: 1, limit: 10 } })
    useAi.getState().selectModel('does/not-exist')
    expect(useAi.getState().modelId).toBe('m/one')
    model.rounds = [[text('hi'), done()]]
    await useAi.getState().send('x')
    expect(model.bodies[0].model).toBe('m/one')
  })
})

describe('asking about what is picked', () => {
  const twoTables = [tool('c', 'create_tables', { tables: [makeTable('customer'), { name: 'order', columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }, { name: 'customer_id', type: 'INT', references: { table: 'customer' } }] }] }), done('tool_calls')]
  const build = async () => {
    model.rounds = [twoTables, [text('built'), done()]]
    await useAi.getState().send('make two tables')
    model.bodies = []
  }

  it('tells the model exactly what is picked, in every round of the question, and keeps it in the history', async () => {
    await build()
    const [customer, order] = useStore.getState().nodes
    useStore.setState({ nodes: useStore.getState().nodes.map((n) => ({ ...n, selected: n.id === order.id })), selectedColumn: { tableId: customer.id, columnId: customer.data.columns[0].id } })
    model.rounds = [[tool('a', 'auto_layout', {}), done('tool_calls')], [text('The order table holds a customer.'), done()]]
    await useAi.getState().send('why is this here?')
    for (const body of model.bodies) {
      expect(body.focus).toEqual({ tables: ['order'], columns: [{ table: 'customer', column: 'id' }], relations: [], manyToMany: [] })
    }
    expect(model.bodies[0].messages.at(-1).content).toBe('[Picked on the canvas: table order; column customer.id]\nwhy is this here?')
    expect(useAi.getState().messages.find((m) => m.role === 'user' && m.text === 'why is this here?')?.about).toEqual(['table order', 'column customer.id'])
  })

  it('knows a picked relation line and a picked link', async () => {
    await build()
    const [customer, order] = useStore.getState().nodes
    const fk = order.data.columns[1]
    useStore.setState({ nodes: useStore.getState().nodes.map((n) => ({ ...n, selected: false })), selectedEdgeId: `${order.id}:${fk.id}` })
    model.rounds = [[text('A customer has many orders.'), done()]]
    await useAi.getState().send('explain this relation')
    expect(model.bodies[0].focus.relations).toEqual([{ table: 'order', column: 'customer_id' }])
    expect(model.bodies[0].messages.at(-1).content).toContain('relation order.customer_id \u2192 customer.id')
    useStore.setState({ manyToMany: [{ id: 'l1', aTableId: customer.id, bTableId: order.id }], selectedEdgeId: 'm2m:l1' })
    model.rounds = [[text('ok then'), done()]]
    await useAi.getState().send('and this link?')
    expect(model.bodies.at(-1).focus.manyToMany).toEqual([{ a: 'customer', b: 'order' }])
  })

  it('sends no focus when nothing is picked', async () => {
    await build()
    useStore.setState({ nodes: useStore.getState().nodes.map((n) => ({ ...n, selected: false })), selectedColumn: null, selectedEdgeId: null })
    model.rounds = [[text('hi'), done()]]
    await useAi.getState().send('hello')
    expect(model.bodies[0].focus).toBeUndefined()
    expect(model.bodies[0].messages.at(-1).content).toBe('hello')
  })

  it('a refine ignores what happens to be picked (it is about the whole schema)', async () => {
    await build()
    useStore.setState({ nodes: useStore.getState().nodes.map((n) => ({ ...n, selected: true })) })
    model.rounds = [[text('done'), done()]]
    await useAi.getState().send('Refine my schema', { refine: { tool: 'sql', database: 'mysql' }, display: 'Refine for production' })
    expect(model.bodies[0].focus).toBeUndefined()
    expect(model.bodies[0].messages.at(-1).content).toBe('Refine my schema')
    expect(useAi.getState().messages.find((m) => m.refine)?.about).toBeUndefined()
  })

  it('"Refine" sends the tool and database on every round, with the schema in the message and a short label on screen', async () => {
    await build()
    model.rounds = [[tool('r', 'alter_table', { table: 'customer', updateColumns: [{ name: 'id', type: 'UUID' }] }), done('tool_calls')], [text('IDs are now UUIDs.'), done()]]
    await useAi.getState().send('Refine my schema for production.\nTarget tool: Prisma\n```prisma\nmodel X {}\n```', { refine: { tool: 'prisma', database: 'postgresql' }, display: 'Refine for production · Prisma · PostgreSQL' })
    for (const body of model.bodies.slice(0, 2)) expect(body.refine).toEqual({ tool: 'prisma', database: 'postgresql' })
    expect(model.bodies[0].messages.at(-1).content).toContain('Target tool: Prisma')
    const shown = useAi.getState().messages.find((m) => m.role === 'user' && m.refine)!
    expect(shown.text).toBe('Refine for production · Prisma · PostgreSQL')
    // The change worked, and the foreign key followed the new key type.
    const order = useStore.getState().nodes.find((n) => n.data.name === 'order')!.data
    expect(order.columns[1].type).toBe('UUID')
  })
})

describe('checking its own work', () => {
  const change = [tool('c', 'create_tables', { tables: [makeTable('a'), makeTable('b')] }), done('tool_calls')]

  it('a model that can see gets the screenshot and a layout report, and "OK" is not shown as an answer', async () => {
    model.vision = true
    setCanvasCapture(async () => SHOT)
    model.rounds = [change, [text('Created a and b.'), done()], [text('OK'), done()]]
    await sendWith('make a and b')
    const check = model.bodies[2].messages.at(-1)
    expect(check.role).toBe('user')
    expect(check.images).toEqual([SHOT])
    expect(check.content).toMatch(/Automatic check/)
    expect(check.content).toMatch(/No overlapping tables/)
    const m = last()
    expect(m.text).toBe('Created a and b.') // the OK stays out of the conversation on screen
    expect(m.checks).toEqual([expect.objectContaining({ status: 'ok', image: SHOT })])
    expect(useAi.getState().busy).toBe(false)
  })

  it('what it sees makes it fix the canvas, and it looks again', async () => {
    model.vision = true
    let shots = 0
    setCanvasCapture(async () => `${SHOT}${++shots}`)
    model.rounds = [
      change,
      [text('Done.'), done()],
      [tool('m', 'move_tables', { moves: [{ table: 'b', nextTo: { table: 'a', side: 'right' } }] }), done('tool_calls')],
      [text('Moved b.'), done()],
      [text('OK'), done()],
    ]
    await sendWith('go')
    expect(shots).toBe(2)
    expect(last().checks!.map((c) => c.status)).toEqual(['fixing', 'ok'])
    expect(last().tools!.map((t) => t.name)).toEqual(['create_tables', 'move_tables'])
    // Only the newest screenshot travels: the older one is stale and costs thousands of tokens.
    const last_ = model.bodies.at(-1).messages
    expect(last_.filter((m: any) => m.images?.length)).toHaveLength(1)
    expect(last_.find((m: any) => m.images?.length).images).toEqual([`${SHOT}2`])
  })

  it('looks at most twice, however the model answers', async () => {
    model.vision = true
    setCanvasCapture(async () => SHOT)
    const fix = [tool('f', 'auto_layout', {}), done('tool_calls')]
    model.rounds = [change, [text('Done.'), done()], fix, [text('Better.'), done()], fix, [text('Better still.'), done()]]
    await sendWith('go')
    expect(last().checks).toHaveLength(2)
    expect(model.rounds).toHaveLength(0) // every scripted call was used, none more
  })

  it('a model that cannot see is only checked when the layout report finds a problem', async () => {
    setCanvasCapture(async () => SHOT)
    model.rounds = [change, [text('Done.'), done()]]
    await sendWith('go')
    expect(model.bodies).toHaveLength(2) // clean layout: no extra call
    expect(last().checks).toEqual([])

    useStore.getState().clear()
    useAi.getState().newChat()
    const overlap = [tool('c', 'create_tables', { tables: [makeTable('a'), makeTable('b')] }), tool('z', 'move_tables', { moves: [{ table: 'b', x: 0, y: 0 }, { table: 'a', x: 10, y: 10 }] }), done('tool_calls')]
    model.bodies = []
    model.rounds = [overlap, [text('Done.'), done()], [text('OK'), done()]]
    await sendWith('go again')
    const check = model.bodies[2].messages.at(-1)
    expect(check.images).toBeUndefined() // no picture for a model that cannot see
    expect(check.content).toMatch(/Tables overlap: b and a|Tables overlap: a and b/)
  })

  it('questions and failed changes are not checked', async () => {
    model.vision = true
    setCanvasCapture(async () => SHOT)
    model.rounds = [[text('Because customers have orders.'), done()]]
    await sendWith('why?')
    expect(model.bodies).toHaveLength(1)
    model.rounds = [[tool('x', 'drop_tables', { tables: ['nothing'] }), done('tool_calls')], [text('I could not.'), done()]]
    model.bodies = []
    await sendWith('drop it')
    expect(model.bodies).toHaveLength(2)
  })

  it('a screenshot that cannot be drawn does not stop the check', async () => {
    model.vision = true
    setCanvasCapture(async () => {
      throw new Error('no canvas')
    })
    model.rounds = [change, [text('Done.'), done()]]
    await sendWith('go')
    expect(model.bodies).toHaveLength(2) // no picture and a clean report: nothing to ask
  })

  it('stopping during the check ends cleanly and leaves a valid conversation', async () => {
    model.vision = true
    setCanvasCapture(async () => SHOT)
    model.rounds = [
      change,
      [text('Done.'), done()],
      async function* (signal) {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      },
    ]
    await useAi.getState().loadModels()
    const sending = useAi.getState().send('go')
    await vi.waitFor(() => expect(useAi.getState().messages.at(-1)?.checks?.length).toBe(1))
    useAi.getState().stop()
    await sending
    expect(last().checks![0].status).not.toBe('checking')
    model.rounds = [[text('fine'), done()]]
    await useAi.getState().send('next')
    const roles = model.bodies.at(-1).messages.map((m: any) => m.role)
    expect(roles.at(-1)).toBe('user')
    expect(model.bodies.at(-1).messages.some((m: any) => /Automatic check/.test(m.content ?? ''))).toBe(false) // the unanswered check is gone
  })
})
