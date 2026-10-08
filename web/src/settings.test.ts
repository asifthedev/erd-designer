/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, EDGE_STYLES, FONT_WEIGHTS, sanitize, TABLE_FONTS, THEMES } from './settings'

const css = readFileSync(path.resolve(import.meta.dirname, 'index.css'), 'utf8')

/** `--color-x: value;` pairs (and `color-scheme`) inside the `[data-theme='id'] { ... }` block. */
function themeTokens(id: string): Record<string, string> {
  const block = new RegExp(`\\[data-theme='${id}'\\]\\s*\\{([^}]*)\\}`).exec(css)
  if (!block) throw new Error(`index.css has no block for theme "${id}"`)
  return Object.fromEntries(
    [...block[1].matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  )
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
/** WCAG contrast ratio between two #rrggbb colours (1 = identical, 21 = black on white). */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('themes', () => {
  const reference = Object.keys(themeTokens('midnight'))

  it('has a block in index.css for every theme in the list, and the default matches the original @theme palette', () => {
    for (const t of THEMES) expect(() => themeTokens(t.id)).not.toThrow()
    const base = Object.fromEntries(
      [...css.split('@theme')[1].matchAll(/(--color-[\w-]+):\s*(#[0-9a-f]{3,8}|rgb\([^)]*\));/gi)].map((m) => [
        m[1],
        m[2],
      ]),
    )
    for (const [token, value] of Object.entries(themeTokens('midnight'))) {
      if (token.startsWith('--')) expect(base[token], token).toBe(value) // (color-scheme is not an @theme token)
    }
  })

  it.each(THEMES.map((t) => t.id))('%s overrides every token (nothing leaks through from another theme)', (id) => {
    const tokens = themeTokens(id)
    for (const key of reference) expect(tokens[key], `${id} is missing ${key}`).toBeDefined()
    expect(Object.keys(tokens).sort()).toEqual([...reference].sort()) // and adds nothing the others lack
    expect(tokens['color-scheme']).toBe('dark')
  })

  it.each(THEMES.map((t) => t.id))('%s keeps text readable (WCAG contrast)', (id) => {
    const t = themeTokens(id)
    const c = (a: string, b: string) => contrast(t[`--color-${a}`], t[`--color-${b}`])
    expect(c('ink', 'canvas'), 'ink on canvas').toBeGreaterThanOrEqual(4.5)
    expect(c('ink', 'surface'), 'ink on surface').toBeGreaterThanOrEqual(4.5)
    expect(c('ink', 'row'), 'ink on table rows').toBeGreaterThanOrEqual(4.5)
    expect(c('muted', 'surface'), 'secondary text on surface').toBeGreaterThanOrEqual(3)
    expect(c('muted', 'canvas'), 'secondary text on canvas').toBeGreaterThanOrEqual(3)
    expect(c('key', 'surface'), 'accent on surface').toBeGreaterThanOrEqual(3)
    expect(c('key', 'row'), 'accent on table rows').toBeGreaterThanOrEqual(3)
    expect(c('num', 'row'), 'default values on table rows').toBeGreaterThanOrEqual(3)
    expect(c('danger', 'surface'), 'errors on surface').toBeGreaterThanOrEqual(3)
    expect(c('primary-foreground', 'key'), 'text on accent buttons').toBeGreaterThanOrEqual(4.5)
    expect(c('line', 'canvas'), 'borders are visible against the canvas').toBeGreaterThanOrEqual(1.15)
  })

  it('offers Midnight (the default), Dracula, Vercel, Warm Dark and Eraser', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('midnight')
    expect(THEMES.map((t) => t.id)).toEqual(['midnight', 'dracula', 'vercel', 'warm', 'eraser'])
  })
})

describe('table font settings', () => {
  it('offers JetBrains Mono and Google Sans Code, Light / Regular / Medium; the default is the original look', () => {
    expect(TABLE_FONTS.map((f) => f.name)).toEqual(['Google Sans Code', 'JetBrains Mono'])
    expect(FONT_WEIGHTS.map((w) => [w.name, w.value])).toEqual([
      ['Light', 300],
      ['Regular', 400],
      ['Medium', 500],
    ])
    expect(DEFAULT_SETTINGS).toEqual({
      theme: 'midnight',
      tableFont: 'google-sans-code',
      tableWeight: 400,
      edgeStyle: 'orthogonal',
    })
  })

  it('both fonts are bundled and support the weights that are offered (variable fonts)', () => {
    expect(css).toContain('@fontsource-variable/google-sans-code')
    expect(css).toContain('@fontsource-variable/jetbrains-mono')
    for (const pkg of ['google-sans-code', 'jetbrains-mono']) {
      const dir = path.dirname(createRequire(import.meta.url).resolve(`@fontsource-variable/${pkg}/package.json`))
      const faces = readFileSync(path.join(dir, 'index.css'), 'utf8').match(/font-weight:\s*(\d+) (\d+)/)!
      expect(Number(faces[1])).toBeLessThanOrEqual(300)
      expect(Number(faces[2])).toBeGreaterThanOrEqual(500)
    }
  })

  it('only the tables use the table font', () => {
    expect(css).toMatch(/\.table-font\s*\{[^}]*--table-font-family/)
    const node = readFileSync(path.resolve(import.meta.dirname, 'components/TableNode.tsx'), 'utf8')
    expect(node).toContain('table-font')
  })
})

describe('sanitize', () => {
  it('keeps known values', () => {
    expect(sanitize({ theme: 'dracula', tableFont: 'jetbrains-mono', tableWeight: 500, edgeStyle: 'curved' })).toEqual({
      theme: 'dracula',
      tableFont: 'jetbrains-mono',
      tableWeight: 500,
      edgeStyle: 'curved',
    })
  })

  it('falls back to the defaults for anything unknown, old or corrupted', () => {
    for (const bad of [
      null,
      undefined,
      'x',
      42,
      [],
      {},
      { theme: 'neon', tableFont: 'comic-sans', tableWeight: 900 },
      { theme: {}, tableWeight: '500' },
    ]) {
      expect(sanitize(bad)).toEqual(DEFAULT_SETTINGS)
    }
    expect(sanitize({ theme: 'dracula', tableFont: 'nope' })).toEqual({ ...DEFAULT_SETTINGS, theme: 'dracula' })
    // a theme that no longer exists (it was removed) falls back to the default instead of breaking the app
    expect(sanitize({ theme: 'gruvbox', tableWeight: 500 })).toEqual({ ...DEFAULT_SETTINGS, tableWeight: 500 })
  })
})

describe('Vercel theme data types', () => {
  it('are pink and stay readable on the table rows', () => {
    const pink = /\[data-theme='vercel'\] \.erd-table \.erd-type\s*\{\s*color:\s*(#[0-9a-f]{6})/i.exec(css)?.[1]
    expect(pink).toBeDefined()
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(pink!.slice(i, i + 2), 16))
    expect(r).toBeGreaterThan(g) // pink: red-dominant with a strong blue part
    expect(b).toBeGreaterThan(g)
    expect(contrast(pink!, themeTokens('vercel')['--color-row'])).toBeGreaterThanOrEqual(4.5)
  })
})

describe('table title and corners', () => {
  it('Eraser shows a pure white title and icon', () => {
    expect(css).toMatch(/\[data-theme='eraser'\] \.erd-table \.erd-title\s*\{[^}]*color:\s*#fff;/i)
    expect(css).toMatch(/\[data-theme='eraser'\] \.erd-table \.erd-icon button\s*\{[^}]*color:\s*#fff;/i)
  })

  it('the title bar and last row use the inner radius (outer radius minus the line) in every theme', () => {
    expect(css).toMatch(/\.erd-table\s*\{[^}]*--r:\s*8px;[^}]*--bw:\s*1px;/)
    expect(css).toMatch(/\.erd-table \.erd-header\s*\{[^}]*calc\(var\(--r\) - var\(--bw\)\)/)
    expect(css).toMatch(/\.erd-table \.erd-last\s*\{[^}]*calc\(var\(--r\) - var\(--bw\)\)/)
    expect(css).toMatch(/\[data-theme='eraser'\] \.erd-table\s*\{[^}]*--bw:\s*2px;/) // only the line width differs
  })
})

describe('line style setting', () => {
  it('offers Orthogonal (the default, as before) and Curved', () => {
    expect(EDGE_STYLES.map((e) => e.id)).toEqual(['orthogonal', 'curved'])
    expect(DEFAULT_SETTINGS.edgeStyle).toBe('orthogonal')
  })

  it('settings saved before the switch existed (no edgeStyle) keep working and get the default', () => {
    expect(sanitize({ theme: 'warm', tableFont: 'jetbrains-mono', tableWeight: 300 }).edgeStyle).toBe('orthogonal')
  })

  it('an unknown line style falls back to the default', () => {
    for (const bad of ['zigzag', 42, null, {}, 'CURVED'])
      expect(sanitize({ edgeStyle: bad }).edgeStyle).toBe('orthogonal')
    expect(sanitize({ edgeStyle: 'curved' }).edgeStyle).toBe('curved')
  })
})
