import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../auth/api'
import { useStore } from '../store'
import type { ServerEvent } from './api'

/** What the stand-in model does on its n-th call: events to stream, or a failure. */
type Round = ServerEvent[] | Error | ((signal: AbortSignal) => AsyncGenerator<ServerEvent>)
const model = { rounds: [] as Round[], bodies: [] as any[] }

vi.mock('./api', () => ({
  fetchModels: vi.fn(async () => ({
    enabled: true,
    models: [{ id: 'm/one', label: 'One', maker: 'M', tier: 'smart' }],
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

const { useAi } = await import('./agent')

const tool = (id: string, name: string, args: object): ServerEvent => ({ type: 'tool_call', id, name, arguments: JSON.stringify(args) })
const text = (delta: string): ServerEvent => ({ type: 'text', delta })
const done = (finishReason = 'stop'): ServerEvent => ({ type: 'done', finishReason })
const makeTable = (name: string) => ({ name, columns: [{ name: 'id', type: 'SERIAL', primaryKey: true }] })
const names = () => useStore.getState().nodes.map((n) => n.data.name)
const last = () => useAi.getState().messages.at(-1)!

beforeEach(() => {
  model.rounds = []
  model.bodies = []
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
    model.rounds = Array.from({ length: 12 }, (_, i) => [tool(`c${i}`, 'auto_layout', {}), done('tool_calls')])
    useStore.getState().addTable()
    await useAi.getState().send('loop')
    expect(model.bodies).toHaveLength(10)
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
