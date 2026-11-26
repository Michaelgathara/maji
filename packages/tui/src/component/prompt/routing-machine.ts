import type { ExperimentalSessionRouteOutput } from "@opencode/client/promise"
import type { RouteTarget } from "./routing-presentation"

export type RouteDraft = {
  text: string
  currentSessionID?: string
  directory?: string
  server: string
}

export type RouteState =
  | { type: "empty" | "disposed"; revision: number }
  | { type: "routing" | "resolving"; revision: number; draft: RouteDraft; override?: RouteTarget }
  | {
      type: "ready"
      revision: number
      draft: RouteDraft
      result: ExperimentalSessionRouteOutput
      override?: RouteTarget
    }
  | { type: "failed"; revision: number; draft: RouteDraft; error: string; override?: RouteTarget }

export type RouteEvent =
  | { type: "changed"; draft?: RouteDraft }
  | { type: "resolved"; revision: number; result: ExperimentalSessionRouteOutput }
  | { type: "failed"; revision: number; error: string }
  | { type: "choose"; revision: number; target: RouteTarget }
  | { type: "resolve"; revision: number }
  | { type: "disposed" }

export function createRouteState(): RouteState {
  return { type: "empty", revision: 0 }
}

export function sameRouteDraft(left: RouteDraft, right: RouteDraft | undefined) {
  return (
    !!right &&
    left.text === right.text &&
    left.currentSessionID === right.currentSessionID &&
    left.directory === right.directory &&
    left.server === right.server
  )
}

export function transitionRoute(state: RouteState, event: RouteEvent): RouteState {
  if (state.type === "disposed") return state
  if (event.type === "disposed") return { type: "disposed", revision: state.revision }
  if (event.type === "changed") {
    if (!event.draft) return state.type === "empty" ? state : { type: "empty", revision: state.revision + 1 }
    if ("draft" in state && sameRouteDraft(state.draft, event.draft)) return state
    return { type: "routing", revision: state.revision + 1, draft: event.draft }
  }
  if (!("draft" in state) || event.revision !== state.revision) return state
  if (event.type === "choose") {
    if (event.target.type === "uncertain" || (event.target.type === "stay" && !state.draft.currentSessionID))
      return state
    return { ...state, override: event.target }
  }
  if (event.type === "resolve")
    return { type: "resolving", revision: state.revision + 1, draft: state.draft, override: state.override }
  if (state.type !== "routing" && state.type !== "resolving") return state
  if (event.type === "resolved")
    return {
      type: "ready",
      revision: state.revision,
      draft: state.draft,
      result: event.result,
      override: state.override,
    }
  return { type: "failed", revision: state.revision, draft: state.draft, error: event.error, override: state.override }
}

export function routeView(state: RouteState) {
  return {
    revision: state.revision,
    busy: state.type === "resolving",
    preview: state.type === "ready" ? { ...state.draft, ...state.result } : undefined,
    override: "draft" in state && state.override ? { ...state.draft, target: state.override } : undefined,
  }
}
