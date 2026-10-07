import { Eye, EyeOff, LoaderCircle, MailCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { ApiError } from '@/auth/api'
import { useAuth } from '@/auth/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Mode = 'login' | 'signup' | 'forgot'
/** `form`: the details; `code`: the 6-digit code that was just emailed (sign-up and forgot password both use it). */
type Step = 'form' | 'code'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Full-screen log in / sign up / forgot password. Creating an account and choosing a new password both need the
 * 6-digit code emailed to the address. "Continue without saving" keeps the old local-only way of working.
 */
export function AuthScreen() {
  const login = useAuth((s) => s.login)
  const signup = useAuth((s) => s.signup)
  const requestSignupCode = useAuth((s) => s.requestSignupCode)
  const requestResetCode = useAuth((s) => s.requestResetCode)
  const resetPassword = useAuth((s) => s.resetPassword)
  const continueAsGuest = useAuth((s) => s.continueAsGuest)

  const [mode, setMode] = useState<Mode>('login')
  const [step, setStep] = useState<Step>('form')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Seconds until another code may be requested (the server enforces it too). */
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const reset = (nextMode: Mode, nextStep: Step = 'form') => {
    setMode(nextMode)
    setStep(nextStep)
    setError(null)
    setNotice(null)
    setCode('')
    setBusy(false)
  }

  const fail = (err: unknown) => {
    const apiErr = err instanceof ApiError ? err : undefined
    setError({ message: (err as Error).message, field: apiErr?.field })
    if (apiErr?.retryAfter) setCooldown(apiErr.retryAfter) // "wait N seconds": show the countdown
    setBusy(false)
  }

  /** Asks for a code to be emailed; `onSent` runs once it is on its way. */
  const sendCode = async (request: (email: string) => Promise<number>, onSent?: () => void) => {
    setBusy(true)
    setError(null)
    try {
      setCooldown(await request(email.trim()))
      setNotice(null)
      onSent?.()
      setBusy(false)
    } catch (err) {
      fail(err)
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (mode === 'login') {
      setBusy(true)
      try {
        await login(email, password)
      } catch (err) {
        fail(err)
      }
      return
    }

    // Sign up and forgot password share the shape: details -> emailed code -> done.
    if (!EMAIL.test(email.trim())) return setError({ message: 'Enter a valid email address', field: 'email' })
    if (step === 'form') {
      if (mode === 'signup' && password.length < 8) {
        return setError({ message: 'Use at least 8 characters', field: 'password' })
      }
      return sendCode(mode === 'signup' ? requestSignupCode : requestResetCode, () => setStep('code'))
    }

    if (!/^\d{6}$/.test(code)) return setError({ message: 'Enter the 6-digit code from the email', field: 'code' })
    if (mode === 'forgot' && password.length < 8) {
      return setError({ message: 'Use at least 8 characters', field: 'password' })
    }
    setBusy(true)
    try {
      if (mode === 'signup') {
        await signup({ name, email, password, code })
      } else {
        await resetPassword({ email, code, password })
        setPassword('')
        reset('login')
        setNotice('Your password was changed. Log in with the new one.')
      }
    } catch (err) {
      fail(err)
    }
  }

  const heading = {
    login: 'Log in to open your saved diagrams.',
    signup: step === 'code' ? 'Check your email.' : 'Create an account to save your work.',
    forgot: step === 'code' ? 'Check your email.' : 'Forgot your password? We will email you a code.',
  }[mode]

  const submitLabel = {
    login: 'Log in',
    signup: step === 'code' ? 'Create account' : 'Send verification code',
    forgot: step === 'code' ? 'Change password' : 'Send reset code',
  }[mode]

  return (
    <main className="font-ui grid min-h-full place-items-center bg-canvas bg-[radial-gradient(var(--color-dot)_1.5px,transparent_1.5px)] [background-size:24px_24px] px-4 text-ink">
      <div className="w-full max-w-[400px] rounded-2xl border border-line bg-surface p-8 shadow-2xl shadow-black/40">
        <h1 className="font-mono text-xl font-semibold">
          <span className="text-key">erd</span>
          <span className="text-muted">.designer</span>
        </h1>
        <p className="mt-1 text-muted">{heading}</p>

        {mode !== 'forgot' && step === 'form' && (
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
                onClick={() => reset(value)}
                className={`cursor-pointer rounded-md py-1.5 font-medium ${
                  mode === value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
          {notice && (
            <p
              role="status"
              className="rounded-md border border-link/40 bg-link/10 px-3 py-2 text-[14px] text-link"
            >
              {notice}
            </p>
          )}

          {step === 'code' ? (
            <>
              <p className="flex items-start gap-2 text-[14px] text-muted">
                <MailCheck size={18} className="mt-0.5 shrink-0 text-key" aria-hidden />
                <span>
                  We sent a 6-digit code to <strong className="break-all text-ink">{email.trim()}</strong>. It expires in
                  10 minutes. Not there? Look in your spam folder.
                </span>
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="code">Verification code</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={6}
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  aria-invalid={error?.field === 'code' || undefined}
                  className="text-center font-mono text-lg tracking-[0.5em]"
                />
              </div>
            </>
          ) : (
            <>
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
            </>
          )}

          {/* The password: yours at log in, the one to create at sign-up, the NEW one when resetting (after the code). */}
          {(mode !== 'forgot' || step === 'code') && (step === 'form' || mode === 'forgot') && (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="password">{mode === 'forgot' ? 'New password' : 'Password'}</Label>
                {mode === 'login' && (
                  <button
                    type="button"
                    onClick={() => reset('forgot')}
                    className="cursor-pointer text-[13px] text-key hover:underline"
                  >
                    Forgot password?
                  </button>
                )}
              </div>
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
              {mode !== 'login' && <p className="text-[13px] text-muted">At least 8 characters.</p>}
            </div>
          )}

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
            {submitLabel}
          </Button>

          {step === 'code' && (
            <div className="flex items-center justify-between text-[13px]">
              <button
                type="button"
                onClick={() => reset(mode)}
                className="cursor-pointer text-muted hover:text-ink"
              >
                Use a different email
              </button>
              <button
                type="button"
                disabled={busy || cooldown > 0}
                onClick={() => void sendCode(mode === 'signup' ? requestSignupCode : requestResetCode, () => setCode(''))}
                className="cursor-pointer text-key hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline"
              >
                {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
              </button>
            </div>
          )}

          {mode === 'forgot' && step === 'form' && (
            <button
              type="button"
              onClick={() => reset('login')}
              className="w-full cursor-pointer text-center text-[13px] text-muted hover:text-ink"
            >
              Back to log in
            </button>
          )}
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
