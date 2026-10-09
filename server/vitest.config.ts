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
      // The AI assistant talks to a fake gateway the tests start on this port (src/ai/testing/fakeGateway.ts).
      AI_GATEWAY_API_KEY: 'test-gateway-key',
      AI_GATEWAY_BASE_URL: 'http://127.0.0.1:49400/v1',
      AI_MODELS: 'test/smart-a,test/smart-b,test/fast-a|fast,test/fast-b|fast',
      AI_DAILY_LIMIT_FREE: '3',
      AI_DAILY_LIMIT_PAID: '50',
      AI_MAX_DAILY_SPEND_USD: '5',
      AI_REQUEST_TIMEOUT_MS: '8000',
    },
    fileParallelism: false, // the integration suite shares one database
  },
})
