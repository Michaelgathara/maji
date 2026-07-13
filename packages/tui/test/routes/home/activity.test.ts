import { describe, expect, test } from "bun:test"
import { compareWorkActivity, workStatus, workStatusLabel } from "../../../src/routes/home/activity"

describe("home work activity", () => {
  test("prioritizes live user attention over remembered completion", () => {
    expect(workStatus({ pending: 1, busy: false, statusHint: "done" })).toBe("needs-you")
    expect(workStatus({ pending: 0, busy: true, statusHint: "done" })).toBe("working")
    expect(workStatus({ pending: 0, busy: false, statusHint: "done" })).toBe("done")
    expect(workStatus({ pending: 0, busy: false })).toBe("ready")
  })

  test("sorts attention and active work before recent completed work", () => {
    const items = [
      { status: "done" as const, updated: 30 },
      { status: "working" as const, updated: 20 },
      { status: "needs-you" as const, updated: 10 },
      { status: "ready" as const, updated: 40 },
    ].toSorted(compareWorkActivity)

    expect(items.map((item) => item.status)).toEqual(["needs-you", "working", "done", "ready"])
    expect(workStatusLabel(items[0].status)).toBe("needs you")
  })
})
