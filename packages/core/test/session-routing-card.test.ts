import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "@opencode/schema/session-message"
import { RoutingCard } from "../src/session/routing-card"

test("a user reply clears the preceding assistant question from open questions", () => {
  const messages = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Info))([
    { id: "msg_answer", type: "user", text: "Use the station hotel", time: { created: 2 } },
    {
      id: "msg_question",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test" },
      time: { created: 1 },
      content: [{ type: "text", text: "Which hotel should we book?" }],
    },
  ])
  expect(
    RoutingCard.fromMessages({ title: "Kyoto hotels", messages, pendingInput: 0, busy: false }).openQuestions,
  ).toEqual([])
})

test("stored newest-first history produces the latest request and reply with structured file context", () => {
  const messages = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Info))([
    {
      id: "msg_latest_tool",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test" },
      time: { created: 5 },
      content: [
        {
          type: "tool",
          id: "call_read",
          name: "read",
          time: { created: 5 },
          state: { status: "completed", input: { path: "schema.ts" }, content: [{ type: "text", text: "read" }] },
        },
      ],
    },
    {
      id: "msg_latest_answer",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test" },
      time: { created: 4 },
      content: [{ type: "text", text: "What is your budget for Kyoto?" }],
    },
    {
      id: "msg_latest_request",
      type: "user",
      text: "Compare Kyoto hotels",
      time: { created: 3 },
      files: [
        {
          name: "itinerary.md",
          data: "",
          mime: "text/markdown",
          source: { type: "uri", uri: "file:///travel/itinerary.md" },
        },
      ],
    },
    {
      id: "msg_old_answer",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "test" },
      time: { created: 2 },
      content: [{ type: "text", text: "The OAuth issue is fixed." }],
    },
    { id: "msg_old_request", type: "user", text: "Fix OAuth", time: { created: 1 } },
  ])
  const card = RoutingCard.fromMessages({ title: "Travel planning", messages, pendingInput: 0, busy: false })
  expect(card.lastUserPrompt).toBe("Compare Kyoto hotels")
  expect(card.lastAssistantReply).toBe("What is your budget for Kyoto?")
  expect(card.files).toContain("file:///travel/itinerary.md")
  expect(card.text).toContain("schema.ts")
  expect(card.statusHint).toBe("idle")
  expect(card.currentStatus).toBe("idle")
  expect(card.outcome).toBeUndefined()
  expect(card.openQuestions).toEqual(["What is your budget for Kyoto?"])
})

test("compaction context contributes topics without masquerading as the latest assistant reply", () => {
  const messages = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Info))([
    { id: "msg_request", type: "user", text: "Can we revisit the accommodation?", time: { created: 2 } },
    {
      id: "msg_summary",
      type: "compaction",
      status: "completed",
      reason: "auto",
      summary: "Kyoto hotels near Kiyomizu-dera, budget under 200 dollars.",
      time: { created: 1 },
    },
  ])
  const card = RoutingCard.fromMessages({ title: "New session", messages, pendingInput: 1, busy: false })
  expect(card.text).toContain("Kiyomizu-dera")
  expect(card.lastAssistantReply).toBeUndefined()
  expect(card.lastUserPrompt).toBe("Can we revisit the accommodation?")
  expect(card.statusHint).toBe("needs-input")
})
