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
- **The prompt set's hash** — the epoch is a name someone bumps; the prompt
  set is the exact identity. `src/services/prompt-set.ts` builds one manifest
  from the running code (the constitution's hash, each role prompt's, each
  skill's version and hash) and one hash over it. `GET /setup/prompt-set`
  (`get_prompt_set`) serves the deployed one, and every traced run records the hash it ran under on its
  prompt step (`setup.promptSet`, shown by `get_run`). So "which prompts was
  this made under" has an answer that does not depend on anyone remembering
  to bump the epoch, and two deployments can be compared by one string. It is
  not committed: a copy in the repository was one line that every prompt
  change rewrote, so every open PR conflicted on it whenever another merged.
  The hash of any commit's prompt set can be recomputed from that commit.
- **`state='archived'`** — a retired cohort leaves search, matching, browse,
  trees, dependents, and the candidate set (every read path filters
  `state = 'active'`, as an allowlist), but keeps its rows, provenance,
  assessments, and embeddings, and stays readable by direct id. Critically,
  archived claims leave the **matcher candidate pool**, so new ingestion cannot
  link into retired structure and resurrect it.
- **`scripts/archive-legacy-claims.ts`** — archives a cohort (`pipeline_epoch
  IS NULL` by default, or `--epoch=<tag>`). Dry-run by default; `--confirm` to
  write; `--restore --confirm` to undo.
- **Every archive and restore is on record** (#962). The script writes a
  `claim_state_changes` row for each node it moves, in the same statement:
  `--actor` (who ran it), `--reason` (or the cohort file's `reason`), the
  cohort, and the successors a cohort file names under `successors` (a map
  from a node to the nodes that carry on what it stated). The node's history
  (`state_change` events), the changes stream and the `changes` view
  (`state_changed`), and get_claim's `retired` section read it, and a plan
  item for an archived node is refused with it. A retired node's inbox takes
  no messages; one addressed to it goes to a live successor if it has one.
  Archives run before the record existed get theirs with `--record-only
  --at=<when>`; `scripts/close-retired-inboxes.ts` closes messages that sat
  on retired nodes from before.
- **Domain skills version with epochs.** A skill (`skills/<name>/SKILL.md`)
  carries `metadata.minerval.version`, bumped on any change to its text or
  tools, and `since_epoch`, the pipeline epoch its current version took
  effect under. Skills live in the same repository and land in the same pull
  request as the code, so a material skill change is an epoch change like any
  prompt change. `assessments.skills` and `agent_runs.skills` record which
  skills a verdict or run was made under, so "assessed under Mathematics skill
  v1" is a `WHERE` clause. `claims.domains` (with `domains_source`) is what
  selects a skill; `scripts/backfill-claim-domains.ts` tags a pre-skills
  cohort by embedding centroid (dry-run by default, `--write` to apply), and
  a domain mandate's Grantmaker re-drives tagged claims through their
  Stewards by valuing reassess actions, the compatible-but-better path below.

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

A cohort no epoch tag picks out (one topic's claims, say, minted before a change
that shipped without an epoch bump) goes in a cohort file under
`scripts/cohorts/`: the claim ids, with the rule that chose them and the
snapshot taken, passed as `--ids-file=<path>`. Restoring with the same file
undoes exactly that archive. `2026-10-ai-pre-assessment-as-thinking.json` is
the first: the AI claims minted under the constitution before #523/#526.

Review the samples, then re-run with `--confirm --actor=<you>` (and
`--reason=<why>` unless the cohort file says). In prod, run it the same way
one-off scripts are run against the prod DB: an ECS run-task using the API task
definition with the command overridden to `npx tsx scripts/archive-legacy-claims.ts …`
(the image ships `scripts/`; `npx` fetches `tsx` on demand). Reversal at any
time: `--restore --confirm --actor=<you> --reason=<why>`.

Where some of the cohort's propositions are worth a live page, say so: put the
nodes that will carry them in the cohort file's `successors`, or re-ingest
their sources (step 3) before archiving, so the retired node names where its
proposition went. A node archived with no successor reads as "the graph holds
no live page for this".

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
form policy, or a domain skill that changes what its domain mints (the
Mathematics skill's introduction, `2026-09-domain-skills`, stopped proof steps
from becoming subclaims and re-anchored conjectures). Don't bump for changes
that only affect operations (retry logic, logging, cost caps) — those don't
invalidate existing claims.

Not every epoch requires archiving the previous one. Archive when the old
cohort actively misleads (wrong claims, wrong importance ordering); leave it
live when the change is compatible-but-better and re-stewarding in place is
enough (`UPDATE claims SET steward_state='pending' WHERE pipeline_epoch = …`
re-drives a cohort through its Stewards without retiring it).
