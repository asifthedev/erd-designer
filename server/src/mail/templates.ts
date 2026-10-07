import type { Mail } from './mailer'

const APP = 'erd.designer'
export const CODE_MINUTES = 10

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One shared, plain layout: a heading, a few lines, and optionally the code in large type. */
function layout(to: string, subject: string, lines: string[], code?: string): Mail {
  const text = [...lines, ...(code ? ['', `    ${code}`, ''] : [])].join('\n')
  const paragraphs = lines.map((l) => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join('')
  const codeBlock = code
    ? `<p style="margin:20px 0;font:600 32px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:8px">${escapeHtml(code)}</p>`
    : ''
  const html =
    `<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1f2430;max-width:480px">` +
    `<p style="margin:0 0 16px;font-weight:600">${APP}</p>${paragraphs}${codeBlock}</div>`
  return { to, subject, text, html }
}

export const signupCodeMail = (to: string, code: string) =>
  layout(
    to,
    `${code} is your ${APP} verification code`,
    [
      `Use this code to finish creating your ${APP} account. It expires in ${CODE_MINUTES} minutes.`,
      "If you didn't ask for it, you can ignore this email: no account is created without the code.",
    ],
    code,
  )

/** Sent instead of a code when someone starts signing up with an address that already has an account. */
export const alreadyRegisteredMail = (to: string) =>
  layout(to, `You already have an ${APP} account`, [
    `Someone (hopefully you) tried to create an ${APP} account with this email address, but one already exists.`,
    'Log in with your password, or use "Forgot password" on the log-in screen to choose a new one.',
    "If it wasn't you, you can ignore this email.",
  ])

export const resetCodeMail = (to: string, code: string) =>
  layout(
    to,
    `${code} is your ${APP} password reset code`,
    [
      `Use this code to choose a new password for your ${APP} account. It expires in ${CODE_MINUTES} minutes.`,
      "If you didn't ask for this, ignore this email: your password has not changed.",
    ],
    code,
  )
