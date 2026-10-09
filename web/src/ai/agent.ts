import { create } from 'zustand'
import type { ChatMessage, ChatToolCall } from '../../../shared/aiToolSpecs'
import { ApiError } from '../auth/api'
import { useAuth } from '../auth/store'
import { toWorkspace, useStore, type Workspace } from '../store'
import { fetchModels, streamChat, type ModelOption, type ModelsResponse } from './api'
import { runTool, type Canvas } from './executor'
import { canvasSnapshot } from './snapshot'

/**
 * The assistant's conversation and its loop. The server answers ONE model call at a time (stateless, so it fits a
 * serverless function); this loop is what turns a request into work: it sends the conversation and the canvas, runs the
 * tool calls the model makes on the real canvas, sends the results back, and repeats until the model just answers.
 */

/** Model calls in a row for one message. The server enforces the same cap. */
const MAX_ROUNDS = 10
/** Rounds in a row where every tool call failed before the assistant gives up and says so. */
const MAX_FAILED_ROUNDS = 3
const MODEL_KEY = 'erd-ai-model'

export type ToolChip = { id: string; name: string; ok: boolean; summary: string }
export type UiMessage = {
  id: string
  role: 'user' | 'assistant' | 'error'
  text: string
  tools?: ToolChip[]
  /** The model that answered. */
  model?: string
  /** E.g. "X was unavailable, so Y answered". */
  notice?: string
  streaming?: boolean
  /** An error with a way forward: where to send the person. */
  action?: 'plans' | 'login'
}

type Undo = { workspace: Workspace; diagramId: string | null; changes: number }

type AiState = {
  /** The person undid the assistant's last change: the next message tells the model so (it still remembers making it). */
  undone: boolean
  /** Unknown until the first load. */
  enabled: boolean | null
  models: ModelOption[]
  locked: ModelOption[]
  quota: { used: number; limit: number } | null
  modelId: string | null
  loadingModels: boolean
  messages: UiMessage[]
  busy: boolean
  undo: Undo | null
  /** Counts canvas changes by the assistant, so the panel can fit the view to them. */
  changeTick: number
  /** True while the assistant itself switches to a new diagram (the conversation must survive that). */
  switching: boolean
  loadModels: () => Promise<void>
  selectModel: (id: string) => void
  send: (text: string) => Promise<void>
  stop: () => void
  newChat: () => void
  undoLast: () => void
}

const readSavedModel = () => {
  try {
    return localStorage.getItem(MODEL_KEY)
  } catch {
    return null
  }
}
const saveModel = (id: string) => {
  try {
    localStorage.setItem(MODEL_KEY, id)
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

class SwitchedAway extends Error {}

let abort: AbortController | null = null
/** What the server sees: every message, with the tool calls and their results. Kept outside the state: it is not for display. */
let wire: ChatMessage[] = []
let counter = 0
const newId = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`

export const useAi = create<AiState>()((set, get) => {
  const patchLast = (patch: (m: UiMessage) => UiMessage) =>
    set((s) => ({ messages: s.messages.map((m, i) => (i === s.messages.length - 1 ? patch(m) : m)) }))
  const addError = (text: string, action?: UiMessage['action']) =>
    set((s) => ({ messages: [...s.messages.filter((m) => !m.streaming || m.text || m.tools?.length), { id: newId(), role: 'error', text, action }] }))
  const canvasNow = (): Canvas => {
    const s = useStore.getState()
    return { provider: s.provider, nodes: s.nodes, manyToMany: s.manyToMany }
  }
  const snapshotNow = () => {
    const s = useStore.getState()
    const a = useAuth.getState()
    const title = a.diagrams.find((d) => d.id === a.currentId)?.title
    return canvasSnapshot(s.provider, s.nodes.map((n) => n.data), s.tablePlan.max, title)
  }

  /** The tool calls of one model answer, run in order on the live canvas. Returns whether any of them worked. */
  async function runCalls(calls: ChatToolCall[], chips: ToolChip[], undoCount: { n: number }, turn: { diagramId: string | null }): Promise<boolean> {
    let anyOk = false
    for (const call of calls) {
      // The person opened another diagram while the model was answering: its changes must not land on that one.
      if (useAuth.getState().currentId !== turn.diagramId) throw new SwitchedAway()
      const before = canvasNow()
      const outcome = runTool(before, call.name, call.arguments, { maxTables: useStore.getState().tablePlan.max, uid: () => crypto.randomUUID() })
      let { ok, message, summary } = outcome
      if (ok && outcome.canvas !== before) {
        useStore.getState().applyAiCanvas(outcome.canvas)
        undoCount.n++
        set((s) => ({ changeTick: s.changeTick + 1 }))
      }
      if (ok && outcome.effect?.type === 'create_diagram') {
        const auth = useAuth.getState()
        set({ switching: true })
        try {
          const id = auth.status === 'authed' ? await auth.createDiagram() : null
          if (id) {
            await useAuth.getState().renameDiagram(id, outcome.effect.title)
            turn.diagramId = id
            message = `Created a new empty diagram "${outcome.effect.title}" and opened it. The canvas is empty now; continue with create_tables.`
            // The old canvas is another diagram now: undo of this turn would restore the wrong one.
            set({ undo: null })
          } else {
            ok = false
            summary = 'Could not create a new diagram'
            message = 'A new diagram could not be created (the plan\'s diagram limit may be reached). Tell the person, and edit the current canvas instead if that helps.'
          }
        } finally {
          set({ switching: false })
        }
      }
      anyOk ||= ok
      chips.push({ id: call.id, name: call.name, ok, summary })
      patchLast((m) => ({ ...m, tools: [...chips] }))
      wire.push({ role: 'tool', toolCallId: call.id, name: call.name, content: message })
    }
    return anyOk
  }

  return {
    enabled: null,
    models: [],
    locked: [],
    quota: null,
    modelId: null,
    loadingModels: false,
    messages: [],
    busy: false,
    undo: null,
    changeTick: 0,
    switching: false,
    undone: false,

    loadModels: async () => {
      if (get().loadingModels) return
      set({ loadingModels: true })
      try {
        const r: ModelsResponse = await fetchModels()
        const saved = get().modelId ?? readSavedModel()
        const modelId = r.models.find((m) => m.id === saved)?.id ?? r.defaultModel ?? r.models[0]?.id ?? null
        set({ enabled: r.enabled, models: r.models, locked: r.locked, quota: r.quota, modelId })
      } catch {
        // Not signed in, or the server is unreachable: the panel says so; nothing else is affected.
        set({ enabled: null })
      } finally {
        set({ loadingModels: false })
      }
    },

    selectModel: (id) => {
      if (!get().models.some((m) => m.id === id)) return
      saveModel(id)
      set({ modelId: id })
    },

    stop: () => abort?.abort(),

    newChat: () => {
      abort?.abort()
      wire = []
      set({ messages: [], undo: null, busy: false })
    },

    undoLast: () => {
      const { undo } = get()
      if (!undo) return
      if (useAuth.getState().currentId !== undo.diagramId) {
        set({ undo: null })
        return
      }
      useStore.getState().loadWorkspace(undo.workspace)
      set((s) => ({ undo: null, undone: true, changeTick: s.changeTick + 1 }))
    },

    send: async (raw) => {
      const text = raw.trim()
      if (!text || get().busy) return
      const auth = useAuth.getState()
      if (auth.status !== 'authed') {
        addError('Log in to use the AI assistant.', 'login')
        return
      }
      abort = new AbortController()
      const { signal } = abort
      const before: Undo = { workspace: toWorkspace(useStore.getState()), diagramId: auth.currentId, changes: 0 }
      set((s) => ({
        busy: true,
        undo: null,
        messages: [...s.messages, { id: newId(), role: 'user', text }, { id: newId(), role: 'assistant', text: '', tools: [], streaming: true }],
      }))
      wire.push({ role: 'user', content: get().undone ? `(The person undid your last changes to the canvas.)\n${text}` : text })
      set({ undone: false })
      const chips: ToolChip[] = []
      const undoCount = { n: 0 }
      let failedRounds = 0
      const turn = { diagramId: auth.currentId }

      try {
        for (let round = 0; ; round++) {
          if (round >= MAX_ROUNDS) {
            patchLast((m) => ({ ...m, notice: 'Stopped after many steps in a row. Send a message to continue.' }))
            break
          }
          let roundText = ''
          const calls: ChatToolCall[] = []
          for await (const ev of streamChat({ model: get().modelId ?? undefined, canvas: snapshotNow(), messages: wire }, signal)) {
            if (ev.type === 'model') {
              patchLast((m) => ({ ...m, model: ev.label, ...(ev.fellBackFrom ? { notice: `${ev.fellBackFrom} was unavailable, so ${ev.label} answered.` } : {}) }))
            } else if (ev.type === 'text') {
              if (!roundText) patchLast((m) => (m.text && !m.text.endsWith('\n\n') ? { ...m, text: m.text + '\n\n' } : m))
              roundText += ev.delta
              patchLast((m) => ({ ...m, text: m.text + ev.delta }))
            } else if (ev.type === 'tool_call') {
              calls.push({ id: ev.id, name: ev.name, arguments: ev.arguments })
            } else if (ev.type === 'error') {
              throw new ApiError(ev.message, 502, undefined, undefined, ev.code)
            }
          }
          wire.push({ role: 'assistant', content: roundText, ...(calls.length ? { toolCalls: calls } : {}) })
          if (!calls.length) break
          const anyOk = await runCalls(calls, chips, undoCount, turn)
          failedRounds = anyOk ? 0 : failedRounds + 1
          if (failedRounds >= MAX_FAILED_ROUNDS) {
            patchLast((m) => ({ ...m, notice: 'I could not make that change. Try describing it differently, or pick another model.' }))
            // The conversation must end on something a provider accepts: the last tool results get one plain answer.
            wire.push({ role: 'assistant', content: 'I could not complete that change.' })
            break
          }
        }
      } catch (e) {
        if (e instanceof SwitchedAway) {
          patchLast((m) => ({ ...m, notice: 'Stopped: you opened another diagram.' }))
          while (wire.length && wire[wire.length - 1].role !== 'user') wire.pop() // drop the unfinished round
        } else if (signal.aborted) {
          patchLast((m) => ({ ...m, notice: 'Stopped.' }))
          // Never leave a tool call without its result: no provider accepts that.
          const last = wire[wire.length - 1]
          if (last?.role === 'assistant' && last.toolCalls?.length) wire.pop()
        } else {
          const err = e instanceof ApiError ? e : new ApiError('The AI assistant ran into a problem. Please try again.', 0)
          // A failed call leaves the conversation as it was before this call.
          while (wire.length && wire[wire.length - 1].role === 'tool') wire.pop()
          if (wire[wire.length - 1]?.role === 'assistant') wire.pop()
          addError(err.message, err.status === 401 ? 'login' : err.code === 'daily_limit' ? 'plans' : undefined)
        }
      } finally {
        patchLast((m) => (m.role === 'assistant' ? { ...m, streaming: false } : m))
        abort = null
        set({ busy: false, undo: undoCount.n > 0 && get().undo === null && !get().switching && useAuth.getState().currentId === before.diagramId ? { ...before, changes: undoCount.n } : get().undo })
        void get().loadModels()
      }
    },
  }
})
