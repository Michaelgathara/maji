export * as RoutingCard from "./routing-card.js"

import type { SessionMessage } from "@opencode/schema/session-message"
import { buildRoutingCard, type RoutingMessage, type RoutingPart } from "./routing-engine.js"

/** SessionStore returns newest first. Card construction and last-message selection use chronology. */
export function fromMessages(input: {
  title: string
  messages: readonly SessionMessage.Info[]
  pendingInput: number
  busy: boolean
}) {
  return buildRoutingCard({ ...input, messages: input.messages.toReversed().flatMap(toRoutingMessage) })
}

function toRoutingMessage(message: SessionMessage.Info): RoutingMessage[] {
  if (message.type === "user")
    return [
      {
        role: "user",
        parts: [
          { type: "text", text: message.text },
          ...(message.files ?? []).map((file) => ({
            type: "file",
            filename: file.name,
            source: file.source.type === "uri" ? { path: file.source.uri } : undefined,
          })),
        ],
      },
    ]
  if (message.type === "assistant")
    return [
      {
        role: "assistant",
        parts: message.content.flatMap((part): RoutingPart[] => {
          if (part.type === "text") return [{ type: "text", text: part.text }]
          if (part.type === "tool") return [{ type: "tool", tool: part.name, state: { input: part.state.input } }]
          return []
        }),
      },
    ]
  if (message.type === "compaction" && message.status === "completed") {
    return [{ role: "context", parts: [{ type: "text", text: message.summary }] }]
  }
  return []
}
