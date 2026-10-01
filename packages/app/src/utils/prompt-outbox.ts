import type { SessionPendingUser, SessionPromptInput } from "@opencode-ai/client/promise"
import type { Part, UserMessage } from "@opencode-ai/sdk/v2/client"

export type OutboxEntry = {
  scope: string
  request: SessionPromptInput & { id: string }
  message: UserMessage
  parts: Part[]
  status: "sending" | "reconnecting" | "accepted" | "failed" | "paused"
  attempts: number
  error?: string
  receipt?: { admittedSeq: number }
  resumeRequested?: boolean
}

export type OutboxStorage = {
  list(scope: string): Promise<OutboxEntry[]>
  put(entry: OutboxEntry): Promise<void>
  remove(scope: string, id: string): Promise<void>
}

class ReceiptMismatch extends Error {}

// Only V2 admission is retryable. Never use this transport for commands, shells, or V1 prompts.
export function createPromptOutbox(input: {
  scope: string
  storage: OutboxStorage
  send(request: OutboxEntry["request"], signal: AbortSignal): Promise<SessionPendingUser>
  promoted(sessionID: string, messageID: string): Promise<boolean>
  change(id: string, entry: OutboxEntry | undefined): void
  restore(entry: OutboxEntry): void
}) {
  const entries = new Map<string, OutboxEntry>()
  const active = new Map<string, Promise<void>>()
  const writes = new Map<string, Promise<void>>()
  const controllers = new Map<string, AbortController>()
  const stopped = new Set<string>()
  let disposed = false

  const write = (id: string, action: () => Promise<void>) => {
    const next = (writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(action)
    writes.set(id, next)
    void next
      .finally(() => {
        if (writes.get(id) === next) writes.delete(id)
      })
      .catch(() => undefined)
    return next
  }

  const update = (entry: OutboxEntry) => {
    entries.set(entry.request.id, entry)
    input.change(entry.request.id, entry)
    return write(entry.request.id, () => input.storage.put(entry))
  }

  const confirm = async (sessionID: string, id: string) => {
    const entry = entries.get(id)
    if (!entry || entry.request.sessionID !== sessionID) return
    // Remove from memory first so a late response cannot resurrect a promoted message.
    entries.delete(id)
    input.change(id, undefined)
    await write(id, () => input.storage.remove(input.scope, id))
  }

  const deliver = async (entry: OutboxEntry) => {
    const id = entry.request.id
    if (entry.receipt && !entry.resumeRequested) {
      if (await input.promoted(entry.request.sessionID, id)) await confirm(entry.request.sessionID, id)
      return
    }
    const controller = new AbortController()
    controllers.set(id, controller)
    await update({ ...entry, status: "sending", attempts: entry.attempts + 1, error: undefined })
    if (disposed || stopped.has(entry.request.sessionID) || !entries.has(id)) return
    const receipt = await input.send(structuredClone(entry.request), controller.signal)
    if (
      receipt.id !== id ||
      receipt.sessionID !== entry.request.sessionID ||
      receipt.delivery !== (entry.request.delivery ?? "steer") ||
      !Number.isSafeInteger(receipt.admittedSeq) ||
      receipt.admittedSeq < 0
    )
      throw new ReceiptMismatch("Prompt admission receipt does not match the submission")
    if (!entries.has(id)) return
    await update({
      ...entries.get(id)!,
      status: stopped.has(entry.request.sessionID) ? "paused" : "accepted",
      receipt: { admittedSeq: receipt.admittedSeq },
      resumeRequested: undefined,
      error: undefined,
    })
  }

  const drain = (sessionID: string) => {
    const running = active.get(sessionID)
    if (running) return running
    const task = (async () => {
      const pending = [...entries.values()].filter((entry) => entry.request.sessionID === sessionID)
      for (const entry of pending) {
        if (disposed) return
        const current = entries.get(entry.request.id)
        if (!current) continue
        // An uncertain earlier admission must not be overtaken by a later send.
        if (stopped.has(sessionID) || current.status === "failed" || current.status === "paused") {
          // A missed promotion event can be reconciled without restarting execution.
          if (!(await input.promoted(sessionID, current.request.id))) return
          await confirm(sessionID, current.request.id)
          continue
        }
        const error = await deliver(current).then(
          () => undefined,
          (error: unknown) => error,
        )
        controllers.delete(entry.request.id)
        if (error === undefined) continue
        const latest = entries.get(entry.request.id)
        if (!latest || disposed) return
        const code = requestStatus(error)
        const rejected =
          error instanceof ReceiptMismatch ||
          (code !== undefined && code >= 400 && code < 500 && code !== 408 && code !== 429)
        const status = stopped.has(sessionID)
          ? "paused"
          : latest.receipt && !latest.resumeRequested
            ? "accepted"
            : rejected || latest.attempts >= 5
              ? "failed"
              : "reconnecting"
        await update({
          ...latest,
          status,
          error: error instanceof Error ? error.message : "Message delivery needs attention",
        })
        return
      }
    })().finally(() => active.delete(sessionID))
    active.set(sessionID, task)
    return task
  }

  const ready = input.storage.list(input.scope).then((stored) => {
    if (disposed) return
    stored
      .filter((entry) => entry.scope === input.scope)
      .forEach((entry) => {
        entries.set(entry.request.id, entry)
        input.change(entry.request.id, entry)
        input.restore(entry)
        if (entry.status === "paused") stopped.add(entry.request.sessionID)
      })
  })

  const flush = async () => {
    await ready
    if (disposed) return
    await Promise.all([...new Set([...entries.values()].map((entry) => entry.request.sessionID))].map(drain))
  }

  return {
    ready,
    flush,
    confirm,
    async enqueue(value: Omit<OutboxEntry, "scope" | "status" | "attempts">) {
      // Snapshot before the first await; callers may navigate or edit their draft immediately.
      const entry: OutboxEntry = JSON.parse(
        JSON.stringify({ ...value, scope: input.scope, status: "sending", attempts: 0 }),
      )
      if (entry.message.id !== entry.request.id || entry.message.sessionID !== entry.request.sessionID)
        throw new Error("Prompt destination does not match its optimistic message")
      await ready
      if (disposed) throw new Error("The submission server has been disconnected")
      // The composer may clear only after this write commits.
      await write(entry.request.id, async () => {
        const existing = entries.get(entry.request.id)
        if (existing) {
          if (JSON.stringify(existing.request) !== JSON.stringify(entry.request))
            throw new Error("Conflicting prompt retry")
          return
        }
        await input.storage.put(entry)
        entries.set(entry.request.id, entry)
        input.change(entry.request.id, entry)
        input.restore(entry)
        stopped.delete(entry.request.sessionID)
      })
    },
    async retry(sessionID: string, id: string) {
      await ready
      const entry = entries.get(id)
      if (!entry || entry.request.sessionID !== sessionID) return
      stopped.delete(sessionID)
      // An explicit Retry may wake a saved input after Stop. Background reconciliation never does.
      await update({
        ...entry,
        status: "reconnecting",
        resumeRequested: !!entry.receipt,
        attempts: 0,
        error: undefined,
      })
      await drain(sessionID)
    },
    async pause(sessionID: string) {
      stopped.add(sessionID)
      await ready
      await Promise.all(
        [...entries.values()]
          .filter((entry) => entry.request.sessionID === sessionID)
          .map((entry) => {
            controllers.get(entry.request.id)?.abort()
            return update({ ...entry, status: "paused", resumeRequested: undefined })
          }),
      )
    },
    dispose() {
      disposed = true
      controllers.forEach((controller) => controller.abort())
    },
  }
}

function requestStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return
  if ("status" in error && typeof error.status === "number") return error.status
  if ("cause" in error) return requestStatus(error.cause)
}

export function createOutboxStorage(): OutboxStorage {
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("opencode-prompt-outbox", 1)
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
      ((await transaction("readonly", (store) => store.getAll())) as OutboxEntry[])
        .filter((entry) => entry.scope === scope)
        .sort((a, b) => a.message.time.created - b.message.time.created || a.request.id.localeCompare(b.request.id)),
    put: async (entry) => {
      await transaction("readwrite", (store) => store.put(entry))
    },
    remove: async (scope, id) => {
      await transaction("readwrite", (store) => store.delete([scope, id]))
    },
  }
}
