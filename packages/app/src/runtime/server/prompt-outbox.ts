import type { Data } from "@opencode/client/solid"
import type { SessionInboxUser, SessionPromptInput } from "@opencode/client/promise"
import { SessionMessage } from "@opencode/schema/session-message"
import { Option, Schema } from "effect"
import { onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ServerSDK } from "./client"
import type { ServerScope } from "./scope"

type PromptCall = SessionPromptInput & { gate?: Promise<unknown>; prepare?: () => Promise<unknown> }
type PromptRequest = SessionPromptInput & { id: string }

export type PromptOutboxEntry = {
  scope: ServerScope
  request: PromptRequest
  status: "sending" | "reconnecting" | "failed"
  attempts: number
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
  const active = new Map<string, Promise<void>>()
  const stopped = new Set<string>()
  let disposed = false

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
    change(entry)
    await storage.put(entry)
  }

  const remove = async (entry: PromptOutboxEntry) => {
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

  const deliver = async (entry: PromptOutboxEntry, initial?: PromptCall) => {
    if (disposed) throw new Error("The submission server has been disconnected")
    if (stopped.has(entry.request.sessionID)) return receipt(entry.request)
    const current = { ...entry, status: "sending" as const, attempts: entry.attempts + 1, error: undefined }
    await update(current)
    const result = await (
      initial
        ? input.data.session.prompt({ ...initial, id: current.request.id })
        : prepare(current.request).then(() => input.data.session.prompt(current.request))
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    if ("value" in result) {
      await remove(current)
      return result.value
    }
    if (disposed) return receipt(current.request)
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

  const drain = (sessionID: string) => {
    const running = active.get(sessionID)
    if (running) return running
    const task = (async () => {
      const pending = Object.values(entries)
        .filter((entry): entry is PromptOutboxEntry => entry?.request.sessionID === sessionID)
        .toSorted((a, b) => a.request.id.localeCompare(b.request.id))
      for (const entry of pending) {
        if (disposed || stopped.has(sessionID) || entry.status === "failed") return
        await deliver(entry).catch(() => undefined)
      }
    })().finally(() => active.delete(sessionID))
    active.set(sessionID, task)
    return task
  }

  const ready = storage.list(input.scope).then((stored) => {
    if (disposed) return
    stored.forEach((entry) => change(entry))
  })

  const flush = async () => {
    await ready
    if (disposed) return
    await Promise.all(
      [...new Set(Object.values(entries).flatMap((entry) => (entry ? [entry.request.sessionID] : [])))].map(drain),
    )
  }

  const timer = setInterval(() => void flush(), 5_000)
  queueMicrotask(() => void flush())
  onCleanup(() => {
    disposed = true
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
      const existing = entries[durable.id]
      if (existing && JSON.stringify(existing.request) !== JSON.stringify(durable))
        throw new Error("Conflicting prompt retry")
      const entry: PromptOutboxEntry = existing ?? {
        scope: input.scope,
        request: durable,
        status: "sending",
        attempts: 0,
      }
      await update(entry)
      return deliver(entry, { ...durable, gate, prepare: beforeSend })
    },
    async retry(sessionID: string, id: string) {
      await ready
      const entry = entries[id]
      if (!entry || entry.request.sessionID !== sessionID) return
      stopped.delete(sessionID)
      await update({ ...entry, status: "reconnecting", attempts: 0, error: undefined })
      await drain(sessionID)
    },
    pause(sessionID: string) {
      stopped.add(sessionID)
    },
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- transport failures cross the promise rejection boundary.
function requestStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return
  if ("status" in error && typeof error.status === "number") return error.status
  if ("cause" in error) return requestStatus(error.cause)
}

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
