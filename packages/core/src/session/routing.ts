export * as SessionRouting from "./routing.js"

import { Form } from "../form.js"
import { Instance } from "../instance/service.js"
import { KV } from "../kv.js"
import { Permission } from "../permission.js"
import { Session } from "../session.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Card, CardEntry, RouteResult } from "@opencode/schema/session-routing"
import { Session as SessionSchema } from "@opencode/schema/session"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SessionRecentText } from "./recent-text.js"
import {
  buildRoutingCard,
  routePrompt,
  routingCardNeedsRefresh,
  type RouteCandidate,
  type RoutingMessage,
} from "./routing-engine.js"

export const RouteInput = Schema.Struct({
  text: Schema.String,
  currentSessionID: SessionSchema.ID.pipe(Schema.optional),
  directory: Schema.String.pipe(Schema.optional),
})
export type RouteInput = typeof RouteInput.Type

const StoredCard = Schema.Struct({
  sessionUpdated: Schema.Finite,
  card: Card,
})

const CANDIDATE_LIMIT = 250
const REFRESH_LIMIT = 32
const TRANSCRIPT_LIMIT = 40
const KEY_PREFIX = "maji:session-routing:"

export interface Interface {
  readonly route: (input: RouteInput) => Effect.Effect<RouteResult>
  readonly cards: () => Effect.Effect<CardEntry[]>
}

export class Service extends Context.Service<Service, Interface>()("@maji/SessionRouting") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const instances = yield* Instance.Service
    const kv = yield* KV.Service

    const candidateSessions = Effect.fn("SessionRouting.candidates")(function* () {
      const list = yield* sessions
        .list({ order: "desc", parentID: null, archived: false, limit: CANDIDATE_LIMIT })
        .pipe(Effect.orDie)
      return list.data
    })

    const pendingInputCounts = Effect.fn("SessionRouting.pendingInput")(function* (
      candidates: readonly SessionSchema.Info[],
    ) {
      const counts = new Map<SessionSchema.ID, number>()
      yield* Effect.forEach(
        candidates,
        (session) =>
          Effect.all({
            permissions: Permission.Service.use((permission) => permission.forSession(session.id)),
            forms: Form.Service.use((form) => form.list({ sessionID: session.id })),
          }).pipe(
            instances.provide(session),
            Effect.tap(({ permissions, forms }) =>
              Effect.sync(() => {
                const count = permissions.length + forms.length
                if (count > 0) counts.set(session.id, count)
              }),
            ),
            Effect.catchCause(() => Effect.void),
          ),
        { concurrency: 8, discard: true },
      )
      return counts
    })

    const rebuild = Effect.fn("SessionRouting.rebuild")(function* (input: {
      session: SessionSchema.Info
      pendingInput: number
      busy: boolean
    }) {
      const messages = yield* sessions.messages({ sessionID: input.session.id, limit: TRANSCRIPT_LIMIT })
      const card = buildRoutingCard({
        title: input.session.title ?? "Untitled task",
        messages: messages.map(toRoutingMessage),
        pendingInput: input.pendingInput,
        busy: input.busy,
      })
      yield* kv.set(`${KEY_PREFIX}${input.session.id}`, {
        sessionUpdated: DateTime.toEpochMillis(input.session.time.updated),
        card,
      })
      return card
    })

    const ensureCards = Effect.fn("SessionRouting.ensureCards")(function* (input: {
      candidates: readonly SessionSchema.Info[]
      pendingInput: ReadonlyMap<SessionSchema.ID, number>
      active: ReadonlySet<SessionSchema.ID>
    }) {
      const cards = new Map<SessionSchema.ID, Card>()
      const known = new Map<SessionSchema.ID, number>()
      yield* Effect.forEach(
        input.candidates,
        (session) =>
          kv.get(`${KEY_PREFIX}${session.id}`).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                if (!Schema.is(StoredCard)(value)) return
                cards.set(session.id, value.card)
                known.set(session.id, value.sessionUpdated)
              }),
            ),
          ),
        { concurrency: 16, discard: true },
      )

      const stale = input.candidates
        .filter(
          (session) =>
            known.get(session.id) !== DateTime.toEpochMillis(session.time.updated) ||
            routingCardNeedsRefresh({
              card: cards.get(session.id),
              pendingInput: input.pendingInput.get(session.id) ?? 0,
              busy: input.active.has(session.id),
            }),
        )
        .slice(0, REFRESH_LIMIT)

      yield* Effect.forEach(
        stale,
        (session) =>
          rebuild({
            session,
            pendingInput: input.pendingInput.get(session.id) ?? 0,
            busy: input.active.has(session.id),
          }).pipe(
            Effect.tap((card) => Effect.sync(() => cards.set(session.id, card))),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to build routing card", { sessionID: session.id, cause }),
            ),
          ),
        { concurrency: 4, discard: true },
      )

      return cards
    })

    const context = Effect.fn("SessionRouting.context")(function* () {
      const candidates = yield* candidateSessions()
      const pendingInput = yield* pendingInputCounts(candidates)
      const active = yield* sessions.active
      const cards = yield* ensureCards({ candidates, pendingInput, active })
      return { candidates, pendingInput, active, cards }
    })

    const route = Effect.fn("SessionRouting.route")(function* (input: RouteInput) {
      const current = yield* context()
      const outcome = routePrompt({
        prompt: input.text,
        currentSessionID: input.currentSessionID,
        directory: input.directory,
        candidates: current.candidates.map(
          (session): RouteCandidate => ({
            id: session.id,
            title: session.title ?? "Untitled task",
            directory: session.location.directory,
            updated: DateTime.toEpochMillis(session.time.updated),
            pendingInput: current.pendingInput.get(session.id) ?? 0,
            busy: current.active.has(session.id),
            card: current.cards.get(session.id),
          }),
        ),
      })
      return {
        decision:
          "sessionID" in outcome.decision
            ? { ...outcome.decision, sessionID: SessionSchema.ID.make(outcome.decision.sessionID) }
            : outcome.decision,
        candidates: outcome.candidates.map(toCandidate),
      }
    })

    const cards = Effect.fn("SessionRouting.cards")(function* () {
      const current = yield* context()
      return current.candidates.flatMap((session) => {
        const card = current.cards.get(session.id)
        return card ? [{ sessionID: session.id, card }] : []
      })
    })

    return Service.of({ route, cards })
  }),
)

function toCandidate(input: { sessionID: string; title: string; score: number; reason: string }) {
  return {
    sessionID: SessionSchema.ID.make(input.sessionID),
    title: input.title,
    score: input.score,
    reason: input.reason,
  }
}

function toRoutingMessage(message: Parameters<typeof SessionRecentText.messageToText>[0]): RoutingMessage {
  return {
    role: message.type === "user" || message.type === "shell" ? "user" : "assistant",
    parts: [{ type: "text", text: SessionRecentText.messageToText(message) }],
  }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Session.node, Instance.node, KV.node] })
