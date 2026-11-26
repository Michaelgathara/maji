import { expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { ProjectTable } from "@opencode/core/project/sql"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSearch } from "@opencode/core/session/search"
import { SessionSearchIndex } from "@opencode/core/session/search-index"
import { SessionStore } from "@opencode/core/session/store"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { RoutingRetrieval } from "@opencode/core/session/routing-retrieval"
import { RoutingCard } from "@opencode/core/session/routing-card"
import { routePrompt } from "@opencode/core/session/routing-engine"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionSearch.node, SessionStore.node])))
const old = Session.ID.make("ses_old_kyoto")
const now = 1_800_000

const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values([
      {
        id: old,
        project_id: Project.ID.global,
        slug: "old",
        directory: "/other",
        title: "Notes",
        version: "test",
        time_created: 1,
        time_updated: 1,
      },
      ...Array.from({ length: 24 }, (_, index) => ({
        id: Session.ID.make(`ses_archived_${index}`),
        project_id: Project.ID.global,
        slug: `archived-${index}`,
        directory: "/project",
        title: "Compare Kyoto hotels",
        version: "test",
        time_archived: now,
      })),
      ...Array.from({ length: 300 }, (_, index) => ({
        id: Session.ID.make(`ses_recent_${index}`),
        project_id: Project.ID.global,
        slug: `recent-${index}`,
        directory: "/project",
        title: `OAuth callback ${index}`,
        version: "test",
        time_created: index + 2,
        time_updated: now - index,
      })),
    ])
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionMessageTable)
    .values(
      Array.from({ length: 51 }, (_, index) => ({
        id: SessionMessage.ID.make(`msg_history_${index.toString().padStart(3, "0")}`),
        session_id: old,
        type: "user" as const,
        seq: index + 1,
        time_created: index + 1,
        time_updated: index + 1,
        data: {
          text: index === 0 ? "Compare Kyoto hotels near the station" : "Thank you for the details",
          time: { created: index + 1 },
        },
      })),
    )
    .run()
    .pipe(Effect.orDie)
  return database.db
})

const build = Effect.fn(function* () {
  const database = yield* Database.Service
  yield* SessionSearchIndex.ensure(database.db)
  while (!(yield* SessionSearchIndex.buildChunk(database.db)).done) {}
})

it.effect("finds a chat beyond the recent 250 and evidence older than its latest 40 messages", () =>
  Effect.gen(function* () {
    yield* setup
    yield* build()
    const store = yield* SessionStore.Service
    const retrieved = yield* RoutingRetrieval.select({ text: "Compare Kyoto hotels" })
    expect(retrieved.candidates.map((session) => session.id)).toContain(old)
    expect(retrieved.candidates.length).toBeLessThanOrEqual(29)
    expect(retrieved.candidates.every((session) => !session.time.archived)).toBe(true)
    const candidates = yield* Effect.forEach(retrieved.candidates, (session) =>
      Effect.gen(function* () {
        const card = RoutingCard.fromMessages({
          title: session.title ?? "",
          messages: yield* store.messages({ sessionID: session.id, limit: 40 }),
          pendingInput: 0,
          busy: false,
        })
        if (session.id === old) expect(card.text).not.toContain("Kyoto")
        return {
          id: session.id,
          title: session.title ?? "",
          directory: session.location.directory,
          updated: DateTime.toEpochMillis(session.time.updated),
          pendingInput: 0,
          busy: false,
          card,
          history: retrieved.matches.get(session.id),
        }
      }),
    )
    expect(routePrompt({ prompt: "Compare Kyoto hotels", candidates, now }).decision).toEqual({
      type: "existing",
      sessionID: old,
    })
  }),
)

it.effect("reports missing, building, and failed indexes separately from a completed no-match lookup", () =>
  Effect.gen(function* () {
    const db = yield* setup
    const missing = yield* RoutingRetrieval.select({ text: "Kyoto hotels" }).pipe(Effect.result)
    expect(missing._tag).toBe("Failure")
    yield* SessionSearchIndex.ensure(db)
    expect((yield* RoutingRetrieval.select({ text: "Kyoto hotels" }).pipe(Effect.result))._tag).toBe("Failure")
    yield* SessionSearchIndex.fail(db, "fixture failure")
    expect((yield* RoutingRetrieval.select({ text: "Kyoto hotels" }).pipe(Effect.result))._tag).toBe("Failure")
    yield* SessionSearchIndex.retry(db)
    yield* build()
    const retrieved = yield* RoutingRetrieval.select({ text: "Penguin migration" })
    expect(retrieved.matches.size).toBe(0)
  }),
)

it.effect("keeps an old current chat in the bounded shortlist for a continuation", () =>
  Effect.gen(function* () {
    yield* setup
    yield* build()
    const retrieved = yield* RoutingRetrieval.select({ text: "Continue", currentSessionID: old })
    expect(retrieved.candidates[0]?.id).toBe(old)
    expect(retrieved.candidates.length).toBeLessThanOrEqual(29)
  }),
)
