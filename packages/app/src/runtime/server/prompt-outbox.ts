import type { Data } from "@opencode/client/solid"
import type { SessionInboxUser, SessionPromptInput } from "@opencode/client/promise"
import { SessionMessage } from "@opencode/schema/session-message"
import { Option, Schema } from "effect"
import { onCleanup } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import {
  createOutboxState,
  outboxDisposed,
  outboxPaused,
  runningOutboxTask,
  transitionOutbox,
} from "./prompt-outbox-machine"
import type { ServerSDK } from "./client"
import type { ServerScope } from "./scope"

type PromptCall = SessionPromptInput & Pick<Parameters<Data["session"]["prompt"]>[0], "gate" | "prepare">

type PromptRequest = SessionPromptInput & { id: string }

export type PromptOutboxEntry = {
  scope: ServerScope
  request: PromptRequest
  status: "sending" | "reconnecting" | "failed"
  attempts: number
  order?: number
  error?: string
}

type PromptOutboxStorage = {
  list(scope: ServerScope): Promise<PromptOutboxEntry[]>
  put(entry: PromptOutboxEntry): Promise<void>
  remove(scope: ServerScope, id: string): Promise<void>
}

type PromptData = {
  session: {
    get(sessionID: string): { revert?: { messageID: string } } | undefined
    prompt: Data["session"]["prompt"]
    sync: Data["session"]["sync"]
  }
}

type PromptSDK = {
  api: {
    session: {
      revert: { commit: ServerSDK["api"]["session"]["revert"]["commit"] }
      switchAgent: ServerSDK["api"]["session"]["switchAgent"]
      switchModel: ServerSDK["api"]["session"]["switchModel"]
    }
  }
}

const PromptSelection = Schema.Struct({
  agent: Schema.String.pipe(Schema.optional),
  model: Schema.Struct({
    providerID: Schema.String,
    modelID: Schema.String,
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
})

export function createPromptOutbox(input: {
  scope: ServerScope
  sdk: PromptSDK
  data: PromptData
  storage?: PromptOutboxStorage
}) {
  const storage = input.storage ?? createPromptOutboxStorage()
  const [entries, setEntries] = createStore<Record<string, PromptOutboxEntry | undefined>>({})
  let state = createOutboxState()
  const preparations = new Map<string, Pick<PromptCall, "gate" | "prepare">>()

  const run = <T>(sessionID: string, execute: () => Promise<T>) => {
    const previous = runningOutboxTask(state, sessionID)
    const result = (previous ?? Promise.resolve()).then(execute)

    const task = result.then(
      () => undefined,
      () => undefined,
    )

    // Claim before persistence or transport can yield to the background flush.
    state = transitionOutbox(state, { type: "scheduled", sessionID, task })
    void task.then(() => {
      state = transitionOutbox(state, { type: "settled", sessionID, task })
    })

    return result
  }

  const change = (entry: PromptOutboxEntry | undefined, id = entry?.request.id) => {
    if (!id) return
    setEntries(
      produce((draft) => {
        if (entry) draft[id] = entry

        if (!entry) delete draft[id]
      }),
    )
  }

  const update = async (entry: PromptOutboxEntry) => {
    const snapshot = structuredClone(unwrap(entry))
    change(snapshot)
    await storage.put(snapshot)
  }

  const remove = async (entry: PromptOutboxEntry) => {
    preparations.delete(entry.request.id)
    change(undefined, entry.request.id)
    await storage.remove(input.scope, entry.request.id)
  }

  const prepare = async (request: PromptRequest) => {
    await input.data.session.sync(request.sessionID).catch(() => undefined)
    const session = input.data.session.get(request.sessionID)

    if (session?.revert) await input.sdk.api.session.revert.commit({ sessionID: request.sessionID })
    const selection = Option.getOrUndefined(Schema.decodeUnknownOption(PromptSelection)(request.metadata))

    if (selection?.agent)
      await input.sdk.api.session.switchAgent({ sessionID: request.sessionID, agent: selection.agent })

    if (selection?.model)
      await input.sdk.api.session.switchModel({
        sessionID: request.sessionID,
        model: {
          providerID: selection.model.providerID,
          id: selection.model.modelID,
          variant: selection.model.variant,
        },
      })
  }

  const deliver = async (entry: PromptOutboxEntry) => {
    if (outboxDisposed(state)) throw new Error("The submission server has been disconnected")

    if (outboxPaused(state, entry.request.sessionID)) return receipt(entry.request)
    const current = { ...unwrap(entry), status: "sending" as const, attempts: entry.attempts + 1, error: undefined }
    await update(current)
    const initial = preparations.get(current.request.id)

    const result = await (
      initial
        ? input.data.session.prompt({ ...current.request, ...initial })
        : prepare(current.request).then(() => input.data.session.prompt(current.request))
    ).then(
      (value) => ({ value }),
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- transport rejections are decoded by requestStatus below.
      (error: unknown) => ({ error }),
    )

    if ("value" in result) {
      await remove(current)

      return result.value
    }

    if (outboxDisposed(state)) return receipt(current.request)
    const error = result.error
    const status = requestStatus(error)

    if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      await remove(current)
      throw error
    }

    await update({
      ...current,
      status: current.attempts >= 5 ? "failed" : "reconnecting",
      error: error instanceof Error ? error.message : "Message delivery needs attention",
    })

    return receipt(current.request)
  }

  const sendPending = async (sessionID: string, target?: PromptRequest) => {
    const pending = Object.values(entries)
      .filter((entry): entry is PromptOutboxEntry => entry?.request.sessionID === sessionID)
      .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.request.id.localeCompare(b.request.id))

    for (const entry of pending) {
      if (outboxPaused(state, sessionID) || entry.status === "failed") return

      const result = await deliver(entry).then(
        (value) => ({ value }),
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- transport rejections are decoded by requestStatus below.
        (error: unknown) => ({ error }),
      )

      if (entry.request.id === target?.id) {
        if ("error" in result) throw result.error

        return result.value
      }

      // An uncertain earlier admission must settle before a later prompt can pass it.
      if (entries[entry.request.id]) return
    }
  }

  const drain = (sessionID: string) => {
    const running = runningOutboxTask(state, sessionID)

    if (running) return running

    return run(sessionID, () => sendPending(sessionID))
  }

  const ready = storage.list(input.scope).then((stored) => {
    if (outboxDisposed(state)) return
    stored.forEach((entry) => change(entry))
  })

  const flush = async () => {
    await ready

    if (outboxDisposed(state)) return
    await Promise.all(
      [...new Set(Object.values(entries).flatMap((entry) => (entry ? [entry.request.sessionID] : [])))].map(drain),
    )
  }

  const timer = setInterval(() => void flush(), 5_000)
  queueMicrotask(() => void flush())
  onCleanup(() => {
    state = transitionOutbox(state, { type: "disposed" })
    preparations.clear()
    clearInterval(timer)
  })

  return {
    entries,
    ready,
    flush,
    async prompt(value: PromptCall) {
      await ready
      const { gate, prepare: beforeSend, ...request } = value
      const durable = structuredClone({ ...request, id: request.id ?? SessionMessage.ID.create() })

      return run(durable.sessionID, async () => {
        if (outboxDisposed(state)) throw new Error("The submission server has been disconnected")
        const existing = entries[durable.id]

        if (existing && JSON.stringify(existing.request) !== JSON.stringify(durable))
          throw new Error("Conflicting prompt retry")

        const entry: PromptOutboxEntry = existing ?? {
          scope: input.scope,
          request: durable,
          status: "sending",
          attempts: 0,
          order: Object.values(entries).reduce((order, entry) => Math.max(order, entry?.order ?? 0), 0) + 1,
        }

        preparations.set(durable.id, { gate, prepare: beforeSend })
        await update(entry)

        return (await sendPending(durable.sessionID, durable)) ?? receipt(durable)
      })
    },
    async retry(sessionID: string, id: string) {
      await ready
      const entry = entries[id]

      if (!entry || entry.request.sessionID !== sessionID) return
      state = transitionOutbox(state, { type: "resume", sessionID })
      await run(sessionID, async () => {
        const current = entries[id]

        if (!current) return
        await update({ ...unwrap(current), status: "reconnecting", attempts: 0, error: undefined })
        await sendPending(sessionID)
      })
    },
    pause(sessionID: string) {
      state = transitionOutbox(state, { type: "pause", sessionID })
    },
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- transport failures cross the promise rejection boundary.
function requestStatus(error: unknown): number | undefined {
  const failure = Option.getOrUndefined(Schema.decodeUnknownOption(TransportFailure)(error))

  return failure?.status ?? (failure?.cause === undefined ? undefined : requestStatus(failure.cause))
}

const TransportFailure = Schema.Struct({
  status: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Unknown),
})

function receipt(request: PromptRequest): SessionInboxUser {
  return {
    id: request.id,
    sessionID: request.sessionID,
    time: { created: Date.now() },
    type: "user",
    delivery: request.delivery ?? "steer",
    payload: {
      text: request.text,
      agents: request.agents?.map((agent) => ({ ...agent })),
      metadata: request.metadata ? { ...request.metadata } : undefined,
    },
  }
}

function createPromptOutboxStorage(): PromptOutboxStorage {
  if (typeof indexedDB === "undefined") return memoryStorage()

  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("maji-prompt-outbox", 1)
    request.onupgradeneeded = () => request.result.createObjectStore("messages", { keyPath: ["scope", "request.id"] })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  const transaction = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) => {
    const tx = (await db).transaction("messages", mode)
    const request = run(tx.objectStore("messages"))

    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error ?? new Error("Outbox transaction aborted"))
      tx.onerror = () => reject(tx.error)
    })
  }

  return {
    list: async (scope) =>
      // SAFETY: this private object store is written only through put(), which accepts PromptOutboxEntry.
      ((await transaction("readonly", (store) => store.getAll())) as PromptOutboxEntry[]).filter(
        (entry) => entry.scope === scope,
      ),
    put: async (entry) => {
      await transaction("readwrite", (store) => store.put(entry))
    },
    remove: async (scope, id) => {
      await transaction("readwrite", (store) => store.delete([scope, id]))
    },
  }
}

function memoryStorage(): PromptOutboxStorage {
  const entries = new Map<string, PromptOutboxEntry>()
  const key = (scope: ServerScope, id: string) => `${scope}\0${id}`

  return {
    list: async (scope) => [...entries.values()].filter((entry) => entry.scope === scope),
    put: async (entry) => {
      entries.set(key(entry.scope, entry.request.id), entry)
    },
    remove: async (scope, id) => {
      entries.delete(key(scope, id))
    },
  }
}
