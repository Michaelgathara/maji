import { expect, test } from "bun:test"
import { Schema } from "effect"
import type { ExperimentalSessionRouteOutput } from "@opencode/client/promise"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"
import { agent, model, session } from "./fixture/local"
import { directory, json } from "./fixture/tui-client"

const Prompt = Schema.Struct({ id: Schema.String, text: Schema.String })
const Lookup = Schema.Struct({ text: Schema.String, currentSessionID: Schema.optionalKey(Schema.String) })
const suggestion: ExperimentalSessionRouteOutput = {
  decision: { type: "existing", sessionID: "ses_route_b" },
  candidates: [{ sessionID: "ses_route_b", title: "Kyoto hotels", score: 9, reason: "topic match" }],
}

async function routingApp(
  answer: (input: typeof Lookup.Type) => Promise<ExperimentalSessionRouteOutput | Response>,
  width = 100,
  admission?: () => Promise<Response>,
) {
  takeDraft("ses_route_a")
  takeDraft("ses_route_b")
  const prompted = Promise.withResolvers<{ sessionID: string; text: string }>()
  const started = Promise.withResolvers<void>()
  const calls: string[] = []
  const sessions = [
    { ...session("ses_route_a"), title: "OAuth callback" },
    { ...session("ses_route_b"), title: "Kyoto hotels" },
  ]
  const setup = await createAppFixture({
    width,
    height: 30,
    args: { sessionID: "ses_route_a" },
    fetch: async (url, request) => {
      const location = { directory }
      if (url.pathname === "/api/agent") return json({ location, data: [agent("build")] })
      if (url.pathname === "/api/model") return json({ location, data: [model("Routing Model")] })
      if (url.pathname === "/api/session") return json({ data: sessions, cursor: {} })
      const selected = sessions.find((session) => url.pathname === `/api/session/${session.id}`)
      if (selected) return json({ data: selected })
      if (url.pathname.endsWith("/message") || url.pathname.endsWith("/inbox")) return json({ data: [], cursor: {} })
      if (url.pathname === "/api/experimental/session/route") {
        const input = Schema.decodeUnknownSync(Lookup)(await request.json())
        started.resolve()
        const result = await answer(input)
        return result instanceof Response ? result : json({ data: result })
      }
      if (url.pathname.endsWith("/prompt")) {
        const input = Schema.decodeUnknownSync(Prompt)(await request.json())
        const sessionID = url.pathname.split("/")[3]
        calls.push(sessionID)
        prompted.resolve({ sessionID, text: input.text })
        if (admission) return admission()
        return json({
          data: {
            id: input.id,
            sessionID,
            type: "user",
            delivery: "steer",
            payload: { text: input.text },
            time: { created: Date.now() },
          },
        })
      }
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Routing Model"))
  return Object.assign(setup, { calls, prompted: prompted.promise, started: started.promise })
}

test.each([44, 100])("Enter waits for routing and opens the receiving chat at width %s", async (width) => {
  const decision = Promise.withResolvers<ExperimentalSessionRouteOutput>()
  await using setup = await routingApp(() => decision.promise, width)
  await setup.mockInput.typeText("Compare Kyoto hotels")
  setup.mockInput.pressEnter()
  await setup.started
  expect(setup.calls).toEqual([])
  await setup.waitForFrame((frame) => frame.includes("Compare Kyoto hotels"))
  decision.resolve(suggestion)
  expect(await setup.prompted).toEqual({ sessionID: "ses_route_b", text: "Compare Kyoto hotels" })
  await setup.waitForFrame((frame) => frame.includes("Kyoto hotels"))
  expect(setup.calls).toEqual(["ses_route_b"])
})

test("a failed route preserves the unsent draft", async () => {
  await using setup = await routingApp(async () => new Response("lookup offline", { status: 503 }))
  await setup.mockInput.typeText("Compare Kyoto hotels")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Could not choose a task"))
  expect(setup.calls).toEqual([])
  expect(setup.renderer.currentFocusedEditor?.plainText).toBe("Compare Kyoto hotels")
})

test("a rejected admission restores the captured draft in the receiving chat after navigation", async () => {
  const admission = Promise.withResolvers<Response>()
  await using setup = await routingApp(
    async () => suggestion,
    100,
    () => admission.promise,
  )
  await setup.mockInput.typeText("Compare Kyoto hotels")
  setup.mockInput.pressEnter()
  await setup.prompted
  await setup.waitForFrame((frame) => frame.includes("Kyoto hotels"))
  admission.resolve(
    json(
      Schema.TaggedStruct("InvalidRequestError", { message: Schema.String }).make({ message: "Admission rejected" }),
      { status: 400 },
    ),
  )
  await setup.waitForFrame((frame) => frame.includes("Failed to send prompt"))
  expect(setup.renderer.currentFocusedEditor?.plainText).toBe("Compare Kyoto hotels")
})

test("an ambiguous route asks for a destination and honors choosing the current chat", async () => {
  await using setup = await routingApp(async () => ({ ...suggestion, decision: { type: "uncertain" } }))
  await setup.mockInput.typeText("Compare Kyoto hotels")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Search tasks"))
  expect(setup.calls).toEqual([])
  await setup.mockInput.typeText("Current task")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes("Search tasks") && frame.includes("Compare Kyoto hotels"))
  expect(setup.renderer.currentFocusedEditor?.plainText).toBe("Compare Kyoto hotels")
  setup.mockInput.pressEnter()
  expect(await setup.prompted).toEqual({ sessionID: "ses_route_a", text: "Compare Kyoto hotels" })
})
