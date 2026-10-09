import { Fragment, type ReactNode } from 'react'

/**
 * A small, safe renderer for the assistant's answers: paragraphs, bullet and numbered lists, **bold**, `code` and
 * fenced code blocks. It builds React elements from text, never HTML, so nothing a model writes can inject markup.
 */

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]
    out.push(
      token.startsWith('`') ? (
        <code key={m.index} className="rounded-sm bg-hover px-1 py-px font-mono text-[0.92em] text-key">
          {token.slice(1, -1)}
        </code>
      ) : (
        <strong key={m.index} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>
      ),
    )
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

type Block = { type: 'p' | 'ul' | 'ol'; lines: string[] } | { type: 'code'; text: string }

function parse(source: string): Block[] {
  const blocks: Block[] = []
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim().startsWith('```')) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++])
      i++ // the closing fence (a still-streaming block simply ends here)
      blocks.push({ type: 'code', text: body.join('\n') })
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''))
      blocks.push({ type: 'ul', lines: items })
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))
      blocks.push({ type: 'ol', lines: items })
    } else if (!line.trim()) {
      i++
    } else {
      const para: string[] = []
      while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith('```') && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++])
      blocks.push({ type: 'p', lines: para })
    }
  }
  return blocks
}

export function RichText({ text }: { text: string }) {
  return (
    <div className="space-y-2 leading-relaxed">
      {parse(text).map((b, i) => {
        if (b.type === 'code') {
          return (
            <pre key={i} className="overflow-x-auto rounded-md border border-line bg-canvas p-2.5 font-mono text-[12.5px] leading-snug">
              {b.text}
            </pre>
          )
        }
        if (b.type === 'ul' || b.type === 'ol') {
          const List = b.type === 'ul' ? 'ul' : 'ol'
          return (
            <List key={i} className={`space-y-0.5 pl-5 ${b.type === 'ul' ? 'list-disc' : 'list-decimal'}`}>
              {b.lines.map((l, j) => (
                <li key={j}>{inline(l)}</li>
              ))}
            </List>
          )
        }
        return (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}
