import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"

export type SessionRouteDecision = {
  sessionID: string
  title: string
  score: number
  reason: string
}

export type SessionRouteProfile = {
  text?: string
  summary?: string
  topics?: string[]
  intents?: string[]
  files?: string[]
  statusHint?: "needs-input" | "active" | "done" | "idle"
  lastUserPrompt?: string
  lastAssistantReply?: string
}

export type SessionRoutingMemory = {
  version: 1
  fingerprint: string
  summary?: string
  topics: string[]
  intents: string[]
  files: string[]
  statusHint: SessionRouteProfile["statusHint"]
  lastUserPrompt?: string
  lastAssistantReply?: string
  updatedAt: number
}

type RoutingMessage = {
  id: string
  role?: string
}

type RoutingPart = {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  filename?: string
  source?: unknown
  tool?: string
  state?: Record<string, unknown>
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
  const intents = classifyIntents(prompt)
  const promptPaths = extractPaths(prompt)
  const followup = isFollowup(prompt)
  const statusCheck = isStatusCheck(prompt)
  const affirmative = isAffirmative(prompt)
  const candidates = input.sessions
    .filter((session) => !session.parentID && !session.time.archived)
    .map((session) => {
      const title = normalize(session.title)
      const titleTokens = tokenize(title)
      const profile = input.profiles?.[session.id]
      const summary = normalize(profile?.summary ?? "")
      const summaryTokens = tokenize(summary)
      const topics = normalize((profile?.topics ?? []).join(" "))
      const topicTokens = tokenize(topics)
      const topicPaths = extractPaths((profile?.files ?? []).join(" "))
      const sessionIntents = new Set(profile?.intents ?? [])
      const context = normalize(profile?.text ?? "")
      const contextTokens = tokenize(context)
      const contextPaths = extractPaths(context)
      const pendingPermissions = input.permissions[session.id]?.length ?? 0
      const pendingQuestions = input.questions[session.id]?.length ?? 0
      const pendingInput = pendingPermissions + pendingQuestions
      const titleOverlap = overlap(tokens, titleTokens)
      const summaryOverlap = overlap(tokens, summaryTokens)
      const topicOverlap = overlap(tokens, topicTokens)
      const intentOverlap = overlap(intents, sessionIntents)
      const contextOverlap = overlap(tokens, contextTokens)
      const titlePhraseMatches = phraseOverlap(prompt, title)
      const summaryPhraseMatches = phraseOverlap(prompt, summary)
      const topicPhraseMatches = phraseOverlap(prompt, topics)
      const contextPhraseMatches = phraseOverlap(prompt, context)
      const phraseMatches =
        titlePhraseMatches + summaryPhraseMatches + topicPhraseMatches + contextPhraseMatches
      const pathMatches = pathOverlap(promptPaths, contextPaths) + pathOverlap(promptPaths, topicPaths)
      const explicitTitle = title.length >= 5 && prompt.includes(title)
      const sameDirectory = input.directory && session.directory === input.directory
      const recent = recencyScore(input.now ?? Date.now(), session.time.updated)
      const busy = input.statuses[session.id]?.type !== "idle"
      const memorySignal = summaryOverlap + topicOverlap + intentOverlap + summaryPhraseMatches + topicPhraseMatches
      const statusHint = profile?.statusHint
      const score =
        (explicitTitle ? 8 : 0) +
        titleOverlap * 1.8 +
        (titleOverlap > 0 ? Math.min(2, (titleOverlap / Math.max(1, titleTokens.size)) * 3) : 0) +
        summaryOverlap * 2.2 +
        (summaryOverlap > 0 ? Math.min(3.5, (summaryOverlap / Math.max(1, summaryTokens.size)) * 12) : 0) +
        topicOverlap * 2.3 +
        intentOverlap * 3.4 +
        contextOverlap * 1.1 +
        (contextOverlap > 0 ? Math.min(3, (contextOverlap / Math.max(1, contextTokens.size)) * 10) : 0) +
        phraseMatches * 3 +
        (followup && memorySignal > 0 ? 1.9 : 0) +
        (statusCheck && memorySignal > 0 ? 2.4 : 0) +
        pathMatches * 3 +
        (sameDirectory ? 1.2 : 0) +
        recent +
        (followup ? recent * 0.9 : 0) +
        (busy ? 0.8 : 0) +
        (statusHint === "needs-input" && affirmative ? 4.5 : 0) +
        (statusHint === "active" && (followup || statusCheck) ? 0.9 : 0) +
        (statusHint === "done" && statusCheck && memorySignal > 0 ? 1.2 : 0) +
        (pendingInput > 0 && affirmative ? 4 : 0) +
        (pendingInput > 0 ? 0.8 : 0)

      const reason = explicitTitle
        ? "title match"
        : pathMatches > 0
          ? "file match"
        : pendingInput > 0 && affirmative
          ? "waiting for input"
          : memorySignal > 0
            ? "memory match"
          : contextOverlap > 0 || contextPhraseMatches > 0
            ? "conversation match"
            : titleOverlap > 0 || titlePhraseMatches > 0
              ? "topic match"
            : followup && recent > 0
                  ? "recent follow-up"
                  : "recent session"

      return { session, score, reason }
    })
    .filter((candidate) => candidate.score >= 3.8)
    .toSorted((a, b) => b.score - a.score || b.session.time.updated - a.session.time.updated)

  const best = candidates[0]
  if (!best) return

  const next = candidates[1]
  if (
    next &&
    best.score - next.score < 1.15 &&
    (best.reason !== "title match" || next.reason === "title match") &&
    !(best.reason === "memory match" && next.reason !== "memory match")
  )
    return

  return {
    sessionID: best.session.id,
    title: best.session.title,
    score: best.score,
    reason: best.reason,
  }
}

export function buildSessionRoutingMemory(input: {
  session: Session
  messages?: readonly RoutingMessage[]
  parts?: Record<string, readonly RoutingPart[] | undefined>
  status?: SessionStatus
  pendingInput?: number
  now?: number
}): SessionRoutingMemory {
  const transcript = collectTranscript(input.messages ?? [], input.parts ?? {})
  const lastUserPrompt = transcript.user.at(-1)
  const lastAssistantReply = transcript.assistant.at(-1)
  const weightedSegments = [
    ...(!looksLikeDefaultTitle(input.session.title) ? [{ text: input.session.title, weight: 4.2 }] : []),
    ...transcript.user.map((text, index, source) => ({ text, weight: index === source.length - 1 ? 3.2 : 2.4 })),
    ...transcript.assistant.map((text, index, source) => ({ text, weight: index === source.length - 1 ? 2.2 : 1.6 })),
    ...transcript.tools.map((text) => ({ text, weight: 1.2 })),
    ...transcript.files.map((text) => ({ text, weight: 1.8 })),
  ]
  const phrases = weightedPhrases(weightedSegments)
  const keywords = weightedKeywords(weightedSegments)
  const topics = dedupePreserve([
    ...phrases.slice(0, 5),
    ...keywords.filter((token) => !phrases.some((phrase) => phrase.includes(token))).slice(0, 5),
  ]).slice(0, 8)
  const intents = [...classifyIntents(weightedSegments.map((segment) => segment.text).join("\n"))]
  const files = dedupePreserve(transcript.files.map((item) => item.trim()).filter(Boolean)).slice(0, 8)
  const statusHint =
    input.pendingInput && input.pendingInput > 0
      ? "needs-input"
      : input.status?.type !== "idle"
        ? "active"
        : lastAssistantReply
          ? "done"
          : "idle"
  const summary = summarizeSession({
    title: input.session.title,
    topics,
    lastUserPrompt,
    lastAssistantReply,
    statusHint,
  })

  return {
    version: 1,
    fingerprint: routingFingerprint({
      title: input.session.title,
      updated: input.session.time.updated,
      lastUserPrompt,
      lastAssistantReply,
      topics,
      files,
      statusHint,
    }),
    summary,
    topics,
    intents,
    files,
    statusHint,
    lastUserPrompt,
    lastAssistantReply,
    updatedAt: input.now ?? Date.now(),
  }
}

export function buildSessionRouteProfile(input: {
  session: Session
  memory?: SessionRoutingMemory
  messages?: readonly RoutingMessage[]
  parts?: Record<string, readonly RoutingPart[] | undefined>
}): SessionRouteProfile {
  const transcript = collectTranscript(input.messages ?? [], input.parts ?? {})
  const memory = input.memory
  const text = [
    input.session.title,
    memory?.summary,
    ...(memory?.topics ?? []),
    ...(memory?.intents ?? []),
    ...(memory?.files ?? []),
    ...(memory?.lastUserPrompt ? [memory.lastUserPrompt] : []),
    ...(memory?.lastAssistantReply ? [memory.lastAssistantReply] : []),
    ...transcript.all.slice(-32),
  ]
    .filter(Boolean)
    .join("\n")

  return {
    text,
    summary: memory?.summary,
    topics: memory?.topics ?? [],
    intents: memory?.intents ?? [],
    files: dedupePreserve([...(memory?.files ?? []), ...transcript.files]).slice(0, 12),
    statusHint: memory?.statusHint,
    lastUserPrompt: memory?.lastUserPrompt ?? transcript.user.at(-1),
    lastAssistantReply: memory?.lastAssistantReply ?? transcript.assistant.at(-1),
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

function isStatusCheck(prompt: string) {
  return /\b(status|progress|results|result|outcome|went|going|finish|finished|completed|wrap up|wrapped up)\b/.test(
    prompt,
  ) || /\bhow\s+(did|has|have|is|was|were)\b/.test(prompt)
}

function isAffirmative(prompt: string) {
  return /^(yes|y|yeah|yep|ok|okay|sure|approve|approved|allow|continue|go ahead|do it)\b/.test(prompt)
}

function classifyIntents(input: string) {
  const text = normalize(input)
  const intents = new Set<string>()
  if (/\b(security|audit|vulnerability|threat|auth finding|penetration|xss|csrf|injection)\b/.test(text)) {
    intents.add("security-audit")
  }
  if (/\b(fix|bug|broken|issue|error|regression|failure|failing|crash)\b/.test(text)) {
    intents.add("bugfix")
  }
  if (/\b(test|tests|spec|coverage|assert|integration|unit)\b/.test(text)) {
    intents.add("tests")
  }
  if (/\b(build|compile|typecheck|lint|release|deploy|bundle|packag)\b/.test(text)) {
    intents.add("build")
  }
  if (/\b(refactor|cleanup|restructure|rename|migrate|migration)\b/.test(text)) {
    intents.add("refactor")
  }
  if (/\b(plan|design|architecture|roadmap|approach)\b/.test(text)) {
    intents.add("planning")
  }
  if (/\b(review|investigate|explore|understand|research)\b/.test(text)) {
    intents.add("research")
  }
  if (/\b(doc|docs|readme|documentation|writeup)\b/.test(text)) {
    intents.add("docs")
  }
  return intents
}

function collectTranscript(messages: readonly RoutingMessage[], partsByMessage: Record<string, readonly RoutingPart[] | undefined>) {
  const user: string[] = []
  const assistant: string[] = []
  const tools: string[] = []
  const files: string[] = []
  const all: string[] = []

  for (const message of messages) {
    const parts = partsByMessage[message.id] ?? []
    const visible = parts.flatMap((part) => extractPartText(part))
    if (visible.length === 0) continue
    const text = visible.join("\n").trim()
    if (!text) continue
    all.push(text)
    if (message.role === "user") user.push(text)
    else assistant.push(text)
    for (const part of parts) {
      const detail = extractPartDetail(part)
      if (detail.tool) tools.push(detail.tool)
      if (detail.file) files.push(detail.file)
    }
  }

  return { user, assistant, tools, files, all }
}

function extractPartText(part: RoutingPart) {
  if (part.type === "text" && !part.synthetic && !part.ignored && part.text) return [part.text]
  if (part.type === "reasoning" && part.text) return [part.text]
  if (part.type === "file") {
    const sourcePath =
      part.source && typeof part.source === "object" && "path" in part.source && typeof part.source.path === "string"
        ? part.source.path
        : undefined
    return [part.filename, sourcePath].filter((item): item is string => !!item)
  }
  if (part.type === "tool") {
    const state = part.state ?? {}
    const title = typeof state.title === "string" ? state.title : undefined
    const input =
      "input" in state && state.input !== undefined
        ? safeJson(state.input)
        : undefined
    return [part.tool, title, input].filter((item): item is string => !!item)
  }
  return []
}

function extractPartDetail(part: RoutingPart) {
  if (part.type === "file") {
    const sourcePath =
      part.source && typeof part.source === "object" && "path" in part.source && typeof part.source.path === "string"
        ? part.source.path
        : undefined
    return {
      file: sourcePath ?? part.filename,
    }
  }
  if (part.type === "tool") {
    const state = part.state ?? {}
    const title = typeof state.title === "string" ? state.title : undefined
    return {
      tool: [part.tool, title].filter(Boolean).join(" "),
    }
  }
  return {}
}

function weightedKeywords(segments: { text: string; weight: number }[]) {
  const counts = new Map<string, number>()
  for (const segment of segments) {
    for (const token of tokenize(segment.text)) {
      counts.set(token, (counts.get(token) ?? 0) + segment.weight)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([token]) => token)
}

function weightedPhrases(segments: { text: string; weight: number }[]) {
  const counts = new Map<string, number>()
  for (const segment of segments) {
    const words = [...tokenize(segment.text)]
    for (const size of [3, 2]) {
      for (let index = 0; index <= words.length - size; index++) {
        const phrase = words.slice(index, index + size).join(" ")
        if (phrase.length < 7) continue
        counts.set(phrase, (counts.get(phrase) ?? 0) + segment.weight)
      }
    }
  }
  return [...counts.entries()]
    .filter(([, score]) => score >= 2.2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([phrase]) => phrase)
}

function summarizeSession(input: {
  title: string
  topics: string[]
  lastUserPrompt?: string
  lastAssistantReply?: string
  statusHint?: SessionRouteProfile["statusHint"]
}) {
  const focus = input.topics.slice(0, 3).join(", ")
  const detail = truncateText(input.lastUserPrompt ?? input.lastAssistantReply, 140)
  const prefix = looksLikeDefaultTitle(input.title) ? "Session" : input.title.trim()
  const suffix =
    input.statusHint === "needs-input"
      ? "awaiting input"
      : input.statusHint === "active"
        ? "in progress"
        : input.statusHint === "done"
          ? "latest outcome"
          : undefined
  return [prefix, focus || undefined, suffix, detail].filter(Boolean).join(" - ")
}

function routingFingerprint(input: {
  title: string
  updated: number
  topics: string[]
  files: string[]
  statusHint?: SessionRouteProfile["statusHint"]
  lastUserPrompt?: string
  lastAssistantReply?: string
}) {
  return [
    "v1",
    input.updated,
    normalize(input.title),
    normalize(input.lastUserPrompt ?? ""),
    normalize(input.lastAssistantReply ?? ""),
    input.statusHint ?? "",
    input.topics.join("|"),
    input.files.join("|"),
  ].join("::")
}

function safeJson(input: unknown) {
  try {
    return JSON.stringify(input)
  } catch {
    return undefined
  }
}

function dedupePreserve(items: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const normalized = item.trim()
    if (!normalized) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function truncateText(input: string | undefined, limit: number) {
  if (!input) return undefined
  const clean = input.replace(/\s+/g, " ").trim()
  if (clean.length <= limit) return clean
  return clean.slice(0, Math.max(0, limit - 1)).trimEnd() + "..."
}

function looksLikeDefaultTitle(title: string) {
  return /^(new|child) session\b/i.test(title.trim())
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
  "keep",
  "going",
  "session",
  "chat",
  "work",
  "need",
  "want",
  "like",
  "just",
])
