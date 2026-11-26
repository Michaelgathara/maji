import { describe, expect, test } from "bun:test"
import { OpenCode, type SessionInboxUser, type InvalidRequestError } from "@opencode/client/promise"
import { Schema } from "effect"
import type { Data } from "@opencode/client/solid"
import { createRoot } from "solid-js"
import { createPromptOutbox, type PromptOutboxEntry } from "./prompt-outbox"
import { ServerScope } from "./scope"

const scope = ServerScope.local

function receipt(id: string): SessionInboxUser {
  return {
    id,
    sessionID: "ses_1",
    time: { created: 1 },
    type: "user",
    delivery: "steer",
    payload: { text: "hello" },
  }
}

function storage() {
  const values = new Map<string, PromptOutboxEntry>()

  return {
    values,
    driver: {
      list: async () => [...values.values()],
      put: async (entry: PromptOutboxEntry) => {
        values.set(entry.request.id, structuredClone(entry))
      },
      remove: async (_scope: ServerScope, id: string) => {
        values.delete(id)
      },
    },
  }
}

function data(send: (id: string, input: Parameters<Data["session"]["prompt"]>[0]) => Promise<SessionInboxUser>) {
  return {
    session: {
      prompt: (input: Parameters<Data["session"]["prompt"]>[0]) => send(input.id ?? "missing", input),
      sync: async () => undefined,
      get: () => undefined,
    },
  }
}

const sdk = {
  api: {
    session: {
      revert: { commit: async () => undefined },
      switchAgent: async () => undefined,
      switchModel: async () => undefined,
    },
  },
}

describe("prompt outbox", () => {
  test("initial delivery and background flush share one lane and preserve the chosen destination", async () => {
    const saved = storage()
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const calls: { id: string; sessionID: string }[] = []

    const source = data(async (id, input) => {
      calls.push({ id, sessionID: input.sessionID })
      started.resolve()
      await input.gate

      return receipt(id)
    })

    using owner = createRoot((dispose) => ({
      outbox: createPromptOutbox({ scope, sdk, data: source, storage: saved.driver }),
      [Symbol.dispose]: dispose,
    }))

    const sending = owner.outbox.prompt({ sessionID: "ses_chosen", id: "msg_1", text: "hello", gate: gate.promise })
    await started.promise
    const flushing = owner.outbox.flush()
    expect(calls).toEqual([{ id: "msg_1", sessionID: "ses_chosen" }])
    gate.resolve()
    await Promise.all([sending, flushing])
    expect(calls).toEqual([{ id: "msg_1", sessionID: "ses_chosen" }])
    expect(saved.values.size).toBe(0)
  })

  test("later prompts wait behind an uncertain earlier admission", async () => {
    const saved = storage()
    const calls: string[] = []
    let offline = true

    const source = data(async (id) => {
      calls.push(id)

      if (offline) throw new Error("offline")

      return receipt(id)
    })

    using owner = createRoot((dispose) => ({
      outbox: createPromptOutbox({ scope, sdk, data: source, storage: saved.driver }),
      [Symbol.dispose]: dispose,
    }))

    await owner.outbox.prompt({ sessionID: "ses_1", id: "msg_z", text: "first" })
    await owner.outbox.prompt({ sessionID: "ses_1", id: "msg_a", text: "second" })
    expect(calls).toEqual(["msg_z", "msg_z"])
    expect(saved.values.size).toBe(2)
    offline = false
    await owner.outbox.flush()
    expect(calls).toEqual(["msg_z", "msg_z", "msg_z", "msg_a"])
    expect(saved.values.size).toBe(0)
  })

  test("retry retains the original preparation and rejects a changed destination", async () => {
    const saved = storage()
    const calls: string[] = []
    let offline = true
    let prepared = 0

    const source = data(async (id, input) => {
      await input.gate
      await input.prepare?.()
      calls.push(input.sessionID)

      if (offline) throw new Error("offline")

      return receipt(id)
    })

    using owner = createRoot((dispose) => ({
      outbox: createPromptOutbox({ scope, sdk, data: source, storage: saved.driver }),
      [Symbol.dispose]: dispose,
    }))

    await owner.outbox.prompt({
      sessionID: "ses_chosen",
      id: "msg_1",
      text: "hello",
      gate: Promise.resolve(),
      prepare: async () => {
        prepared++
      },
    })
    await expect(owner.outbox.prompt({ sessionID: "ses_other", id: "msg_1", text: "hello" })).rejects.toThrow(
      "Conflicting prompt retry",
    )
    offline = false
    await owner.outbox.flush()
    expect(calls).toEqual(["ses_chosen", "ses_chosen"])
    expect(prepared).toBe(2)
    expect(saved.values.size).toBe(0)
  })

  test("keeps an uncertain admission and retries the same ID", async () => {
    const saved = storage()
    const calls: string[] = []
    let fail = true

    const source = data(async (id) => {
      calls.push(id)

      if (fail) throw new Error("offline")

      return receipt(id)
    })

    await createRoot(async (dispose) => {
      const outbox = createPromptOutbox({ scope, sdk, data: source, storage: saved.driver })
      const admitted = await outbox.prompt({ sessionID: "ses_1", id: "msg_1", text: "hello" })
      expect(admitted.id).toBe("msg_1")
      expect(outbox.entries.msg_1?.status).toBe("reconnecting")
      expect(saved.values.get("msg_1")?.request.text).toBe("hello")

      fail = false
      await outbox.flush()
      expect(calls).toEqual(["msg_1", "msg_1"])
      expect(outbox.entries.msg_1).toBeUndefined()
      expect(saved.values.size).toBe(0)
      dispose()
    })
  })

  test("rejects a permanent error and removes it", async () => {
    const saved = storage()
    const source = data(async () => Promise.reject({ status: 400, message: "bad request" }))

    await createRoot(async (dispose) => {
      const outbox = createPromptOutbox({ scope, sdk, data: source, storage: saved.driver })
      await expect(outbox.prompt({ sessionID: "ses_1", id: "msg_bad", text: "hello" })).rejects.toEqual({
        status: 400,
        message: "bad request",
      })
      expect(outbox.entries.msg_bad).toBeUndefined()
      expect(saved.values.size).toBe(0)
      dispose()
    })
  })

  test("a declared HTTP rejection from the real client is permanent even without a numeric status on the error", async () => {
    const saved = storage()

    const client = OpenCode.make({
      baseUrl: "http://localhost",
      fetch: Object.assign(
        async () =>
          Response.json(
            Schema.TaggedStruct("InvalidRequestError", { message: Schema.String }).make({
              message: "Admission rejected",
            }) satisfies InvalidRequestError,
            {
              status: 400,
            },
          ),
        { preconnect: fetch.preconnect },
      ),
    })

    const source = data((id) =>
      client.session.prompt({ sessionID: "ses_1", id, text: "hello" }).then(() => receipt(id)),
    )

    using owner = createRoot((dispose) => ({
      dispose,
      [Symbol.dispose]: dispose,
      outbox: createPromptOutbox({ scope, sdk, data: source, storage: saved.driver }),
    }))

    await expect(owner.outbox.prompt({ sessionID: "ses_1", id: "msg_bad", text: "hello" })).rejects.toHaveProperty(
      "_tag",
      "InvalidRequestError",
    )
    expect(owner.outbox.entries.msg_bad).toBeUndefined()
    expect(saved.values.size).toBe(0)
  })
})
