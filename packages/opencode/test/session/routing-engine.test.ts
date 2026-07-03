import { describe, expect, test } from "bun:test"
import { buildRoutingCard, routePrompt, type RouteCandidate } from "@/session/routing-engine"
import type { SessionRouting } from "@opencode-ai/schema/session-routing"

const now = 1_800_000

function candidate(input: {
  id: string
  title: string
  updated?: number
  directory?: string
  pendingInput?: number
  busy?: boolean
  card?: Partial<SessionRouting.Card>
}): RouteCandidate {
  return {
    id: input.id,
    title: input.title,
    directory: input.directory ?? "/repo",
    updated: input.updated ?? now - 60_000,
    pendingInput: input.pendingInput ?? 0,
    busy: input.busy ?? false,
    card: input.card
      ? {
          version: 1,
          topics: [],
          intents: [],
          files: [],
          openQuestions: [],
          text: "",
          updatedAt: now,
          ...input.card,
        }
      : undefined,
  }
}

describe("routing-engine", () => {
  test("routes a topical prompt to the matching session", () => {
    const outcome = routePrompt({
      prompt: "Can you also fix the oauth callback tests?",
      candidates: [candidate({ id: "a", title: "OAuth callback bug" }), candidate({ id: "b", title: "Pitch deck" })],
      directory: "/repo",
      now,
    })

    expect(outcome.decision?.sessionID).toBe("a")
    expect(outcome.decision?.reason).toBe("topic match")
  })

  test("abstains when two sessions are similarly likely", () => {
    const outcome = routePrompt({
      prompt: "Continue auth",
      candidates: [candidate({ id: "a", title: "Auth login" }), candidate({ id: "b", title: "Auth billing" })],
      directory: "/repo",
      now,
    })

    expect(outcome.decision).toBeUndefined()
    expect(outcome.candidates.length).toBeGreaterThan(0)
  })

  test("routes short approval text to a session waiting for input", () => {
    const outcome = routePrompt({
      prompt: "yes go ahead",
      candidates: [candidate({ id: "a", title: "Database migration", pendingInput: 1 })],
      directory: "/repo",
      now,
    })

    expect(outcome.decision?.sessionID).toBe("a")
    expect(outcome.decision?.reason).toBe("waiting for input")
  })

  test("uses recent conversation text when titles are vague", () => {
    const outcome = routePrompt({
      prompt: "Can you keep going on the sqlite migration?",
      candidates: [
        candidate({
          id: "a",
          title: "Follow up",
          card: { text: "we were planning the sqlite migration and storage schema changes." },
        }),
        candidate({ id: "b", title: "Follow up", card: { text: "we were drafting the landing page copy." } }),
      ],
      directory: "/repo",
      now,
    })

    expect(outcome.decision?.sessionID).toBe("a")
    expect(outcome.decision?.reason).toBe("conversation match")
  })

  test("uses file mentions as a strong routing signal", () => {
    const outcome = routePrompt({
      prompt: "What about the error in parser.ts?",
      candidates: [
        candidate({ id: "a", title: "Build issue", card: { text: "the failing code is in packages/tui/src/parser.ts." } }),
        candidate({ id: "b", title: "Build issue", card: { text: "the issue is in packages/tui/src/theme.tsx." } }),
      ],
      directory: "/repo",
      now,
    })

    expect(outcome.decision?.sessionID).toBe("a")
    expect(outcome.decision?.reason).toBe("file match")
  })

  test("routes status follow-ups to the session with matching conversation context", () => {
    const outcome = routePrompt({
      prompt: "How did the security audit go?",
      candidates: [
        candidate({
          id: "a",
          title: "New session",
          updated: now - 45 * 60_000,
          card: { text: "we completed a security audit and found two medium-risk auth findings." },
        }),
        candidate({
          id: "b",
          title: "New session",
          updated: now - 2 * 60_000,
          card: { text: "we discussed mobile layout polish and command menu styling." },
        }),
      ],
      directory: "/repo",
      now,
    })

    expect(outcome.decision?.sessionID).toBe("a")
    expect(outcome.decision?.reason).toBe("conversation match")
  })

  test("switches away from the current session when another session is clearly relevant", () => {
    const outcome = routePrompt({
      prompt: "What did we decide about the landing page copy?",
      candidates: [
        candidate({
          id: "a",
          title: "OAuth callback bug",
          updated: now - 30_000,
          busy: true,
          card: { text: "we are debugging oauth callback tests and auth redirects." },
        }),
        candidate({
          id: "b",
          title: "Landing page copy",
          updated: now - 45 * 60_000,
          card: {
            summary: "Landing page copy decisions for pricing and hero messaging",
            topics: ["landing page copy", "hero messaging"],
            intents: ["planning"],
          },
        }),
      ],
      currentSessionID: "a",
      directory: "/repo",
      now,
    })

    expect(outcome.decision?.sessionID).toBe("b")
    expect(outcome.decision?.reason).toBe("title match")
  })

  test("keeps ordinary follow-ups in the current session", () => {
    const outcome = routePrompt({
      prompt: "Can you keep going on auth?",
      candidates: [
        candidate({ id: "a", title: "OAuth callback bug", updated: now - 30_000 }),
        candidate({ id: "b", title: "Auth billing", updated: now - 45_000 }),
      ],
      currentSessionID: "a",
      directory: "/repo",
      now,
    })

    expect(outcome.decision).toBeUndefined()
  })

  test("routes using stored cards even without transcript text", () => {
    const outcome = routePrompt({
      prompt: "How did the security audit go?",
      candidates: [
        candidate({
          id: "a",
          title: "New session",
          updated: now - 40 * 60_000,
          card: {
            summary: "Security audit latest outcome medium-risk auth findings",
            topics: ["security audit", "auth findings"],
            intents: ["security-audit"],
            statusHint: "done",
          },
        }),
        candidate({
          id: "b",
          title: "New session",
          updated: now - 2 * 60_000,
          card: {
            summary: "Recent UI polish work for the command menu",
            topics: ["command menu", "ui polish"],
            intents: ["planning"],
            statusHint: "done",
          },
        }),
      ],
      directory: "/repo",
      now,
    })

    expect(outcome.decision?.sessionID).toBe("a")
    expect(outcome.decision?.reason).toBe("memory match")
  })

  test("builds a routing card from transcript messages", () => {
    const card = buildRoutingCard({
      title: "Security audit",
      messages: [
        { role: "user", parts: [{ type: "text", text: "Please run a security audit on the auth flow." }] },
        { role: "assistant", parts: [{ type: "text", text: "The security audit found two medium-risk auth issues." }] },
      ],
      pendingInput: 0,
      busy: false,
      now,
    })

    expect(card.summary).toContain("Security audit")
    expect(card.canonicalTopic).toBe("security audit")
    expect(card.taskType).toBe("security audit")
    expect(card.topics).toContain("security audit")
    expect(card.intents).toContain("security-audit")
    expect(card.currentStatus).toBe("finished with an outcome")
    expect(card.outcome).toContain("security audit found")
    expect(card.lastAssistantReply).toContain("medium-risk auth issues")
    expect(card.text).toContain("security audit")
  })

  test("live pending input overrides a stale done card for approvals", () => {
    const outcome = routePrompt({
      prompt: "yes",
      candidates: [
        candidate({
          id: "a",
          title: "Database migration",
          pendingInput: 1,
          card: { statusHint: "done", summary: "Database migration plan" },
        }),
        candidate({ id: "b", title: "Landing page", updated: now - 5 * 60_000 }),
      ],
      directory: "/repo",
      now,
    })

    expect(outcome.decision?.sessionID).toBe("a")
  })
})
