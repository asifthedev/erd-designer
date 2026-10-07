import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/client'
import { config } from './config'

// One client (= one connection pool) per process. On serverless every instance holds its own pool, so keep
// it small and let the database's pooler (the `-pooler` / `pooled.` host) multiplex the connections.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: config.DATABASE_URL,
    max: config.isProd ? 3 : 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  }),
})
