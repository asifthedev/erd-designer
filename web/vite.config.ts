import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The Express API lives in ../erd-designer-api; proxying keeps the session cookie same-origin.
    proxy: { '/api': 'http://127.0.0.1:3001' },
  },
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
