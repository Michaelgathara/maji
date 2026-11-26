import { expect, test } from "bun:test"
import { createOutboxState, outboxPaused, runningOutboxTask, transitionOutbox } from "./prompt-outbox-machine"

test("an older completion cannot release a newer queued send", () => {
  const first = Promise.resolve()
  const next = Promise.resolve()
  const running = transitionOutbox(createOutboxState(), { type: "scheduled", sessionID: "ses_1", task: first })
  const queued = transitionOutbox(running, { type: "scheduled", sessionID: "ses_1", task: next })
  const stale = transitionOutbox(queued, { type: "settled", sessionID: "ses_1", task: first })
  expect(stale).toBe(queued)
  expect(runningOutboxTask(stale, "ses_1")).toBe(next)
  expect(
    runningOutboxTask(transitionOutbox(stale, { type: "settled", sessionID: "ses_1", task: next }), "ses_1"),
  ).toBeUndefined()
})

test("pause survives completion, resume reopens the lane, and disposal rejects late events", () => {
  const task = Promise.resolve()
  const running = transitionOutbox(createOutboxState(), { type: "scheduled", sessionID: "ses_1", task })
  const paused = transitionOutbox(running, { type: "pause", sessionID: "ses_1" })
  const settled = transitionOutbox(paused, { type: "settled", sessionID: "ses_1", task })
  expect(outboxPaused(settled, "ses_1")).toBe(true)
  expect(outboxPaused(transitionOutbox(settled, { type: "resume", sessionID: "ses_1" }), "ses_1")).toBe(false)
  const disposed = transitionOutbox(settled, { type: "disposed" })
  expect(transitionOutbox(disposed, { type: "resume", sessionID: "ses_1" })).toBe(disposed)
})
