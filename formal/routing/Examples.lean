import Routing

namespace Maji.Routing.Examples

private def oauth : Candidate := ⟨1, .none, true⟩
private def kyoto : Candidate := ⟨2, .topical, true⟩
private def kyotoAlternative : Candidate := ⟨3, .topical, true⟩
private def draft : Draft := ⟨1, "Where should we stay in Kyoto?", 1, "/repo", some 1⟩

-- A high score without relevance cannot send a travel question to an OAuth chat.
example : automatic none [oauth] false = .newChat := by decide

-- Filtering happens before selection, even if an unrelated chat ranks first.
example : automatic (some 1) [oauth, kyoto] false = .existing 2 := by decide

example : automatic (some 2) [kyoto] false = .current 2 := by decide

example : automatic none [kyoto, kyotoAlternative] true = .uncertain := by decide

-- An ambiguity flag cannot make a single eligible candidate ambiguous.
example : automatic none [oauth, kyoto] true = .existing 2 := by decide

example : decide ⟨some 1, some (.session 1), [kyoto], false⟩ = .current 1 := by decide

example : decide ⟨some 1, some .newChat, [kyoto], false⟩ = .newChat := by decide

-- Enter before a routing preview exists must wait for routing.
example : submit draft 42 none none = none := by decide

-- A result for the prior revision cannot route this submission.
example : submit draft 42 none
    (some ⟨{ draft with revision := 0 }, .existing 2⟩) = none := by decide

-- The manual destination wins even when a fresh preview selects another chat.
example : submit draft 42 (some (.session 1))
    (some ⟨draft, .existing 2⟩) = some ⟨42, draft, .session 1⟩ := by decide

-- Draft revisions prevent accepting an old result after returning to the same text (ABA).
example : freshPreview { draft with revision := 3 }
    (some ⟨draft, .existing 2⟩) = none := by decide

end Maji.Routing.Examples
