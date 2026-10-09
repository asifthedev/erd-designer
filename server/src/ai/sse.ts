import { UpstreamError } from './errors'

export type SseMessage = { event?: string; data: string }

type Timeouts = { firstByteMs: number; idleMs: number; signal: AbortSignal }

/** Reads one chunk, but gives up when the upstream goes quiet for `ms` or the caller aborts. */
function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number, signal: AbortSignal, first: boolean) {
  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new UpstreamError(first ? 'No response from the model in time' : 'The model stopped answering', 'timeout'))
    }, ms)
    const onAbort = () => reject(new UpstreamError('Aborted', 'aborted'))
    if (signal.aborted) onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    reader.read().then(resolve, (e) => reject(new UpstreamError(String(e?.message ?? e), signal.aborted ? 'aborted' : 'network')))
      .finally(() => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      })
  })
}

/**
 * Server-sent events from a fetch Response: handles chunks that split anywhere, CRLF, multi-line data, and the
 * ": keep-alive" comment lines gateways send while a model is still thinking. Times out when the stream goes quiet.
 */
export async function* readSse(res: Response, { firstByteMs, idleMs, signal }: Timeouts): AsyncGenerator<SseMessage> {
  if (!res.body) throw new UpstreamError('The response had no body', 'network')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let first = true
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, first ? firstByteMs : idleMs, signal, first)
      first = false
      if (value) buffer += decoder.decode(value, { stream: !done })
      buffer = buffer.replace(/\r\n/g, '\n')
      let cut: number
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const message = parseBlock(buffer.slice(0, cut))
        buffer = buffer.slice(cut + 2)
        if (message) yield message
      }
      if (done) {
        const rest = parseBlock(buffer)
        if (rest) yield rest
        return
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

function parseBlock(block: string): SseMessage | null {
  let event: string | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  return data.length ? { event, data: data.join('\n') } : null
}
