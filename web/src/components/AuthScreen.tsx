import { Eye, EyeOff, LoaderCircle } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ApiError } from '@/auth/api'
import { useAuth } from '@/auth/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Mode = 'login' | 'signup'

/** Full-screen log in / sign up. "Continue without saving" keeps the old local-only way of working. */
export function AuthScreen() {
  const login = useAuth((s) => s.login)
  const signup = useAuth((s) => s.signup)
  const continueAsGuest = useAuth((s) => s.continueAsGuest)

  const [mode, setMode] = useState<Mode>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)

  const switchMode = (next: Mode) => {
    setMode(next)
    setError(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (mode === 'signup' && password.length < 8) {
      setError({ message: 'Use at least 8 characters', field: 'password' })
      return
    }
    setBusy(true)
    try {
      if (mode === 'login') await login(email, password)
      else await signup({ name, email, password })
    } catch (err) {
      setError({ message: (err as Error).message, field: err instanceof ApiError ? err.field : undefined })
      setBusy(false)
    }
  }

  return (
    <main className="font-ui grid min-h-full place-items-center bg-canvas bg-[radial-gradient(var(--color-dot)_1.5px,transparent_1.5px)] [background-size:24px_24px] px-4 text-ink">
      <div className="w-full max-w-[400px] rounded-2xl border border-line bg-surface p-8 shadow-2xl shadow-black/40">
        <h1 className="font-mono text-xl font-semibold">
          <span className="text-key">erd</span>
          <span className="text-muted">.designer</span>
        </h1>
        <p className="mt-1 text-muted">
          {mode === 'login' ? 'Log in to open your saved diagrams.' : 'Create an account to save your work.'}
        </p>

        <div role="tablist" className="mt-6 grid grid-cols-2 gap-1 rounded-lg bg-canvas p-1">
          {(
            [
              ['login', 'Log in'],
              ['signup', 'Sign up'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => switchMode(value)}
              className={`cursor-pointer rounded-md py-1.5 font-medium ${
                mode === value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
          {mode === 'signup' && (
            <div className="space-y-1.5">
              <Label htmlFor="name">
                Name <span className="text-muted">(optional)</span>
              </Label>
              <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={error?.field === 'email' || undefined}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={show ? 'text' : 'password'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={error?.field === 'password' || undefined}
                className="pr-10"
              />
              <button
                type="button"
                tabIndex={-1}
                aria-label={show ? 'Hide password' : 'Show password'}
                onClick={() => setShow((v) => !v)}
                className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-muted hover:bg-hover hover:text-ink"
              >
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {mode === 'signup' && <p className="text-[13px] text-muted">At least 8 characters.</p>}
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[14px] text-danger"
            >
              {error.message}
            </p>
          )}

          <Button type="submit" disabled={busy} className="h-10 w-full cursor-pointer text-[15px]">
            {busy && <LoaderCircle className="animate-spin" />}
            {mode === 'login' ? 'Log in' : 'Create account'}
          </Button>
        </form>

        <button
          type="button"
          onClick={continueAsGuest}
          className="mt-5 w-full cursor-pointer text-center text-[14px] text-muted hover:text-ink"
        >
          Continue without saving
        </button>
      </div>
    </main>
  )
}
