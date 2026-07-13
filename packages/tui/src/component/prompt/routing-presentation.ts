export type RouteCandidate = {
  sessionID: string
  title: string
  reason: string
  score?: number
}

export type RouteTarget = ({ type: "session" } & RouteCandidate) | { type: "new" } | { type: "stay" }

export type DeliverySource = "automatic" | "manual"

export function routeTargetKey(target: RouteTarget) {
  if (target.type === "session") return `session:${target.sessionID}`
  return target.type
}

export function routeTargetAction(target: RouteTarget) {
  if (target.type === "session") return "Continue"
  if (target.type === "new") return "Start"
  return "Keep"
}

export function routeTargetTitle(target: RouteTarget) {
  if (target.type === "session") return target.title
  if (target.type === "new") return "new task"
  return "current task"
}

export function routeTargetDetail(target: RouteTarget, source: DeliverySource) {
  if (source === "manual") return "Chosen by you"
  if (target.type !== "session") return target.type === "new" ? "No related task found" : "Current task"
  return explainRouteReason(target.reason)
}

export function explainRouteReason(reason: string) {
  if (reason === "title match") return "Matches the task title"
  if (reason === "file match") return "Matches a referenced file"
  if (reason === "waiting for input") return "This task is waiting for you"
  if (reason === "memory match") return "Matches remembered task context"
  if (reason === "conversation match") return "Matches recent conversation"
  if (reason === "topic match") return "Matches the task topic"
  if (reason === "recent follow-up") return "Looks like a recent follow-up"
  if (reason === "recent session") return "Most recently related task"
  if (reason === "manual") return "Chosen by you"
  return "Related work found"
}
