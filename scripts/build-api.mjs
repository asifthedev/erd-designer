// Bundles the Express API into a single ESM file for Vercel's serverless runtime.
//
// Why bundle: the server is written as extension-less TypeScript imports ('./app'), which Node's ESM loader
// can't resolve at runtime. esbuild inlines our own code (including the generated Prisma client) and leaves
// npm packages external, so Vercel installs and traces them as usual.
import { build } from 'esbuild'

await build({
  entryPoints: ['server/src/vercel.ts'],
  outfile: 'api/_server.mjs', // the leading underscore keeps Vercel from exposing it as a route
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: false,
  logLevel: 'info',
})
