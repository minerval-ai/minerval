# Graph Epochs

How to retire claims minted under superseded prompts — without deleting
anything — and how to keep this from being a crisis each time.

## The problem this solves

Claims are **derived artifacts** of a particular pipeline era: the constitution,
prompts, and mechanisms in force when they were minted. When those change
materially (a new claim bar, a new importance standard, a new decomposition stop
rule — e.g. the #97/#98/#68 fixes), the existing cohort was held to rules we no
longer endorse. Re-stewarding in place can revise an importance score, but it
cannot un-mint a node that should never have cleared the claim bar. The honest
operation is to retire the cohort and re-derive from sources.

The ground truth in this system is the **source/instance layer** (documents and
who-said-what) plus the original corpus texts. Regenerating the claim layer
after fixing the generator is the same operation as re-running a build after a
compiler fix — nothing of record is lost, provided we snapshot first.

## The pieces

- **`claims.pipeline_epoch`** — every claim-creation path stamps the epoch from
  config (`PIPELINE_EPOCH` env; default in `src/config.ts`). `NULL` means the
  legacy pre-stamping cohort. Bump the default in the same PR as any material
  prompt/constitution change, so "claims from before fix X" is always a `WHERE`
  clause.
- **`state='archived'`** — a retired cohort leaves search, matching, browse,
  trees, dependents, and the candidate set (every read path filters
  `state = 'active'`, as an allowlist), but keeps its rows, provenance,
  assessments, and embeddings, and stays readable by direct id. Critically,
  archived claims leave the **matcher candidate pool**, so new ingestion cannot
  link into retired structure and resurrect it.
- **`scripts/archive-legacy-claims.ts`** — archives a cohort (`pipeline_epoch
  IS NULL` by default, or `--epoch=<tag>`). Dry-run by default; `--confirm` to
  write; `--restore --confirm` to undo.

## The norm: corpus-harness first

A material prompt change is validated in the corpus harness **before** it
reaches prod:

1. Land the prompt/mechanism change with a bumped `pipelineEpoch` default.
2. Run the relevant corpus cluster against the isolated corpus DB
   (`npm run corpus:reset && npm run corpus:run -- <cluster>`), ideally the
   cluster that exhibited the failure the change fixes.
3. Judge the output (`npm run corpus:score`, `corpus/RUBRIC.md`) and compare
   with the previous era's run.
4. Only then let prod ingest under the new epoch.

Prod ingests only through a vetted epoch; old epochs accumulate as snapshots
plus judge scorecards — a regression history, not dead weight.

## Retiring an epoch: the runbook

### 1. Snapshot (the conscience)

Take a cold-storage snapshot before archiving. For prod (RDS):

```sh
aws rds create-db-snapshot \
  --db-instance-identifier <EpistemeDb instance id> \
  --db-snapshot-identifier episteme-epoch-<epoch-tag>-$(date +%Y%m%d)
```

An RDS snapshot preserves the entire era (claims, edges, assessments, events)
and can be restored to a scratch instance later for eval comparisons. For a
portable/local archive, `pg_dump` works too.

### 2. Archive the cohort (the undo button)

Dry-run first — it prints cohort size, how many claims carry instances and
assessments, and the highest-importance samples:

```sh
npx tsx scripts/archive-legacy-claims.ts                # legacy (NULL epoch)
npx tsx scripts/archive-legacy-claims.ts --epoch=<tag>  # a named epoch
```

Review the samples, then re-run with `--confirm`. In prod, run it the same way
one-off scripts are run against the prod DB: an ECS run-task using the API task
definition with the command overridden to `npx tsx scripts/archive-legacy-claims.ts …`
(the image ships `scripts/`; `npx` fetches `tsx` on demand). Reversal at any
time: `--restore --confirm`.

Archived claims remain visible by direct link (the UI shows an `archived` tag)
and listable on request via `GET /claims?state=archived`.

### 3. Re-ingest what's worth keeping

Sources, not claims, are what re-enter the pipeline. Submit the documents you
still want represented (via `POST /sources` or the extension) and let the new
epoch's agents derive the claim layer under the current rules. Content that was
only ever test material (e.g. the physics seed case studies) can live as corpus
fixtures instead of prod claims.

## Deciding whether a change is a new epoch

Bump the epoch when the change alters **what gets minted or how it is valued**:
the claim bar, the decomposition stop rule, the importance standard, canonical
form policy. Don't bump for changes that only affect operations (retry logic,
logging, cost caps) — those don't invalidate existing claims.

Not every epoch requires archiving the previous one. Archive when the old
cohort actively misleads (wrong claims, wrong importance ordering); leave it
live when the change is compatible-but-better and re-stewarding in place is
enough (`UPDATE claims SET steward_state='pending' WHERE pipeline_epoch = …`
re-drives a cohort through its Stewards without retiring it).
