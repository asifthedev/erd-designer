import { createContext, useContext } from 'react'
import type { RelationIssue } from '../core/relations'

/** column id -> problems that column is part of (as the foreign key or as the referenced column). */
export const IssuesContext = createContext<Map<string, RelationIssue[]>>(new Map())

export function useColumnIssues(columnId: string): RelationIssue[] {
  return useContext(IssuesContext).get(columnId) ?? []
}
