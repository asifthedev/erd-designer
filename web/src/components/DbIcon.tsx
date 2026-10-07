import { siMysql, siPostgresql, siSqlite } from 'simple-icons'
import type { Provider } from '../core/model'

// Brand colours from simple-icons; SQLite's own navy is unreadable on the dark canvas, so it is lightened.
const LOGOS: Record<Provider, { path: string; color: string }> = {
  postgresql: { path: siPostgresql.path, color: `#${siPostgresql.hex}` },
  mysql: { path: siMysql.path, color: `#${siMysql.hex}` },
  sqlite: { path: siSqlite.path, color: '#3FA9E0' },
}

/** Official-style logo of a database engine (simple-icons, CC0). */
export function DbIcon({ provider, size = 16 }: { provider: Provider; size?: number }) {
  const logo = LOGOS[provider]
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={logo.color} aria-hidden className="shrink-0">
      <path d={logo.path} />
    </svg>
  )
}
