export * as RoutingRetrieval from "./routing-retrieval.js"

import { Effect } from "effect"
import type { Session } from "@opencode/schema/session"
import { Database } from "../database/database.js"
import { routingTerms } from "./routing-engine.js"
import { SessionSearch } from "./search.js"
import { SessionSearchIndex } from "./search-index.js"
import { SessionStore } from "./store.js"

/** Full-history retrieval stays separate from the evidence and decision policy. */
export const select = Effect.fn("RoutingRetrieval.select")(function* (input: {
  text: string
  currentSessionID?: Session.ID
}) {
  const database = yield* Database.Service
  const search = yield* SessionSearch.Service
  const store = yield* SessionStore.Service
  const state = yield* SessionSearchIndex.state(database.db)
  if (!SessionSearchIndex.current(state) || state.status !== "done" || state.skipped > 0)
    return yield* Effect.fail(
      new SessionSearch.IndexUnavailableError({
        reason: "Conversation routing search is not ready. Try again after the history index finishes building.",
      }),
    )

  // Quote terms ourselves: a chat message is text, never an FTS expression.
  const query = routingTerms(input.text)
    .slice(0, 32)
    .map((term) => `"${term}"`)
    .join(" OR ")
  const hits = query
    ? ((yield* search.search({ query, subagents: false, archived: false, limit: 20 })).results ?? [])
    : []
  const recent = yield* store.list({ order: "desc", parentID: null, archived: false, limit: 8 })
  const ids = [
    ...new Set([
      ...(input.currentSessionID ? [input.currentSessionID] : []),
      ...hits.map((hit) => hit.sessionID),
      ...recent.map((session) => session.id),
    ]),
  ]
  const candidates = (yield* Effect.forEach(ids, (id) => store.get(id), { concurrency: 8 })).filter(
    (session): session is Session.Info => session !== undefined && !session.parentID && !session.time.archived,
  )
  return {
    candidates,
    matches: new Map(hits.map((hit) => [hit.sessionID, hit.matches.map((match) => match.snippet).join("\n")])),
  }
})
