import type { ChatMessage, ToolSpec } from '../../../shared/aiToolSpecs'

export type { ChatMessage, ToolSpec }

/** One model call, in the provider-neutral shape every adapter translates to its own wire format. */
export type UpstreamRequest = {
  /** The id the upstream API knows (a gateway slug like "anthropic/claude-sonnet-4.5", or "claude-sonnet-5-5"). */
  model: string
  /** Rules that never change between requests. Adapters that support prompt caching cache this part. */
  systemStatic: string
  /** The canvas and the plan limits: changes with every request. */
  systemDynamic: string
  messages: ChatMessage[]
  tools: ToolSpec[]
  maxTokens: number
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other'

/** What an adapter yields while a model answers. `tool_call` arrives complete (arguments fully assembled). */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'done'; finishReason: FinishReason }

export type AdapterOptions = {
  baseUrl: string
  apiKey: string
  signal: AbortSignal
  /** Longest wait for the first byte, and between two chunks afterwards. */
  firstByteMs: number
  idleMs: number
}

export type Adapter = (req: UpstreamRequest, opts: AdapterOptions) => AsyncGenerator<StreamEvent>
