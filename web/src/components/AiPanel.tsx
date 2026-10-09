import { useReactFlow } from '@xyflow/react'
import { AlertTriangle, ArrowUp, Check, Eye, Lock, Plus, Sparkles, Square, Undo2, Wand2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { RefineTool } from '../../../shared/aiToolSpecs'
import { setCanvasCapture, useAi, type CheckChip, type UiMessage } from '../ai/agent'
import { pickedItems, suggestionsFor, type FocusItem } from '../ai/focus'
import { DB_LABEL, REFINE_TOOLS } from '../ai/refine'
import { captureCanvas } from '../ai/screenshot'
import { useAuth } from '../auth/store'
import { PROVIDERS, type Provider } from '../core/model'
import { navigate } from '../lib/route'
import { useStore } from '../store'
import { DbIcon } from './DbIcon'
import { RichText } from './RichText'
import { Select } from './Select'

const MAX_INPUT = 40_000
/** More picked things than this are shown as "+N more" (the question is still about all of them). */
const MAX_CHIPS = 6

const STARTERS_EMPTY = [
  'Design a database for an online store with customers, products, orders and payments',
  'Model a booking app for salons: staff, services, clients and appointments',
  'I will paste a SQL schema: draw it for me',
]
const STARTERS_FILLED = [
  'Explain how these tables relate to each other',
  'Review this schema for problems and missing indexes or constraints',
  'Add created_at and updated_at timestamps to every table that lacks them',
  'Arrange the tables so the relation lines are easy to follow',
]

/** The assistant's chat: lives in the side panel, next to the canvas it reads and edits. */
export function AiPanel() {
  const toggleAi = useStore((s) => s.toggleAi)
  const tableCount = useStore((s) => s.nodes.length)
  const nodes = useStore((s) => s.nodes)
  const manyToMany = useStore((s) => s.manyToMany)
  const selectedColumn = useStore((s) => s.selectedColumn)
  const selectedEdgeId = useStore((s) => s.selectedEdgeId)
  const status = useAuth((s) => s.status)
  const currentId = useAuth((s) => s.currentId)
  const ai = useAi()
  const flow = useReactFlow()
  const [draft, setDraft] = useState('')
  const [refineOpen, setRefineOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const authed = status === 'authed'
  const picked = useMemo(() => pickedItems({ nodes, manyToMany, selectedColumn, selectedEdgeId }), [nodes, manyToMany, selectedColumn, selectedEdgeId])

  useEffect(() => {
    if (authed) void useAi.getState().loadModels()
  }, [authed])

  // Lets the assistant look at the canvas after it changed it (it is drawn from here because this is inside React Flow).
  useEffect(() => {
    setCanvasCapture(() => captureCanvas(flow))
    return () => setCanvasCapture(null)
  }, [flow])

  // Another diagram opened by the person: the conversation was about the old one. (The assistant's own switch keeps it.)
  const lastDiagram = useRef(currentId)
  useEffect(() => {
    if (lastDiagram.current !== currentId && !useAi.getState().switching) useAi.getState().newChat()
    lastDiagram.current = currentId
  }, [currentId])

  // After the assistant changed the canvas, bring the result into view once the new tables have been measured.
  useEffect(() => {
    if (!ai.changeTick) return
    const t = setTimeout(() => void flow.fitView({ duration: 500, padding: 0.15 }), 200)
    return () => clearTimeout(t)
  }, [ai.changeTick, flow])

  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [ai.messages])

  // "Ask AI about this" opened the panel on purpose: the cursor goes to the message box.
  const askedFor = useRef(picked.items.map((i) => i.key).join('|'))
  useEffect(() => {
    const key = picked.items.map((i) => i.key).join('|')
    if (key !== askedFor.current && key) inputRef.current?.focus({ preventScroll: true })
    askedFor.current = key
  }, [picked.items])

  const submit = (text = draft) => {
    if (!text.trim() || ai.busy) return
    setDraft('')
    stick.current = true
    void ai.send(text)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  /** A chip's X: stop asking about that one (it is un-picked on the canvas too, so the two never disagree). */
  const drop = (item: FocusItem) => {
    const s = useStore.getState()
    if (item.kind === 'table') {
      const id = item.key.slice('table:'.length)
      useStore.setState({ nodes: s.nodes.map((n) => (id === 'more' || n.id === id ? { ...n, selected: false } : n)) })
    } else if (item.kind === 'column') s.setSelectedColumn(null)
    else s.selectEdge(null)
  }

  const clearPicks = () => {
    const s = useStore.getState()
    useStore.setState({ nodes: s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)) })
    s.setSelectedColumn(null)
    s.selectEdge(null)
  }

  const left = ai.quota ? Math.max(ai.quota.limit - ai.quota.used, 0) : null
  const btn = 'grid size-7 cursor-pointer place-items-center rounded-sm border border-line text-muted hover:border-key hover:text-key'
  const suggestions = suggestionsFor(picked.items)
  const sees = ai.models.find((m) => m.id === ai.modelId)?.vision === true

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="AI assistant">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Sparkles size={16} className="text-key" aria-hidden />
        <h2 className="mr-auto font-semibold">AI assistant</h2>
        <button type="button" className={btn} onClick={() => ai.newChat()} title="New chat" aria-label="New chat" disabled={!ai.messages.length && !ai.busy}>
          <Plus size={15} />
        </button>
        <button type="button" className={btn} onClick={toggleAi} title="Close" aria-label="Close the AI assistant">
          <X size={15} />
        </button>
      </header>

      {!authed ? (
        <Notice icon={<Lock size={18} />} title="Log in to use the AI assistant">
          It designs and edits your diagram from a description, so it needs an account.
          <button type="button" onClick={() => useAuth.getState().showSignIn()} className="mt-3 block w-full cursor-pointer rounded-md bg-key px-3 py-1.5 font-medium text-primary-foreground">
            Log in
          </button>
        </Notice>
      ) : ai.enabled === false ? (
        <Notice icon={<AlertTriangle size={18} />} title="The assistant is not available">
          It is switched off, or no AI provider has been set up yet.
        </Notice>
      ) : ai.enabled === null ? (
        <Notice icon={<Sparkles size={18} />} title={ai.loadingModels ? 'Loading…' : 'The assistant is unavailable'}>
          {ai.loadingModels ? null : (
            <button type="button" onClick={() => void ai.loadModels()} className="mt-2 cursor-pointer rounded-sm border border-line px-2.5 py-1 hover:border-key hover:text-key">
              Try again
            </button>
          )}
        </Notice>
      ) : (
        <>
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
            <span className="text-[12px] text-muted">Model</span>
            {sees && (
              <span title="This model can look at a picture of your canvas to check its work" className="text-muted">
                <Eye size={13} aria-label="Can see the canvas" />
              </span>
            )}
            <Select
              aria-label="AI model"
              value={ai.modelId ?? ''}
              onValueChange={ai.selectModel}
              options={ai.models.map((m) => ({ value: m.id, label: `${m.label} · ${m.maker}` }))}
              className="ml-auto min-w-0 max-w-[70%] flex-1"
            />
          </div>

          <div
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3 text-[14px]"
            aria-live="polite"
          >
            {ai.messages.length === 0 ? (
              <Empty starters={tableCount ? STARTERS_FILLED : STARTERS_EMPTY} onPick={submit} />
            ) : (
              ai.messages.map((m) => <Message key={m.id} m={m} />)
            )}
          </div>

          {ai.undo && !ai.busy && (
            <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-[13px]">
              <span className="mr-auto text-muted">The assistant changed the canvas.</span>
              <button type="button" onClick={ai.undoLast} className="flex cursor-pointer items-center gap-1 rounded-sm border border-line px-2 py-0.5 hover:border-key hover:text-key">
                <Undo2 size={13} /> Undo
              </button>
            </div>
          )}

          {refineOpen && (
            <RefineCard
              onClose={() => setRefineOpen(false)}
              onStart={(tool, database) => {
                setRefineOpen(false)
                stick.current = true
                void ai.refine(tool, database)
              }}
            />
          )}

          <div className="border-t border-line p-3">
            {picked.items.length > 0 && (
              <div className="mb-2" aria-label="What your question is about">
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[12px] text-muted">Asking about</span>
                  {picked.items.slice(0, MAX_CHIPS).map((item) => (
                    <FocusChip key={item.key} item={item} onDrop={() => drop(item)} />
                  ))}
                  {picked.items.length > MAX_CHIPS && <span className="text-[12px] text-muted">+{picked.items.length - MAX_CHIPS} more</span>}
                  {picked.items.length > 1 && (
                    <button type="button" onClick={clearPicks} className="cursor-pointer text-[12px] text-muted underline hover:text-ink">
                      Clear
                    </button>
                  )}
                </div>
                {!ai.busy && suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s) => (
                      <button key={s} type="button" onClick={() => submit(s)} className="cursor-pointer rounded-full border border-line px-2.5 py-0.5 text-[12.5px] text-muted hover:border-key hover:text-key">
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-lg border border-line bg-canvas p-2 focus-within:border-key">
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, MAX_INPUT))}
                onKeyDown={onKeyDown}
                rows={2}
                placeholder={picked.items.length ? 'Ask about what you picked…' : 'Describe what to build, paste a schema, or ask about the diagram…'}
                aria-label="Message to the AI assistant"
                className="max-h-40 min-h-[2.75rem] flex-1 resize-none bg-transparent px-1 text-[14px] outline-none placeholder:text-muted"
                disabled={left === 0}
              />
              {ai.busy ? (
                <button type="button" onClick={ai.stop} className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md bg-danger/20 text-danger hover:bg-danger/30" title="Stop" aria-label="Stop">
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => submit()}
                  disabled={!draft.trim() || left === 0}
                  className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md bg-key text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  title="Send (Enter)"
                  aria-label="Send"
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
            <p className="mt-1.5 flex items-center gap-2 text-[11.5px] text-muted">
              <button
                type="button"
                onClick={() => setRefineOpen((o) => !o)}
                disabled={!tableCount || ai.busy || left === 0}
                title={tableCount ? 'Rewrite the schema to production best practice' : 'Add tables first'}
                className="flex cursor-pointer items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 text-[12px] hover:border-key hover:text-key disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Wand2 size={12} /> Refine for production
              </button>
              {left !== null && <span className={`ml-auto ${left === 0 ? 'text-danger' : ''}`}>{left === 0 ? 'No requests left today' : `${left} requests left today`}</span>}
            </p>
            {ai.locked.length > 0 && (
              <p className="mt-1 text-[11.5px] text-muted">
                {ai.locked.length} more model{ai.locked.length === 1 ? '' : 's'} on paid plans.{' '}
                <a href="/pricing" onClick={(e) => { e.preventDefault(); navigate('/pricing') }} className="text-key hover:underline">
                  See plans
                </a>
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function RefineCard({ onClose, onStart }: { onClose: () => void; onStart: (tool: RefineTool, database: Provider) => void }) {
  const provider = useStore((s) => s.provider)
  const format = useStore((s) => s.codeFormat)
  const [tool, setTool] = useState<RefineTool>(format)
  const [database, setDatabase] = useState<Provider>(provider)
  return (
    <div className="border-t border-line bg-canvas/60 p-3 text-[13px]">
      <div className="mb-2 flex items-center gap-2">
        <Wand2 size={14} className="text-key" aria-hidden />
        <h3 className="mr-auto font-semibold">Refine for production</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="cursor-pointer text-muted hover:text-ink">
          <X size={14} />
        </button>
      </div>
      <p className="mb-2 text-muted">
        Rewrites your schema the way it should be in production. Ids become random UUIDs instead of 1, 2, 3… (done by the app itself, always); the assistant then fixes types, timestamps, constraints, delete rules and history snapshots. You get the finished code. What do you ship with?
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Tool" className="flex overflow-hidden rounded-md border border-line">
          {REFINE_TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={tool === t.id}
              onClick={() => setTool(t.id)}
              className={`cursor-pointer px-3 py-1 ${tool === t.id ? 'bg-key/15 text-key' : 'text-muted hover:bg-hover'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Select
          aria-label="Database"
          value={database}
          onValueChange={setDatabase}
          options={PROVIDERS.map((p) => ({ value: p, label: DB_LABEL[p], icon: <DbIcon provider={p} /> }))}
          className="min-w-36"
        />
      </div>
      <button type="button" onClick={() => onStart(tool, database)} className="w-full cursor-pointer rounded-md bg-key px-3 py-1.5 font-medium text-primary-foreground">
        Refine my schema
      </button>
    </div>
  )
}

function FocusChip({ item, onDrop }: { item: FocusItem; onDrop: () => void }) {
  const kind = item.kind === 'many-to-many' ? 'link' : item.kind
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-key/40 bg-key/10 py-0.5 pl-2 pr-1 text-[12px] text-ink">
      <span className="text-muted">{kind}</span>
      <code className="truncate font-mono">{item.label}</code>
      <button type="button" onClick={onDrop} aria-label={`Stop asking about ${item.label}`} className="grid size-4 cursor-pointer place-items-center rounded-full text-muted hover:bg-hover hover:text-ink">
        <X size={11} />
      </button>
    </span>
  )
}

function Notice({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center p-6 text-center text-[14px] text-muted">
      <div className="max-w-xs">
        <div className="mx-auto mb-2 grid size-9 place-items-center rounded-full bg-hover text-key">{icon}</div>
        <h3 className="mb-1 font-semibold text-ink">{title}</h3>
        {children}
      </div>
    </div>
  )
}

function Empty({ starters, onPick }: { starters: string[]; onPick: (text: string) => void }) {
  return (
    <div className="pt-2">
      <p className="mb-1 font-semibold text-ink">What should we build?</p>
      <p className="mb-3 text-muted">
        Describe a database in plain words, or paste SQL, Prisma or DBML and I will draw it with the right types and relations. I can also change what is already on the canvas and answer questions about it. Click a table, a column or a relation line first to ask about exactly that.
      </p>
      <div className="space-y-1.5">
        {starters.map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)} className="block w-full cursor-pointer rounded-md border border-line px-3 py-2 text-left text-[13.5px] hover:border-key hover:text-key">
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function CheckRow({ c }: { c: CheckChip }) {
  return (
    <li className="rounded-md border border-line px-2 py-1.5 text-[12.5px] text-muted">
      <div className="flex items-center gap-1.5">
        {c.status === 'checking' ? (
          <span className="size-3 animate-spin rounded-full border-2 border-key border-t-transparent" aria-hidden />
        ) : c.status === 'ok' ? (
          <Check size={13} className="text-ok" aria-hidden />
        ) : (
          <Eye size={13} className="text-num" aria-hidden />
        )}
        <span>{c.note}</span>
      </div>
      {c.image && <img src={c.image} alt="The canvas as the assistant checked it" className="mt-1.5 max-h-28 w-full rounded-sm border border-line bg-canvas object-contain" />}
    </li>
  )
}

function Message({ m }: { m: UiMessage }) {
  const navigateToPlans = () => navigate('/pricing')
  if (m.role === 'user') {
    return (
      <div className="ml-8 break-words rounded-lg bg-key/15 px-3 py-2 text-ink">
        {m.refine && (
          <span className="mb-1 flex items-center gap-1 text-[12px] text-key">
            <Wand2 size={12} aria-hidden /> Refine
          </span>
        )}
        {m.about && m.about.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {m.about.map((a) => (
              <span key={a} className="rounded-full border border-key/40 px-1.5 text-[11.5px] text-muted">
                {a}
              </span>
            ))}
          </div>
        )}
        <span className="whitespace-pre-wrap">{m.text}</span>
      </div>
    )
  }
  if (m.role === 'error') {
    return (
      <div className="flex gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-danger" role="alert">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p>{m.text}</p>
          {m.action === 'plans' && (
            <button type="button" onClick={navigateToPlans} className="mt-1 cursor-pointer underline">
              See plans
            </button>
          )}
          {m.action === 'login' && (
            <button type="button" onClick={() => useAuth.getState().showSignIn()} className="mt-1 cursor-pointer underline">
              Log in
            </button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="min-w-0 text-ink">
      {m.tools && m.tools.length > 0 && (
        <ul className="mb-2 space-y-1">
          {m.tools.map((t) => (
            <li key={t.id} className={`flex items-start gap-1.5 rounded-md border px-2 py-1 text-[12.5px] ${t.ok ? 'border-line text-muted' : 'border-danger/40 text-danger'}`}>
              {t.ok ? <Check size={13} className="mt-0.5 shrink-0 text-ok" aria-hidden /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />}
              <span className="min-w-0 break-words">{t.summary}</span>
            </li>
          ))}
        </ul>
      )}
      {m.text ? <RichText text={m.text} /> : m.streaming && !(m.checks && m.checks.length) ? <Thinking /> : null}
      {m.streaming && m.text ? <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-key align-middle" aria-hidden /> : null}
      {m.refinedCode && <RefinedCode code={m.refinedCode} />}
      {m.checks && m.checks.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {m.checks.map((c) => (
            <CheckRow key={c.id} c={c} />
          ))}
        </ul>
      )}
      {m.notice && <p className="mt-1.5 text-[12px] text-num">{m.notice}</p>}
      {m.model && !m.streaming && <p className="mt-1 text-[11.5px] text-muted">{m.model}</p>}
    </div>
  )
}

function Thinking() {
  return (
    <span className="inline-flex items-center gap-1 text-muted" role="status" aria-label="Thinking">
      <span className="size-1.5 animate-bounce rounded-full bg-key [animation-delay:-0.3s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-key [animation-delay:-0.15s]" />
      <span className="size-1.5 animate-bounce rounded-full bg-key" />
    </span>
  )
}

/** The finished schema of a refine, as the chosen tool's code, ready to take away. */
function RefinedCode({ code }: { code: NonNullable<UiMessage['refinedCode']> }) {
  const [copied, setCopied] = useState(false)
  const open = () => {
    useStore.setState({ codeFormat: code.tool })
    useStore.getState().toggleCode()
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([code.code], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = code.file
    a.click()
    URL.revokeObjectURL(url)
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  const btn = 'cursor-pointer rounded-sm border border-line px-2 py-0.5 text-[12px] text-muted hover:border-key hover:text-key'
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-line bg-canvas" aria-label="The refined schema">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <Wand2 size={13} className="text-key" aria-hidden />
        <span className="mr-auto text-[12.5px] font-semibold">{code.file} · refined</span>
        <button type="button" className={btn} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className={btn} onClick={download}>
          Download
        </button>
        <button type="button" className={btn} onClick={open}>
          Open in code panel
        </button>
      </div>
      <pre className="max-h-72 overflow-auto px-3 py-2 font-mono text-[12px] leading-snug">{code.code}</pre>
    </div>
  )
}
