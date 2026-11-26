import Routing
import Lean

-- Audit the transitive axioms of every theorem in the specification's namespace.
-- In particular, `sorryAx` and new project-specific axioms must fail the build.
run_cmd do
  let environment ← Lean.getEnv
  let allowed := #[`propext, `Classical.choice, `Quot.sound]
  let mut count : Nat := 0
  for (name, info) in environment.constants.toList do
    if (`Maji.Routing).isPrefixOf name then
      if let .thmInfo _ := info then
        let axioms ← Lean.collectAxioms name
        for dependency in axioms do
          unless allowed.contains dependency do
            throwError "{name} depends on unapproved axiom {dependency}"
        count := count + 1
  Lean.logInfo m!"Audited {count} routing theorems: only Lean's standard logical axioms are permitted."
