import { Schema } from "effect"
import { buildRoutingCard, routePrompt } from "../src/session/routing-engine"

const Decision = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["existing", "current"]), sessionID: Schema.String }),
  Schema.Struct({ type: Schema.Literals(["new", "uncertain"]) }),
])
const Corpus = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    category: Schema.String,
    prompt: Schema.String,
    current: Schema.optional(Schema.String),
    expected: Decision,
    candidates: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        text: Schema.optional(Schema.String),
        updated: Schema.optional(Schema.Number),
        busy: Schema.optional(Schema.Boolean),
        pendingInput: Schema.optional(Schema.Number),
      }),
    ),
  }),
)

const now = 1_800_000
const corpus = Schema.decodeUnknownSync(Corpus)(
  await Bun.file(new URL("../test/fixtures/routing-corpus.json", import.meta.url)).json(),
)
const cases = corpus.map((example) => {
  const actual = routePrompt({
    prompt: example.prompt,
    currentSessionID: example.current,
    now,
    directory: "/repo",
    candidates: example.candidates.map((candidate) => ({
      ...candidate,
      directory: "/repo",
      updated: candidate.updated ?? now - 60_000,
      pendingInput: candidate.pendingInput ?? 0,
      busy: candidate.busy ?? false,
      card: buildRoutingCard({
        title: candidate.title,
        pendingInput: candidate.pendingInput ?? 0,
        busy: candidate.busy ?? false,
        now,
        messages: candidate.text ? [{ role: "user", parts: [{ type: "text", text: candidate.text }] }] : [],
      }),
    })),
  }).decision
  const correct =
    actual.type === example.expected.type &&
    (!("sessionID" in actual) || ("sessionID" in example.expected && actual.sessionID === example.expected.sessionID))
  return { name: example.name, category: example.category, expected: example.expected, actual, correct }
})
const summarize = (items: typeof cases) => ({
  total: items.length,
  correct: items.filter((item) => item.correct).length,
  falseContinuations: items.filter(
    (item) => !item.correct && (item.actual.type === "existing" || item.actual.type === "current"),
  ).length,
  unnecessaryNew: items.filter(
    (item) => item.actual.type === "new" && (item.expected.type === "existing" || item.expected.type === "current"),
  ).length,
  abstentions: items.filter((item) => item.actual.type === "uncertain").length,
})
console.log(
  JSON.stringify(
    {
      metrics: summarize(cases),
      categories: Object.fromEntries(
        [...new Set(cases.map((item) => item.category))].map((category) => [
          category,
          summarize(cases.filter((item) => item.category === category)),
        ]),
      ),
      failures: cases.filter((item) => !item.correct),
    },
    null,
    2,
  ),
)
