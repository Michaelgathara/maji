import Routing
import Lean

open Lean Maji.Routing

private def candidate (value : Json) : Except String Candidate := do
  let evidence ← value.getObjValAs? String "evidence"
  let kind ← match evidence with
    | "none" => pure Evidence.none
    | "topical" => pure Evidence.topical
    | "continuation" => pure Evidence.continuation
    | "pendingReply" => pure Evidence.pendingReply
    | _ => throw "Unknown relevance evidence"
  return ⟨← value.getObjValAs? Nat "sessionID", kind, ← value.getObjValAs? Bool "aboveThreshold"⟩

private def destination (value : Json) : Except String Destination := do
  match ← value.getObjValAs? String "type" with
  | "new" => return .newChat
  | "session" => return .session (← value.getObjValAs? Nat "sessionID")
  | _ => throw "Unknown manual destination"

private def input (value : Json) : Except String Input := do
  let current ← value.getObjValAs? (Option Nat) "current"
  let manual ← value.getObjValAs? (Option Json) "manual"
  let ranked ← value.getObjValAs? (Array Json) "ranked"
  return ⟨current, ← manual.mapM destination, (← ranked.mapM candidate).toList,
    ← value.getObjValAs? Bool "ambiguous"⟩

private def output : Decision → Json
  | .existing id => Json.mkObj [("type", toJson "existing"), ("sessionID", toJson (toString id))]
  | .current id => Json.mkObj [("type", toJson "current"), ("sessionID", toJson (toString id))]
  | .newChat => Json.mkObj [("type", toJson "new")]
  | .uncertain => Json.mkObj [("type", toJson "uncertain")]

def main : IO Unit := do
  let line ← (← IO.getStdin).getLine
  let result := do
    let values ← (← Json.parse line).getArr?
    values.mapM fun value => return output (decide (← input value))
  match result with
  | .error error => throw (IO.userError error)
  | .ok decisions => (← IO.getStdout).putStrLn (Json.arr decisions).compress
