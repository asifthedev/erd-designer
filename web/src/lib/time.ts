const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * "just now", "5m ago", "2h ago", "yesterday", "3d ago", "2w ago", then a plain date: how long ago something
 * happened, short enough for a sidebar row. `now` is passed in so the result is predictable (and testable).
 */
export function timeAgo(iso: string, now: number): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const age = now - then
  if (age < MINUTE) return 'just now' // also covers a clock that is a little behind the server's
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`
  if (age < DAY) return `${Math.floor(age / HOUR)}h ago`
  const days = Math.floor(age / DAY)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return new Date(then).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Empty", "1 table", "12 tables"; nothing while the count is not known yet. */
export function tableCountLabel(count: number | undefined): string {
  if (count === undefined) return ''
  if (count === 0) return 'Empty'
  return count === 1 ? '1 table' : `${count} tables`
}

/** Two capital letters for an avatar: "Asif Shahzad" -> "AS", "ada@example.com" -> "AD". */
export function initials(label: string): string {
  const words = label
    .split('@')[0] // an email address: only the part before the @
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}
