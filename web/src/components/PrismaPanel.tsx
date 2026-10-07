import { useMemo, useState, type ReactNode } from 'react'
import { generateDrizzle } from '../core/drizzle'
import { generatePrisma } from '../core/prisma'
import { generateSql } from '../core/sql'
import { toDiagram, useStore, type CodeFormat } from '../store'

const TOKEN =
  /(\/\/.*)|("(?:[^"\\]|\\.)*")|(@@?[A-Za-z_.]+)|\b(model|enum|generator|datasource)\b|\b(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes|Unsupported)\b|\b(\d+)\b/g

const TOKEN_CLASS = [
  '',
  'text-muted italic', // comment
  'text-ok', // string
  'text-num', // attribute
  'text-key font-semibold', // keyword
  'text-key', // scalar type
  'text-num', // number
]

// TypeScript (Drizzle) schema: comments, strings, keywords, Drizzle helpers, column modifiers, numbers.
const TS_TOKEN =
  /(\/\/.*)|('(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|export|const|from|type|typeof)\b|\b(pgTable|mysqlTable|sqliteTable|pgEnum|mysqlEnum|relations|one|many|sql|customType|primaryKey)\b|(\.(?:references|notNull|unique|default|defaultNow|defaultRandom|array|autoincrement|primaryKey)\b)|\b(\d+)\b/g

const TS_TOKEN_CLASS = [
  '',
  'text-muted italic', // comment
  'text-ok', // string
  'text-key font-semibold', // keyword
  'text-key', // drizzle helper
  'text-num', // column modifier
  'text-num', // number
]

const SQL_TOKEN =
  /(--.*)|('(?:[^']|'')*')|("(?:[^"]|"")*"|`(?:[^`]|``)*`)|\b(CREATE|TABLE|TYPE|AS|ENUM|NOT|NULL|DEFAULT|PRIMARY|KEY|UNIQUE|CONSTRAINT|FOREIGN|REFERENCES|ON|DELETE|UPDATE|CASCADE|SET|RESTRICT|NO|ACTION|ALTER|ADD|AUTOINCREMENT|AUTO_INCREMENT|CHECK|IN|CURRENT_TIMESTAMP|TRUE|FALSE|UNSIGNED)\b|\b(INTEGER|INT|SMALLINT|TINYINT|MEDIUMINT|BIGINT|SERIAL|BIGSERIAL|VARCHAR|CHAR|TEXT|MEDIUMTEXT|LONGTEXT|UUID|BOOLEAN|NUMERIC|DECIMAL|FLOAT|REAL|DOUBLE|PRECISION|DATE|TIME|TIMESTAMP|TIMESTAMPTZ|DATETIME|JSON|JSONB|BYTEA|BLOB)\b|\b(\d+)\b/g

const SQL_TOKEN_CLASS = [
  '',
  'text-muted italic', // comment
  'text-ok', // string
  'text-ink', // quoted identifier
  'text-key font-semibold', // keyword
  'text-num', // type
  'text-num', // number
]

function highlight(line: string, format: CodeFormat): ReactNode[] {
  const token = format === 'sql' ? SQL_TOKEN : format === 'drizzle' ? TS_TOKEN : TOKEN
  const classes = format === 'sql' ? SQL_TOKEN_CLASS : format === 'drizzle' ? TS_TOKEN_CLASS : TOKEN_CLASS
  const parts: ReactNode[] = []
  let last = 0
  for (const m of line.matchAll(token)) {
    if (m.index > last) parts.push(line.slice(last, m.index))
    const group = m.findIndex((g, i) => i > 0 && g !== undefined)
    parts.push(
      <span key={m.index} className={classes[group]}>
        {m[0]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < line.length) parts.push(line.slice(last))
  return parts
}

const PROVIDER_LABEL = { postgresql: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite' }

export function PrismaPanel() {
  const provider = useStore((s) => s.provider)
  const nodes = useStore((s) => s.nodes)
  const manyToMany = useStore((s) => s.manyToMany)
  const toggleCode = useStore((s) => s.toggleCode)
  const format = useStore((s) => s.codeFormat)
  const setFormat = useStore((s) => s.setCodeFormat)
  const [copied, setCopied] = useState(false)

  // Only the visible format is generated. The SQL follows the selected database.
  const schema = useMemo(() => {
    const diagram = toDiagram(provider, nodes, manyToMany)
    if (format === 'sql') return generateSql(diagram).sql
    return format === 'drizzle' ? generateDrizzle(diagram).schema : generatePrisma(diagram).schema
  }, [provider, nodes, manyToMany, format])
  const filename = { prisma: 'schema.prisma', drizzle: 'schema.ts', sql: 'schema.sql' }[format]

  // The schema ends with a newline; don't number the empty "line" after it.
  const lines = useMemo(() => schema.replace(/\n$/, '').split('\n'), [schema])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(schema)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable; ignore */
    }
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([schema], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const btn =
    'cursor-pointer rounded-sm border border-line px-2 py-1 text-muted hover:border-key hover:text-key'

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="mr-auto font-semibold">{filename}</h2>
        <button type="button" className={btn} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className={btn} onClick={download}>
          Download
        </button>
        <button
          type="button"
          className={btn}
          onClick={toggleCode}
          title="Hide code panel"
          aria-label="Hide code panel"
        >
          »
        </button>
      </header>

      <div
        role="tablist"
        aria-label="Export format"
        className="flex items-center gap-1 border-b border-line px-3 py-1.5"
      >
        {(
          [
            ['prisma', 'Prisma'],
            ['drizzle', 'Drizzle'],
            ['sql', `SQL · ${PROVIDER_LABEL[provider]}`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={format === value}
            onClick={() => setFormat(value)}
            className={`cursor-pointer rounded-md px-2.5 py-1 text-[13px] font-medium ${
              format === value ? 'bg-key/15 text-key' : 'text-muted hover:bg-white/8 hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <pre className="min-h-0 flex-1 overflow-auto py-3 font-mono leading-relaxed">
        <code className="block min-w-max">
          {lines.map((line, i) => (
            <div key={i} className="flex">
              {/* Gutter is sticky and unselectable, so scrolling sideways keeps numbers and copying skips them. */}
              <span
                aria-hidden
                className="sticky left-0 w-12 shrink-0 bg-surface pr-3 text-right text-muted/50 select-none"
              >
                {i + 1}
              </span>
              <span className="pr-3 whitespace-pre">{line ? highlight(line, format) : '\u200b'}</span>
            </div>
          ))}
        </code>
      </pre>
    </section>
  )
}
