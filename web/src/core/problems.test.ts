import { describe, expect, it } from 'vitest'
import type { Column, Diagram, Provider } from './model'
import { explainIssue, planLimitProblem, refusedProblem, removedProblem } from './problems'
import { checkRelations } from './relations'

const col = (id: string, name: string, type: string, extra: Partial<Column> = {}): Column => ({
  id,
  name,
  type,
  primaryKey: false,
  notNull: false,
  unique: false,
  default: '',
  ...extra,
})

/** users(id) <- posts(author_id): the pieces each test bends to break the relation in one specific way. */
function scenario(opts: {
  provider?: Provider
  parentType?: string
  childType?: string
  parentKey?: boolean
  childNotNull?: boolean
  onDelete?: 'SET NULL'
}): Diagram {
  const references = { tableId: 'users', columnId: 'u_id', ...(opts.onDelete ? { onDelete: opts.onDelete } : {}) }
  return {
    provider: opts.provider ?? 'postgresql',
    tables: [
      {
        id: 'users',
        name: 'users',
        columns: [col('u_id', 'id', opts.parentType ?? 'SERIAL', { primaryKey: opts.parentKey ?? true })],
      },
      {
        id: 'posts',
        name: 'posts',
        columns: [col('p_author', 'author_id', opts.childType ?? 'INT', { notNull: !!opts.childNotNull, references })],
      },
    ],
  }
}

const issueOf = (d: Diagram) => {
  const issues = checkRelations(d)
  expect(issues).toHaveLength(1)
  return issues[0]
}

describe('friendly relation messages', () => {
  it('names the real columns and SQL types when the types differ', () => {
    const p = explainIssue(issueOf(scenario({ childType: 'TEXT' })))
    expect(p.title).toBe("Column types don't match")
    expect(p.where).toBe('posts.author_id → users.id')
    expect(p.reason).toBe('posts.author_id is TEXT, but users.id is SERIAL.')
    expect(p.fix).toBe('Give both columns the same type.')
  })

  it('explains the MySQL integer-size rule on its own', () => {
    const p = explainIssue(issueOf(scenario({ provider: 'mysql', parentType: 'INT', childType: 'TINYINT' })))
    expect(p.title).toBe("Integer sizes don't match")
    expect(p.reason).toContain('INT')
    expect(p.reason).toContain('TINYINT')
  })

  it('explains a target column that is not unique', () => {
    const p = explainIssue(issueOf(scenario({ parentKey: false })))
    expect(p.title).toBe("The target column isn't unique")
    expect(p.fix).toBe('Mark id as PK or UQ.')
  })

  it('explains NOT NULL together with ON DELETE SET NULL', () => {
    const p = explainIssue(issueOf(scenario({ childNotNull: true, onDelete: 'SET NULL' })))
    expect(p.title).toBe('NOT NULL conflicts with SET NULL')
    expect(p.fix).toContain('Turn off NN on author_id')
  })

  it('keeps every message short, finished and free of tool jargon (low reading effort)', () => {
    const cases = [
      scenario({ childType: 'TEXT' }),
      scenario({ provider: 'mysql', parentType: 'INT', childType: 'TINYINT' }),
      scenario({ parentKey: false }),
      scenario({ childNotNull: true, onDelete: 'SET NULL' }),
    ]
    for (const d of cases) {
      const i = issueOf(d)
      for (const p of [explainIssue(i), removedProblem(i), refusedProblem(i)]) {
        expect(p.title.length, p.title).toBeLessThanOrEqual(40)
        expect(p.reason.length, p.reason).toBeLessThanOrEqual(150)
        expect((p.fix ?? '').length, p.fix).toBeLessThanOrEqual(120)
        expect(p.reason.endsWith('.'), p.reason).toBe(true)
        expect(p.fix?.endsWith('.'), p.fix).toBe(true)
        expect(`${p.title} ${p.reason} ${p.fix}`).not.toMatch(/scalar|prisma|\b(String|Int|BigInt) vs\b/i)
      }
    }
  })

  it('wraps the same explanation as a removal or a refusal', () => {
    const i = issueOf(scenario({ childType: 'TEXT' }))
    expect(removedProblem(i).title).toBe('Relation removed')
    expect(removedProblem(i).reason).toBe(explainIssue(i).reason)
    expect(removedProblem(i).fix).toContain('draw the relation again')
    expect(refusedProblem(i).title).toBe('Relation not created')
  })
})

describe('free plan limit message', () => {
  it('tells the person what the limit is and what to do, in the three-part shape every message has', () => {
    expect(planLimitProblem(1)).toEqual({
      title: 'Free plan limit reached',
      reason: 'You can only create one diagram on the Free plan.',
      fix: 'Please upgrade your plan to create more.',
    })
  })

  it('says the number when the plan allows more than one', () => {
    expect(planLimitProblem(3).reason).toBe('You can only create 3 diagrams on the Free plan.')
  })
})
