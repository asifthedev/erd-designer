/** Thin fetch wrapper for the Express API (../erd-designer-api). Cookies are same-origin via the Vite proxy. */
const BASE = import.meta.env.VITE_API_URL ?? ''

export class ApiError extends Error {
  status: number
  field?: string
  /** On a 429 for "ask again later": how many seconds to wait. */
  retryAfter?: number

  constructor(message: string, status: number, field?: string, retryAfter?: number) {
    super(message)
    this.status = status
    this.field = field
    this.retryAfter = retryAfter
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; keepalive?: boolean } = {},
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'include',
      keepalive: options.keepalive,
    })
  } catch {
    throw new ApiError('Cannot reach the server. Is the API running?', 0)
  }
  if (res.status === 204) return undefined as T
  const data = (await res.json().catch(() => ({}))) as { error?: string; field?: string; retryAfter?: number }
  if (!res.ok) throw new ApiError(data.error ?? 'Something went wrong', res.status, data.field, data.retryAfter)
  return data as T
}
