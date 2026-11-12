# The run log

Every agent run leaves a log: one `agent_runs` row, and one `agent_steps`
row for the setup the model was given, each model turn, and each batch of
tool results. This page describes what makes that log checkable, and the
mode in which a run depends on it (#552).

## The chain and the seal

Each step carries two hashes:

```
genesis   = sha256("minerval-run-log/1\n" + run id)
step hash = sha256(prev_hash + "\n" + seq + "\n" + kind + "\n" + canonical content)
```

The first step's `prev_hash` is the genesis; each later step's is the hash
of the step before it. Starting from the run's id keeps a step from being
moved to another run. Canonical content is the step's content as stored,
written as JSON with object keys sorted (by UTF-16 code unit), no
whitespace, and scalars as `JSON.stringify` writes them: what survives a
round trip through a `jsonb` column.

Steps are written one at a time, in order. When the run closes and every
step was written, the run is **sealed**: `agent_runs.log_hash` is the last
step's hash (the genesis, for a run with no steps) and `sealed_at` is when.
A run that lost a step closes unsealed, and the steps after the lost one
still chain from it, so the gap shows instead of being closed over. So:

- **Sealed** means the log is whole: every step the run took is there.
- **Unsealed** means the run is still open, it lost a step, or it ran
  before steps were chained.

The code is in `src/services/run-log.ts` (the arithmetic, no database) and
`src/services/trace-service.ts` (the writer).

## What the first step says about the run

A run's first step is a prompt step (a run that starts more than one tool
loop or single call has one for each), and its content carries a `setup`
object: the commit the code was built from, the hash of the prompt set
(`promptSet`), the model and its settings, the parts the setup was made of
(the constitution, the role prompt, each tool) by hash, the `label` the
run wrote at, the `provider` that served it, and the features that were
switched off for it (`featuresOff`).

A label says who may read a row (`src/labels.ts`). Every judgment and source
a run writes is stamped with the run's label (the `sensitivity_label`
column), and so is its `agent_runs` row. Recording the label in the setup puts it under the chain: the label a
sealed run worked at cannot be changed afterwards without the log no longer
reaching its seal. The public graph has one label, `public`, so every run
there records `"label": "public"`; a run logged before labels existed has
no `label` in its setup and was public.

A run takes its label from the work that started it. The row that work
waited in (a job, a ledger action, an order, a contribution, a paused
session) was stamped with the label of the run or request that created it,
and the worker that picks the row up opens the run at that label. So the
label in a run's setup is the label of whatever asked for the run, through
however many hand-overs, and never something the agent chose.

`provider` is what served the run's model: `anthropic`, `openai`,
`openrouter`, or `endpoint:<name>` for an endpoint the deployment runs
itself, as the model id resolved (docs/architecture.md, "Providers"). A run
is served only by a provider cleared for the label it works at
(docs/architecture.md, "Providers cleared by label"), and the label and the
provider together are what a later reader needs to check that this held for
a given run. The field is always recorded; a setup with no `provider` is
from before the field existed.

`featuresOff` names the features the deployment had switched off when the
run was set up (docs/architecture.md, "Features"): `["mathematics",
"prizes"]` where mathematics is off, since prizes go with it. A run with
any off was told so at the head of its first task message, and the same
prompt step records that message as it was sent. The prompts and the prompt
set's hash do not depend on the list, so two runs with the same `promptSet`
and different `featuresOff` read the same role text and were offered
different tools. The list is always recorded: `[]` means nothing was off,
which is every run on the public graph, and a setup with no `featuresOff`
is from before the field existed and says nothing either way.

## Checking a log

`GET /runs/:run_id/verify` (`verify_run_log` on MCP) recomputes the chain
from the stored steps and answers whether they still chain to the seal, and
where they first do not: a step missing, a step that does not follow from
the one before it, a step whose content is not what its hash was taken
over, or a chain that does not end at the sealed hash.

That is the server checking its own rows. To check without trusting it,
read the steps (`GET /runs/:run_id/steps/:seq` serves each step's content,
`prev_hash` and `hash`) and recompute with the two lines above.

## What the chain does and does not show

It shows that a sealed log is whole and has not been altered since it was
sealed, against the sealed hash: a step changed, dropped, reordered or added
afterwards no longer reaches it.

It does not show that the sealed hash is the original. Whoever can rewrite
every row can rewrite the seal as well. That takes the hash being held
somewhere its author cannot change, which is what a published page's
record is for: it names the log's hash at the time of publication.

It also does not show that the logged run was the only run. A deployment
on its owner's own machines can run an assessment off the log. Only where
the run happens can close that.

## Record mode

By default the log is best-effort: a step that cannot be written is logged
to the console and the run carries on, closing unsealed. `RUN_LOG_MODE=record`
turns the dependence round:

- every traceable run is traced, whatever `TRACE_LEVEL` says;
- nothing in a step is cut to a size cap;
- the run does not return until its log is sealed, and a run whose log
  could not be written whole fails with `RunLogError`;
- the retention sweep deletes nothing.

What a run wrote to the graph before its log failed stays written; a reader
tells it by the run being unsealed. Making readers treat a judgment whose
run is unsealed as unfinished is later work.

Two things record mode does not change yet: the paths that are untraced on
purpose because they handle a reader's own page or conversation (the
browser extension, the MCP's on-demand analysis, #356), and work that
returns without a promise, which has nothing to hold its result behind. A
private graph switches the first off instead of exempting it.

The public graph runs best-effort until record mode has run somewhere in
earnest.
