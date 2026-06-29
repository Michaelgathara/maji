import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"

export type SessionRouteDecision = {
  sessionID: string
  title: string
  score: number
  reason: string
}

export type SessionRouteProfile = {
  text?: string
}

export function routePromptToSession(input: {
  prompt: string
  sessions: Session[]
  statuses: Record<string, SessionStatus>
  permissions: Record<string, readonly unknown[]>
  questions: Record<string, readonly unknown[]>
  profiles?: Record<string, SessionRouteProfile | undefined>
  directory?: string
  now?: number
}): SessionRouteDecision | undefined {
  const prompt = normalize(input.prompt)
  if (!prompt) return

  const tokens = tokenize(prompt)
  const promptPaths = extractPaths(prompt)
  const followup = isFollowup(prompt)
  const affirmative = isAffirmative(prompt)
  const candidates = input.sessions
    .filter((session) => !session.parentID && !session.time.archived)
    .map((session) => {
      const title = normalize(session.title)
      const titleTokens = tokenize(title)
      const profile = input.profiles?.[session.id]
      const context = normalize(profile?.text ?? "")
      const contextTokens = tokenize(context)
      const contextPaths = extractPaths(context)
      const pendingPermissions = input.permissions[session.id]?.length ?? 0
      const pendingQuestions = input.questions[session.id]?.length ?? 0
      const pendingInput = pendingPermissions + pendingQuestions
      const titleOverlap = overlap(tokens, titleTokens)
      const contextOverlap = overlap(tokens, contextTokens)
      const titlePhraseMatches = phraseOverlap(prompt, title)
      const contextPhraseMatches = phraseOverlap(prompt, context)
      const phraseMatches = titlePhraseMatches + contextPhraseMatches
      const pathMatches = pathOverlap(promptPaths, contextPaths)
      const explicitTitle = title.length >= 5 && prompt.includes(title)
      const sameDirectory = input.directory && session.directory === input.directory
      const recent = recencyScore(input.now ?? Date.now(), session.time.updated)
      const busy = input.statuses[session.id]?.type !== "idle"
      const score =
        (explicitTitle ? 8 : 0) +
        titleOverlap * 1.8 +
        (titleOverlap > 0 ? Math.min(2, (titleOverlap / Math.max(1, titleTokens.size)) * 3) : 0) +
        contextOverlap * 1.25 +
        (contextOverlap > 0 ? Math.min(3, (contextOverlap / Math.max(1, contextTokens.size)) * 10) : 0) +
        phraseMatches * 3 +
        (followup && phraseMatches > 0 ? 1.4 : 0) +
        pathMatches * 3 +
        (sameDirectory ? 1.2 : 0) +
        recent +
        (followup ? recent * 0.9 : 0) +
        (busy ? 0.8 : 0) +
        (pendingInput > 0 && affirmative ? 4 : 0) +
        (pendingInput > 0 ? 0.8 : 0)

      const reason = explicitTitle
        ? "title match"
        : pathMatches > 0
          ? "file match"
          : pendingInput > 0 && affirmative
            ? "waiting for input"
            : contextOverlap > 0 || contextPhraseMatches > 0
              ? "conversation match"
              : titleOverlap > 0 || titlePhraseMatches > 0
                ? "topic match"
                : followup && recent > 0
                  ? "recent follow-up"
                  : "recent session"

      return { session, score, reason }
    })
    .filter((candidate) => candidate.score >= 3.4)
    .toSorted((a, b) => b.score - a.score || b.session.time.updated - a.session.time.updated)

  const best = candidates[0]
  if (!best) return

  const next = candidates[1]
  if (next && best.score - next.score < 1.1 && (best.reason !== "title match" || next.reason === "title match")) return

  return {
    sessionID: best.session.id,
    title: best.session.title,
    score: best.score,
    reason: best.reason,
  }
}

function normalize(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_\-./\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokenize(input: string) {
  return new Set(
    input
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 2)
      .filter((token) => !stopwords.has(token)),
  )
}

function overlap(left: Set<string>, right: Set<string>) {
  return [...left].filter((token) => right.has(token)).length
}

function phraseOverlap(prompt: string, context: string) {
  if (!context) return 0
  return phraseCandidates(prompt).filter((phrase) => context.includes(phrase)).length
}

function phraseCandidates(input: string) {
  const tokens = input
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
    .filter((token) => !stopwords.has(token))

  const phrases = new Set<string>()
  for (const size of [3, 2]) {
    for (let index = 0; index <= tokens.length - size; index++) {
      phrases.add(tokens.slice(index, index + size).join(" "))
    }
  }
  return [...phrases]
}

function extractPaths(input: string) {
  return new Set(
    input
      .split(/\s+/)
      .map((token) => token.replace(/^["'`({\[]+|[)"'`,.;:}\]]+$/g, ""))
      .filter((token) => /[/\\]/.test(token) || /\.[a-z0-9]{1,8}$/i.test(token))
      .flatMap((token) =>
        [token.toLowerCase(), token.split(/[\\/]/).at(-1)?.toLowerCase()].filter((item): item is string => !!item),
      ),
  )
}

function pathOverlap(left: Set<string>, right: Set<string>) {
  return [...left].filter((path) => right.has(path)).length
}

function recencyScore(now: number, updated: number) {
  const age = Math.max(0, now - updated)
  if (age < 10 * 60 * 1000) return 2.8
  if (age < 60 * 60 * 1000) return 2
  if (age < 24 * 60 * 60 * 1000) return 1.1
  if (age < 7 * 24 * 60 * 60 * 1000) return 0.5
  return 0
}

function isFollowup(prompt: string) {
  return /\b(also|again|continue|that|this|it|those|there|same|previous|earlier|next|now|still|status|result|results|outcome|went)\b/.test(
    prompt,
  ) || /\bhow\s+(did|was|were)\b/.test(prompt)
}

function isAffirmative(prompt: string) {
  return /^(yes|y|yeah|yep|ok|okay|sure|approve|approved|allow|continue|go ahead|do it)\b/.test(prompt)
}

const stopwords = new Set([
  "the",
  "and",
  "for",
  "with",
  "you",
  "your",
  "can",
  "could",
  "would",
  "should",
  "please",
  "that",
  "this",
  "from",
  "into",
  "about",
  "what",
  "did",
  "does",
  "done",
  "when",
  "where",
  "why",
  "how",
  "was",
  "were",
  "is",
  "are",
  "go",
  "went",
  "fix",
  "make",
  "add",
  "change",
  "update",
])
