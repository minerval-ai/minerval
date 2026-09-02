# Corpus test harness

A small, pinned set of documents for testing and iterating on the claim agent
organization. A run drives the whole pipeline to a stable state — Extract →
Match → Decompose → Assess, plus the **stewardship propagation** those
assessments trigger — so you can see whether the agents fit together and settle
correctly as more overlapping claims are ingested. The focus is disambiguation,
canonicalization, related-claim handling, and propagation behavior.

Community contributions, conflict review, escalation, and arbitration are
driven by contributions submitted against existing claims, which an ingest
never generates — so they are exercised separately, by
[`corpus:contributions`](./contributions/README.md): a scenario of
contributions and appeals submitted against the graph a run produced,
through the real Reviewer and Arbitrator pipelines, with a report of every
decision and its reasoning.

It runs against an **isolated database** (`episteme_corpus` by default), never
the main graph, so you can wipe and re-run freely.

## Layout

```
corpus/
  RUBRIC.md              qualitative review rubric, distilled from the constitution
  SCORING.md             scorecard design (corpus:score / corpus:compare)
  scorecards/            committed scorecard history (see its README)
  predictions/           resolvable predictions + README (S6 calibration track)
  contributions/         contribution scenarios + README (review / escalation / arbitration)
  <cluster>/
    manifest.json        pinned LessWrong post IDs (source of truth, reproducible)
    expectations.json    minimal orienting notes (intentionally not an answer key)
    posts/<id>.md        clean markdown, committed so runs are reproducible offline
    posts/<id>.json      metadata sidecar (title, author, score, url, fetchedAt)
scripts/corpus/          fetch / reset / run / report / score / compare (run via tsx)
runs/                    report.md + trace + graph.json per run (gitignored)
```

Clusters:

- **`lethalities`** — the 2022 "List of Lethalities" AI-risk debate (Yudkowsky's
  anchor + direct responses + two sub-threads, 11 posts, ~85k words). Fetched
  from LessWrong. Chosen for dense claim overlap and head-to-head disagreement.
- **`blackholes`** — the LHC micro black hole safety case, one of the three FLF
  Epistack case studies. A `web` cluster (see below): curated, committed markdown
  from CERN/LSAG, a Giddings–Mangano safety paper, Wikipedia, and a published
  dissent. A near-settled but deeply-argued question — heavy overlap on a few
  load-bearing claims plus a couple of genuine cruxes. The near-settled control
  to `lableak`'s genuinely-open case.
- **`lableak`** — the origin of SARS-CoV-2 (zoonosis vs. lab leak), the hardest
  and most-contested FLF case study. A `web` cluster with both sides
  steelmanned and primary sources behind each synthesis. Stresses
  contested-claim handling and head-to-head disagreement at maximum difficulty
  — the good target for robustness and consistency work.
- **`eggs`** — the health effects of eggs, the third FLF case study. A `web`
  cluster. A deliberately mundane question that is really about ways of
  knowing: observational cohorts vs. randomized trials, confounding, subgroup
  effects. Stresses methodology-driven disagreement where the cruxes are about
  evidence quality rather than a single fact.

The three FLF case studies (`lableak` / `blackholes` / `eggs`) are the intended
production seed set, and all three are built.

### Cluster kinds

`manifest.json` has a `kind`:

- **`lesswrong`** (default) — posts are fetched from the LessWrong GraphQL API by
  id (`corpus:fetch`).
- **`web`** — posts are curated, committed markdown from arbitrary public sources,
  each carrying its own `url`. The committed `.md` is the pinned source of truth;
  `corpus:fetch` is a no-op for these clusters (edit the files directly to update).

## Prerequisites

- Postgres running (`docker compose up -d`).
- `.env` with `ANTHROPIC_API_KEY` (claims), `OPENAI_API_KEY` (embeddings) and
  `OPENROUTER_API_KEY` (the Matcher, which defaults to DeepSeek V4 Flash — set
  `MATCHER_MODEL=claude-haiku-4-5-20251001` to run a cluster Anthropic-only,
  but then the scorecard is not measuring the production Matcher).
- Optionally set budget limits in `.env` (`LLM_DAILY_TOKEN_LIMIT`, etc.) — the
  pipeline's circuit breaker will stop a run cleanly when hit.

## Usage

```bash
# 1. Cache the posts (once; re-run only to refresh pinned content)
npm run corpus:fetch -- lethalities

# 2. Hit run — resets the corpus DB, ingests, writes a report
npm run corpus:run -- lethalities --limit=2      # cheap smoke test (2 posts)
npm run corpus:run -- lethalities                # full cluster

# Other entry points
npm run corpus:reset                             # wipe the corpus DB only
npm run corpus:report -- lethalities             # re-render a report from current DB state

# Scored, diffable scorecard (#99) — the automated counterpart to report.md
npm run corpus:score -- lethalities --no-judge   # structural metrics only (free)
npm run corpus:score -- lethalities --sample=15  # + a bounded LLM-judge sample
npm run corpus:compare -- runs/<A> runs/<B>      # diff two scorecards (no verdict: one sample each)
npm run corpus:compare -- runs/<A1>,runs/<A2>,runs/<A3> runs/<B1>,runs/<B2>,runs/<B3>
                                                 # groups: mean ± sd per side, delta vs the noise band
```

**Run on the production models.** The config defaults are the cheap dev
tiers (Sonnet Steward, Haiku Matcher); production pins other models in the
CDK task definition (`infra/lib/api-stack.ts`). A baseline that should say
something about production has to run on those pins:

```bash
npm run corpus:run -- blackholes --profile=production --score
npm run corpus:golden -- --profile=production
```

`--profile=production` (or `CORPUS_PROFILE=production`) applies every
`*_MODEL` pin from the stack source before config loads, overriding any
`*_MODEL` in your `.env` — a profile means "as production". The first epoch
baseline was cut on the Sonnet default Steward while production ran Fable,
which is what this exists to prevent. It needs a key for every provider the
pins route to (the preflight names any that are missing).

**Every run records its fingerprint at run time.** `corpus:run` registers an
`ingest` row in the eval-run registry (`eval_runs`, which `corpus:reset`
deliberately does not truncate) before its first LLM call: epoch, commit,
profile, the model each agent was configured with, and the spend caps in
force. When the drain finishes it adds the models actually observed in
`llm_usage` per agent (a second model under an agent means a fallback fired)
and writes the same record to `runs/<run>/run.json`. `corpus:score` reads that
row back rather than re-deriving models from config at score time — the
first baseline recorded the Matcher as Haiku that way while ingestion had run
on DeepSeek. A scorecard with no ingest row behind it says so
(`modelsSource: "score-time"`); trust those models only if nothing changed
between the run and the score.

Every `corpus:score` also files its `scorecard.json` into the committed history
at `corpus/scorecards/<cluster>/` (with that fingerprint embedded) — commit the
ones that matter as baselines. See [`scorecards/README.md`](./scorecards/README.md).

```bash
npm run corpus:runs                              # list registered runs + headline metrics
npm run corpus:compare -- db:<idA> db:<idB>      # compare straight from the registry
```

**Snapshots** make re-runs cheap — a template-database copy takes seconds, so
you can drain a cluster once and branch experiments off it (the primitive
behind metamorphic re-runs and adversarial episodes):

```bash
npm run corpus:snapshot -- save baseline         # corpus DB → episteme_corpus_snap_baseline
npm run corpus:snapshot -- restore baseline      # replace corpus DB from the snapshot
npm run corpus:snapshot -- list
npm run corpus:snapshot -- drop baseline
```

Snapshot operations force-terminate other connections on the databases they
touch (Postgres template semantics) — never run one mid-drain. The main
`episteme` database is refused by name.

**Matcher golden pairs** (#99 layer 1) — the per-PR regression net for the one
agent whose task saturates enough for exact-match grading. 30 pinned pairs in
[`golden/matcher-pairs.json`](./golden/matcher-pairs.json) (paraphrase /
negation-with-stance / specification / similar-but-different / hard), each
seeded into the corpus DB and run through the real agentic Matcher:

```bash
npm run corpus:golden                        # all pairs, cents per run
npm run corpus:golden -- --category=negation --model=gpt-5-mini
npm run corpus:golden -- --min-pass=0.9      # exit 1 below the bar (CI gate)
```

Results land in `runs/` and in the eval-run registry (`corpus:runs` lists
them). Per the constitution (§2), a negation is expected to MATCH its
counterpart with stance `denies` — a claim and its denial are one node.

**In CI** (`.github/workflows/golden-matcher.yml`): every PR that touches
something that can move a match decision — the Matcher or its prompt, the
constitution, the LLM client or a provider adapter, retrieval, the fixture or
runner, the production pins — runs the suite on the production Matcher
(`--profile=production`) against a throwaway corpus DB and fails below
`--min-pass=0.95` (29 of 30). It needs the `OPENAI_API_KEY` and
`OPENROUTER_API_KEY` repository secrets; a run without them (a fork PR)
reports that it skipped rather than failing. Cents per run; the report is
uploaded as a workflow artifact.

**Judge review** (#99/#137; #334 §2.8 as amended) — no judge number feeds a
gate until a human has read its verdicts and reasoning. The judge is presumed
good-faith and competent at its assigned task — its judgment is as good as
its prompt — so the reviewer's real contribution is not re-deriving numbers
or grading the judge's homework but catching where the assigned task itself
misses: a standard that doesn't get at the right thing, a dimension that
should exist and doesn't, a better task. Rubric-wording fixes go to
`scripts/corpus/judge.ts` and get re-judged; what-is-measured fixes go to the
plan (#334). No agreement statistic is computed. After a scored run:

```bash
npm run corpus:calibrate -- review           # review sheet from the latest scored run
# … read the verdicts, note only where one misses, fill the Overall block …
```

The sheet shows the full claim context plus the judge's complete verdict per
item (every dimension, flags, and note), and closes with the `## Overall`
block — the feedback that actually matters. Commit the filled sheet as the
record of the review. Generate it before resetting the graph (or restore the
snapshot).

**Contributions** (#334 L1) — the half of the organization an ingest never
reaches. After a corpus run, `npm run corpus:contributions -- blackholes`
submits the scenario in `contributions/blackholes.json` (four personas, ten
contributions across every type, appeals on the rejections that carry one)
through the real review, escalation and arbitration pipelines and writes a
report of every decision with its reasoning, the bad-faith findings, the
appeal outcomes, the reputation deltas and the cost. `--dry-run` resolves
the targets and prints the plan. Rubric section G finally has something to
read.

**Predictions** (#334 S6) — the one class of claim reality grades:
[`predictions/`](./predictions/README.md) holds a pinned set of resolvable
questions with criteria and resolution dates; `npm run predictions -- seed
--corpus` seeds them as claims, `resolve` records outcomes as the world settles
them, and `score` reports Brier, log score, calibration curve and ECE over the
credences the Steward held before resolution. Seeded early because the signal
accrues only as questions resolve.

`corpus:run` flags: `--limit=N`, `--posts=id1,id2`, `--no-reset` (ingest on top
of the existing graph instead of wiping first), `--score[=N]` (emit a scorecard
into the run dir; `--score=0` is structural-only).

`corpus:score` flags: `--sample=N` (claims to LLM-judge; default 15, `0` =
structural-only), `--no-judge`, `--out=DIR`, `--allow-same-model-judge`. The
judge runs on `JUDGE_MODEL` (default Sonnet — deliberately a different
model/context than the agents under test). Scoring **refuses** a judge that
is the Steward model the graph was built with, unless overridden: on the
config defaults that means set `JUDGE_MODEL` to something other than Sonnet,
or use `--profile=production`, where the Steward is Fable. See
[`SCORING.md`](./SCORING.md).

## Reading the results

Open the printed `runs/<cluster>-<timestamp>/report.md` and read it top to bottom
against [`RUBRIC.md`](./RUBRIC.md) — the report's sections cite the rubric
dimensions they serve. `graph.json` in the same folder is the machine-readable
dump for deeper digging.

## Cost & nondeterminism

- A run is a real LLM workload: extraction over the document text, then the
  Steward decomposing AND assessing each claim in a multi-tool agent loop (with
  web search), plus Curator structure sweeps. The **Steward is the dominant
  cost** — one invocation is a whole tool-use loop, and decomposition seeds more
  Steward runs. **Always start cheap** and scale up only once a tiny run looks
  right.
- **Every run prints an LLM usage + cost report** at the end: calls, fresh vs
  cache-read vs cache-write input, output, and the **exact metered cost** — every
  call priced at its own model's raw rate through the same metering chokepoint
  production bills through (`src/llm/pricing.ts` via the usage-context cost
  meter), so the figure tracks whatever models the agents are actually
  configured to run on. Read it; it's the ground truth for what a run costs.
- **The cost knobs (set in `.env` or inline; 0 = unlimited):**
  | knob | bounds | good test value |
  |---|---|---|
  | `EXTRACTION_MAX_CLAIMS` | most-central claims extracted per doc (multiplies everything downstream) | `2`–`8` |
  | `STEWARD_MAX_RUNS` | total Steward invocations for the whole run (the main spend guardrail) | `2`–`10` |
  | `STEWARD_MAX_ITERATIONS` | tool-use iterations *within* one Steward (a runaway backstop; **keep high in production** — a deep claim wants many calls) | `8`–`15` for tests; `200` default |
  | `CURATOR_MAX_RUNS` / `CURATOR_SWEEP_RATE` | Curator structure sweeps (`RATE=0` disables the proactive path) | `0` to disable for a first smoke |
  | `LLM_DAILY_TOKEN_LIMIT` / `LLM_HOURLY_TOKEN_LIMIT` | hard circuit breaker — the run stops cleanly when hit (counts uncached input+output) | a safety ceiling, e.g. `300000` for a smoke |
- The agents are **told their iteration budget** and warned as it runs low, so a
  Steward records its assessment before being cut off rather than leaving a claim
  decomposed-but-unassessed. Lowering `STEWARD_MAX_ITERATIONS` for tests is safe.
- Recommended escalation: **very small** (`--posts=<one id>`,
  `EXTRACTION_MAX_CLAIMS=2`, `STEWARD_MAX_RUNS=2`, curator off) → **small**
  (`--limit=2`/`3`) → **full**. Check the printed cost at each step.
- LLM output is nondeterministic. Treat a single run as one sample: run 2–3×
  and watch whether the metrics and failure modes are **stable**, not whether
  any one number matches. `corpus:compare` takes groups of runs per side for
  exactly this reason, and gives no verdict on a single-sample side.

## Notes for maintainers

- The harness IS the real system: `run.ts` builds the actual Fastify app and
  submits each post through the real `POST /sources` route via `app.inject`
  (in-process HTTP). Only the database differs (`episteme_corpus`).
- Processing runs through the real workers, drained by
  `src/workers/local-runner.ts` — the in-memory queue consumer that production
  lacked. `index.ts` now starts it automatically when no `SQS_*` queues are
  configured, so `npm run dev` also processes work locally. `drainLocalQueues()`
  runs every queue (claim-pipeline, steward, contribution, arbitration, audit)
  to quiescence with a safety cap; the run log prints `CAPPED` if it's hit.
- The agent tools are NOT HTTP wrappers — they read/write the graph in-process
  via the shared `getDb()`/`rawQuery` pool, which resolves `DATABASE_URL`. So
  pointing `DATABASE_URL` at the corpus DB redirects the entire system, tools
  included; no dev-specific tool wiring is needed.
- Every processed message is recorded to `runs/<run>/trace.jsonl` (queue, message,
  ok/error, duration) so inter-agent behavior and propagation are observable.
- The audit agent runs in production via `requestAudit` (#180): scheduled sweeps
  (`startAuditScheduler`, `AUDIT_SWEEP_INTERVAL_HOURS`), arbitration overturns,
  bad-faith flags, and suspension reviews. A corpus run drains the audit queue,
  but the sweep scheduler only starts with the full server (`index.ts`), and
  ingestion doesn't produce the other triggers — so audit work is normally
  absent from a run, which is expected, not a gap.
- All claim identity — top-level and subclaim — is decided by the single
  agentic Matcher (`src/llm/agents/matcher.ts`): top-level claims reach it via
  `url-extraction.ts`, subclaims via the Steward's `match_claim` tool.
  Embedding similarity is retrieval, not decision: each search returns the top
  `MATCHING_TOP_K` candidates (default 20) above a deliberately low 0.4 cosine
  floor, and the Matcher LLM makes the final match-vs-new call after searching
  multiple framings (including the negation). The disambiguation knobs are
  `MATCHING_TOP_K` and `MATCHER_MODEL` (default DeepSeek V4 Flash, the model
  production runs — it routes to OpenRouter); the 0.4 retrieval floor
  is hardcoded in `matcher.ts`, so changing it means editing that file.
