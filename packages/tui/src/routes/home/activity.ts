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

export function workDescription(input: {
  status?: WorkStatus
  outcome?: string
  openQuestions?: readonly string[]
  canonicalTopic?: string
  topics?: readonly string[]
  taskType?: string
}) {
  const question = input.openQuestions?.[0]
  const questionDetail = question?.includes("?") ? question.slice(0, question.indexOf("?") + 1) : question
  const detail =
    input.status === "working"
      ? (input.canonicalTopic ?? input.topics?.[0] ?? input.taskType ?? input.outcome)
      : input.status === "needs-you"
        ? (questionDetail ?? input.canonicalTopic ?? input.topics?.[0] ?? input.taskType)
        : (input.outcome ?? questionDetail ?? input.canonicalTopic ?? input.topics?.[0] ?? input.taskType)
  if (!detail) return
  const clean = detail
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[`*_#|{}[\]"]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-–—]\s*/, "")
    .trim()
  return clean || undefined
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
