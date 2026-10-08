import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toWorkspace, useStore, type Workspace } from '../store'

type Row = { id: string; title: string; data: Workspace; updatedAt: string }

// An in-memory stand-in for the server, recording every call so tests can check ORDER (e.g. save before switch).
/** The plan the stand-in server reports: Free, with the limits the test wants. */
function planWith(maxDiagrams: number, maxTablesPerDiagram = 25) {
  return {
    id: 'free',
    name: 'Free',
    kind: 'free' as const,
    description: '',
    priceCents: 0,
    currency: 'USD',
    maxDiagrams,
    maxTablesPerDiagram,
    features: { export: false, codeFormats: false, themes: false, localCopy: false, setup: false },
    highlights: [],
    sortOrder: 0,
    expiresAt: null,
  }
}
const server = {
  rows: new Map<string, Row>(),
  calls: [] as string[],
  failNext: new Set<string>(),
  clock: 0,
  seq: 0,
  plan: planWith(50),
}
const stamp = () => new Date(2026, 0, 1, 0, 0, ++server.clock).toISOString()

vi.mock('./api', async (orig) => {
  const real = await orig<typeof import('./api')>()
  return {
    ...real,
    api: vi.fn(async (path: string, options: { method?: string; body?: any } = {}) => {
      const method = options.method ?? (options.body === undefined ? 'GET' : 'POST')
      const key = `${method} ${path}`
      server.calls.push(key)
      if (server.failNext.delete(key)) throw new real.ApiError('Server says no', 500)

      if (path === '/diagrams' && method === 'GET') {
        return { diagrams: [...server.rows.values()].map(({ data: _d, ...meta }) => meta), plan: server.plan }
      }
      if (path === '/diagrams' && method === 'POST') {
        if (server.rows.size >= server.plan.maxDiagrams) {
          throw new real.ApiError('You can only create one diagram on the Free plan. Please upgrade your plan.', 403, undefined, undefined, 'plan_limit')
        }
        const row: Row = {
          id: `d${++server.seq}`,
          title: options.body.title ?? 'Untitled diagram',
          data: options.body.data,
          updatedAt: stamp(),
        }
        server.rows.set(row.id, row)
        const { data: _d, ...meta } = row
        return { diagram: meta }
      }
      const id = path.split('/')[2]
      const row = server.rows.get(id)
      if (!row) throw new real.ApiError('Diagram not found', 404)
      if (method === 'GET') return { diagram: row }
      if (method === 'PUT') {
        if (options.body.title) row.title = options.body.title
        if (options.body.data) row.data = options.body.data
        row.updatedAt = stamp()
        return { updatedAt: row.updatedAt }
      }
      if (method === 'DELETE') {
        server.rows.delete(id)
        return undefined
      }
      throw new Error(`unexpected ${key}`)
    }),
  }
})

// What the person is shown at the plan's limit is checked by looking at what the store asks the toast helper to show.
vi.mock('../components/problemToast', () => ({ showProblem: vi.fn(), showNote: vi.fn() }))
const { showProblem } = await import('../components/problemToast')
const { planLimitProblem } = await import('../core/problems')
const { useAuth } = await import('./store')

const user = { id: 'u1', email: 'a@b.co', name: null }
const ws = (name: string): Workspace => ({
  provider: 'postgresql',
  nodes: [
    {
      id: name,
      position: { x: 0, y: 0 },
      data: { id: name, name, columns: [{ id: `${name}-id`, name: 'id', type: 'INT', primaryKey: true, notNull: true, unique: false, default: '' }] },
    },
  ],
  manyToMany: [],
})
const seed = (id: string, title: string, name: string) =>
  server.rows.set(id, { id, title, data: ws(name), updatedAt: stamp() })
const names = () => useStore.getState().nodes.map((n) => n.data.name)
const rename = (name: string) =>
  useStore.setState({ nodes: useStore.getState().nodes.map((n) => ({ ...n, data: { ...n.data, name } })) })

async function signIn() {
  const { api } = await import('./api')
  vi.mocked(api).mockImplementationOnce(async () => ({ user })) // POST /auth/login
  await useAuth.getState().login('a@b.co', 'x')
}

beforeEach(() => {
  server.rows.clear()
  server.calls = []
  server.failNext.clear()
  server.clock = 0
  server.seq = 0
  server.plan = planWith(50)
  vi.mocked(showProblem).mockClear()
  useStore.getState().loadSample()
  useAuth.setState({ status: 'loading', user: null, ready: false, save: 'idle', diagrams: [], currentId: null, switching: false, loading: null })
})

describe('start-up', () => {
  it('runs init once even when called twice, so a new account gets one first ERD, not two', async () => {
    const { api } = await import('./api')
    vi.mocked(api).mockImplementationOnce(async () => ({ user })) // GET /auth/me (only one is expected)
    await Promise.all([useAuth.getState().init(), useAuth.getState().init()])
    expect(server.calls.filter((c) => c === 'POST /diagrams')).toHaveLength(1)
    expect(useAuth.getState().diagrams).toHaveLength(1)
  })
})

describe('ERDs already loaded this session', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('open instantly the second time: no loading indicator, and the edits made meanwhile are there', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn() // b open (and cached)
    await useAuth.getState().openDiagram('a') // first visit: a real load
    expect(server.calls.filter((c) => c === 'GET /diagrams/a')).toHaveLength(1)
    rename('a_edited')
    await useAuth.getState().saveNow()

    const back = useAuth.getState().openDiagram('b') // b was loaded before
    expect(useAuth.getState().loading).toBeNull() // never set: nothing to show
    expect(useAuth.getState().switching).toBe(false)
    expect(useAuth.getState().currentId).toBe('b') // switched synchronously
    expect(names()).toEqual(['table_b'])
    await back

    const again = useAuth.getState().openDiagram('a')
    expect(useAuth.getState().loading).toBeNull()
    expect(names()).toEqual(['a_edited']) // the saved edit, straight from memory
    await again
    await settle()
    expect(server.calls.filter((c) => c === 'GET /diagrams/a')).toHaveLength(2) // only the quiet freshness check
  })

  it('with unsaved edits it saves first, spinning only the row (a quiet load), then switches', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn()
    await useAuth.getState().openDiagram('a')
    await useAuth.getState().openDiagram('b') // both cached now
    rename('typed_but_not_saved')

    const opening = useAuth.getState().openDiagram('a')
    expect(useAuth.getState().loading).toEqual({ kind: 'open', id: 'a', quiet: true })
    await opening
    expect(server.rows.get('b')!.data.nodes[0].data.name).toBe('typed_but_not_saved')
    expect(names()).toEqual(['table_a'])
    expect(useAuth.getState().loading).toBeNull()
  })

  it('picks up a newer version saved elsewhere, but never overwrites what is being edited', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn() // b open
    await useAuth.getState().openDiagram('a')
    await useAuth.getState().openDiagram('b')

    // "another device" saves a
    server.rows.get('a')!.data = ws('from_other_device')
    server.rows.get('a')!.updatedAt = stamp()
    void useAuth.getState().openDiagram('a') // shows the cached copy at once (the check below is still in flight)...
    expect(names()).toEqual(['table_a'])
    await settle()
    expect(names()).toEqual(['from_other_device']) // ...then quietly updates

    // the same again, but the person has already started typing
    await useAuth.getState().openDiagram('b')
    server.rows.get('b')!.data = ws('remote_b')
    server.rows.get('b')!.updatedAt = stamp()
    await useAuth.getState().openDiagram('a')
    await useAuth.getState().openDiagram('b')
    rename('my_typing') // edited before the freshness check answers
    await settle()
    expect(names()).toEqual(['my_typing'])
  })

  it('forgets a deleted ERD, remembers a created one, and is emptied on logout', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn()
    await useAuth.getState().openDiagram('a')
    await useAuth.getState().deleteDiagram('a')
    server.calls = []

    const id = (await useAuth.getState().createDiagram())!
    await useAuth.getState().openDiagram('b') // cached from sign-in
    await useAuth.getState().openDiagram(id) // created this session: instant too
    expect(server.calls.filter((c) => c === `GET /diagrams/${id}`)).toHaveLength(1) // just the quiet check, no load
    expect(useAuth.getState().loading).toBeNull()

    await useAuth.getState().logout()
    await signIn() // a fresh sign-in must load from the server again
    server.calls = []
    await useAuth.getState().openDiagram('b')
    expect(server.calls).toContain('GET /diagrams/b')
    await settle()
  })
})

describe('loading indicators', () => {
  it('say what the server is doing while it does it, and clear afterwards', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn() // b open
    expect(useAuth.getState().loading).toBeNull()

    const opening = useAuth.getState().openDiagram('a')
    expect(useAuth.getState().loading).toEqual({ kind: 'open', id: 'a' }) // set synchronously: no frozen-looking gap
    await opening
    expect(useAuth.getState().loading).toBeNull()

    const creating = useAuth.getState().createDiagram()
    expect(useAuth.getState().loading).toEqual({ kind: 'create' })
    await creating
    expect(useAuth.getState().loading).toBeNull()

    const deleting = useAuth.getState().deleteDiagram('b')
    expect(useAuth.getState().loading).toEqual({ kind: 'delete', id: 'b' })
    await deleting
    expect(useAuth.getState().loading).toBeNull()
  })

  it('also clear when the request fails, so the app never stays stuck on a spinner', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn() // b open
    server.failNext.add('GET /diagrams/a')
    await useAuth.getState().openDiagram('a')
    expect(useAuth.getState().loading).toBeNull()
    expect(useAuth.getState().switching).toBe(false)
    expect(useAuth.getState().ready).toBe(true)

    server.failNext.add('POST /diagrams')
    expect(await useAuth.getState().createDiagram()).toBeNull()
    expect(useAuth.getState().loading).toBeNull()

    server.failNext.add('DELETE /diagrams/a')
    await useAuth.getState().deleteDiagram('a')
    expect(useAuth.getState().loading).toBeNull()
    expect(useAuth.getState().diagrams.some((d) => d.id === 'a')).toBe(true) // still there: the delete failed
  })
})

describe('multiple ERDs', () => {
  it('turns what is on the canvas into "My first ERD" for an account with none', async () => {
    const before = names()
    await signIn()
    const s = useAuth.getState()
    expect(s.diagrams.map((d) => d.title)).toEqual(['My first ERD'])
    expect(s.currentId).toBe(s.diagrams[0].id)
    expect(s.ready).toBe(true)
    expect(server.rows.get(s.currentId!)!.data.nodes.map((n) => n.data.name)).toEqual(before)
  })

  it('opens the most recently edited ERD after login', async () => {
    seed('a', 'Old', 'old_table')
    seed('b', 'Newest', 'new_table') // stamped later
    await signIn()
    expect(useAuth.getState().currentId).toBe('b')
    expect(names()).toEqual(['new_table'])
  })

  it('saves pending edits to the ERD being left, before the other one loads', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn() // opens b (newest)
    await useAuth.getState().openDiagram('a')
    rename('edited_a')
    await useAuth.getState().openDiagram('b') // must save edited_a to a, not onto b

    expect(server.rows.get('a')!.data.nodes[0].data.name).toBe('edited_a')
    expect(server.rows.get('b')!.data.nodes[0].data.name).toBe('table_b')
    expect(names()).toEqual(['table_b'])
    const calls = server.calls.join(' | ')
    expect(calls.indexOf('PUT /diagrams/a')).toBeLessThan(calls.lastIndexOf('GET /diagrams/b'))
  })

  it('does not switch (and so does not lose edits) when saving fails', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn() // b is open
    rename('unsaved')
    server.failNext.add('PUT /diagrams/b')
    await useAuth.getState().openDiagram('a')
    expect(useAuth.getState().currentId).toBe('b')
    expect(names()).toEqual(['unsaved'])
    expect(useAuth.getState().switching).toBe(false)
  })

  it('stays on the current ERD when the other one cannot be loaded', async () => {
    seed('a', 'A', 'table_a')
    await signIn()
    useAuth.setState({ diagrams: [...useAuth.getState().diagrams, { id: 'nope', title: 'Gone', updatedAt: '' }] })
    await useAuth.getState().openDiagram('nope')
    expect(useAuth.getState().currentId).toBe('a')
    expect(useAuth.getState().ready).toBe(true)
    expect(names()).toEqual(['table_a'])
  })

  it('creates a blank ERD, opens it, and keeps the previous one saved', async () => {
    seed('a', 'A', 'table_a')
    await signIn()
    rename('changed')
    const id = await useAuth.getState().createDiagram()
    expect(id).toBeTruthy()
    expect(useAuth.getState().currentId).toBe(id)
    expect(names()).toEqual([])
    expect(server.rows.get('a')!.data.nodes[0].data.name).toBe('changed')
    expect(useAuth.getState().diagrams.map((d) => d.title)).toEqual(['A', 'Untitled diagram'])
  })

  it('ignores a second switch while one is in progress', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn()
    await Promise.all([useAuth.getState().openDiagram('a'), useAuth.getState().openDiagram('a')])
    expect(server.calls.filter((c) => c === 'GET /diagrams/a')).toHaveLength(1)
  })

  it('renames right away and rolls back if the server refuses', async () => {
    seed('a', 'A', 'table_a')
    await signIn()
    const p = useAuth.getState().renameDiagram('a', '  Shop  ')
    expect(useAuth.getState().diagrams[0].title).toBe('Shop') // optimistic
    await p
    expect(server.rows.get('a')!.title).toBe('Shop')

    server.failNext.add('PUT /diagrams/a')
    await useAuth.getState().renameDiagram('a', 'Broken')
    expect(useAuth.getState().diagrams[0].title).toBe('Shop')
    await useAuth.getState().renameDiagram('a', '   ') // blank titles are ignored
    expect(useAuth.getState().diagrams[0].title).toBe('Shop')
  })

  it('deleting the open ERD opens another; deleting the last one starts a blank one', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn() // b open
    await useAuth.getState().deleteDiagram('b')
    expect(useAuth.getState().currentId).toBe('a')
    expect(names()).toEqual(['table_a'])
    expect(server.rows.has('b')).toBe(false)

    await useAuth.getState().deleteDiagram('a')
    const s = useAuth.getState()
    expect(s.diagrams).toHaveLength(1)
    expect(s.diagrams[0].title).toBe('Untitled diagram')
    expect(s.currentId).toBe(s.diagrams[0].id)
    expect(names()).toEqual([])
  })

  it('deleting a different ERD leaves the open one untouched', async () => {
    seed('a', 'A', 'table_a')
    seed('b', 'B', 'table_b')
    await signIn() // b open
    rename('mine')
    await useAuth.getState().deleteDiagram('a')
    expect(useAuth.getState().currentId).toBe('b')
    expect(names()).toEqual(['mine'])
  })

  it('never saves onto a deleted ERD', async () => {
    seed('a', 'A', 'table_a')
    await signIn()
    server.calls = []
    await useAuth.getState().deleteDiagram('a') // last one: replaced by a fresh blank
    rename('after')
    await useAuth.getState().saveNow()
    expect(server.calls.some((c) => c === 'PUT /diagrams/a')).toBe(false)
  })

  it('logout clears the list and the canvas', async () => {
    seed('a', 'A', 'table_a')
    await signIn()
    await useAuth.getState().logout()
    expect(useAuth.getState().diagrams).toEqual([])
    expect(useAuth.getState().currentId).toBeNull()
    expect(snapshotNames()).not.toContain('table_a')
  })
})

const snapshotNames = () => toWorkspace(useStore.getState()).nodes.map((n) => n.data.name)

describe('Free plan limit', () => {
  it('uses the plan the server reports (and shows it in the store)', async () => {
    server.plan = planWith(1)
    await signIn()
    expect(useAuth.getState().plan).toMatchObject({ name: 'Free', maxDiagrams: 1 })
  })

  it('at the limit, a second diagram is not asked for: the upgrade note is shown instead and nothing changes', async () => {
    server.plan = planWith(1)
    await signIn() // the account gets its first diagram
    const before = useAuth.getState()
    server.calls = []

    expect(await useAuth.getState().createDiagram()).toBeNull()
    expect(showProblem).toHaveBeenCalledWith(planLimitProblem(1), 'warning')
    expect(server.calls).toEqual([]) // no request, no spinner, no save
    expect(useAuth.getState().diagrams).toEqual(before.diagrams)
    expect(useAuth.getState().currentId).toBe(before.currentId)
    expect(useAuth.getState().loading).toBeNull()
  })

  it('shows the same note when the server is the one that refuses (e.g. the plan changed in another tab)', async () => {
    server.plan = planWith(1)
    await signIn()
    useAuth.setState({ plan: planWith(5) }) // this tab still believes the old, bigger limit
    expect(await useAuth.getState().createDiagram()).toBeNull()
    expect(server.calls).toContain('POST /diagrams') // it did ask ...
    expect(showProblem).toHaveBeenCalledWith(planLimitProblem(5), 'warning') // ... and explained when told no
    expect(useAuth.getState().diagrams).toHaveLength(1)
    expect(useAuth.getState().loading).toBeNull() // and is not left spinning
  })

  it('still creates diagrams while there is room', async () => {
    server.plan = planWith(2)
    await signIn()
    expect(await useAuth.getState().createDiagram()).not.toBeNull()
    expect(useAuth.getState().diagrams).toHaveLength(2)
    expect(await useAuth.getState().createDiagram()).toBeNull() // the third is over the limit of 2
    expect(showProblem).toHaveBeenLastCalledWith(planLimitProblem(2), 'warning')
  })
})
