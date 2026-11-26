import Std

namespace Maji.Routing

abbrev SessionID := Nat

/-- Evidence is supplied by retrieval or conversation context, independently of recency. -/
inductive Evidence where
  | none
  | topical
  | continuation
  | pendingReply
  deriving DecidableEq, Repr

structure Candidate where
  sessionID : SessionID
  evidence : Evidence
  aboveThreshold : Bool
  deriving DecidableEq, Repr

def eligible (candidate : Candidate) : Bool :=
  candidate.aboveThreshold && candidate.evidence != .none

/-- Manual choices name a destination; choosing the current chat supplies its ID. -/
inductive Destination where
  | session (id : SessionID)
  | newChat
  deriving DecidableEq, Repr

inductive Decision where
  | existing (id : SessionID)
  | current (id : SessionID)
  | newChat
  | uncertain
  deriving DecidableEq, Repr

def chooseSession (current : Option SessionID) (id : SessionID) : Decision :=
  if current = some id then .current id else .existing id

def manualDecision (current : Option SessionID) : Destination → Decision
  | .session id => chooseSession current id
  | .newChat => .newChat

/-- Ranking and ambiguity estimation belong to the scorer. Policy filters eligibility itself. -/
def automatic (current : Option SessionID) (ranked : List Candidate) (ambiguous : Bool) : Decision :=
  match ranked.filter eligible with
  | [] => .newChat
  | first :: rest =>
    if ambiguous && !rest.isEmpty then .uncertain
    else chooseSession current first.sessionID

structure Input where
  current : Option SessionID
  manual : Option Destination
  ranked : List Candidate
  ambiguous : Bool
  deriving Repr

def decide (input : Input) : Decision :=
  match input.manual with
  | some destination => manualDecision input.current destination
  | none => automatic input.current input.ranked input.ambiguous

def selectedSession : Decision → Option SessionID
  | .existing id | .current id => some id
  | .newChat | .uncertain => none

theorem chooseSession_selected (current : Option SessionID) (id : SessionID) :
    selectedSession (chooseSession current id) = some id := by
  unfold chooseSession
  split <;> rfl

theorem manual_wins (input : Input) (destination : Destination) :
    decide { input with manual := some destination } = manualDecision input.current destination := by
  rfl

theorem manual_new_starts_fresh (input : Input) :
    decide { input with manual := some .newChat } = .newChat := by
  rfl

theorem manual_current_stays (input : Input) (id : SessionID) :
    decide { input with current := some id, manual := some (.session id) } = .current id := by
  simp [decide, manualDecision, chooseSession]

theorem automatic_selects_eligible (current : Option SessionID) (ranked : List Candidate)
    (ambiguous : Bool) (id : SessionID)
    (selected : selectedSession (automatic current ranked ambiguous) = some id) :
    ∃ candidate ∈ ranked, eligible candidate = true ∧ candidate.sessionID = id := by
  cases entries : ranked.filter eligible with
  | nil => simp [automatic, entries, selectedSession] at selected
  | cons first rest =>
    have member : first ∈ ranked.filter eligible := by rw [entries]; simp
    have valid := List.mem_filter.mp member
    simp only [automatic, entries] at selected
    split at selected
    · simp [selectedSession] at selected
    · rw [chooseSession_selected] at selected
      exact ⟨first, valid.1, valid.2, Option.some.inj selected⟩

/-- Arbitrary recency-based ordering cannot admit a shortlist with no relevance evidence. -/
theorem no_evidence_starts_fresh (current : Option SessionID) (ranked : List Candidate)
    (ambiguous : Bool) (unrelated : ∀ candidate ∈ ranked, candidate.evidence = .none) :
    automatic current ranked ambiguous = .newChat := by
  have empty : ranked.filter eligible = [] := by
    apply List.filter_eq_nil_iff.mpr
    intro candidate member
    simp [eligible, unrelated candidate member]
  simp [automatic, empty]

theorem below_threshold_starts_fresh (current : Option SessionID) (ranked : List Candidate)
    (ambiguous : Bool) (low : ∀ candidate ∈ ranked, candidate.aboveThreshold = false) :
    automatic current ranked ambiguous = .newChat := by
  have empty : ranked.filter eligible = [] := by
    apply List.filter_eq_nil_iff.mpr
    intro candidate member
    simp [eligible, low candidate member]
  simp [automatic, empty]

theorem ambiguous_shortlist_abstains (current : Option SessionID) (ranked : List Candidate)
    (first second : Candidate) (rest : List Candidate)
    (shortlist : ranked.filter eligible = first :: second :: rest) :
    automatic current ranked true = .uncertain := by
  simp [automatic, shortlist]

theorem unique_match_routes (current : Option SessionID) (ranked : List Candidate)
    (candidate : Candidate) (ambiguous : Bool)
    (shortlist : ranked.filter eligible = [candidate]) :
    automatic current ranked ambiguous = chooseSession current candidate.sessionID := by
  simp [automatic, shortlist]

/-- A revision belongs to one composer; the driver changes it on edits or context changes. -/
structure Draft where
  revision : Nat
  text : String
  server : Nat
  directory : String
  current : Option SessionID
  deriving DecidableEq, Repr

structure Preview where
  draft : Draft
  decision : Decision
  deriving DecidableEq, Repr

def freshPreview (draft : Draft) (preview : Option Preview) : Option Decision :=
  match preview with
  | none => none
  | some value => if value.draft = draft then some value.decision else none

theorem stale_preview_rejected (draft : Draft) (preview : Preview) (stale : preview.draft ≠ draft) :
    freshPreview draft (some preview) = none := by
  simp [freshPreview, stale]

theorem matching_preview_accepted (draft : Draft) (decision : Decision) :
    freshPreview draft (some ⟨draft, decision⟩) = some decision := by
  simp [freshPreview]

def resolvedDestination : Decision → Option Destination
  | .existing id | .current id => some (.session id)
  | .newChat => some .newChat
  | .uncertain => none

structure Submission where
  messageID : Nat
  draft : Draft
  destination : Destination
  deriving DecidableEq, Repr

/-- `none` asks the caller to resolve routing; it never silently falls back to a chat. -/
def submit (draft : Draft) (messageID : Nat) (manual : Option Destination)
    (preview : Option Preview) : Option Submission :=
  let destination := match manual with
    | some target => some target
    | none => (freshPreview draft preview).bind resolvedDestination
  destination.map fun target => ⟨messageID, draft, target⟩

theorem submit_honors_manual (draft : Draft) (messageID : Nat) (destination : Destination)
    (preview : Option Preview) :
    submit draft messageID (some destination) preview = some ⟨messageID, draft, destination⟩ := by
  rfl

theorem submit_without_preview_waits (draft : Draft) (messageID : Nat) :
    submit draft messageID none none = none := by
  rfl

theorem submit_with_stale_preview_waits (draft : Draft) (messageID : Nat) (preview : Preview)
    (stale : preview.draft ≠ draft) :
    submit draft messageID none (some preview) = none := by
  simp [submit, freshPreview, stale]

theorem submit_with_uncertainty_waits (draft : Draft) (messageID : Nat) :
    submit draft messageID none (some ⟨draft, .uncertain⟩) = none := by
  simp [submit, freshPreview, resolvedDestination]

/-- The per-message delivery boundary seals the admission, including its identity and target. -/
inductive DeliveryEvent where
  | retry
  | preview (value : Preview)
  | manual (destination : Destination)
  deriving Repr

structure Delivery where
  submission : Submission
  attempts : Nat
  deriving DecidableEq, Repr

def deliver (delivery : Delivery) : DeliveryEvent → Delivery
  | .retry => { delivery with attempts := delivery.attempts + 1 }
  | .preview _ | .manual _ => delivery

theorem delivery_preserves_submission (delivery : Delivery) (event : DeliveryEvent) :
    (deliver delivery event).submission = delivery.submission := by
  cases event <;> rfl

theorem delivery_sequence_preserves_submission (delivery : Delivery) (events : List DeliveryEvent) :
    (events.foldl deliver delivery).submission = delivery.submission := by
  induction events generalizing delivery with
  | nil => rfl
  | cons event events ih =>
    exact (ih (deliver delivery event)).trans (delivery_preserves_submission delivery event)

end Maji.Routing
