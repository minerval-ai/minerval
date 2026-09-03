import Lake
open Lake DSL

/-!
The checker's Lake package. It exists for three reasons:

1. `require mathlib` at the pinned tag makes `lake exe cache get` fetch the
   prebuilt oleans for exactly that revision, and `lake env` puts them on
   `LEAN_PATH` for every process the server starts.
2. `minerval_check` is the purpose-built executable of design section 5.3:
   it loads the statement olean and the submission olean, finds the target,
   compares types, collects axioms, applies the declaration policy, and
   prints one JSON object. See Minerval/Check.lean.
3. `MinervalWarm` is a one-line module (`import Mathlib`) whose build at
   image time proves every Mathlib olean loads under this toolchain, so a
   broken cache fails the image build rather than the first check.

The pin (tag and revision) is chosen at first deployment: pin.json is the
source of truth, this file names the tag, and lake-manifest.json carries the
resolved revision. Advance all three together (README, "Advancing the pin").
-/

package «minerval-checker» where
  -- Options for every module built in this package. `autoImplicit false`
  -- mirrors the statement convention (section 5.4); it does not apply to
  -- statement or submission files, which are compiled by the server with
  -- their own headers, only to the checker's own code.
  leanOptions := #[⟨`autoImplicit, false⟩]

require mathlib from git
  "https://github.com/leanprover-community/mathlib4" @ "v4.33.0"

@[default_target]
lean_lib Minerval where
  -- Minerval.Check is the checker program; nothing else lives here yet.
  roots := #[`Minerval.Check]

lean_lib MinervalWarm where
  -- `import Mathlib` only. Building it is the pre-warm of section 5.3.
  roots := #[`MinervalWarm]

@[default_target]
lean_exe minerval_check where
  root := `Minerval.Check
  -- The executable links against the compiled Lean frontend (importModules,
  -- the pretty-printer, CollectAxioms), so it needs the full runtime.
  supportInterpreter := true
