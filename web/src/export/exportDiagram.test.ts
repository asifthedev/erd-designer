import { describe, expect, it } from 'vitest'
import { coversBasicLatin, dataUrlToBlob, exportFileName, exportSize, PADDING } from './exportDiagram'

describe('exportSize', () => {
  it('adds the margin on every side and draws at 3x when the picture is of a normal size', () => {
    const s = exportSize({ width: 800, height: 500 })
    expect(s.width).toBe(800 + 2 * PADDING)
    expect(s.height).toBe(500 + 2 * PADDING)
    expect(s.pixelRatio).toBe(3)
  })

  it('rounds up, so the last pixel of a table is never cut', () => {
    expect(exportSize({ width: 100.2, height: 50.7 })).toMatchObject({
      width: Math.ceil(100.2 + 2 * PADDING),
      height: Math.ceil(50.7 + 2 * PADDING),
    })
  })

  it('draws a very large diagram at a lower resolution so the browser can make the picture', () => {
    const s = exportSize({ width: 9000, height: 6000 })
    expect(s.pixelRatio).toBeLessThan(3)
    expect(s.pixelRatio).toBeGreaterThan(0)
    expect(Math.max(s.width, s.height) * s.pixelRatio).toBeLessThanOrEqual(16_000) // longest side
    expect(s.width * s.height * s.pixelRatio ** 2).toBeLessThanOrEqual(100_000_000) // total pixels
  })
})

describe('exportFileName', () => {
  it('turns the diagram name into a safe file name', () => {
    expect(exportFileName('My Shop ERD!', 'png')).toBe('my-shop-erd.png')
    expect(exportFileName('  Café / Orders (v2)  ', 'pdf')).toBe('cafe-orders-v2.pdf')
    expect(exportFileName('a'.repeat(200), 'svg')).toBe(`${'a'.repeat(60)}.svg`)
  })

  it('never produces an empty name', () => {
    for (const bad of [undefined, '', '   ', '!!!', '日本語'])
      expect(exportFileName(bad, 'png')).toBe('erd-diagram.png')
  })
})

describe('dataUrlToBlob', () => {
  it('decodes base64 data (PNG)', async () => {
    const blob = dataUrlToBlob(`data:image/png;base64,${btoa('hello')}`)
    expect(blob.type).toBe('image/png')
    expect(await blob.text()).toBe('hello')
  })

  it('decodes URL-encoded data (the SVG html-to-image makes), keeping the markup intact', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>users — id</text></svg>'
    const blob = dataUrlToBlob(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    expect(blob.type).toBe('image/svg+xml')
    expect(await blob.text()).toBe(svg)
  })
})

describe('coversBasicLatin', () => {
  it('finds the main (Latin) piece of a font, however the browser writes the range', () => {
    expect(coversBasicLatin('U+0000-00FF, U+0131, U+0152-0153')).toBe(true)
    expect(coversBasicLatin('U+0-FF, U+131, U+152-153, U+2BB-2BC')).toBe(true) // Chrome drops the leading zeros
    expect(coversBasicLatin('u+41')).toBe(true)
    expect(coversBasicLatin('')).toBe(true) // no range: serves everything
  })

  it('skips the pieces for other alphabets and accents', () => {
    expect(coversBasicLatin('U+0301, U+0400-045F, U+0490-0491')).toBe(false) // Cyrillic
    expect(coversBasicLatin('U+0100-02AF, U+0304, U+0308')).toBe(false) // Latin Extended
    expect(coversBasicLatin('U+0370-03FF')).toBe(false) // Greek
    expect(coversBasicLatin('U+1-C, U+E-1F, U+7F-9F')).toBe(false) // control characters
  })
})
