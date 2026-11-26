import { expect, test } from "bun:test"
import { createRoutingState, routingView, transitionRouting, type RoutingDraft } from "./routing-machine"

const draft: RoutingDraft = {
  key: "server-a:chat-a:kyoto",
  text: "Kyoto hotels",
  directory: "/project",
  currentSessionID: "ses_a",
}

const result = {
  decision: { type: "existing" as const, sessionID: "ses_b" },
  candidates: [{ sessionID: "ses_b", title: "Kyoto hotels", score: 9, reason: "topic match" }],
}

test("an older preview cannot win after editing away and back or claiming submission", () => {
  const first = transitionRouting(createRoutingState(), { type: "changed", draft })
  const edited = transitionRouting(first, { type: "changed", draft: { ...draft, key: "other" } })
  const restored = transitionRouting(edited, { type: "changed", draft })
  expect(transitionRouting(restored, { type: "resolved", attempt: first.attempt, result })).toBe(restored)
  const submitting = transitionRouting(restored, { type: "resolve" })
  expect(transitionRouting(submitting, { type: "resolved", attempt: restored.attempt, result })).toBe(submitting)
})

test("manual current and new destinations survive a late automatic suggestion", () => {
  const first = transitionRouting(createRoutingState(), { type: "changed", draft })

  for (const choice of [{ type: "new" as const }, { type: "session" as const, sessionID: "ses_a" }]) {
    const chosen = transitionRouting(first, { type: "choose", attempt: first.attempt, choice })
    expect(
      routingView(transitionRouting(chosen, { type: "resolved", attempt: first.attempt, result })).destination,
    ).toEqual(choice)
    expect(
      routingView(transitionRouting(chosen, { type: "changed", draft: { ...draft, key: "server-b" } })).destination,
    ).toBeUndefined()
  }
})

test("uncertainty, failures, malformed suggestions, and disposal never choose a destination", () => {
  const first = transitionRouting(createRoutingState(), { type: "changed", draft })

  for (const response of [
    { ...result, decision: { type: "uncertain" as const } },
    { ...result, candidates: [] },
  ]) {
    expect(
      routingView(transitionRouting(first, { type: "resolved", attempt: first.attempt, result: response })).destination,
    ).toBeUndefined()
  }

  const failed = transitionRouting(first, { type: "failed", attempt: first.attempt })
  expect(failed).toMatchObject({ type: "failed", draft })
  const disposed = transitionRouting(failed, { type: "dispose" })
  expect(transitionRouting(disposed, { type: "resolved", attempt: first.attempt, result })).toBe(disposed)
})
