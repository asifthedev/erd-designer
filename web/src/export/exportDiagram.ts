/**
 * Saves the whole diagram as a picture: PNG, SVG or PDF. The picture is the canvas as it looks right now (theme,
 * table colours, font, line style), all tables, with a margin around them, not just the part on screen.
 *
 * It is taken from the live DOM with html-to-image: that is what keeps it identical to the screen. The heavy parts
 * (html-to-image, jsPDF) are loaded only when someone exports, so they cost nothing at start-up.
 */
import type { Rect } from '@xyflow/react'

export type ExportFormat = 'png' | 'svg' | 'pdf'

export const EXPORT_FORMATS: { id: ExportFormat; label: string; note: string; extension: string }[] = [
  { id: 'png', label: 'PNG image', note: 'For slides, chats and docs', extension: 'png' },
  { id: 'svg', label: 'SVG image', note: 'Sharp at any size, opens in browsers', extension: 'svg' },
  { id: 'pdf', label: 'PDF document', note: 'One page, sized to the diagram', extension: 'pdf' },
]

/** Empty space around the tables, in canvas pixels. */
export const PADDING = 48
/** Browsers refuse canvases beyond about 16 000 px a side or ~270 M pixels; stay well inside both. */
const MAX_CANVAS_SIDE = 16_000
const MAX_CANVAS_PIXELS = 100_000_000
/** Past this the picture would be unusable anyway (and a PDF page can't be larger). */
export const MAX_DIAGRAM_SIDE = 18_000
/** A PNG is taken at up to 3x for sharpness on high-resolution screens and in print. */
const MAX_PIXEL_RATIO = 3

/** The size of the picture for tables spanning `bounds`, and how many real pixels per canvas pixel to draw. */
export function exportSize(bounds: Pick<Rect, 'width' | 'height'>) {
  const width = Math.ceil(bounds.width + 2 * PADDING)
  const height = Math.ceil(bounds.height + 2 * PADDING)
  const pixelRatio = Math.min(
    MAX_PIXEL_RATIO,
    MAX_CANVAS_SIDE / Math.max(width, height),
    Math.sqrt(MAX_CANVAS_PIXELS / (width * height)),
  )
  return { width, height, pixelRatio }
}

/** `My shop ERD!` -> `my-shop-erd.png`: safe on every file system, never empty. */
export function exportFileName(title: string | undefined, extension: string): string {
  const base = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${base || 'erd-diagram'}.${extension}`
}

/** Decodes a data: URL into a Blob without fetch() (the page's security policy does not allow fetching data: URLs). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  const meta = dataUrl.slice(5, comma) // after "data:"
  const mime = meta.split(';')[0] || 'application/octet-stream'
  const body = dataUrl.slice(comma + 1)
  if (!meta.includes(';base64')) return new Blob([decodeURIComponent(body)], { type: mime })
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: mime })
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * html-to-image copies the computed style of ordinary (HTML) elements, but for the shapes inside an <svg> (the relation
 * lines and their symbols) it only keeps the inline style they already have: whatever comes from a CSS class or from
 * `var(--colour)` is lost in the picture, and a shape then turns black. So, for the moment of drawing, every shape's
 * resolved style is written onto it, and put back afterwards. Returns the function that puts things back.
 */
const SVG_STYLE_PROPERTIES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-opacity',
  'opacity',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'visibility',
]
export function inlineSvgStyles(root: Element): () => void {
  const saved: [SVGElement, string | null][] = []
  for (const el of root.querySelectorAll<SVGElement>('svg *')) {
    const computed = getComputedStyle(el)
    saved.push([el, el.getAttribute('style')])
    for (const property of SVG_STYLE_PROPERTIES) el.style.setProperty(property, computed.getPropertyValue(property))
  }
  return () => {
    for (const [el, style] of saved) {
      if (style === null) el.removeAttribute('style')
      else el.setAttribute('style', style)
    }
  }
}

/**
 * An empty field shows a grey hint on screen ("default"). In the picture that hint would be drawn like a real value, so
 * the hints are taken out for the moment of drawing. Returns the function that puts them back.
 */
export function hideEmptyFieldHints(root: Element): () => void {
  const hidden: [HTMLInputElement, string][] = []
  for (const input of root.querySelectorAll<HTMLInputElement>('input[placeholder]')) {
    if (input.value !== '') continue
    hidden.push([input, input.placeholder])
    input.removeAttribute('placeholder')
  }
  return () => hidden.forEach(([input, hint]) => input.setAttribute('placeholder', hint))
}

/**
 * The fonts the picture really uses (the interface font and the chosen table font), latin letters only, as one
 * embeddable @font-face text. html-to-image's own embedding takes every font file the page knows, including all the
 * Cyrillic / Greek / Vietnamese pieces, which made an SVG several megabytes. Returns undefined if anything is off, so
 * the library falls back to its own way.
 */
/** True when a @font-face `unicode-range` includes the basic Latin letters (so it is the main piece of the font). */
export function coversBasicLatin(range: string): boolean {
  if (!range.trim()) return true // no range: the file serves every character
  return range.split(',').some((part) => {
    const m = /U\+([0-9a-f]+)(?:-([0-9a-f]+))?/i.exec(part)
    if (!m) return false
    const low = parseInt(m[1], 16)
    const high = m[2] ? parseInt(m[2], 16) : low
    return low <= 0x41 && 0x41 <= high // "A"; browsers write U+0000-00FF as U+0-FF
  })
}

const fontData = new Map<string, Promise<string>>()
async function embeddedFonts(): Promise<string | undefined> {
  try {
    const tableFont = getComputedStyle(document.documentElement).getPropertyValue('--table-font-family')
    const families = new Set(['Inter Variable', /'([^']+)'/.exec(tableFont)?.[1] ?? ''])
    const faces: CSSFontFaceRule[] = []
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSFontFaceRule) faces.push(rule)
        else if (rule instanceof CSSImportRule && rule.styleSheet) visit(rule.styleSheet.cssRules)
        else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules)
      } catch {
        /* a stylesheet from another origin cannot be read: skip it */
      }
    }

    const css: string[] = []
    for (const face of faces) {
      const family = face.style.getPropertyValue('font-family').replace(/["']/g, '').trim()
      const range = face.style.getPropertyValue('unicode-range')
      if (!families.has(family) || !coversBasicLatin(range)) continue // not a font in use, or not its Latin part
      const url = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(face.style.getPropertyValue('src'))?.[1]
      if (!url) continue
      const absolute = new URL(url, face.parentStyleSheet?.href ?? document.baseURI).href
      if (!fontData.has(absolute)) {
        fontData.set(
          absolute,
          fetch(absolute)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
            .then((buffer) => {
              let binary = ''
              const bytes = new Uint8Array(buffer)
              for (let i = 0; i < bytes.length; i += 0x8000)
                binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
              return `data:font/woff2;base64,${btoa(binary)}`
            }),
        )
      }
      const data = await fontData.get(absolute)!
      css.push(
        `@font-face{font-family:'${family}';font-style:${face.style.getPropertyValue('font-style') || 'normal'};` +
          `font-weight:${face.style.getPropertyValue('font-weight') || '400'};font-display:block;` +
          `src:url(${data}) format('woff2');}`,
      )
    }
    return css.length ? css.join('\n') : undefined
  } catch {
    return undefined
  }
}

/**
 * The styles that change how an element LOOKS. html-to-image writes every computed style (300+) onto every element it
 * draws, ~9 KB each, which made a four-table SVG three megabytes. Only these are written now, about a tenth of that.
 * (If something looks different in a picture than on screen, a property missing from this list is the first suspect.)
 */
const PICTURE_STYLE_PROPERTIES = [
  // layout and box
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'box-sizing',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'overflow-x',
  'overflow-y',
  'order',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-items',
  'align-self',
  'align-content',
  'justify-content',
  'justify-items',
  'justify-self',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column-start',
  'grid-column-end',
  'grid-row-start',
  'grid-row-end',
  'grid-auto-flow',
  'place-items',
  'float',
  'clear',
  // borders, shadows, background
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'outline-width',
  'outline-style',
  'outline-color',
  'outline-offset',
  'box-shadow',
  'background-color',
  'background-image',
  'background-position',
  'background-size',
  'background-repeat',
  // text
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variation-settings',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-transform',
  'text-decoration-line',
  'text-indent',
  'text-overflow',
  'white-space',
  'word-break',
  'overflow-wrap',
  'vertical-align',
  'tab-size',
  '-webkit-text-fill-color',
  'caret-color',
  // effects and svg
  'opacity',
  'visibility',
  'transform',
  'translate',
  'rotate',
  'scale',
  'aspect-ratio',
  'text-wrap',
  'transform-origin',
  'filter',
  'mix-blend-mode',
  'clip-path',
  'appearance',
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-opacity',
  'text-anchor',
]

/** What is left out of the picture: the editing controls that only make sense on screen. */
const keepInPicture = (node: Node) =>
  !(node instanceof Element) || !node.matches('[data-export-hide], .react-flow__handle')

/**
 * Draws the diagram and saves it. `bounds` is the rectangle the tables span (in canvas coordinates); the caller
 * takes it from React Flow. Rejects with a readable message when it cannot be done.
 */
export async function exportDiagram(format: ExportFormat, bounds: Rect, title?: string): Promise<void> {
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')
  const canvas = document.querySelector<HTMLElement>('.react-flow')
  if (!viewport || !canvas) throw new Error('The canvas is not ready yet.')
  if (Math.max(bounds.width, bounds.height) + 2 * PADDING > MAX_DIAGRAM_SIDE) {
    throw new Error('This diagram is too large to export as a picture.')
  }

  const { width, height, pixelRatio } = exportSize(bounds)
  const { toPng, toSvg } = await import('html-to-image')
  const fontEmbedCSS = await embeddedFonts()
  const options = {
    includeStyleProperties: PICTURE_STYLE_PROPERTIES,
    ...(fontEmbedCSS ? { fontEmbedCSS } : {}),
    width,
    height,
    pixelRatio,
    backgroundColor: getComputedStyle(canvas).backgroundColor, // the theme's canvas colour
    // The viewport is moved so the tables start PADDING from the top left, at 100%: the picture is the whole diagram.
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${PADDING - bounds.x}px, ${PADDING - bounds.y}px) scale(1)`,
    },
    filter: keepInPicture,
  }

  const name = (extension: string) => exportFileName(title, extension)
  // The lines' styles must be on the shapes (see inlineSvgStyles); empty-field hints must not be drawn.
  const restoreShapes = inlineSvgStyles(viewport)
  const restoreHints = hideEmptyFieldHints(viewport)
  try {
    if (format === 'svg') {
      download(dataUrlToBlob(await toSvg(viewport, options)), name('svg'))
    } else if (format === 'png') {
      download(dataUrlToBlob(await toPng(viewport, options)), name('png'))
    } else {
      const picture = await toPng(viewport, options)
      const { jsPDF } = await import('jspdf')
      // One page exactly the size of the diagram (1 canvas pixel = 1 px unit), so nothing is cut or scaled.
      const pdf = new jsPDF({
        unit: 'px',
        format: [width, height],
        orientation: width >= height ? 'landscape' : 'portrait',
        compress: true,
        hotfixes: ['px_scaling'],
      })
      pdf.setProperties({ title: title || 'ERD diagram', creator: 'erd.designer' })
      pdf.addImage(picture, 'PNG', 0, 0, width, height, undefined, 'FAST')
      download(pdf.output('blob'), name('pdf'))
    }
  } finally {
    restoreHints()
    restoreShapes()
  }
}
