import { ArrowRight, Moon, Sun } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '@/auth/store'
import { APP_PATH, link } from '@/lib/route'

/**
 * The marketing page at "/": a hero, then one block per feature (heading, one sentence, screenshot).
 * It has its own light / dark mode (white and midnight), independent from the editor's themes in Settings.
 * Colours are the --l-* variables defined under ".landing" in index.css.
 */

type Mode = 'light' | 'dark'
const MODE_KEY = 'erd-landing-mode'

/** Saved choice, else the system preference. Storage can throw (private windows), so it is always optional. */
function initialMode(): Mode {
  try {
    const saved = localStorage.getItem(MODE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* ignore */
  }
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

type Feature = { id: string; label: string; title: string; text: string; image: string; alt: string; size: [number, number] }

const FEATURES: Feature[] = [
  {
    id: 'canvas',
    label: 'Canvas',
    title: 'Relations that stay clean.',
    text: 'Drag tables anywhere. Lines stay orthogonal, route around tables, and light up when you hover a table.',
    image: '/landing/canvas.webp',
    size: [2680, 1416],
    alt: 'Tables connected by green relation lines, highlighted on hover',
  },
  {
    id: 'code',
    label: 'Code',
    title: 'Your schema, as code.',
    text: 'Prisma, Drizzle and SQL update as you draw. Production conventions, validated against the real tools.',
    image: '/landing/code.webp',
    size: [2220, 1440],
    alt: 'The diagram next to its generated schema.prisma',
  },
  {
    id: 'erds',
    label: 'Projects',
    title: 'Saved to your account.',
    text: 'Changes save themselves, and your diagram opens where you left it, on any device.',
    image: '/landing/erds.webp',
    size: [1920, 1280],
    alt: 'The list of saved ERDs next to the canvas',
  },
  {
    id: 'look',
    label: 'Themes',
    title: 'Make it yours.',
    text: 'Four themes and your choice of table font and weight, for long sessions that stay easy on the eyes.',
    image: '/landing/settings.webp',
    size: [2040, 1360],
    alt: 'The settings menu with four themes',
  },
]

/** A screenshot in a soft frame. Pixel sizes are passed so the browser reserves the space and the page never jumps. */
function Shot({ src, alt, size = [2880, 1800], eager }: { src: string; alt: string; size?: [number, number]; eager?: boolean }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-(--l-line) bg-(--l-panel) shadow-[0_30px_80px_-30px_var(--l-shadow)]">
      <img
        src={src}
        alt={alt}
        width={size[0]}
        height={size[1]}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className="block h-auto w-full"
      />
    </div>
  )
}

function FeatureRow({ feature, flip }: { feature: Feature; flip: boolean }) {
  return (
    <section id={feature.id} className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-16 md:grid-cols-12 md:gap-14 md:py-24">
      <div className={`md:col-span-5 ${flip ? 'md:order-2' : ''}`}>
        <p className="mb-4 text-sm text-(--l-muted)">{feature.label}</p>
        <h2 className="text-4xl leading-[1.08] font-medium tracking-[-0.03em] text-balance md:text-5xl">{feature.title}</h2>
        <p className="mt-5 max-w-md text-lg leading-relaxed text-(--l-muted)">{feature.text}</p>
      </div>
      <div className={`md:col-span-7 ${flip ? 'md:order-1' : ''}`}>
        <Shot src={feature.image} alt={feature.alt} size={feature.size} />
      </div>
    </section>
  )
}

function Cta({ children, variant = 'solid' }: { children: ReactNode; variant?: 'solid' | 'ghost' }) {
  const base =
    'inline-flex h-12 items-center gap-2 rounded-full px-6 text-[15px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-(--l-ink) focus-visible:ring-offset-2 focus-visible:ring-offset-(--l-bg)'
  const look =
    variant === 'solid'
      ? 'bg-(--l-ink) text-(--l-bg) hover:opacity-85'
      : 'border border-(--l-line) text-(--l-ink) hover:bg-(--l-hover)'
  return (
    <a href={APP_PATH} onClick={link(APP_PATH)} className={`${base} ${look}`}>
      {children}
    </a>
  )
}

export function Landing() {
  const [mode, setMode] = useState<Mode>(initialMode)
  const signedIn = useAuth((s) => s.status === 'authed')

  // Page chrome follows the mode: browser scrollbars / overscroll colour and the tab title.
  useEffect(() => {
    const root = document.documentElement
    const before = { scheme: root.style.colorScheme, bg: document.body.style.background, title: document.title }
    root.style.colorScheme = mode
    document.body.style.background = mode === 'light' ? '#ffffff' : '#0d0f14'
    document.title = 'erd.designer · Design your database visually'
    return () => {
      root.style.colorScheme = before.scheme
      document.body.style.background = before.bg
      document.title = before.title
    }
  }, [mode])

  const toggle = () => {
    const next: Mode = mode === 'light' ? 'dark' : 'light'
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      /* ignore */
    }
  }

  return (
    <div data-mode={mode} className="landing min-h-full bg-(--l-bg) font-ui text-(--l-ink) antialiased">
      <header className="sticky top-0 z-20 border-b border-(--l-line) bg-(--l-bg)/80 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-6" aria-label="Main">
          <a href="/" onClick={link('/')} className="mr-auto text-[17px] font-medium tracking-tight">
            erd<span className="text-(--l-muted)">.designer</span>
          </a>
          <button
            type="button"
            onClick={toggle}
            aria-label={mode === 'light' ? 'Switch to the dark theme' : 'Switch to the light theme'}
            title={mode === 'light' ? 'Dark theme' : 'Light theme'}
            className="grid size-9 cursor-pointer place-items-center rounded-full text-(--l-muted) transition-colors outline-none hover:bg-(--l-hover) hover:text-(--l-ink) focus-visible:ring-2 focus-visible:ring-(--l-ink)"
          >
            {mode === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <a
            href={APP_PATH}
            onClick={link(APP_PATH)}
            className="ml-1 inline-flex h-9 items-center rounded-full bg-(--l-ink) px-4 text-sm font-medium text-(--l-bg) transition-opacity outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-(--l-ink) focus-visible:ring-offset-2 focus-visible:ring-offset-(--l-bg)"
          >
            {signedIn ? 'Open editor' : 'Get started'}
          </a>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(60%_60%_at_50%_0%,var(--l-glow),transparent)]" />
          <div className="relative mx-auto max-w-4xl px-6 pt-20 text-center md:pt-32">
            <h1 className="text-5xl leading-[1.04] font-medium tracking-[-0.035em] text-balance sm:text-6xl md:text-7xl">
              Design your database, visually.
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-(--l-muted) md:text-xl">
              Draw tables and relations on a canvas. Get Prisma, Drizzle and SQL as you go.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Cta>
                {signedIn ? 'Open editor' : 'Start designing'}
                <ArrowRight size={17} />
              </Cta>
              <a
                href="#canvas"
                className="inline-flex h-12 items-center rounded-full px-5 text-[15px] font-medium text-(--l-muted) transition-colors hover:text-(--l-ink)"
              >
                See how it works
              </a>
            </div>
            <p className="mt-4 text-sm text-(--l-muted)">No account needed to try it.</p>
          </div>
          <div className="relative mx-auto mt-14 max-w-6xl px-6 md:mt-20">
            <Shot src="/landing/hero.webp" alt="The erd.designer editor showing four connected tables" eager />
          </div>
        </section>

        {FEATURES.map((f, i) => (
          <FeatureRow key={f.id} feature={f} flip={i % 2 === 1} />
        ))}

        {/* Closing call to action */}
        <section className="mx-auto max-w-4xl px-6 py-24 text-center md:py-32">
          <h2 className="text-4xl leading-[1.06] font-medium tracking-[-0.03em] text-balance md:text-6xl">Start with a blank canvas.</h2>
          <div className="mt-9 flex justify-center">
            <Cta>
              {signedIn ? 'Open editor' : 'Start designing'}
              <ArrowRight size={17} />
            </Cta>
          </div>
        </section>
      </main>

      <footer className="border-t border-(--l-line)">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-8 text-sm text-(--l-muted)">
          <span>
            erd<span className="opacity-60">.designer</span>
          </span>
          <a href={APP_PATH} onClick={link(APP_PATH)} className="transition-colors hover:text-(--l-ink)">
            Open editor
          </a>
        </div>
      </footer>
    </div>
  )
}
