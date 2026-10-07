/// <reference types="node" />
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Diagram, Provider } from './model'
import { generatePrisma } from './prisma'
import { kitchenSink, randomDiagram } from './testing/fixtures'

/**
 * Battle tests: every schema the generator writes is checked by the REAL Prisma validator (`prisma validate`, the
 * same code `prisma migrate` runs), not by pattern matching. Random but seeded diagrams, so a failure names its seed.
 */

const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('prisma/package.json')), 'build', 'index.js')
const PROVIDERS: Provider[] = ['postgresql', 'mysql', 'sqlite']
const SEEDS = Number(process.env.BATTLE_SEEDS ?? 30) // BATTLE_SEEDS=150 for a heavier one-off run

let dir: string
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'erd-prisma-battle-'))
  mkdirSync(dir, { recursive: true })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Verdict = { ok: boolean; output: string }
const run = (args: string[]) =>
  new Promise<Verdict>((resolve) =>
    execFile(process.execPath, [cli, ...args], { cwd: dir, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${stdout}${stderr}`.replace(/\u001b\[[0-9;]*m/g, '') }),
    ),
  )

/** Real validation, in parallel batches so 90 schemas take seconds, not minutes. */
async function validateAll(items: { label: string; schema: string }[]) {
  const failures: string[] = []
  const batch = 8
  for (let i = 0; i < items.length; i += batch) {
    await Promise.all(
      items.slice(i, i + batch).map(async ({ label, schema }, j) => {
        const file = path.join(dir, `s${i + j}.prisma`)
        writeFileSync(file, schema)
        const v = await run(['validate', '--schema', file])
        if (!v.ok) failures.push(`--- ${label}\n${v.output.trim().split('\n').slice(0, 14).join('\n')}\n${schema}`)
      }),
    )
  }
  return failures
}

describe('Prisma output, validated by Prisma itself', () => {
  it('the Prisma CLI is wired up and really rejects a bad schema (so a pass means something)', async () => {
    const bad = path.join(dir, 'bad.prisma')
    writeFileSync(bad, 'model A {\n  id Int @id\n  b B @relation(fields: [id], references: [nope])\n}\n')
    expect((await run(['validate', '--schema', bad])).ok).toBe(false)
    const good = path.join(dir, 'good.prisma')
    writeFileSync(good, 'model A {\n  id Int @id\n}\n')
    expect((await run(['validate', '--schema', good])).ok).toBe(true)
  }, 60_000)

  it.each(PROVIDERS)('%s: the kitchen-sink diagram is a valid schema', async (provider) => {
    const d = kitchenSink(provider)
    const { schema } = generatePrisma(d)
    const failures = await validateAll([{ label: `kitchen sink (${provider})`, schema }])
    expect(failures.join('\n')).toBe('')
  }, 120_000)

  it.each(PROVIDERS)(`%s: ${SEEDS} random diagrams all produce valid schemas`, async (provider) => {
    const items = Array.from({ length: SEEDS }, (_, seed) => {
      const diagram: Diagram = randomDiagram(seed + 1, provider)
      return { label: `seed ${seed + 1} (${provider})`, schema: generatePrisma(diagram).schema }
    })
    const failures = await validateAll(items)
    expect(failures.slice(0, 3).join('\n\n')).toBe('') // show the first few, with the offending schema
    expect(failures).toHaveLength(0)
  }, 240_000)

  it('the schema is already in `prisma format` shape (nothing left for the formatter to change)', async () => {
    const items = [kitchenSink('postgresql'), randomDiagram(7, 'postgresql'), randomDiagram(11, 'mysql')]
    for (const [i, diagram] of items.entries()) {
      const { schema } = generatePrisma(diagram)
      const file = path.join(dir, `fmt${i}.prisma`)
      writeFileSync(file, schema)
      const formatted = await run(['format', '--schema', file])
      expect(formatted.ok, formatted.output).toBe(true)
      const { readFileSync } = await import('node:fs')
      expect(readFileSync(file, 'utf8')).toBe(schema)
    }
  }, 120_000)
})
