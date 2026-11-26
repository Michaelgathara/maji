import { expect, test } from "bun:test"
import {
  createRouteState,
  routeView,
  transitionRoute,
  type RouteDraft,
} from "../../src/component/prompt/routing-machine"

const draft: RouteDraft = {
  text: "Compare Kyoto hotels",
  currentSessionID: "ses_a",
  directory: "/repo",
  server: "local",
}
const result = { decision: { type: "existing" as const, sessionID: "ses_b" }, candidates: [] }

test("returning to the same text cannot admit an older preview", () => {
  const first = transitionRoute(createRouteState(), { type: "changed", draft })
  const edited = transitionRoute(first, { type: "changed", draft: { ...draft, text: "Something else" } })
  const restored = transitionRoute(edited, { type: "changed", draft })
  expect(transitionRoute(restored, { type: "resolved", revision: first.revision, result })).toBe(restored)
  expect(routeView(restored).preview).toBeUndefined()
})

test("manual current-chat selection survives a late automatic suggestion", () => {
  const first = transitionRoute(createRouteState(), { type: "changed", draft })
  const chosen = transitionRoute(first, { type: "choose", revision: first.revision, target: { type: "stay" } })
  const ready = transitionRoute(chosen, { type: "resolved", revision: first.revision, result })
  expect(routeView(ready).override?.target).toEqual({ type: "stay" })
})

test("submission claims a fresh revision, failures retain the draft, and disposal rejects replies", () => {
  const first = transitionRoute(createRouteState(), { type: "changed", draft })
  const resolving = transitionRoute(first, { type: "resolve", revision: first.revision })
  expect(routeView(resolving).busy).toBe(true)
  expect(transitionRoute(resolving, { type: "resolved", revision: first.revision, result })).toBe(resolving)
  const failed = transitionRoute(resolving, { type: "failed", revision: resolving.revision, error: "offline" })
  expect(failed).toMatchObject({ type: "failed", draft })
  expect(routeView(failed).busy).toBe(false)
  const disposed = transitionRoute(failed, { type: "disposed" })
  expect(transitionRoute(disposed, { type: "resolved", revision: resolving.revision, result })).toBe(disposed)
})

test.each(["server", "directory", "currentSessionID"] as const)(
  "changing %s invalidates preview and manual choice",
  (key) => {
    const first = transitionRoute(createRouteState(), { type: "changed", draft })
    const chosen = transitionRoute(first, { type: "choose", revision: first.revision, target: { type: "new" } })
    const changed = transitionRoute(chosen, { type: "changed", draft: { ...draft, [key]: "other" } })
    expect(routeView(changed).override).toBeUndefined()
    expect(transitionRoute(changed, { type: "resolved", revision: first.revision, result })).toBe(changed)
  },
)
