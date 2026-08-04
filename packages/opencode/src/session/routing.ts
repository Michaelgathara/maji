import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { eq, inArray } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRoutingTable } from "@opencode-ai/core/session/sql"
import { Card, CardEntry, RouteResult } from "@opencode-ai/schema/session-routing"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { InstanceState } from "@/effect/instance-state"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Session } from "./session"
import { SessionStatus } from "./status"
import { SessionID } from "./schema"
import {
  buildRoutingCard,
  routePrompt,
  routingCardNeedsRefresh,
  type RouteCandidate,
  type RoutingMessage,
  type RoutingPart,
} from "./routing-engine"

export const RouteInput = Schema.Struct({
  text: Schema.String,
  currentSessionID: Schema.optional(SessionID),
  directory: Schema.optional(Schema.String),
})
export type RouteInput = Schema.Schema.Type<typeof RouteInput>

// Most sessions never route; only the most recently active ones get their
// cards (re)built per call, so one route request stays cheap even in
// projects with hundreds of sessions.
const CANDIDATE_LIMIT = 250
const REFRESH_LIMIT = 32
const TRANSCRIPT_LIMIT = 40

export interface Interface {
  readonly route: (input: RouteInput) => Effect.Effect<RouteResult>
  readonly cards: () => Effect.Effect<CardEntry[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRouting") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statusSvc = yield* SessionStatus.Service
    const permissionSvc = yield* Permission.Service
    const questionSvc = yield* Question.Service
    const { db } = yield* Database.Service

    const candidateSessions = Effect.fn("SessionRouting.candidates")(function* () {
      const list = yield* sessions.list({ scope: "project", roots: true, limit: CANDIDATE_LIMIT })
      return list.filter((session) => !session.parentID && !session.time.archived)
    })

    const pendingInputCounts = Effect.fn("SessionRouting.pendingInput")(function* () {
      const counts = new Map<string, number>()
      for (const request of yield* permissionSvc.list()) {
        counts.set(request.sessionID, (counts.get(request.sessionID) ?? 0) + 1)
      }
      for (const request of yield* questionSvc.list()) {
        counts.set(request.sessionID, (counts.get(request.sessionID) ?? 0) + 1)
      }
      return counts
    })

    const rebuild = Effect.fn("SessionRouting.rebuild")(function* (input: {
      session: Session.Info
      pendingInput: number
      busy: boolean
    }) {
      const messages = yield* sessions
        .messages({ sessionID: input.session.id, limit: TRANSCRIPT_LIMIT })
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed([] as SessionV1.WithParts[])))
      const card = buildRoutingCard({
        title: input.session.title,
        messages: messages.map(toRoutingMessage),
        pendingInput: input.pendingInput,
        busy: input.busy,
      })
      yield* db
        .insert(SessionRoutingTable)
        .values({
          session_id: input.session.id,
          session_updated: input.session.time.updated,
          data: card,
        })
        .onConflictDoUpdate({
          target: SessionRoutingTable.session_id,
          set: {
            session_updated: input.session.time.updated,
            data: card,
          },
        })
        .run()
        .pipe(Effect.orDie)
      return card
    })

    // Cards are rebuilt lazily: a stored card is stale once its session has
    // been updated since the card was built. Only the most recent stale
    // sessions are rebuilt per call; older sessions keep their stored card.
    const ensureCards = Effect.fn("SessionRouting.ensureCards")(function* (input: {
      candidates: Session.Info[]
      pendingInput: Map<string, number>
      statuses: Map<SessionID, SessionStatus.Info>
    }) {
      const ids = input.candidates.map((session) => session.id)
      const cards = new Map<string, Card>()
      const known = new Map<string, number>()
      if (ids.length > 0) {
        const rows = yield* db
          .select()
          .from(SessionRoutingTable)
          .where(inArray(SessionRoutingTable.session_id, ids))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          cards.set(row.session_id, row.data)
          known.set(row.session_id, row.session_updated)
        }
      }

      const stale = input.candidates
        .filter(
          (session) =>
            known.get(session.id) !== session.time.updated ||
            routingCardNeedsRefresh({
              card: cards.get(session.id),
              pendingInput: input.pendingInput.get(session.id) ?? 0,
              busy: isBusy(input.statuses.get(session.id)),
            }),
        )
        .toSorted((a, b) => b.time.updated - a.time.updated)
        .slice(0, REFRESH_LIMIT)

      yield* Effect.forEach(
        stale,
        (session) =>
          rebuild({
            session,
            pendingInput: input.pendingInput.get(session.id) ?? 0,
            busy: isBusy(input.statuses.get(session.id)),
          }).pipe(
            Effect.map((card) => cards.set(session.id, card)),
            Effect.catchCause((cause) => Effect.logWarning("failed to build routing card", { sessionID: session.id, cause }),
            ),
          ),
        { concurrency: 4, discard: true },
      )

      return cards
    })

    const context = Effect.fn("SessionRouting.context")(function* () {
      const candidates = yield* candidateSessions()
      const pendingInput = yield* pendingInputCounts()
      const statuses = yield* statusSvc.list()
      const cards = yield* ensureCards({ candidates, pendingInput, statuses })
      return { candidates, pendingInput, statuses, cards }
    })

    const route = Effect.fn("SessionRouting.route")(function* (input: RouteInput) {
      const { candidates, pendingInput, statuses, cards } = yield* context()
      const directory = input.directory ?? (yield* InstanceState.directory)
      const outcome = routePrompt({
        prompt: input.text,
        currentSessionID: input.currentSessionID,
        directory,
        candidates: candidates.map(
          (session): RouteCandidate => ({
            id: session.id,
            title: session.title,
            directory: session.directory,
            updated: session.time.updated,
            pendingInput: pendingInput.get(session.id) ?? 0,
            busy: isBusy(statuses.get(session.id)),
            card: cards.get(session.id),
          }),
        ),
      })
      return {
        decision: outcome.decision ? toCandidate(outcome.decision) : undefined,
        candidates: outcome.candidates.map(toCandidate),
      }
    })

    const cardsList = Effect.fn("SessionRouting.cards")(function* () {
      const { candidates, cards } = yield* context()
      return candidates.flatMap((session) => {
        const card = cards.get(session.id)
        if (!card) return []
        return [{ sessionID: session.id, card }]
      })
    })

    return Service.of({ route, cards: cardsList })
  }),
)

function toCandidate(input: { sessionID: string; title: string; score: number; reason: string }) {
  return {
    sessionID: input.sessionID as SessionID,
    title: input.title,
    score: input.score,
    reason: input.reason,
  }
}

function isBusy(status: SessionStatus.Info | undefined) {
  return !!status && status.type !== "idle"
}

function toRoutingMessage(message: SessionV1.WithParts): RoutingMessage {
  return {
    role: message.info.role,
    parts: message.parts.map((part): RoutingPart => {
      const record = part as unknown as Record<string, unknown>
      return {
        type: part.type,
        text: typeof record.text === "string" ? record.text : undefined,
        synthetic: typeof record.synthetic === "boolean" ? record.synthetic : undefined,
        ignored: typeof record.ignored === "boolean" ? record.ignored : undefined,
        filename: typeof record.filename === "string" ? record.filename : undefined,
        source: record.source,
        tool: typeof record.tool === "string" ? record.tool : undefined,
        state:
          record.state && typeof record.state === "object" ? (record.state as Record<string, unknown>) : undefined,
      }
    }),
  }
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, SessionStatus.node, Permission.node, Question.node, Database.node],
})

export * as SessionRouting from "./routing"
