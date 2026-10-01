import { onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createOutboxStorage, createPromptOutbox, type OutboxEntry, type OutboxStorage } from "@/utils/prompt-outbox"
import type { ServerSDK } from "./server-sdk"
import type { ServerSession } from "./server-session"

export function createServerOutbox(sdk: ServerSDK, session: ServerSession) {
  const enabled = sdk.protocol.then((protocol) => protocol === "v2")
  const [entries, setEntries] = createStore<Record<string, OutboxEntry | undefined>>({})
  const storage: { value?: OutboxStorage } = {}
  const driver = () => (storage.value ??= createOutboxStorage())
  const outbox = createPromptOutbox({
    scope: sdk.scope,
    storage: {
      list: async (scope) => ((await enabled) ? driver().list(scope) : []),
      put: (entry) => driver().put(entry),
      remove: (scope, id) => driver().remove(scope, id),
    },
    send: (request, signal) =>
      sdk.currentApi.session.prompt(request, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }),
    promoted: async (sessionID, messageID) => {
      if (session.data.session_message[sessionID]?.some((message) => message.id === messageID)) return true
      return sdk.currentApi.session
        .message({ sessionID, messageID }, { signal: AbortSignal.timeout(10_000) })
        .then(() => true)
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            error.cause &&
            typeof error.cause === "object" &&
            "status" in error.cause &&
            error.cause.status === 404
          )
            return false
          throw error
        })
    },
    change: (id, entry) =>
      setEntries(
        produce((state) => {
          if (entry) state[id] = entry
          if (!entry) delete state[id]
        }),
      ),
    restore: (entry) =>
      session.optimistic.add({ sessionID: entry.request.sessionID, message: entry.message, parts: entry.parts }),
  })
  // Reconciliation survives navigation because this service belongs to the server, not a page.
  const flush = () =>
    outbox.flush().catch((error: unknown) => console.error("Prompt outbox reconciliation failed", error))
  const timer: { id?: ReturnType<typeof setInterval> } = {}
  let disposed = false
  onMount(() => {
    void outbox.ready
      .then(async () => {
        if (disposed || !(await enabled)) return
        await flush()
        if (!disposed) timer.id = setInterval(() => void flush(), 5_000)
      })
      .catch((error: unknown) => console.error("Prompt outbox could not be loaded", error))
  })
  onCleanup(() => {
    disposed = true
    clearInterval(timer.id)
    outbox.dispose()
  })
  return { ...outbox, enabled, entries, flush }
}
