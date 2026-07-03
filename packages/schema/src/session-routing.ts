export * as SessionRouting from "./session-routing"

import { Schema } from "effect"
import { SessionID } from "./session-id"

export const StatusHint = Schema.Literals(["needs-input", "active", "done", "idle"])
export type StatusHint = typeof StatusHint.Type

export const Card = Schema.Struct({
  version: Schema.Literal(1),
  summary: Schema.optional(Schema.String),
  canonicalTopic: Schema.optional(Schema.String),
  taskType: Schema.optional(Schema.String),
  topics: Schema.Array(Schema.String),
  intents: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  statusHint: Schema.optional(StatusHint),
  currentStatus: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  openQuestions: Schema.Array(Schema.String),
  lastUserPrompt: Schema.optional(Schema.String),
  lastAssistantReply: Schema.optional(Schema.String),
  text: Schema.String.annotate({ description: "Bounded recent conversation text used for lexical routing" }),
  updatedAt: Schema.Finite,
}).annotate({ identifier: "SessionRoutingCard" })
export interface Card extends Schema.Schema.Type<typeof Card> {}

export const CardEntry = Schema.Struct({
  sessionID: SessionID,
  card: Card,
}).annotate({ identifier: "SessionRoutingCardEntry" })
export interface CardEntry extends Schema.Schema.Type<typeof CardEntry> {}

export const Candidate = Schema.Struct({
  sessionID: SessionID,
  title: Schema.String,
  score: Schema.Finite,
  reason: Schema.String,
}).annotate({ identifier: "SessionRouteCandidate" })
export interface Candidate extends Schema.Schema.Type<typeof Candidate> {}

export const RouteResult = Schema.Struct({
  decision: Schema.optional(Candidate),
  candidates: Schema.Array(Candidate),
}).annotate({ identifier: "SessionRouteResult" })
export interface RouteResult extends Schema.Schema.Type<typeof RouteResult> {}
