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

export function routeTargetTitle(target: RouteTarget) {
  if (target.type === "session") return target.title
  if (target.type === "new") return "New task"
  return "Current task"
}

export function routeTargetDetail(target: RouteTarget, source: DeliverySource) {
  if (source === "manual") return "You chose this task"
  if (target.type !== "session") return target.type === "new" ? "Start fresh" : "Keep working here"
  return explainRouteReason(target.reason)
}

export function explainRouteReason(reason: string) {
  if (reason === "title match") return "Matches the task title"
  if (reason === "file match") return "Matches a referenced file"
  if (reason === "waiting for input") return "This task is waiting for you"
  if (reason === "memory match") return "Matches this task's context"
  if (reason === "conversation match") return "Matches the conversation"
  if (reason === "topic match") return "Matches the task topic"
  if (reason === "recent follow-up") return "Looks like a recent follow-up"
  if (reason === "recent session") return "Most recently related task"
  if (reason === "manual") return "You chose this task"
  return "Looks related"
}
