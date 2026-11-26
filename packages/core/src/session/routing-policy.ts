export * as RoutingPolicy from "./routing-policy.js"

export type Evidence = "none" | "topical" | "continuation" | "pendingReply"

export type Candidate = {
  sessionID: string
  evidence: Evidence
  aboveThreshold: boolean
}

export type Destination = { type: "session"; sessionID: string } | { type: "new" }

export type Decision = { type: "existing" | "current"; sessionID: string } | { type: "new" | "uncertain" }

export type Input = {
  current?: string
  manual?: Destination
  ranked: readonly Candidate[]
  ambiguous: boolean
}

/** Executable counterpart of formal/routing/Routing.lean; ranking supplies evidence, policy owns admission. */
export function decide(input: Input): Decision {
  if (input.manual?.type === "new") return { type: "new" }
  if (input.manual?.type === "session") return chooseSession(input.current, input.manual.sessionID)
  const eligible = input.ranked.filter((candidate) => candidate.aboveThreshold && candidate.evidence !== "none")
  if (eligible.length === 0) return { type: "new" }
  if (input.ambiguous && eligible.length > 1) return { type: "uncertain" }
  return chooseSession(input.current, eligible[0].sessionID)
}

function chooseSession(current: string | undefined, sessionID: string): Decision {
  return { type: current === sessionID ? "current" : "existing", sessionID }
}
