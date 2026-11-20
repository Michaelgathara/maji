import { describe, expect, test } from "bun:test"
import type { SessionInboxUser } from "@opencode/client/promise"
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

function data(send: (id: string) => Promise<SessionInboxUser>) {
  return {
    session: {
      prompt: (input: { id?: string | null | undefined }) => send(input.id ?? "missing"),
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
})
