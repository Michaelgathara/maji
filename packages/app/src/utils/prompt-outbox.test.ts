import { describe, expect, test } from "bun:test"
import { createPromptOutbox, type OutboxEntry, type OutboxStorage } from "./prompt-outbox"

function fixture() {
  const rows = new Map<string, OutboxEntry>()
  const visible = new Map<string, OutboxEntry>()
  const sent: OutboxEntry["request"][] = []
  const promoted = new Set<string>()
  const storage: OutboxStorage = {
    list: async (scope) => [...rows.values()].filter((entry) => entry.scope === scope),
    put: async (entry) => {
      rows.set(`${entry.scope}:${entry.request.id}`, structuredClone(entry))
    },
    remove: async (scope, id) => {
      rows.delete(`${scope}:${id}`)
    },
  }
  const options = {
    scope: "server-a",
    storage,
    promoted: async (_sessionID: string, id: string) => promoted.has(id),
    restore: () => undefined,
    change: (id: string, entry: OutboxEntry | undefined) => {
      if (entry) visible.set(id, entry)
      else visible.delete(id)
    },
    send: async (request: OutboxEntry["request"]) => {
      sent.push(structuredClone(request))
      return {
        id: request.id,
        sessionID: request.sessionID,
        admittedSeq: 1,
        timeCreated: 1,
        type: "user" as const,
        data: { text: request.text },
        delivery: "steer" as const,
      }
    },
  }
  return { rows, visible, sent, promoted, options }
}

function submission(id = "msg_1", sessionID = "ses_a") {
  return {
    request: { id, sessionID, text: "Original message", delivery: "steer" as const },
    message: {
      id,
      sessionID,
      role: "user" as const,
      time: { created: 1 },
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
    },
    parts: [],
  }
}

describe("durable prompt outbox", () => {
  test("freezes the destination and payload before asynchronous persistence", async () => {
    const f = fixture()
    const outbox = createPromptOutbox(f.options)
    const draft = submission()
    const enqueued = outbox.enqueue(draft)
    draft.request.sessionID = "ses_b"
    draft.request.text = "Edited after send"
    await enqueued
    await outbox.flush()
    expect(f.sent).toEqual([submission().request])
  })

  test("does not send or claim a saved message when persistence fails", async () => {
    const f = fixture()
    const outbox = createPromptOutbox({
      ...f.options,
      storage: {
        ...f.options.storage,
        put: async () => {
          throw new Error("Disk full")
        },
      },
    })
    await expect(outbox.enqueue(submission())).rejects.toThrow("Disk full")
    await outbox.flush()
    expect(f.sent).toHaveLength(0)
    expect(f.visible.size).toBe(0)
  })

  test("retries a lost response with the same identity and blocks later messages", async () => {
    const f = fixture()
    const responses = [false, true, true]
    const outbox = createPromptOutbox({
      ...f.options,
      send: async (request) => {
        const receipt = await f.options.send(request)
        if (!responses.shift()) throw new Error("Connection lost after commit")
        return receipt
      },
    })
    await outbox.enqueue(submission())
    await outbox.enqueue(submission("msg_2"))
    await outbox.flush()
    expect(f.sent.map((request) => request.id)).toEqual(["msg_1"])
    expect(f.visible.get("msg_1")?.status).toBe("reconnecting")
    await outbox.flush()
    expect(f.sent.map((request) => request.id)).toEqual(["msg_1", "msg_1", "msg_2"])
    expect(f.sent[0]).toEqual(f.sent[1])
  })

  test("restores unresolved submissions after restart without crossing servers", async () => {
    const f = fixture()
    const original = createPromptOutbox(f.options)
    await original.enqueue(submission())
    original.dispose()
    await createPromptOutbox({ ...f.options, scope: "server-b" }).flush()
    expect(f.sent).toHaveLength(0)
    await createPromptOutbox(f.options).flush()
    expect(f.sent).toEqual([submission().request])
  })

  test("reconciles an accepted message after restart without waking execution", async () => {
    const f = fixture()
    const original = createPromptOutbox(f.options)
    await original.enqueue(submission())
    await original.flush()
    original.dispose()
    f.promoted.add("msg_1")
    await createPromptOutbox(f.options).flush()
    expect(f.sent).toHaveLength(1)
    expect(f.rows.size).toBe(0)
  })

  test("a promotion racing the admission response cannot resurrect the message", async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const outbox = createPromptOutbox({
      ...f.options,
      send: async (request) => {
        started.resolve()
        await gate.promise
        return f.options.send(request)
      },
    })
    await outbox.enqueue(submission())
    const flushing = outbox.flush()
    await started.promise
    await outbox.confirm("ses_b", "msg_1")
    expect(f.rows.size).toBe(1)
    await outbox.confirm("ses_a", "msg_1")
    gate.resolve()
    await flushing
    expect(f.visible.size).toBe(0)
    expect(f.rows.size).toBe(0)
  })

  test("stop preserves pending messages and prevents automatic retries across restart", async () => {
    const f = fixture()
    const outbox = createPromptOutbox(f.options)
    await outbox.enqueue(submission())
    await outbox.pause("ses_a")
    await outbox.flush()
    outbox.dispose()
    const restored = createPromptOutbox(f.options)
    await restored.flush()
    expect(f.sent).toHaveLength(0)
    await restored.retry("ses_a", "msg_1")
    expect(f.sent).toHaveLength(1)
  })

  test("rejects conflicting local retries and mismatched destinations", async () => {
    const f = fixture()
    const outbox = createPromptOutbox(f.options)
    await outbox.enqueue(submission())
    await expect(
      outbox.enqueue({ ...submission(), request: { ...submission().request, text: "Changed" } }),
    ).rejects.toThrow("Conflicting")
    await expect(
      outbox.enqueue({ ...submission(), message: { ...submission().message, sessionID: "ses_b" } }),
    ).rejects.toThrow("destination")
  })

  test("serializes simultaneous admission of the same ID", async () => {
    const f = fixture()
    const outbox = createPromptOutbox(f.options)
    const results = await Promise.allSettled([
      outbox.enqueue(submission()),
      outbox.enqueue({ ...submission(), request: { ...submission().request, text: "Conflicting" } }),
    ])
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"])
    await outbox.flush()
    expect(f.sent).toEqual([submission().request])
  })

  test("does not retry a mismatched server receipt automatically", async () => {
    const f = fixture()
    const outbox = createPromptOutbox({
      ...f.options,
      send: async (request) => ({ ...(await f.options.send(request)), sessionID: "ses_b" }),
    })
    await outbox.enqueue(submission())
    await outbox.flush()
    await outbox.flush()
    expect(f.sent).toHaveLength(1)
    expect(f.visible.get("msg_1")?.status).toBe("failed")
    expect(f.visible.get("msg_1")?.receipt).toBeUndefined()
  })

  test("caps automatic transport retries and retains the original message", async () => {
    const f = fixture()
    const outbox = createPromptOutbox({
      ...f.options,
      send: async (request) => {
        await f.options.send(request)
        throw new Error("Offline")
      },
    })
    await outbox.enqueue(submission())
    for (let attempt = 0; attempt < 7; attempt++) await outbox.flush()
    expect(f.sent).toHaveLength(5)
    expect(f.visible.get("msg_1")?.status).toBe("failed")
    expect(f.rows.get("server-a:msg_1")?.request).toEqual(submission().request)
  })

  test("allows independent sessions to send while another session is blocked", async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const outbox = createPromptOutbox({
      ...f.options,
      send: async (request) => {
        if (request.sessionID === "ses_a") await gate.promise
        if (request.sessionID === "ses_b") second.resolve()
        return f.options.send(request)
      },
    })
    await outbox.enqueue(submission())
    await outbox.enqueue(submission("msg_2", "ses_b"))
    const flushing = outbox.flush()
    await second.promise
    expect(f.sent.map((request) => request.sessionID)).toEqual(["ses_b"])
    gate.resolve()
    await flushing
    expect(f.sent).toHaveLength(2)
  })

  test("a transport adapter cannot mutate the persisted retry payload", async () => {
    const f = fixture()
    const outbox = createPromptOutbox({
      ...f.options,
      send: async (request) => {
        const receipt = await f.options.send(request)
        Object.assign(request, { text: "Changed by adapter" })
        if (f.sent.length === 1) throw new Error("Lost response")
        return receipt
      },
    })
    await outbox.enqueue(submission())
    await outbox.flush()
    await outbox.flush()
    expect(f.sent).toEqual([submission().request, submission().request])
  })

  test("keeps a rejected message without automatically retrying it", async () => {
    const f = fixture()
    const outbox = createPromptOutbox({
      ...f.options,
      send: async (request) => {
        await f.options.send(request)
        throw new Error("Forbidden", { cause: { status: 403 } })
      },
    })
    await outbox.enqueue(submission())
    await outbox.flush()
    await outbox.flush()
    expect(f.sent).toHaveLength(1)
    expect(f.visible.get("msg_1")?.status).toBe("failed")
    expect(f.rows.size).toBe(1)
  })

  test("only an explicit retry wakes an accepted input after Stop and restart", async () => {
    const f = fixture()
    const original = createPromptOutbox(f.options)
    await original.enqueue(submission())
    await original.flush()
    await original.pause("ses_a")
    expect(f.visible.get("msg_1")?.receipt).toEqual({ admittedSeq: 1 })
    original.dispose()
    const restored = createPromptOutbox(f.options)
    await restored.flush()
    expect(f.sent).toHaveLength(1)
    expect(f.visible.get("msg_1")?.status).toBe("paused")
    await restored.retry("ses_a", "msg_1")
    expect(f.sent).toEqual([submission().request, submission().request])
    expect(f.visible.get("msg_1")?.status).toBe("accepted")
  })

  test("reconciles a missed promotion after Stop without resending", async () => {
    const f = fixture()
    const original = createPromptOutbox(f.options)
    await original.enqueue(submission())
    await original.flush()
    await original.pause("ses_a")
    original.dispose()
    f.promoted.add("msg_1")
    await createPromptOutbox(f.options).flush()
    expect(f.sent).toHaveLength(1)
    expect(f.visible.size).toBe(0)
    expect(f.rows.size).toBe(0)
  })
})
