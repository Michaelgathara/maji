type Lane = { type: "idle" } | { type: "paused" } | { type: "running"; task: Promise<void>; paused: boolean }

export type OutboxState = { type: "active"; lanes: ReadonlyMap<string, Lane> } | { type: "disposed" }

export type OutboxEvent =
  | { type: "scheduled" | "settled"; sessionID: string; task: Promise<void> }
  | { type: "pause" | "resume"; sessionID: string }
  | { type: "disposed" }

export function createOutboxState(): OutboxState {
  return { type: "active", lanes: new Map() }
}

export function transitionOutbox(state: OutboxState, event: OutboxEvent): OutboxState {
  if (state.type === "disposed") return state

  if (event.type === "disposed") return { type: "disposed" }
  const lane = state.lanes.get(event.sessionID)

  if (event.type === "settled" && (lane?.type !== "running" || lane.task !== event.task)) return state
  const paused = lane?.type === "paused" || (lane?.type === "running" && lane.paused)

  const next: Lane =
    event.type === "scheduled"
      ? { type: "running", task: event.task, paused }
      : event.type === "settled"
        ? { type: paused ? "paused" : "idle" }
        : lane?.type === "running"
          ? { ...lane, paused: event.type === "pause" }
          : { type: event.type === "pause" ? "paused" : "idle" }

  return { type: "active", lanes: new Map(state.lanes).set(event.sessionID, next) }
}

export function runningOutboxTask(state: OutboxState, sessionID: string) {
  const lane = state.type === "active" ? state.lanes.get(sessionID) : undefined

  return lane?.type === "running" ? lane.task : undefined
}

export function outboxDisposed(state: OutboxState) {
  return state.type === "disposed"
}

export function outboxPaused(state: OutboxState, sessionID: string) {
  if (state.type === "disposed") return true
  const lane = state.lanes.get(sessionID)

  return lane?.type === "paused" || (lane?.type === "running" && lane.paused)
}
