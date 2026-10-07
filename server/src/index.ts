import { createApp } from './app'
import { config } from './config'
import { prisma } from './db'

const server = createApp().listen(config.PORT, '127.0.0.1', () => {
  console.log(`erd-designer-api listening on http://127.0.0.1:${config.PORT}`)
})

const shutdown = async () => {
  server.close()
  await prisma.$disconnect()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
