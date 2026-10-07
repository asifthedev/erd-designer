import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { checkRelations, type RelationIssue } from '../core/relations'
import { toDiagram, useStore } from '../store'
import { IssuesContext } from './issuesContext'

const issueKey = (i: RelationIssue) => `${i.tableId}:${i.columnId}:${i.kind}`

export function IssuesProvider({ children }: { children: ReactNode }) {
  const provider = useStore((s) => s.provider)
  const nodes = useStore((s) => s.nodes)
  const purgeInvalid = useStore((s) => s.purgeInvalid)

  // Relations saved earlier (or by an older version) may already be invalid: clean them up on load.
  useEffect(() => purgeInvalid(), [purgeInvalid])

  const { byColumn, issues } = useMemo(() => {
    const issues = checkRelations(toDiagram(provider, nodes))
    const byColumn = new Map<string, RelationIssue[]>()
    for (const i of issues) {
      for (const id of [i.columnId, i.targetColumnId]) byColumn.set(id, [...(byColumn.get(id) ?? []), i])
    }
    return { byColumn, issues }
  }, [provider, nodes])

  return (
    <IssuesContext.Provider value={byColumn}>
      {children}
      <IssueToasts issues={issues} />
    </IssuesContext.Provider>
  )
}

/** Notifies for each problem that newly appears (not for ones already present on load). */
function IssueToasts({ issues }: { issues: RelationIssue[] }) {
  const notify = useStore((s) => s.notify)
  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    const keys = new Set(issues.map(issueKey))
    const previous = seen.current
    seen.current = keys
    if (previous === null) return
    for (const i of issues) {
      if (!previous.has(issueKey(i))) notify(`${i.label}: ${i.message}`)
    }
  }, [issues, notify])

  return null
}
