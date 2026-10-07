import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { ArrowLeft, Check, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, MailCheck, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from '@/auth/api'
import { useAuth } from '@/auth/store'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

/**
 * The pages of the sign-in flow. Log in and sign up share one page (two tabs); each step after that is its own page:
 *   sign up:         signup -> signup-code (the emailed code creates the account)
 *   forgot password: forgot -> forgot-code (is the code right?) -> forgot-password (choose the new password) -> login
 */
type View = 'login' | 'signup' | 'signup-code' | 'forgot' | 'forgot-code' | 'forgot-password'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD = 8

type Problem = { message: string; field?: string }

/** Password field with a show / hide toggle. */
function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  invalid,
  autoFocus,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  invalid?: boolean
  autoFocus?: boolean
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        className="h-10 pr-10"
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
  )
}

/** A small live checklist: green tick once a rule is met. */
function Rule({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={`flex items-center gap-1.5 ${ok ? 'text-link' : 'text-muted'}`}>
      <Check size={13} className={ok ? '' : 'opacity-30'} aria-hidden />
      {children}
    </li>
  )
}

function ErrorNote({ problem }: { problem: Problem | null }) {
  if (!problem) return null
  return (
    <Alert variant="destructive" className="border-danger/40 bg-danger/10">
      <CircleAlert />
      <AlertDescription className="text-danger">{problem.message}</AlertDescription>
    </Alert>
  )
}

/** The 6-digit code boxes. Finishing the 6th digit submits, like most "enter the code we sent you" screens. */
function CodeInput({
  value,
  onChange,
  onComplete,
  invalid,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  onComplete: (value: string) => void
  invalid: boolean
  disabled: boolean
}) {
  const slot = 'size-12 text-xl font-mono sm:size-13'
  return (
    <div className="flex justify-center">
      <InputOTP
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        value={value}
        disabled={disabled}
        onChange={onChange}
        onComplete={onComplete}
        aria-label="6-digit verification code"
      >
        <InputOTPGroup>
          {[0, 1, 2].map((i) => (
            <InputOTPSlot key={i} index={i} aria-invalid={invalid || undefined} className={slot} />
          ))}
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
          {[3, 4, 5].map((i) => (
            <InputOTPSlot key={i} index={i} aria-invalid={invalid || undefined} className={slot} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  )
}

/**
 * Full-screen log in / sign up / forgot password. Creating an account and choosing a new password both need the
 * 6-digit code emailed to the address. "Continue without saving" keeps the old local-only way of working.
 */
export function AuthScreen() {
  const login = useAuth((s) => s.login)
  const signup = useAuth((s) => s.signup)
  const requestSignupCode = useAuth((s) => s.requestSignupCode)
  const requestResetCode = useAuth((s) => s.requestResetCode)
  const verifyResetCode = useAuth((s) => s.verifyResetCode)
  const resetPassword = useAuth((s) => s.resetPassword)
  const continueAsGuest = useAuth((s) => s.continueAsGuest)

  const [view, setView] = useState<View>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Problem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Seconds until another code may be requested (the server enforces it too). */
  const [cooldown, setCooldown] = useState(0)
  /** Bumped after a wrong code, to remount the boxes so the first one is focused again. */
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])

  const go = (next: View, opts: { keepNotice?: boolean } = {}) => {
    setView(next)
    setError(null)
    if (!opts.keepNotice) setNotice(null)
    setCode('')
    setBusy(false)
  }

  const fail = (err: unknown, field?: string) => {
    const apiErr = err instanceof ApiError ? err : undefined
    setError({ message: (err as Error).message, field: apiErr?.field ?? field })
    if (apiErr?.retryAfter) setCooldown(apiErr.retryAfter) // "wait N seconds": show the countdown
    setBusy(false)
  }

  /** Runs a request with the busy state and error handling; resolves true when it worked. */
  const run = async (work: () => Promise<void>, field?: string): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      setBusy(false)
      return true
    } catch (err) {
      fail(err, field)
      return false
    }
  }

  /** Emails a code and moves to the page where it is entered. */
  const sendCode = async (request: (email: string) => Promise<number>, next: View) => {
    if (!EMAIL.test(email.trim())) return setError({ message: 'Enter a valid email address', field: 'email' })
    const sent = await run(async () => setCooldown(await request(email.trim())), 'email')
    if (sent) go(next)
  }

  const resend = async () => {
    const request = view === 'signup-code' ? requestSignupCode : requestResetCode
    if (await run(async () => setCooldown(await request(email.trim())))) {
      setCode('')
      setNotice('A new code is on its way.')
    }
  }

  // ---- the actions of each page -------------------------------------------------------------------------------

  const submitLogin = () => run(() => login(email, password)).then(() => undefined)

  const submitSignupDetails = () => {
    if (password.length < MIN_PASSWORD) return setError({ message: 'Use at least 8 characters', field: 'password' })
    return sendCode(requestSignupCode, 'signup-code')
  }

  const submitSignupCode = async (value: string) => {
    if (!/^\d{6}$/.test(value)) return setError({ message: 'Enter the 6-digit code from the email', field: 'code' })
    const ok = await run(() => signup({ name, email, password, code: value }), 'code')
    if (!ok) {
      setCode('') // wrong code: clear the boxes so the next try starts fresh
      setAttempt((n) => n + 1)
    }
  }

  const submitForgotCode = async (value: string) => {
    if (!/^\d{6}$/.test(value)) return setError({ message: 'Enter the 6-digit code from the email', field: 'code' })
    const ok = await run(() => verifyResetCode({ email: email.trim(), code: value }), 'code')
    if (ok) {
      setCode(value) // kept for the next page, which sends it along with the new password
      setView('forgot-password')
      setError(null)
      setNotice(null)
    } else {
      setCode('')
      setAttempt((n) => n + 1)
    }
  }

  const submitNewPassword = async () => {
    if (password.length < MIN_PASSWORD) return setError({ message: 'Use at least 8 characters', field: 'password' })
    if (password !== confirm) return setError({ message: 'The two passwords do not match', field: 'confirm' })
    setBusy(true)
    setError(null)
    try {
      await resetPassword({ email: email.trim(), code, password })
      setPassword('')
      setConfirm('')
      go('login')
      setNotice('Your password was changed. Log in with the new one.')
    } catch (err) {
      if (err instanceof ApiError && err.field === 'code') {
        // The code ran out or was used up between the two pages: back to the code page to ask for a new one.
        go('forgot-code')
        setAttempt((n) => n + 1)
        setError({ message: 'That code is no longer valid. Request a new one.', field: 'code' })
      } else fail(err)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (view === 'login') void submitLogin()
    else if (view === 'signup') void submitSignupDetails()
    else if (view === 'signup-code') void submitSignupCode(code)
    else if (view === 'forgot') void sendCode(requestResetCode, 'forgot-code')
    else if (view === 'forgot-code') void submitForgotCode(code)
    else void submitNewPassword()
  }

  // ---- layout -------------------------------------------------------------------------------------------------

  const tabbed = view === 'login' || view === 'signup'
  // The selected tab is the card colour on the darker bar (the default would use the page background, i.e. vanish).
  const tab = 'cursor-pointer data-[state=active]:bg-surface dark:data-[state=active]:border-line dark:data-[state=active]:bg-surface'
  const BACK: Partial<Record<View, View>> = {
    'signup-code': 'signup',
    forgot: 'login',
    'forgot-code': 'forgot',
    'forgot-password': 'forgot-code',
  }
  const back = BACK[view]

  const page = {
    login: { icon: null, title: 'Welcome back', text: 'Log in to open your saved diagrams.', action: 'Log in' },
    signup: { icon: null, title: 'Create your account', text: 'Save your diagrams and open them anywhere.', action: 'Send verification code' },
    'signup-code': { icon: <MailCheck />, title: 'Check your email', text: 'Enter the code we sent to confirm your address.', action: 'Create account' },
    forgot: { icon: <KeyRound />, title: 'Forgot your password?', text: "Enter your email and we'll send you a code.", action: 'Send reset code' },
    'forgot-code': { icon: <MailCheck />, title: 'Check your email', text: 'Enter the reset code we sent you.', action: 'Continue' },
    'forgot-password': { icon: <ShieldCheck />, title: 'Choose a new password', text: 'Your code is confirmed. Pick a new password.', action: 'Change password' },
  }[view]

  const codePage = view === 'signup-code' || view === 'forgot-code'

  return (
    <main className="font-ui grid min-h-full place-items-center bg-canvas bg-[radial-gradient(var(--color-dot)_1.5px,transparent_1.5px)] [background-size:24px_24px] px-4 py-8 text-ink">
      <div className="w-full max-w-[420px]">
        <h1 className="mb-5 text-center font-mono text-xl font-semibold">
          <span className="text-key">erd</span>
          <span className="text-muted">.designer</span>
        </h1>

        <Card className="gap-5 border-line py-7 shadow-2xl shadow-black/40">
          {/* key: each page fades in on its own, so moving to the next step is visible */}
          <div key={view} className="animate-in space-y-5 duration-300 fade-in slide-in-from-right-3">
            <CardHeader className="gap-1.5 px-7">
              {back && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => go(back)}
                  className="-ml-3 mb-1 w-fit cursor-pointer text-muted hover:text-ink"
                >
                  <ArrowLeft />
                  Back
                </Button>
              )}
              {page.icon && (
                <div className="mb-1 grid size-11 place-items-center rounded-full bg-key/15 text-key [&_svg]:size-5">
                  {page.icon}
                </div>
              )}
              <CardTitle className="text-xl">{page.title}</CardTitle>
              <CardDescription className="text-[15px] text-muted">{page.text}</CardDescription>
              {codePage && (
                <p className="mt-1 text-[14px] text-muted">
                  Sent to <strong className="font-medium break-all text-ink">{email.trim()}</strong>. It expires in 10 minutes.
                  Not there? Check your spam folder.
                </p>
              )}
            </CardHeader>

            <form onSubmit={onSubmit} noValidate>
              <CardContent className="space-y-4 px-7">
                {tabbed && (
                  <Tabs value={view} onValueChange={(v) => go(v as View)}>
                    <TabsList className="grid h-10 w-full grid-cols-2 bg-canvas">
                      <TabsTrigger value="login" className={tab}>
                        Log in
                      </TabsTrigger>
                      <TabsTrigger value="signup" className={tab}>
                        Sign up
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                )}

                {notice && (
                  <Alert className="border-link/40 bg-link/10 text-link">
                    <Check />
                    <AlertDescription className="text-link">{notice}</AlertDescription>
                  </Alert>
                )}

                {codePage ? (
                  <div className="space-y-3 py-1">
                    <CodeInput
                      key={attempt}
                      value={code}
                      onChange={(v) => {
                        setCode(v)
                        if (error) setError(null)
                      }}
                      onComplete={(v) => void (view === 'signup-code' ? submitSignupCode(v) : submitForgotCode(v))}
                      invalid={error?.field === 'code'}
                      disabled={busy}
                    />
                  </div>
                ) : view === 'forgot-password' ? (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="new-password">New password</Label>
                      <PasswordInput
                        id="new-password"
                        value={password}
                        onChange={setPassword}
                        autoComplete="new-password"
                        autoFocus
                        invalid={error?.field === 'password'}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="confirm-password">Confirm new password</Label>
                      <PasswordInput
                        id="confirm-password"
                        value={confirm}
                        onChange={setConfirm}
                        autoComplete="new-password"
                        invalid={error?.field === 'confirm'}
                      />
                    </div>
                    <ul className="space-y-1 text-[13px]" aria-label="Password requirements">
                      <Rule ok={password.length >= MIN_PASSWORD}>At least 8 characters</Rule>
                      <Rule ok={password.length > 0 && password === confirm}>Both passwords match</Rule>
                    </ul>
                  </>
                ) : (
                  <>
                    {view === 'signup' && (
                      <div className="space-y-1.5">
                        <Label htmlFor="name">
                          Name <span className="text-muted">(optional)</span>
                        </Label>
                        <Input
                          id="name"
                          autoComplete="name"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          className="h-10"
                        />
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
                        className="h-10"
                      />
                    </div>

                    {(view === 'login' || view === 'signup') && (
                      <div className="space-y-1.5">
                        <div className="flex items-baseline justify-between">
                          <Label htmlFor="password">Password</Label>
                          {view === 'login' && (
                            <button
                              type="button"
                              onClick={() => go('forgot')}
                              className="cursor-pointer text-[13px] text-key hover:underline"
                            >
                              Forgot password?
                            </button>
                          )}
                        </div>
                        <PasswordInput
                          id="password"
                          value={password}
                          onChange={setPassword}
                          autoComplete={view === 'login' ? 'current-password' : 'new-password'}
                          invalid={error?.field === 'password'}
                        />
                        {view === 'signup' && <p className="text-[13px] text-muted">At least 8 characters.</p>}
                      </div>
                    )}
                  </>
                )}

                <ErrorNote problem={error} />
              </CardContent>

              <CardFooter className="mt-5 flex-col gap-3 px-7">
                <Button type="submit" disabled={busy} className="h-10 w-full cursor-pointer text-[15px]">
                  {busy && <LoaderCircle className="animate-spin" />}
                  {page.action}
                </Button>

                {codePage && (
                  <p className="text-center text-[13px] text-muted">
                    Didn't get it?{' '}
                    <button
                      type="button"
                      disabled={busy || cooldown > 0}
                      onClick={() => void resend()}
                      className="cursor-pointer font-medium text-key hover:underline disabled:cursor-default disabled:text-muted disabled:no-underline"
                    >
                      {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                    </button>
                  </p>
                )}
              </CardFooter>
            </form>
          </div>
        </Card>

        <Button
          type="button"
          variant="ghost"
          onClick={continueAsGuest}
          className="mt-4 w-full cursor-pointer text-muted hover:text-ink"
        >
          Continue without saving
        </Button>
      </div>
    </main>
  )
}
