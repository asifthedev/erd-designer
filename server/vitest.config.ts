import { defineConfig } from 'vitest/config'

// Integration tests talk to a real PostgreSQL (never the production database):
//   docker run -d --rm -p 5433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=erd_test postgres:16-alpine
//   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:5433/erd_test npx prisma migrate deploy
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      TRUST_PROXY: '1', // tests choose the client IP per request via X-Forwarded-For
      CODE_REQUEST_MIN_MS: '0', // the real server pads code requests to a minimum duration; tests needn't wait
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
    },
    fileParallelism: false, // the integration suite shares one database
  },
})
