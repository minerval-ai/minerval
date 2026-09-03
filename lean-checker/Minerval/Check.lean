/-!
# `minerval_check`: the checker executable of design section 5.3

Two modes, one JSON object on stdout, exit code 0 whenever a result was
decided (the JSON says what), non-zero only for usage errors (2) and for
failures to load the environment at all (3).

```
minerval_check elaborate --statement-module M --namespace N [--search-path DIR]...
minerval_check check --statement-module M --submission-module M' --namespace N
                     --target N.proof --kind proof|disproof [--search-path DIR]...
```

`elaborate` loads the compiled statement module, finds `N.Statement`, and
reports its pretty-printed body (two ways: the reader-facing `pp_type` and a
fully explicit `pp_all` that the server hashes into `expr_hash`), the
Mathlib constants it references, the definitions the statement introduces
and the axioms each of those uses.

`check` loads both compiled modules and evaluates gates 2, 3, and 4 of the
verdict rule (section 5.2): the target exists, is a theorem, has no universe
parameters, and its type is alpha-equivalent (`Expr.eqv`) to the statement
constant (proof) or its negation (disproof); the axiom closure over the
target is within `{propext, Classical.choice, Quot.sound}` and the new
constants contain no `axiomInfo` or `opaqueInfo`; no new constant is
`unsafe` or `partial` or carries `implemented_by`, `extern`, or `csimp`.
Gate 1 (static policy and compilation) and gate 5 (kernel replay with
`leanchecker`) are the server's and are not repeated here. Every gate is
evaluated and reported even when an earlier one failed, so a rejection can
name everything wrong at once; the server decides the verdict from the
ordered record.

This file is compiled at first deployment against the pinned toolchain, not
in the repository's CI, so each place where an API name may have moved
between Lean releases is marked with `API:` in a comment.
-/
import Lean

open Lean Meta

namespace Minerval.Check

/-- The three axioms a prize proof may depend on (section 5.2, gate 3). -/
def allowedAxioms : List Name := [``propext, ``Classical.choice, ``Quot.sound]

/-- One gate of the verdict rule, as it appears in the `checks` record. -/
structure Gate where
  name   : String
  pass   : Bool
  detail : String
  extra  : List (String × Json) := []

def Gate.toJson (g : Gate) : Json :=
  Json.mkObj
    ([("status", Json.str (if g.pass then "pass" else "fail")),
      ("detail", Json.str g.detail)] ++ g.extra)

/-- Names as a sorted JSON array of strings; sorted so the output is stable
across runs and hashable by the server. -/
def namesJson (ns : Array Name) : Json :=
  let sorted := ns.qsort (fun a b => a.toString < b.toString)
  Json.arr (sorted.map fun n => Json.str n.toString)

structure Args where
  mode             : String := ""
  statementModule  : Name := .anonymous
  submissionModule : Name := .anonymous
  ns               : Name := .anonymous
  target           : Name := .anonymous
  kind             : String := "proof"
  searchPaths      : List System.FilePath := []
  loadExts         : Bool := false

def parseArgs : List String → Args → Except String Args
  | [], a => .ok a
  | "--statement-module" :: v :: rest, a =>
      parseArgs rest { a with statementModule := v.toName }
  | "--submission-module" :: v :: rest, a =>
      parseArgs rest { a with submissionModule := v.toName }
  | "--namespace" :: v :: rest, a => parseArgs rest { a with ns := v.toName }
  | "--target" :: v :: rest, a => parseArgs rest { a with target := v.toName }
  | "--kind" :: v :: rest, a => parseArgs rest { a with kind := v }
  | "--search-path" :: v :: rest, a =>
      parseArgs rest { a with searchPaths := a.searchPaths ++ [v] }
  | "--load-exts" :: rest, a => parseArgs rest { a with loadExts := true }
  | mode :: rest, a =>
      if a.mode.isEmpty && !mode.startsWith "--" then
        parseArgs rest { a with mode := mode }
      else
        .error s!"unexpected argument {mode}"

def emit (j : Json) : IO Unit := IO.println j.compress

def failWith (code : UInt32) (msg : String) : IO UInt32 := do
  emit (Json.mkObj [("ok", toJson false), ("error", Json.str msg)])
  return code

/-- Load the compiled modules. The work directory holding the statement and
submission oleans is passed with `--search-path`; `LEAN_PATH` (set by `lake
env` to Mathlib's build directories) is appended by `addSearchPathFromEnv`,
and `initSearchPath` adds the toolchain's own library directory.

Environment extensions declared by `initialize` in imported modules are NOT
run (`loadExts := false`): the checker only reads constants and the core
attributes below, none of which need Mathlib's extensions initialised, and
not running initialisers means nothing from the submission executes here
even if the static gate were bypassed. `--load-exts` exists in case the
pinned toolchain refuses to import Mathlib without them; the README's
first-deployment checklist covers it. -/
def loadEnv (args : Args) (mods : Array Name) : IO Environment := do
  -- API: `addSearchPathFromEnv` and `initSearchPath` live in Lean.Util.Path.
  let sp ← addSearchPathFromEnv args.searchPaths
  initSearchPath (← findSysroot) sp
  if args.loadExts then
    enableInitializersExecution
  -- API: `importModules` gained `loadExts` in 2024 and further named
  -- parameters with the module system in 2025; named arguments keep this
  -- call valid as long as these four names survive.
  importModules
    (imports := mods.map fun m => { module := m })
    (opts := {})
    (trustLevel := 0)
    (loadExts := args.loadExts)

/-- Run a `MetaM` computation for pretty-printing against a loaded
environment, outside of any elaboration context. -/
def runMeta (env : Environment) (opts : Options) (x : MetaM α) : IO α := do
  let ctx : Core.Context :=
    { fileName := "<minerval_check>", fileMap := default, options := opts }
  -- API: `MetaM.toIO (x) (ctxCore) (sCore) (ctx := {}) (s := {})`.
  let (a, _, _) ← x.toIO ctx { env := env }
  return a

def ppWith (env : Environment) (opts : Options) (e : Expr) : IO String :=
  runMeta env opts do
    let f ← ppExpr e
    -- A very wide line so the hash input does not depend on line breaking.
    return f.pretty (width := 100000)

/-- `pp.all` prints every implicit argument, universe, and full name, which
is what the server hashes into `expr_hash`: two statements that print the
same way under `pp.all` have the same elaborated body up to binder names. -/
def ppAllOptions : Options :=
  -- API: `Lean.Option.set (opts) (opt) (val)`; `pp.all` and `pp.fullNames`
  -- are the registered `Lean.Option Bool` values.
  pp.fullNames.set (pp.all.set ({} : Options) true) true

/-- Axiom closure over a constant (section 5.2, gate 3).
API: `Lean.CollectAxioms.collect : Name → ReaderT Environment (StateM State) Unit`
with `State.axioms : Array Name`; `Lean.collectAxioms` is a monadic wrapper
over the same walk. -/
def axiomClosure (env : Environment) (c : Name) : Array Name :=
  let ((), s) := Id.run (((CollectAxioms.collect c).run env).run {})
  s.axioms

/-- The module a constant came from, by name.
API: `Environment.getModuleFor?` (name of the module) wraps
`getModuleIdxFor?` and `header.moduleNames`. -/
def moduleOf (env : Environment) (c : Name) : Option Name :=
  env.getModuleFor? c

/-- Every constant that a module contributed, in declaration order as far
as the constant map preserves it (it does not; the array is sorted by name
in the output). API: `SMap.fold` walks both stages of the constant map. -/
def constantsOfModule (env : Environment) (m : Name) : Array (Name × ConstantInfo) :=
  env.constants.fold (init := #[]) fun acc n ci =>
    if moduleOf env n == some m then acc.push (n, ci) else acc

/-- Names Lean generates for its own use (`_private`, `_proof_1`, ...) are
not the user's declarations, but they ARE still subject to the declaration
policy: the policy walks every constant, and only the reader-facing lists
filter them out. -/
def isUserFacing (n : Name) : Bool :=
  !n.isInternal && !n.isInternalDetail

/-- Gate 4 (section 5.2): the reasons a single new constant is unacceptable. -/
def declarationOffences (env : Environment) (n : Name) (ci : ConstantInfo) : List String :=
  let unsafeOff := if ci.isUnsafe then ["unsafe"] else []
  -- `partial def f` becomes an opaque `f` with `implemented_by f._unsafe_rec`;
  -- `isPartial` covers the `DefinitionSafety.partial` form and the opaque
  -- form is caught by gate 3's `opaqueInfo` rejection and by implemented_by.
  let partialOff := if ci.isPartial then ["partial"] else []
  -- API: `Compiler.implementedByAttr : ParametricAttribute Name`.
  let implBy := match Compiler.implementedByAttr.getParam? env n with
    | some target => [s!"implemented_by {target}"]
    | none => []
  -- API: `Lean.isExtern : Environment → Name → Bool` (Lean.Compiler.ExternAttr).
  let ext := if isExtern env n then ["extern"] else []
  -- API: `Compiler.CSimp.ext` is a `SimpleScopedEnvExtension` whose state
  -- has `thmNames : SSet Name`, the set of `@[csimp]` theorems.
  let csimp := if (Compiler.CSimp.ext.getState env).thmNames.contains n then ["csimp"] else []
  -- `initialize`/`builtin_initialize` and `@[export]` are not in section
  -- 5.2's list but are the same class of hazard (code that runs or is
  -- reachable outside the kernel) and cost one lookup each.
  -- API: `getInitFnNameFor?` (Lean.Compiler.InitAttr), `getExportNameFor?`
  -- (Lean.Compiler.ExportAttr).
  let initOff := if (getInitFnNameFor? env n).isSome then ["initialize"] else []
  let exportOff := if (getExportNameFor? env n).isSome then ["export"] else []
  unsafeOff ++ partialOff ++ implBy ++ ext ++ csimp ++ initOff ++ exportOff

def kindJson (ci : ConstantInfo) : String :=
  match ci with
  | .axiomInfo _  => "axiom"
  | .defnInfo _   => "def"
  | .thmInfo _    => "theorem"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _   => "quot"
  | .inductInfo _ => "inductive"
  | .ctorInfo _   => "constructor"
  | .recInfo _    => "recursor"

/-! ## `elaborate` -/

def runElaborate (args : Args) : IO UInt32 := do
  if args.statementModule.isAnonymous || args.ns.isAnonymous then
    return (← failWith 2 "elaborate needs --statement-module and --namespace")
  let env ← loadEnv args #[args.statementModule]
  let stmtName := args.ns ++ `Statement
  let some ci := env.find? stmtName
    | return (← failWith 0 s!"statement constant {stmtName} not found in {args.statementModule}")
  let .defnInfo d := ci
    | return (← failWith 0 s!"{stmtName} is a {kindJson ci}, not a def")
  unless d.type.isProp do
    return (← failWith 0 s!"{stmtName} must have type Prop")
  unless d.levelParams.isEmpty do
    return (← failWith 0 s!"{stmtName} must not have universe parameters")
  unless moduleOf env stmtName == some args.statementModule do
    return (← failWith 0 s!"{stmtName} does not come from the statement module")
  let body := d.value
  let ppType ← ppWith env {} body
  let ppAll ← ppWith env ppAllOptions body
  -- API: `Expr.getUsedConstants` (Lean.Util.FoldConsts).
  let used := body.getUsedConstants
  let fromOutside := used.filter fun c => moduleOf env c != some args.statementModule
  let introduced := (constantsOfModule env args.statementModule).filter fun (n, _) =>
    n != stmtName && isUserFacing n
  let defsAxioms : List (String × Json) := introduced.toList.map fun (n, _) =>
    (n.toString, namesJson (axiomClosure env n))
  emit <| Json.mkObj [
    ("ok", toJson true),
    ("mode", Json.str "elaborate"),
    ("statement", Json.str stmtName.toString),
    ("pp_type", Json.str ppType),
    ("pp_all", Json.str ppAll),
    ("constants", namesJson fromOutside),
    ("definitions", namesJson (introduced.map (·.1))),
    ("definitions_axioms", Json.mkObj defsAxioms),
    ("statement_axioms", namesJson (axiomClosure env stmtName))
  ]
  return 0

/-- Gate 2 (section 5.2): the target exists, comes from the submission, is a
theorem, has no universe parameters, and its type is alpha-equivalent to the
expected expression. Theorem types stored in the environment carry no
metavariables, so `instantiateMVars` would be a no-op; `Expr.eqv` is
alpha-equivalence with no reduction, which is what makes the comparison
against the constant (not an unfolded body) unarguable. -/
def evalTargetGate (env : Environment) (args : Args) (expected : Expr) : IO Gate := do
  let ppExpected ← ppWith env {} expected
  let fail (detail : String) (extra : List (String × Json)) : Gate :=
    { name := "target", pass := false, detail := detail, extra := extra }
  match env.find? args.target with
  | none => return fail s!"the target constant {args.target} was not declared" []
  | some ci =>
    if moduleOf env args.target != some args.submissionModule then
      return fail s!"{args.target} does not come from the submission" []
    match ci with
    | .thmInfo t =>
      if !t.levelParams.isEmpty then
        return fail s!"{args.target} has universe parameters {t.levelParams}; the target must be universe-monomorphic" []
      let actual := t.type
      if actual.eqv expected then
        return { name := "target", pass := true, detail := s!"{args.target} : {ppExpected}" }
      let ppActual ← ppWith env {} actual
      return fail s!"the type of {args.target} is `{ppActual}`, not `{ppExpected}`"
        [("expected", Json.str ppExpected), ("actual", Json.str ppActual)]
    | other =>
      return fail s!"{args.target} is a {kindJson other}, not a theorem" []

/-! ## `check` -/

def runCheck (args : Args) : IO UInt32 := do
  if args.statementModule.isAnonymous || args.submissionModule.isAnonymous
      || args.ns.isAnonymous || args.target.isAnonymous then
    return (← failWith 2 "check needs --statement-module, --submission-module, --namespace, --target")
  unless args.kind == "proof" || args.kind == "disproof" do
    return (← failWith 2 s!"--kind must be proof or disproof, got {args.kind}")
  let env ← loadEnv args #[args.statementModule, args.submissionModule]
  let stmtName := args.ns ++ `Statement
  -- The statement constant is the server's; if it is missing or not from
  -- the statement module the check cannot be decided and the server records
  -- an `error`, not a rejection.
  let some stmtCi := env.find? stmtName
    | return (← failWith 3 s!"statement constant {stmtName} not found")
  unless stmtCi matches .defnInfo _ do
    return (← failWith 3 s!"{stmtName} is not a def")
  unless moduleOf env stmtName == some args.statementModule do
    return (← failWith 3 s!"{stmtName} does not come from the statement module")

  -- Gate 2: the target.
  let expected : Expr :=
    if args.kind == "proof" then mkConst stmtName [] else mkNot (mkConst stmtName [])
  let targetGate ← evalTargetGate env args expected

  -- Gate 3: axioms, over the target's closure and over what the submission
  -- declared. Because `CollectAxioms` does not walk axiom types (Lean issue
  -- #8840), a submission's own `axiom`/`opaque` is rejected on sight.
  let newConsts := constantsOfModule env args.submissionModule
  let axioms := if env.contains args.target then axiomClosure env args.target else #[]
  let disallowed := axioms.filter fun a => !allowedAxioms.contains a
  let newAxiomLike := newConsts.filter fun (_, ci) =>
    (ci matches .axiomInfo _) || (ci matches .opaqueInfo _)
  let axiomsGate : Gate :=
    if !disallowed.isEmpty then
      { name := "axioms", pass := false,
        detail := s!"the proof depends on {disallowed.toList}, which the rules do not allow",
        extra := [("axioms", namesJson axioms), ("disallowed", namesJson disallowed)] }
    else if !newAxiomLike.isEmpty then
      { name := "axioms", pass := false,
        detail := s!"the submission declares {(newAxiomLike.map (·.1)).toList} as an axiom or opaque constant",
        extra := [("axioms", namesJson axioms),
                  ("declared", namesJson (newAxiomLike.map (·.1)))] }
    else
      { name := "axioms", pass := true,
        detail := s!"axioms used: {axioms.toList}",
        extra := [("axioms", namesJson axioms)] }

  -- Gate 4: the declaration policy over every new constant, internal names
  -- included.
  let offenders := newConsts.filterMap fun (n, ci) =>
    match declarationOffences env n ci with
    | [] => none
    | offs => some (n, offs)
  let offenderText := String.intercalate "; " <| offenders.toList.map fun (n, offs) =>
    n.toString ++ " (" ++ String.intercalate ", " offs ++ ")"
  let declarationsGate : Gate :=
    if offenders.isEmpty then
      { name := "declarations", pass := true,
        detail := s!"{newConsts.size} new constants, none unsafe, partial, implemented_by, extern, or csimp" }
    else
      { name := "declarations", pass := false,
        detail := s!"the submission declares {offenderText}",
        extra := [("offenders", Json.arr (offenders.map fun (n, offs) =>
          Json.mkObj [("name", Json.str n.toString),
                      ("reasons", Json.arr (offs.toArray.map Json.str))]))] }

  let userNew := (newConsts.filter fun (n, _) => isUserFacing n).map (·.1)
  emit <| Json.mkObj [
    ("ok", toJson true),
    ("mode", Json.str "check"),
    ("kind", Json.str args.kind),
    ("target", Json.str args.target.toString),
    ("statement", Json.str stmtName.toString),
    ("gates", Json.mkObj [
      ("target", targetGate.toJson),
      ("axioms", axiomsGate.toJson),
      ("declarations", declarationsGate.toJson)]),
    ("all_pass", toJson (targetGate.pass && axiomsGate.pass && declarationsGate.pass)),
    ("new_constants", namesJson userNew),
    ("new_constants_total", toJson newConsts.size)
  ]
  return 0

def usage : String :=
  "usage: minerval_check (elaborate|check) --statement-module M [--submission-module M'] " ++
  "--namespace N [--target T] [--kind proof|disproof] [--search-path DIR]... [--load-exts]"

end Minerval.Check

open Minerval.Check in
def main (argv : List String) : IO UInt32 := do
  match parseArgs argv {} with
  | .error e => failWith 2 s!"{e}\n{usage}"
  | .ok args =>
    try
      match args.mode with
      | "elaborate" => runElaborate args
      | "check" => runCheck args
      | "" => failWith 2 usage
      | other => failWith 2 s!"unknown mode {other}\n{usage}"
    catch e =>
      -- Anything thrown while loading or walking the environment is an
      -- infrastructure failure: the server maps exit code 3 to `error`.
      failWith 3 s!"{e}"
