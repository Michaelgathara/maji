import { describe, expect, test } from "bun:test"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"
import { buildSessionRouteProfile, buildSessionRoutingMemory, routePromptToSession } from "../src/session-router"

const now = 1_800_000

function session(input: { id: string; title: string; updated?: number; directory?: string }): Session {
  return {
    id: input.id,
    slug: input.id,
    projectID: "project",
    directory: input.directory ?? "/repo",
    title: input.title,
    version: "1",
    time: {
      created: 1,
      updated: input.updated ?? now - 60_000,
    },
  }
}

function route(input: { prompt: string; sessions: Session[]; statuses?: Record<string, SessionStatus> }) {
  return routePromptToSession({
    prompt: input.prompt,
    sessions: input.sessions,
    statuses: input.statuses ?? {},
    permissions: {},
    questions: {},
    directory: "/repo",
    now,
  })
}

describe("session-router", () => {
  test("routes a topical prompt to the matching session", () => {
    const decision = route({
      prompt: "Can you also fix the oauth callback tests?",
      sessions: [session({ id: "a", title: "OAuth callback bug" }), session({ id: "b", title: "Pitch deck" })],
    })

    expect(decision?.sessionID).toBe("a")
    expect(decision?.reason).toBe("topic match")
  })

  test("does not route when two sessions are similarly likely", () => {
    const decision = route({
      prompt: "Continue auth",
      sessions: [session({ id: "a", title: "Auth login" }), session({ id: "b", title: "Auth billing" })],
    })

    expect(decision).toBeUndefined()
  })

  test("routes short approval text to a session waiting for input", () => {
    const decision = routePromptToSession({
      prompt: "yes go ahead",
      sessions: [session({ id: "a", title: "Database migration" })],
      statuses: {},
      permissions: { a: [{}] },
      questions: {},
      directory: "/repo",
      now,
    })

    expect(decision?.sessionID).toBe("a")
    expect(decision?.reason).toBe("waiting for input")
  })

  test("uses recent conversation text when titles are vague", () => {
    const decision = routePromptToSession({
      prompt: "Can you keep going on the sqlite migration?",
      sessions: [session({ id: "a", title: "Follow up" }), session({ id: "b", title: "Follow up" })],
      statuses: {},
      permissions: {},
      questions: {},
      profiles: {
        a: { text: "We were planning the sqlite migration and storage schema changes." },
        b: { text: "We were drafting the landing page copy." },
      },
      directory: "/repo",
      now,
    })

    expect(decision?.sessionID).toBe("a")
    expect(decision?.reason).toBe("conversation match")
  })

  test("uses file mentions as a strong routing signal", () => {
    const decision = routePromptToSession({
      prompt: "What about the error in parser.ts?",
      sessions: [session({ id: "a", title: "Build issue" }), session({ id: "b", title: "Build issue" })],
      statuses: {},
      permissions: {},
      questions: {},
      profiles: {
        a: { text: "The failing code is in packages/tui/src/parser.ts." },
        b: { text: "The issue is in packages/tui/src/theme.tsx." },
      },
      directory: "/repo",
      now,
    })

    expect(decision?.sessionID).toBe("a")
    expect(decision?.reason).toBe("file match")
  })

  test("routes status follow-ups to the session with matching conversation context", () => {
    const decision = routePromptToSession({
      prompt: "How did the security audit go?",
      sessions: [
        session({ id: "a", title: "New session", updated: now - 45 * 60_000 }),
        session({ id: "b", title: "New session", updated: now - 2 * 60_000 }),
      ],
      statuses: {},
      permissions: {},
      questions: {},
      profiles: {
        a: { text: "We completed a security audit and found two medium-risk auth findings." },
        b: { text: "We discussed mobile layout polish and command menu styling." },
      },
      directory: "/repo",
      now,
    })

    expect(decision?.sessionID).toBe("a")
    expect(decision?.reason).toBe("conversation match")
  })

  test("routes using stored session memory even without hydrated transcript", () => {
    const decision = routePromptToSession({
      prompt: "How did the security audit go?",
      sessions: [
        session({ id: "a", title: "New session", updated: now - 40 * 60_000 }),
        session({ id: "b", title: "New session", updated: now - 2 * 60_000 }),
      ],
      statuses: {},
      permissions: {},
      questions: {},
      profiles: {
        a: {
          summary: "Security audit latest outcome medium-risk auth findings",
          topics: ["security audit", "auth findings"],
          intents: ["security-audit"],
          statusHint: "done",
        },
        b: {
          summary: "Recent UI polish work for the command menu",
          topics: ["command menu", "ui polish"],
          intents: ["planning"],
          statusHint: "done",
        },
      },
      directory: "/repo",
      now,
    })

    expect(decision?.sessionID).toBe("a")
    expect(decision?.reason).toBe("memory match")
  })

  test("builds a route profile from routing memory and transcript", () => {
    const target = session({ id: "a", title: "Security audit" })
    const memory = buildSessionRoutingMemory({
      session: target,
      messages: [{ id: "m1", role: "user" }, { id: "m2", role: "assistant" }],
      parts: {
        m1: [{ type: "text", text: "Please run a security audit on the auth flow." }],
        m2: [{ type: "text", text: "The security audit found two medium-risk auth issues." }],
      },
      pendingInput: 0,
      now,
    })
    const profile = buildSessionRouteProfile({
      session: target,
      memory,
      messages: [{ id: "m1", role: "user" }, { id: "m2", role: "assistant" }],
      parts: {
        m1: [{ type: "text", text: "Please run a security audit on the auth flow." }],
        m2: [{ type: "text", text: "The security audit found two medium-risk auth issues." }],
      },
    })

    expect(profile.summary).toContain("Security audit")
    expect(profile.topics).toContain("security audit")
    expect(profile.intents).toContain("security-audit")
    expect(profile.lastAssistantReply).toContain("medium-risk auth issues")
  })
})
