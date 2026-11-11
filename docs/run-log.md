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
