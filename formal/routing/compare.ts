import { RoutingPolicy } from "../../packages/core/src/session/routing-policy"
import { isDeepStrictEqual } from "node:util"

const variants = (["none", "topical", "continuation", "pendingReply"] as const).flatMap((evidence) =>
  [false, true].map((aboveThreshold) => ({ evidence, aboveThreshold })),
)
const shortlists = [
  [],
  ...variants.map((variant) => [{ sessionID: 1, ...variant }]),
  ...variants.flatMap((first) =>
    variants.map((second) => [
      { sessionID: 1, ...first },
      { sessionID: 2, ...second },
    ]),
  ),
]
const inputs = shortlists.flatMap((ranked) =>
  [null, 0, 1, 2].flatMap((current) =>
    [
      null,
      { type: "new" as const },
      ...[0, 1, 2].map((sessionID) => ({ type: "session" as const, sessionID })),
    ].flatMap((manual) => [false, true].map((ambiguous) => ({ current, manual, ranked, ambiguous }))),
  ),
)
const oracle = Bun.spawn(["lake", "env", "lean", "--run", "Oracle.lean"], {
  cwd: import.meta.dir,
  stdin: new Blob([JSON.stringify(inputs) + "\n"]),
  stdout: "pipe",
  stderr: "inherit",
})
const actual: unknown = await new Response(oracle.stdout).json()
if (await oracle.exited) throw new Error("Lean oracle failed")
const expected = inputs.map((input) =>
  RoutingPolicy.decide({
    current: input.current === null ? undefined : String(input.current),
    manual:
      input.manual?.type === "session"
        ? { type: "session", sessionID: String(input.manual.sessionID) }
        : (input.manual ?? undefined),
    ranked: input.ranked.map((candidate) => ({ ...candidate, sessionID: String(candidate.sessionID) })),
    ambiguous: input.ambiguous,
  }),
)
if (!isDeepStrictEqual(actual, expected)) {
  if (!Array.isArray(actual)) throw new Error("Lean oracle did not return a decision array")
  const index = expected.findIndex((decision, index) => !isDeepStrictEqual(actual[index], decision))
  throw new Error(
    `Routing conformance failed: ${JSON.stringify({ input: inputs[index], lean: actual[index], typescript: expected[index] })}`,
  )
}
console.log(`TypeScript agrees with Lean on all ${inputs.length} routing cases.`)
