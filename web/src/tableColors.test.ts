/// <reference types="node" />
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveTableColor, TABLE_COLORS } from './tableColors'

const css = readFileSync(path.resolve(import.meta.dirname, 'index.css'), 'utf8')

function colorTokens(id: string): Record<string, string> {
  const block = new RegExp(`\\.erd-table\\[data-color='${id}'\\]\\s*\\{([^}]*)\\}`).exec(css)
  if (!block) throw new Error(`index.css has no table colour "${id}"`)
  return Object.fromEntries([...block[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('table colours', () => {
  it.each(TABLE_COLORS.map((c) => c.id))('%s defines all five tokens, readable on its own body', (id) => {
    const t = colorTokens(id)
    for (const key of ['--body', '--border', '--divider', '--name', '--type']) expect(t[key], key).toMatch(/^#[0-9a-f]{6}$/i)
    expect(contrast(t['--name'], t['--body']), 'names').toBeGreaterThanOrEqual(4.5)
    expect(contrast(t['--type'], t['--body']), 'types').toBeGreaterThanOrEqual(3)
    expect(contrast(t['--border'], '#161616'), 'border against the canvas').toBeGreaterThanOrEqual(3)
  })

  it('the swatch in the menu is the table border colour', () => {
    for (const c of TABLE_COLORS) expect(colorTokens(c.id)['--border'].toLowerCase()).toBe(c.swatch)
  })

  it('keeps a chosen colour, ignores unknown ones, and picks the same automatic colour every time', () => {
    expect(resolveTableColor('t1', 'teal')).toBe('teal')
    const auto = resolveTableColor('t1', undefined)
    expect(resolveTableColor('t1', 'not-a-colour')).toBe(auto)
    expect(resolveTableColor('t1', undefined)).toBe(auto)
    expect(TABLE_COLORS.slice(0, 5).map((c) => c.id)).toContain(auto)
    const spread = new Set(Array.from({ length: 40 }, (_, i) => resolveTableColor(`table_${i}`, undefined)))
    expect(spread.size).toBeGreaterThan(2) // not everything lands on one colour
  })
})
