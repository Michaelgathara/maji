# Maji routing contract

Status: **machine-checked reference specification**. This project defines the intended decision and submission policy. It does not execute in Maji, and it does not prove that the current TypeScript implementation conforms. Existing runtime routing bugs remain until the implementation is connected to this contract.

The project uses Lean 4.36.0 and its bundled standard library, with no external Lean dependencies.

## Contract

Maji has one entry point backed by persistent conversations. Each message needs an explicit decision: continue another conversation, stay in the current conversation, create a new conversation, or leave the choice unresolved.

1. A manual destination wins over every automatic suggestion, including a choice of the current chat or a new chat.
2. Automatic selection considers only candidates with relevance evidence that pass the scorer's threshold. Recency, directory proximity, and background activity alone are insufficient.
3. No eligible candidates means a new chat, including when another chat is currently open. Staying requires relevance evidence too.
4. A single eligible candidate is selected. Multiple eligible candidates marked ambiguous produce an unresolved decision; they never silently select a winner.
5. Automatic selection can return only an eligible candidate from the supplied shortlist.
6. A preview must match the entire draft identity: revision, text, server, directory, and current conversation. Missing, stale, and unresolved previews cannot authorize automatic submission.
7. A manual choice permits submission without waiting for an automatic preview. The caller must bind that choice to the current draft.
8. Once a message is committed for delivery, retries, later previews, and later manual suggestions preserve its message ID, captured draft, and destination. A later message starts a separate routing operation.

`Routing.lean` defines these rules as total functions and proves their properties for arbitrary inputs. `Examples.lean` checks concrete cases, including unrelated recent chats, ambiguous matches, manual overrides, early Enter, and draft revisions. `Audit.lean` rejects any theorem whose transitive dependencies include an axiom beyond Lean's standard `propext`, `Classical.choice`, and `Quot.sound`. This includes rejecting `sorryAx`. Compiler warnings also fail the build.

## Trust boundary

The model treats session and server IDs as natural numbers. An integration must map real IDs without collisions and validate that a manual destination still exists and is available to the user.

Retrieval supplies a ranked shortlist, a relevance category (`topical`, `continuation`, or `pendingReply`), threshold acceptance, and an ambiguity signal. The proofs validate the policy applied to those inputs. They do not establish whether a relevance label or ambiguity estimate is correct, that retrieval covers the complete history, or that the ranking is optimal. In particular, `pendingReply` must refer to the conversation the user is actually answering; an arbitrary session waiting for input is insufficient.

The driver must increment the draft revision on edits and context changes, capture the draft at submission, and associate manual choices with that draft. The model rejects mismatched identities but does not prove that a UI driver constructs them correctly.

Delivery is modeled per message, after its destination has been committed. The preservation theorem covers arbitrary finite sequences of retries and late routing suggestions. It does not prove storage durability, network delivery, eventual completion, or exactly-once external side effects.

Transcript ordering and card generation, semantic relevance, floating-point scoring, UI navigation, provider behavior, and network/storage integration remain outside this proof boundary.

## Relationship to production

| Production area                                                      | Reference contract                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/core/src/session/routing-engine.ts` scoring and selection  | `eligible`, `automatic`, `decide`                    |
| `packages/schema/src/session-routing.ts` optional decision           | Explicit `Decision` variants                         |
| `packages/tui/src/component/prompt/index.tsx` preview and submission | `freshPreview`, `submit`                             |
| `packages/app/src/runtime/server/prompt-outbox.ts` retries           | `Delivery`, `delivery_sequence_preserves_submission` |

The current optional route result conflates a new chat, staying, and uncertainty. The TUI also uses a pending typing preview at send time and can ignore a manual current-chat choice. The reference policy makes the intended distinctions explicit; it is deliberately not presented as a proof of the existing code.

Production conformance needs its own evidence. A practical next step is to extract a pure TypeScript policy using this same input contract and compare it with an executable Lean oracle over shared inputs, then test the real submission drivers. Those comparisons are conformance tests, not a formal equivalence proof. A stronger claim requires executing the verified core or proving an implementation refinement.

## Check the proofs

Install Lean through [Elan](https://lean-lang.org/install/), then run from this directory:

```sh
lake --wfail build
```

`lean-toolchain` pins the compiler. `lake-manifest.json` records the empty dependency set. The `check-routing-proofs` GitHub workflow runs the same build when this project changes, using a pinned, checksum-verified official Lean release.
