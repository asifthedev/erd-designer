import cookieParser from 'cookie-parser'
import express, { type ErrorRequestHandler } from 'express'
import helmet from 'helmet'
import { ZodError } from 'zod'
import { config } from './config'
import { attachUser, originCheck } from './middleware/auth'
import { authRouter } from './routes/auth'
import { diagramsRouter } from './routes/diagrams'
import { settingsRouter } from './routes/settings'
import { globalLimiter } from './security/limiters'

/** Builds the Express app. Kept separate from `listen()` so tests and the serverless entry can reuse it. */
export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  if (config.trustProxy) app.set('trust proxy', 1)

  app.use(helmet())
  app.use(cookieParser())

  // Cheap and DB-free, so uptime monitors don't count against (or load) anything.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  // JSON body parsing is mounted per router (small cap for auth, 2 MB only for authenticated saves).
  app.use('/api', globalLimiter, originCheck, attachUser)
  app.use('/api/auth', authRouter)
  app.use('/api/diagrams', diagramsRouter)
  app.use('/api/settings', settingsRouter)

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      // First problem only, in plain words: the UI shows it under the form.
      res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid input', field: err.issues[0]?.path[0] })
      return
    }
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request is too large' })
      return
    }
    if (err?.type === 'encoding.unsupported' || err?.type === 'charset.unsupported') {
      res.status(415).json({ error: 'Unsupported encoding' })
      return
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'Invalid JSON' })
      return
    }
    console.error(err)
    res.status(500).json({ error: 'Something went wrong' })
  }
  app.use(onError)

  return app
}
