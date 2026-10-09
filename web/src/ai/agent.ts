import { create } from 'zustand'
import type { ChatMessage, ChatToolCall, FocusSnapshot, RefineRequest, RefineTool } from '../../../shared/aiToolSpecs'
import { ApiError } from '../auth/api'
import { useAuth } from '../auth/store'
import type { Provider } from '../core/model'
import { toWorkspace, useStore, type Workspace } from '../store'
import { fetchModels, streamChat, type ModelOption, type ModelsResponse } from './api'
import { runTool, unpredictableIds, type Canvas } from './executor'
import { pickedItems } from './focus'
import { generateCode, prepareRefine, toolInfo, DB_LABEL } from './refine'
import { layoutReport } from './layoutReport'
import { canvasSnapshot } from './snapshot'

/**
 * The assistant's conversation and its loop. The server answers ONE model call at a time (stateless, so it fits a
 * serverless function); this loop is what turns a request into work: it sends the conversation and the canvas, runs the
 * tool calls the model makes on the real canvas, sends the results back, and repeats until the model just answers.
 * After it changed the canvas it also lets the model LOOK at the result (a screenshot, plus a layout report) and fix
 * what is wrong, before the person sees the final answer.
 */

/** Model calls in a row for one message (checking its own work included). The server enforces a cap too. */
const MAX_ROUNDS = 14
/** Rounds in a row where every tool call failed before the assistant gives up and says so. */
const MAX_FAILED_ROUNDS = 3
/** How many times the model may look at the canvas and correct it, for one message. */
const MAX_CHECKS = 2
const MODEL_KEY = 'erd-ai-model'

export type ToolChip = { id: string; name: string; ok: boolean; summary: string }
/** One look at the canvas the assistant took after changing it. */
export type CheckChip = { id: string; status: 'checking' | 'ok' | 'fixing'; image?: string; note: string }
export type UiMessage = {
  id: string
  role: 'user' | 'assistant' | 'error'
  text: string
  tools?: ToolChip[]
  checks?: CheckChip[]
  /** The model that answered. */
  model?: string
  /** E.g. "X was unavailable, so Y answered". */
  notice?: string
  streaming?: boolean
  /** An error with a way forward: where to send the person. */
  action?: 'plans' | 'login'
  /** What the person had picked when they asked (shown as chips on their message). */
  about?: string[]
  /** A "Refine for production" request: shown as a label instead of the long message that carries the schema. */
  refine?: string
  /** What a refine ended with: the schema as the chosen tool's code, ready to copy. */
  refinedCode?: { tool: RefineTool; file: string; fence: string; code: string }
}

type Undo = { workspace: Workspace; diagramId: string | null; changes: number }

export type SendOptions = {
  refine?: RefineRequest
  /** Work to do on the canvas first (inside the same undo), returning the message to send. */
  prepare?: () => { text: string; changes: number }
  /** What to show as the person's message when it is not the text itself (the refine request carries a whole schema). */
  display?: string
}

type AiState = {
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
  /** The person undid the assistant's last change: the next message tells the model so (it still remembers making it). */
  undone: boolean
  /** Counts canvas changes by the assistant, so the panel can fit the view to them. */
  changeTick: number
  /** True while the assistant itself switches to a new diagram (the conversation must survive that). */
  switching: boolean
  loadModels: () => Promise<void>
  selectModel: (id: string) => void
  send: (text: string, options?: SendOptions) => Promise<void>
  /** "Refine for production" for one tool and database: ids made unguessable by the app, the rest by the model, ending with the code. */
  refine: (tool: RefineTool, database: Provider) => Promise<void>
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

/** Draws the canvas; set by the panel, which is inside the React Flow provider. Resolves to null when it cannot. */
let capture: (() => Promise<string | null>) | null = null
export const setCanvasCapture = (fn: (() => Promise<string | null>) | null) => {
  capture = fn
}

/** Only the newest screenshot is kept in the conversation: each one costs thousands of tokens and the old ones are stale. */
const withLatestImageOnly = (messages: ChatMessage[]): ChatMessage[] => {
  let last = -1
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.images?.length) last = i
  })
  return messages.map((m, i) => (m.role === 'user' && m.images && i !== last ? { role: 'user' as const, content: m.content } : m))
}

const isOk = (text: string) => /^\s*ok[.!]?\s*$/i.test(text)

const VERIFY_PROMPT = (hasImage: boolean, report: string) =>
  `(Automatic check, not a message from the person.) You just changed the canvas. ${hasImage ? 'The attached picture is the canvas as the person sees it now. ' : ''}Layout report:\n${report}\n\n` +
  'Check that every table and relation you meant to make is there and correct, nothing overlaps, no relation line runs behind a table, and it looks tidy and readable. ' +
  'If something is wrong, fix it with the tools. If everything is fine, reply with exactly: OK'

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
  const patchCheck = (id: string, patch: Partial<CheckChip>) =>
    patchLast((m) => ({ ...m, checks: (m.checks ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)) }))

  /** The tool calls of one model answer, run in order on the live canvas. Returns whether any of them worked. */
  async function runCalls(calls: ChatToolCall[], chips: ToolChip[], turn: { diagramId: string | null; changes: number }): Promise<boolean> {
    let anyOk = false
    for (const call of calls) {
      // The person opened another diagram while the model was answering: its changes must not land on that one.
      if (useAuth.getState().currentId !== turn.diagramId) throw new SwitchedAway()
      const before = canvasNow()
      const outcome = runTool(before, call.name, call.arguments, { maxTables: useStore.getState().tablePlan.max, uid: () => crypto.randomUUID() })
      let { ok, message, summary } = outcome
      if (ok && outcome.canvas !== before) {
        useStore.getState().applyAiCanvas(outcome.canvas)
        turn.changes++
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
            message = "A new diagram could not be created (the plan's diagram limit may be reached). Tell the person, and edit the current canvas instead if that helps."
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

  /**
   * The last word of a refine is the app's, not the model's: any integer id the model left (or added) is made unguessable,
   * and the result is shown as the code of the tool it was refined for.
   */
  function finishRefine(refine: RefineRequest, turn: { changes: number }) {
    const state = useStore.getState()
    const ids = unpredictableIds({ provider: state.provider, nodes: state.nodes, manyToMany: state.manyToMany })
    if (ids.changed.length) {
      useStore.getState().applyAiCanvas(ids.canvas)
      turn.changes++
      set((s) => ({ changeTick: s.changeTick + 1 }))
      patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), { id: newId(), name: 'use_unpredictable_ids', ok: true, summary: `Ids are now unguessable in ${ids.changed.length} more table${ids.changed.length === 1 ? '' : 's'}: ${ids.changed.join(', ')}` }] }))
    }
    const info = toolInfo(refine.tool)
    const code = generateCode(refine.tool, useStore.getState())
    patchLast((m) => ({ ...m, refinedCode: { tool: refine.tool, file: info.file, fence: info.fence, code } }))
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
    undone: false,
    changeTick: 0,
    switching: false,

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

    refine: (tool, database) =>
      get().send('Refine for production', {
        refine: { tool, database },
        display: `Refine for production \u00b7 ${toolInfo(tool).label} \u00b7 ${DB_LABEL[database]}`,
        prepare: () => prepareRefine(tool, database),
      }),

    send: async (raw, options = {}) => {
      let text = raw.trim()
      if ((!text && !options.prepare) || get().busy) return
      const auth = useAuth.getState()
      if (auth.status !== 'authed') {
        addError('Log in to use the AI assistant.', 'login')
        return
      }
      abort = new AbortController()
      const { signal } = abort
      const before: Undo = { workspace: toWorkspace(useStore.getState()), diagramId: auth.currentId, changes: 0 }
      const turn = { diagramId: auth.currentId, changes: 0 }
      if (options.prepare) {
        const prepared = options.prepare()
        text = prepared.text
        turn.changes += prepared.changes
        if (prepared.changes) set((s) => ({ changeTick: s.changeTick + 1 }))
      }
      // What is picked on the canvas right now is what this question is about; it stays the same for every round of it.
      // (A refine is about the whole schema, whatever happens to be picked.)
      const picked = options.refine ? { items: [], snapshot: { tables: [], columns: [], relations: [], manyToMany: [] } } : pickedItems(useStore.getState())
      const focus: FocusSnapshot | undefined = picked.items.length ? picked.snapshot : undefined
      const about = picked.items.map((i) => `${i.kind === 'many-to-many' ? 'link' : i.kind} ${i.label}`)
      const modelInfo = get().models.find((m) => m.id === get().modelId)
      const canSee = modelInfo?.vision === true

      set((s) => ({
        busy: true,
        undo: null,
        messages: [
          ...s.messages,
          { id: newId(), role: 'user', text: options.display ?? text, ...(about.length ? { about } : {}), ...(options.refine ? { refine: options.display ?? 'Refine for production' } : {}) },
          { id: newId(), role: 'assistant', text: '', tools: [], checks: [], streaming: true },
        ],
      }))
      const prefix = about.length ? `[Picked on the canvas: ${about.join('; ')}]\n` : ''
      wire.push({ role: 'user', content: `${get().undone ? '(The person undid your last changes to the canvas.)\n' : ''}${prefix}${text}` })
      set({ undone: false })
      const chips: ToolChip[] = []
      let failedRounds = 0
      let checks = 0
      let changedSinceCheck = false
      let checkingId: string | null = null

      try {
        for (let round = 0; ; round++) {
          if (round >= MAX_ROUNDS) {
            patchLast((m) => ({ ...m, notice: 'Stopped after many steps in a row. Send a message to continue.' }))
            break
          }
          const verifying = checkingId !== null
          let roundText = ''
          const calls: ChatToolCall[] = []
          const body = { model: get().modelId ?? undefined, canvas: snapshotNow(), messages: withLatestImageOnly(wire), focus, refine: options.refine }
          for await (const ev of streamChat(body, signal)) {
            if (ev.type === 'model') {
              patchLast((m) => ({ ...m, model: ev.label, ...(ev.fellBackFrom ? { notice: `${ev.fellBackFrom} was unavailable, so ${ev.label} answered.` } : {}) }))
            } else if (ev.type === 'text') {
              roundText += ev.delta
              // The word OK after a check is not an answer: it is shown only if the model says more than that.
              if (!verifying) {
                if (roundText === ev.delta) patchLast((m) => (m.text && !m.text.endsWith('\n\n') ? { ...m, text: m.text + '\n\n' } : m))
                patchLast((m) => ({ ...m, text: m.text + ev.delta }))
              }
            } else if (ev.type === 'tool_call') {
              calls.push({ id: ev.id, name: ev.name, arguments: ev.arguments })
            } else if (ev.type === 'error') {
              throw new ApiError(ev.message, 502, undefined, undefined, ev.code)
            }
          }
          wire.push({ role: 'assistant', content: roundText, ...(calls.length ? { toolCalls: calls } : {}) })

          if (verifying) {
            const id = checkingId!
            if (!calls.length && isOk(roundText)) {
              patchCheck(id, { status: 'ok', note: 'Looks right' })
              checkingId = null
              break
            }
            if (!calls.length) {
              // The model says what is wrong (or something else) in words: that is worth showing.
              patchLast((m) => ({ ...m, text: m.text ? `${m.text}\n\n${roundText}` : roundText }))
              patchCheck(id, { status: 'ok', note: 'Checked' })
              checkingId = null
              break
            }
            patchCheck(id, { status: 'fixing', note: 'Found something to fix' })
            checkingId = null
          }

          if (!calls.length) {
            // The model is done. If it changed the canvas, it now looks at the result before the person is told it is finished.
            if (!changedSinceCheck || checks >= MAX_CHECKS) break
            const report = layoutReport(canvasNow())
            let image: string | null = null
            if (canSee && capture) image = await capture().catch(() => null)
            // A model that cannot see, and a layout with nothing wrong in it: there is nothing left to check.
            if (!image && !report.problems.length) break
            checks++
            changedSinceCheck = false
            const id = newId()
            checkingId = id
            patchLast((m) => ({ ...m, checks: [...(m.checks ?? []), { id, status: 'checking', image: image ?? undefined, note: 'Checking the result' }] }))
            wire.push({ role: 'user', content: VERIFY_PROMPT(Boolean(image), report.text), ...(image ? { images: [image] } : {}) })
            continue
          }

          const turnChangesBefore = turn.changes
          const anyOk = await runCalls(calls, chips, turn)
          if (turn.changes > turnChangesBefore) changedSinceCheck = true
          failedRounds = anyOk ? 0 : failedRounds + 1
          if (failedRounds >= MAX_FAILED_ROUNDS) {
            patchLast((m) => ({ ...m, notice: 'I could not make that change. Try describing it differently, or pick another model.' }))
            // The conversation must end on something a provider accepts: the last tool results get one plain answer.
            wire.push({ role: 'assistant', content: 'I could not complete that change.' })
            break
          }
        }
        if (options.refine) finishRefine(options.refine, turn)
      } catch (e) {
        if (e instanceof SwitchedAway) {
          patchLast((m) => ({ ...m, notice: 'Stopped: you opened another diagram.' }))
          while (wire.length && wire[wire.length - 1].role !== 'user') wire.pop() // drop the unfinished round
        } else if (signal.aborted) {
          patchLast((m) => ({ ...m, notice: 'Stopped.' }))
          if (checkingId) wire.pop() // the automatic "check your work" message: it was not answered
          // Never leave a tool call without its result: no provider accepts that.
          const last = wire[wire.length - 1]
          if (last?.role === 'assistant' && last.toolCalls?.length) wire.pop()
        } else {
          const err = e instanceof ApiError ? e : new ApiError('The AI assistant ran into a problem. Please try again.', 0)
          // A failed call leaves the conversation as it was before this call.
          if (checkingId) wire.pop()
          while (wire.length && wire[wire.length - 1].role === 'tool') wire.pop()
          if (wire[wire.length - 1]?.role === 'assistant') wire.pop()
          addError(err.message, err.status === 401 ? 'login' : err.code === 'daily_limit' ? 'plans' : undefined)
        }
      } finally {
        // A check that was cut short must not stay "checking" for ever.
        patchLast((m) => (m.role === 'assistant' ? { ...m, streaming: false, checks: (m.checks ?? []).map((c) => (c.status === 'checking' ? { ...c, status: 'ok' as const, note: 'Check interrupted' } : c)) } : m))
        abort = null
        set({ busy: false, undo: turn.changes > 0 && get().undo === null && !get().switching && useAuth.getState().currentId === before.diagramId ? { ...before, changes: turn.changes } : get().undo })
        void get().loadModels()
      }
    },
  }
})
