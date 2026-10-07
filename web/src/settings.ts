import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Personal preferences: colour theme and the font used inside the tables. They live in this browser
 * (localStorage), not in the account, and apply instantly. The theme colours themselves are in index.css
 * under "Themes"; this file only picks which one is active.
 */

export const THEMES = [
  { id: 'midnight', name: 'Midnight', note: 'Default' },
  { id: 'dracula', name: 'Dracula', note: 'Purple accents' },
  { id: 'vercel', name: 'Vercel', note: 'Pure black' },
  { id: 'warm', name: 'Warm Dark', note: 'Cream and amber' },
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

export type Settings = { theme: ThemeId; tableFont: TableFontId; tableWeight: FontWeight }

/** The look the app has always had: Midnight, Google Sans Code, regular weight. */
export const DEFAULT_SETTINGS: Settings = { theme: 'midnight', tableFont: 'google-sans-code', tableWeight: 400 }

type SettingsState = Settings & {
  setTheme: (theme: ThemeId) => void
  setTableFont: (tableFont: TableFontId) => void
  setTableWeight: (tableWeight: FontWeight) => void
  reset: () => void
}

/** Keeps each stored value only if it is one we know, so an edited / old / corrupted entry can't break the UI. */
export function sanitize(input: unknown): Settings {
  const v = (input ?? {}) as Partial<Record<keyof Settings, unknown>>
  return {
    theme: THEMES.find((t) => t.id === v.theme)?.id ?? DEFAULT_SETTINGS.theme,
    tableFont: TABLE_FONTS.find((f) => f.id === v.tableFont)?.id ?? DEFAULT_SETTINGS.tableFont,
    tableWeight: FONT_WEIGHTS.find((w) => w.value === v.tableWeight)?.value ?? DEFAULT_SETTINGS.tableWeight,
  }
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      setTheme: (theme) => set({ theme }),
      setTableFont: (tableFont) => set({ tableFont }),
      setTableWeight: (tableWeight) => set({ tableWeight }),
      reset: () => set(DEFAULT_SETTINGS),
    }),
    {
      name: 'erd-designer-settings',
      version: 1,
      partialize: (s) => ({ theme: s.theme, tableFont: s.tableFont, tableWeight: s.tableWeight }),
      merge: (persisted, current) => ({ ...current, ...sanitize(persisted) }),
    },
  ),
)

/** Puts the settings on <html>: the theme attribute (colours) and the table font variables. */
export function applySettings(s: Settings) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = s.theme
  root.style.setProperty('--table-font-family', TABLE_FONTS.find((f) => f.id === s.tableFont)!.family)
  root.style.setProperty('--table-font-weight', String(s.tableWeight))
}

// Apply at start-up (the store has already read localStorage) and on every change.
applySettings(useSettings.getState())
useSettings.subscribe(applySettings)
