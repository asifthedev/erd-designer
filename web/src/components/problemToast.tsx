import { toast } from 'sonner'
import type { Problem } from '../core/problems'

/**
 * The body of a message toast: which columns (a small code chip), why (one sentence) and what to do (one line).
 * The title is the toast's own title. The look is in index.css under "Toasts".
 */
function ProblemBody({ problem }: { problem: Problem }) {
  return (
    <div className="problem">
      {problem.where && <code className="problem-where">{problem.where}</code>}
      <p className="problem-reason">{problem.reason}</p>
      {problem.fix && (
        <p className="problem-fix">
          <span>Fix</span>
          {problem.fix}
        </p>
      )}
    </div>
  )
}

/** Something went wrong (error) or needs attention (warning). It stays until closed; the same content reuses its toast. */
export function showProblem(problem: Problem, kind: 'error' | 'warning' = 'error') {
  const id = `${problem.title}|${problem.where ?? ''}|${problem.reason}`
  const open = kind === 'warning' ? toast.warning : toast.error
  open(problem.title, {
    id,
    description: <ProblemBody problem={problem} />,
    duration: Infinity,
    closeButton: true,
  })
}

/** Good news that still deserves a sentence of explanation (e.g. a relation was flipped). */
export function showNote(problem: Problem, id: string) {
  toast.success(problem.title, {
    id,
    description: <ProblemBody problem={problem} />,
    duration: Infinity,
    closeButton: true,
  })
}
