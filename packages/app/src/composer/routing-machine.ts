import type { ExperimentalSessionRouteOutput } from "@opencode/client/promise"

export type RoutingDraft = { key: string; text: string; directory: string; currentSessionID?: string }

export type RoutingDestination = { type: "new" } | { type: "session"; sessionID: string }

export type RoutingState =
  | { type: "empty" | "disposed"; attempt: number }
  | { type: "previewing" | "resolving"; attempt: number; draft: RoutingDraft; choice?: RoutingDestination }
  | {
      type: "ready"
      attempt: number
      draft: RoutingDraft
      result: ExperimentalSessionRouteOutput
      choice?: RoutingDestination
    }
  | { type: "failed"; attempt: number; draft: RoutingDraft; choice?: RoutingDestination }

export type RoutingEvent =
  | { type: "changed"; draft?: RoutingDraft }
  | { type: "resolve" }
  | { type: "resolved"; attempt: number; result: ExperimentalSessionRouteOutput }
  | { type: "failed"; attempt: number }
  | { type: "choose"; attempt: number; choice: RoutingDestination }
  | { type: "dispose" }

export function createRoutingState(): RoutingState {
  return { type: "empty", attempt: 0 }
}

export function transitionRouting(state: RoutingState, event: RoutingEvent): RoutingState {
  if (state.type === "disposed") return state

  if (event.type === "dispose") return { type: "disposed", attempt: state.attempt }

  if (event.type === "changed") {
    if (!event.draft) return state.type === "empty" ? state : { type: "empty", attempt: state.attempt + 1 }

    if ("draft" in state && state.draft.key === event.draft.key) return state

    return { type: "previewing", attempt: state.attempt + 1, draft: event.draft }
  }

  if (!("draft" in state)) return state

  if (event.type === "resolve")
    return { type: "resolving", attempt: state.attempt + 1, draft: state.draft, choice: state.choice }

  if (event.attempt !== state.attempt) return state

  if (event.type === "choose") return { ...state, choice: event.choice }

  if (state.type !== "previewing" && state.type !== "resolving") return state

  if (event.type === "failed")
    return { type: "failed", attempt: state.attempt, draft: state.draft, choice: state.choice }

  return { type: "ready", attempt: state.attempt, draft: state.draft, result: event.result, choice: state.choice }
}

export function routingView(state: RoutingState) {
  const result = state.type === "ready" ? state.result : undefined
  const choice = "draft" in state ? state.choice : undefined
  const decision = result?.decision

  const destination =
    choice ??
    (decision &&
    (decision.type === "current" ||
      (decision.type === "existing" &&
        result?.candidates.some((candidate) => candidate.sessionID === decision.sessionID)))
      ? { type: "session" as const, sessionID: decision.sessionID }
      : decision?.type === "new"
        ? { type: "new" as const }
        : undefined)

  return { result, destination, resolving: state.type === "resolving", manual: !!choice }
}
