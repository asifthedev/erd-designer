/** Why an upstream call failed, in terms the router can act on. */
export type UpstreamKind =
  | 'auth' // our key is wrong or revoked: nothing will work until the operator fixes it
  | 'credits' // out of credit at the gateway / provider
  | 'rate_limit'
  | 'overloaded'
  | 'not_found' // the model id does not exist (any more)
  | 'bad_request'
  | 'timeout'
  | 'network'
  | 'aborted' // the person closed the tab / pressed stop
  | 'unknown'

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly kind: UpstreamKind,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'UpstreamError'
  }

  /** Worth another attempt on the same model (it may just have been a blip). */
  get retryable() {
    return this.kind === 'rate_limit' || this.kind === 'overloaded' || this.kind === 'timeout' || this.kind === 'network'
  }

  /** Worth trying a different model instead. */
  get fallbackable() {
    return this.retryable || this.kind === 'not_found' || (this.kind === 'bad_request' && /tool|function/i.test(this.message))
  }
}

/** Maps an HTTP status (and the provider's own words) to a kind. */
export function classifyStatus(status: number, message: string): UpstreamKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'credits'
  if (status === 404) return 'not_found'
  if (status === 408 || status === 504) return 'timeout'
  if (status === 429) return /credit|quota|billing|insufficient/i.test(message) ? 'credits' : 'rate_limit'
  if (status === 529 || status >= 500) return 'overloaded'
  if (status >= 400) return 'bad_request'
  return 'unknown'
}

/** What the person sees: never the provider's raw text (it may name keys, accounts or internals). */
export const PUBLIC_MESSAGES: Record<UpstreamKind, { code: string; message: string }> = {
  auth: { code: 'unavailable', message: 'The AI assistant is not available right now. Please try again later.' },
  credits: { code: 'unavailable', message: 'The AI assistant is not available right now. Please try again later.' },
  rate_limit: { code: 'busy', message: 'The AI service is busy. Please try again in a moment.' },
  overloaded: { code: 'busy', message: 'The AI service is busy. Please try again in a moment.' },
  not_found: { code: 'unavailable', message: 'That model is not available right now. Pick another one.' },
  bad_request: { code: 'bad_request', message: 'The model could not handle this request. Try rephrasing, or pick another model.' },
  timeout: { code: 'timeout', message: 'The model took too long to answer. Please try again, or pick a faster model.' },
  network: { code: 'busy', message: 'Could not reach the AI service. Please try again in a moment.' },
  aborted: { code: 'aborted', message: 'Stopped.' },
  unknown: { code: 'failed', message: 'The AI assistant ran into a problem. Please try again.' },
}
