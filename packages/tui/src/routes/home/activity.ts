export type WorkStatus = "needs-you" | "working" | "done" | "ready"

export function workStatus(input: { pending: number; busy: boolean; statusHint?: string }): WorkStatus {
  if (input.pending > 0) return "needs-you"
  if (input.busy) return "working"
  if (input.statusHint === "done") return "done"
  return "ready"
}

export function workStatusLabel(status: WorkStatus) {
  if (status === "needs-you") return "needs you"
  return status
}

export function compareWorkActivity(
  a: { status: WorkStatus; updated: number },
  b: { status: WorkStatus; updated: number },
) {
  return workStatusPriority(b.status) - workStatusPriority(a.status) || b.updated - a.updated
}

function workStatusPriority(status: WorkStatus) {
  if (status === "needs-you") return 3
  if (status === "working") return 2
  if (status === "done") return 1
  return 0
}
