import { describe, expect, test } from "bun:test"
import {
  explainRouteReason,
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
    expect(routeTargetTitle(target)).toBe("OAuth callback tests")
    expect(routeTargetDetail(target, "automatic")).toBe("Matches a referenced file")
  })

  test("describes explicit destinations without exposing routing jargon", () => {
    expect(routeTargetDetail({ type: "new" }, "automatic")).toBe("Start fresh")
    expect(routeTargetDetail({ type: "stay" }, "manual")).toBe("You chose this task")
    expect(explainRouteReason("memory match")).toBe("Matches this task's context")
  })
})
