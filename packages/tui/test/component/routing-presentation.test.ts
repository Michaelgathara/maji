import { describe, expect, test } from "bun:test"
import {
  explainRouteReason,
  routeTargetAction,
  routeTargetDetail,
  routeTargetKey,
  routeTargetTitle,
} from "../../src/component/prompt/routing-presentation"

describe("routing presentation", () => {
  test("describes an automatic session destination in task language", () => {
    const target = {
      type: "session" as const,
      sessionID: "ses_auth",
      title: "OAuth callback tests",
      reason: "file match",
    }

    expect(routeTargetKey(target)).toBe("session:ses_auth")
    expect(routeTargetAction(target)).toBe("Continue")
    expect(routeTargetTitle(target)).toBe("OAuth callback tests")
    expect(routeTargetDetail(target, "automatic")).toBe("Matches a referenced file")
  })

  test("describes explicit destinations without exposing routing jargon", () => {
    expect(routeTargetDetail({ type: "new" }, "automatic")).toBe("No related task found")
    expect(routeTargetDetail({ type: "stay" }, "manual")).toBe("Chosen by you")
    expect(explainRouteReason("memory match")).toBe("Matches remembered task context")
  })
})
