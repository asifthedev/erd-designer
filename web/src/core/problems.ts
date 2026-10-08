import type { RelationIssue } from './relations'

/**
 * What the person sees when something about a relation does not work. Every message has the same short shape, so it
 * can be read in a glance:
 *   title  - what happened, in a few words
 *   where  - the columns involved, as `table.column → table.column`
 *   reason - one plain sentence on why (using the names and types from the diagram, no tool jargon)
 *   fix    - one sentence on what to do next
 */
export type Problem = { title: string; reason: string; fix?: string; where?: string }

/** Explains one relation issue (see checkRelations) in plain words. */
export function explainIssue(i: RelationIssue): Problem {
  const { table, column, columnType, targetTable, targetColumn, targetColumnType } = i.names
  const where = i.label
  switch (i.kind) {
    case 'type':
      // typeMismatch() words the MySQL integer-size case as "MySQL needs identical integer types ...".
      if (i.message.startsWith('MySQL')) {
        return {
          title: "Integer sizes don't match",
          where,
          reason: `MySQL needs ${column} (${columnType}) and ${targetColumn} (${targetColumnType}) to be exactly the same integer type.`,
          fix: 'Use the same integer type on both columns.',
        }
      }
      return {
        title: "Column types don't match",
        where,
        reason: `${table}.${column} is ${columnType}, but ${targetTable}.${targetColumn} is ${targetColumnType}.`,
        fix: 'Give both columns the same type.',
      }
    case 'unique':
      return {
        title: "The target column isn't unique",
        where,
        reason: `${targetTable}.${targetColumn} is not a primary key or unique, so one value could match many rows.`,
        fix: `Mark ${targetColumn} as PK or UQ.`,
      }
    case 'nullable':
      return {
        title: 'NOT NULL conflicts with SET NULL',
        where,
        reason: `When a ${targetTable} row is deleted, ${column} should become empty, but it is marked NOT NULL.`,
        fix: `Turn off NN on ${column}, or pick another ON DELETE action.`,
      }
  }
}

/** A relation that was taken off the canvas because it can't work (after a type or database change). */
export function removedProblem(i: RelationIssue): Problem {
  const p = explainIssue(i)
  return { ...p, title: 'Relation removed', fix: `${p.fix} Then draw the relation again.` }
}

/** A relation the person tried to draw but that could not be created. */
export function refusedProblem(i: RelationIssue): Problem {
  return { ...explainIssue(i), title: 'Relation not created' }
}

/** Shown when someone on the Free plan tries to create more diagrams than the plan includes. */
export function planLimitProblem(maxDiagrams: number): Problem {
  const what = maxDiagrams === 1 ? 'one diagram' : `${maxDiagrams} diagrams`
  return {
    title: 'Free plan limit reached',
    reason: `You can only create ${what} on the Free plan.`,
    fix: 'Please upgrade your plan to create more.',
  }
}
