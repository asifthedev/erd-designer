import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { isPremiumTheme } from './plans'

/**
 * Personal preferences: colour theme and the font used inside the tables. They live in this browser
 * (localStorage), not in the account, and apply instantly. The theme colours themselves are in index.css
 * under "Themes"; this file only picks which one is active.
 */

export const THEMES = [
  { id: 'midnight', name: 'Midnight', note: 'Dark blue' },
  { id: 'dracula', name: 'Dracula', note: 'Purple accents' },
  { id: 'vercel', name: 'Vercel', note: 'Pure black' },
  { id: 'warm', name: 'Warm Dark', note: 'Cream and amber' },
  { id: 'eraser', name: 'Eraser', note: 'Default · coloured tables' },
  { id: 'violet', name: 'Violet', note: 'Purple primary' },
] as const
export type ThemeId = (typeof THEMES)[number]['id']

const MONO_FALLBACK = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
export const TABLE_FONTS = [
  { id: 'google-sans-code', name: 'Google Sans Code', family: `'Google Sans Code Variable', ${MONO_FALLBACK}` },
  { id: 'jetbrains-mono', name: 'JetBrains Mono', family: `'JetBrains Mono Variable', ${MONO_FALLBACK}` },
] as const
export type TableFontId = (typeof TABLE_FONTS)[number]['id']

export const FONT_WEIGHTS = [
  { value: 300, name: 'Light' },
  { value: 400, name: 'Regular' },
  { value: 500, name: 'Medium' },
] as const
export type FontWeight = (typeof FONT_WEIGHTS)[number]['value']

/** How relation lines are drawn. Orthogonal is the default; both keep the line on its columns and movable by hand. */
export const EDGE_STYLES = [
  { id: 'orthogonal', name: 'Orthogonal', note: 'Right-angle lines' },
  { id: 'curved', name: 'Curved', note: 'Smooth, flowing curves' },
] as const
export type EdgeStyleId = (typeof EDGE_STYLES)[number]['id']

export type Settings = { theme: ThemeId; tableFont: TableFontId; tableWeight: FontWeight; edgeStyle: EdgeStyleId }

/** The default look: Eraser, Google Sans Code, regular weight, orthogonal lines. */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'eraser',
  tableFont: 'google-sans-code',
  tableWeight: 400,
  edgeStyle: 'orthogonal',
}

type SettingsState = Settings & {
  setTheme: (theme: ThemeId) => void
  setTableFont: (tableFont: TableFontId) => void
  setTableWeight: (tableWeight: FontWeight) => void
  setEdgeStyle: (edgeStyle: EdgeStyleId) => void
  /** Replaces all four at once (used when the account's saved settings arrive). */
  replace: (settings: Settings) => void
  reset: () => void
}

/** Keeps each stored value only if it is one we know, so an edited / old / corrupted entry can't break the UI. */
export function sanitize(input: unknown): Settings {
  const v = (input ?? {}) as Partial<Record<keyof Settings, unknown>>
  return {
    theme: THEMES.find((t) => t.id === v.theme)?.id ?? DEFAULT_SETTINGS.theme,
    tableFont: TABLE_FONTS.find((f) => f.id === v.tableFont)?.id ?? DEFAULT_SETTINGS.tableFont,
    tableWeight: FONT_WEIGHTS.find((w) => w.value === v.tableWeight)?.value ?? DEFAULT_SETTINGS.tableWeight,
    edgeStyle: EDGE_STYLES.find((e) => e.id === v.edgeStyle)?.id ?? DEFAULT_SETTINGS.edgeStyle,
  }
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      setTheme: (theme) => set({ theme }),
      setTableFont: (tableFont) => set({ tableFont }),
      setTableWeight: (tableWeight) => set({ tableWeight }),
      setEdgeStyle: (edgeStyle) => set({ edgeStyle }),
      replace: (settings) => set(settings),
      reset: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: 'erd-designer-settings',
      version: 1,
      partialize: (s) => ({ theme: s.theme, tableFont: s.tableFont, tableWeight: s.tableWeight, edgeStyle: s.edgeStyle }),
      merge: (persisted, current) => ({ ...current, ...sanitize(persisted) }),
    },
  ),
)

/** The four settings of a state (without the actions), e.g. to send them to the server. */
export const pickSettings = (s: Settings): Settings => ({
  theme: s.theme,
  tableFont: s.tableFont,
  tableWeight: s.tableWeight,
  edgeStyle: s.edgeStyle,
})

export const sameSettings = (a: Settings, b: Settings) =>
  a.theme === b.theme && a.tableFont === b.tableFont && a.tableWeight === b.tableWeight && a.edgeStyle === b.edgeStyle

// The premium themes (see PREMIUM_THEMES) only show when the plan includes the `themes` feature. The choice itself is kept,
// so it comes back when the plan does; until then the default theme is drawn instead. planEffects.ts sets this.
const UNLOCK_HINT = 'erd-themes-unlocked'
/** Remembered from last time, so a paying person's theme is not swapped for the default for a second at every start. */
function rememberedUnlock(): boolean {
  try {
    return localStorage.getItem(UNLOCK_HINT) === '1'
  } catch {
    return false
  }
}
let themesUnlocked = rememberedUnlock()

/** The theme that is actually drawn for a chosen one: the same, unless it is a premium theme the plan does not include. */
export const themeInForce = (theme: ThemeId, unlocked: boolean): ThemeId =>
  isPremiumTheme(theme) && !unlocked ? DEFAULT_SETTINGS.theme : theme

export const isThemeLocked = (theme: ThemeId) => isPremiumTheme(theme) && !themesUnlocked

export function setThemesUnlocked(unlocked: boolean) {
  if (unlocked === themesUnlocked) return
  themesUnlocked = unlocked
  try {
    localStorage.setItem(UNLOCK_HINT, unlocked ? '1' : '0')
  } catch {
    /* a private window: the hint is only a nicety */
  }
  applySettings(useSettings.getState())
}

/** Puts the settings on <html>: the theme attribute (colours) and the table font variables. */
export function applySettings(s: Settings) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = themeInForce(s.theme, themesUnlocked)
  root.style.setProperty('--table-font-family', TABLE_FONTS.find((f) => f.id === s.tableFont)!.family)
  root.style.setProperty('--table-font-weight', String(s.tableWeight))
}

// Apply at start-up (the store has already read localStorage) and on every change.
applySettings(useSettings.getState())
useSettings.subscribe(applySettings)
