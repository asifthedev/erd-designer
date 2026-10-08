/**
 * Makes the value for ADMIN_PASSWORD_HASH:  npm run admin:hash -w server
 * It asks for the password (nothing is shown while typing, nothing is saved) and prints the hash. The hash is safe to
 * put in an environment variable; the password itself is never stored anywhere.
 */
import { hashPassword } from '../src/auth/password'

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stdout.write(prompt)
    if (!stdin.isTTY) {
      // Piped in (printf '%s' "$PASSWORD" | npm run admin:hash -w server): take the whole input as the password.
      let text = ''
      stdin.setEncoding('utf8')
      stdin.on('data', (chunk) => (text += chunk))
      stdin.on('end', () => {
        process.stdout.write('\n')
        resolve(text.replace(/\r?\n$/, ''))
      })
      return
    }
    let typed = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          resolve(typed)
          return
        }
        if (ch === '\u0003') process.exit(130) // Ctrl+C
        if (ch === '\u007f' || ch === '\b') typed = typed.slice(0, -1)
        else typed += ch
      }
    }
    stdin.on('data', onData)
  })
}

const MIN_LENGTH = 12
const password = await ask('Admin password: ')
if (password.length < MIN_LENGTH) {
  console.error(`Too short: use at least ${MIN_LENGTH} characters (a few random words is a good password).`)
  process.exit(1)
}
if (process.stdin.isTTY && (await ask('Type it again: ')) !== password) {
  console.error('The two passwords do not match.')
  process.exit(1)
}
const hash = await hashPassword(password)
console.log('\nSet these two environment variables on the server (Vercel: Settings -> Environment Variables):\n')
console.log('ADMIN_EMAIL=<the admin email you want to log in with>')
console.log(`ADMIN_PASSWORD_HASH=${hash}`)
console.log('\nIn a .env file, put the hash in single quotes (it contains $ signs):')
console.log(`ADMIN_PASSWORD_HASH='${hash}'`)
