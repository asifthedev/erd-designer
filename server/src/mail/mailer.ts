import { createTransport, type Transporter } from 'nodemailer'
import { config } from '../config'

export type Mail = { to: string; subject: string; text: string; html: string }
export interface Mailer {
  send(mail: Mail): Promise<void>
}

let transport: Transporter | undefined
/** Real delivery over SMTP. Timeouts are short: a request must not hang on a slow mail server. */
const smtpMailer: Mailer = {
  async send(mail) {
    transport ??= createTransport({
      url: config.SMTP_URL,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    })
    await transport.sendMail({ from: config.MAIL_FROM, ...mail })
  },
}

/** Development convenience: prints the email (and so the code) to the server console. Never used in production. */
const consoleMailer: Mailer = {
  async send(mail) {
    console.log(`\n--- email to ${mail.to} -------------------------\nSubject: ${mail.subject}\n\n${mail.text}\n---\n`)
  },
}

let override: Mailer | null | undefined
/**
 * Tests plug in a mailer that records what would have been sent, or `null` to simulate a server without email
 * set up. Pass nothing to restore the default.
 */
export const setMailer = (mailer?: Mailer | null) => {
  override = mailer
}

/** The mailer to use, or null when none is available (production without SMTP settings). */
export function getMailer(): Mailer | null {
  if (override !== undefined) return override
  if (config.SMTP_URL && config.MAIL_FROM) return smtpMailer
  return config.isProd ? null : consoleMailer
}
