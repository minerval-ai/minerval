# Consistency Checker: implementation plan for #330

Status: Phase 0 built (`src/services/coherence-service.ts`, `GET /coherence`);
Phases 1 and 2 planned. Issue: https://github.com/minerval-ai/minerval/issues/330

## 1. What has changed since the issue was written

Both gates the issue named are closed, and the landscape they left behind
settles the issue's central design question.

- **Tagging (#272) shipped** (PR #397): `tags` + `taggings` (subject_kind
  `claim`), a nano tagger, and `listTags()` with per-tag live claim counts.
  The sweep's partition exists.
- **Allocation (#291) shipped** as the owl economy: every unit of work is an
  `actions` row in an exclusion group (`assess:<claimId>`, variants
  `standard`/`strong`), mandates write `mandate_valuations` on rows, and the
  allocator funds the best value-per-owl. The seeded **General Assessment
  mandate** is the platform's own funder and its allocation policy holds the
  cadence knobs (#283).
- **The Lookout landed** (`src/llm/agents/lookout.ts`,
  `src/services/lookout-service.ts`, docs/allocation.md "Lookouts"). It is
  the shape this issue was reaching for: a cheap, read-only agent whose one
  write is `flag_reassessment`, which (a) enqueues the Steward with a
  trigger and the rationale as context, (b) ensures the claim's assess
  action group, and (c) writes a valuation on the funding mandate's ledger,
  clamped to a delegated ceiling. Whether the pass runs is the allocator's
  call. Flags are recorded (`lookout_flags`) with the assessment at flag
  time, so precision ("did the pass move anything?") is a query.
- **Steward enqueue is lossless** (#182): re-triggers append to the pending
  slot instead of replacing it. The issue's "pending-slot collision"
  objection to steward messages no longer holds.
- **The constitution already mandates this agent.** Part VII (§21, line
  241): "The graph's assessments must cohere along its edges... Periodic
  sweeps hunt for incoherence. Each find is a defect in an assessment or in
  the structure." No constitutional amendment is needed to *authorize* the
  role, only to *name* it in Part VIII.

## 2. Decisions

### 2.1 A new agent, not a wider Curator

The Curator's mandate is claim identity and connective tissue. Assessment
coherence is a different question with a different reading load (traces,
credences, edge semantics) and a different output (a flag, never a write).
Keep the Curator crisp. The Audit Agent is the wrong home too: it judges
decisions by agents, not the graph's content.

Name: **Consistency Checker** (agent key `consistency-checker`, usage
context agent `consistency_checker`, following `contribution_reviewer`).
Its one question, stated in its prompt: *can these assessments all stand at
once, given the edges between them?*

### 2.2 Delivery channel: the Lookout's flag channel, not contributions, not `notify_steward`

The issue weighed two channels. A third now exists and dominates both:

| Property | `notify_steward` | Contribution | **Ledger flag (Lookout-style)** |
|---|---|---|---|
| Enters allocation, no fast lane | no (bypasses ledger) | yes, via review | **yes: a valuation, capped, allocator decides** |
| Provenance / precision record | none | review record | **flags table with assessment-at-flag, precision query** |
| Spend per flag | one Steward run | one Reviewer run + one Steward run | **zero until the allocator funds the pass** |
| Multi-claim shape | context text only | needs a new contribution type | **flag row carries `claim_ids[]`; Steward context names them** |
| Damper against churn | none | review gate | **ceiling + per-sweep cap + open-flag dedupe + allocator** |
| New trust surface | privileged | none | **a valuation on the General mandate, bounded like a Lookout's** |

So: `flag_inconsistency` writes a `consistency_flags` row, enqueues the
Steward of the primary claim with trigger `consistency_flag`, ensures its
assess group, and values the `standard` variant on the General mandate at
`min(urgency, config ceiling)`. No new contribution type, no reviewer spend,
no privileged notification.

### 2.3 Sweeps are scheduled and tag-partitioned; the agent only judges candidates

Two layers, mirroring "mechanism as backstop, judgment for decisions":

1. **Mechanical pre-filter** (`coherence-service.ts`, pure SQL, no LLM):
   over one tag's claims plus their one-hop neighbors, list the neighborhoods
   where current assessments are *mechanically* suspect. Cheap, runs on
   every sweep, and doubles as an observability surface before any agent
   spend.
2. **Agent judgment**: one run per sweep reads the candidates, opens the
   claims and traces, decides whether each tension is real or already
   accounted for in the reasoning, and flags materially, not exhaustively.

The scheduler picks the tag due next (least recently swept, weighted by the
tag's importance mass and by how many of its claims were re-assessed since
its last sweep).

**Partition threshold.** The live vocabulary (September 2026: 342 tags over
866 claims) is a few dozen broad field tags and a long tail of one- and
two-claim tags. A sweep over a two-claim tag cannot find a cross-claim
tension, so only tags carrying at least `CONSISTENCY_MIN_TAG_CLAIMS`
claims (default 10; about 40 tags today) are sweep partitions. Every live
claim not covered by a qualifying tag falls into one **residual bucket**,
which competes for sweeps on the same terms. The pre-filter itself takes a
tag or the whole graph; the residual bucket is the scheduler's construction
(Phase 1), so thinning the vocabulary later changes nothing below it.

### 2.4 Spend shape: config caps now, ledger-funded runs later

Phase 1 runs sweeps from a scheduler with config caps (interval, sweeps per
day, candidates per sweep, flags per sweep), the same shape as the audit
scheduler, and values flags on the General mandate. Phase 2 promotes a
sweep to a `consistency_sweep` action kind self-funded from the General
mandate's escrow (like `lookout_run`), so the sweep's own spend competes on
the ledger. Phase 1 is deliberately the smaller change; the flag side is
already inside allocation from day one, which is what #291 required.

### 2.5 Cascade discipline

A flag targets **one** primary claim (the one whose assessment looks
wrong, or the parent when the defect is compositional). The primary's
Steward reconciles and decides, through its existing
`notify_dependent_stewards` materiality gate, what else moves. The checker
never flags every member of a neighborhood. Caps: flags per sweep, an open
flag on a claim is a repeat (folded, counted) not a new flag, and a
candidate the agent explicitly dismissed is suppressed until an assessment
in that neighborhood changes.

## 3. Components

### 3.1 Schema (`src/db/schema.ts`, one migration)

- `consistency_sweeps`: `id`, `tag_id` (nullable: the residual bucket),
  `started_at`, `finished_at`, `run_id` (agent_runs, no FK), `claims_scanned`,
  `candidates_found`, `flags_raised`, `dismissed`, `note`, `status`
  (`running`|`done`|`error`). Coverage tracking: "tag X last swept at T".
- `consistency_flags`: `id`, `sweep_id`, `kind` (see 3.2), `primary_claim_id`,
  `claim_ids uuid[]`, `action_id` (the valued standard action, set null on
  delete), `rationale`, `urgency`, `value_written`, `status_at_flag`,
  `credence_at_flag`, `assessment_id_at_flag`, `repeats`, `created_at`,
  `updated_at`. Same columns as `lookout_flags` where the meaning is the
  same, so the precision read is the same query.
- `consistency_dismissals`: `id`, `sweep_id`, `kind`, `claim_ids uuid[]`,
  `reason`, `assessment_ids uuid[]` (the assessments judged jointly
  tenable), `created_at`. A candidate is suppressed while every assessment
  it named is still current.

### 3.2 Mechanical pre-filter (`src/services/coherence-service.ts`) — BUILT

`listCoherenceCandidates({ tagId? }, { limit, offset })` returns
`{ kind, primary_claim_id, claim_ids, importance, relation, primary, other,
neighbor_status_then? }[]`, most important primary first. One SQL statement
over current assessments joined through `claim_relationships` and
`claim_links`; thresholds in `COHERENCE_THRESHOLDS`:

| kind | rule |
|---|---|
| `requires_status` | parent `verified`/`supported` while a `requires` child is `contradicted`/`unsupported` |
| `requires_credence` | parent credence exceeds a `requires` child's by more than `requiresMargin` (0.15); yields to `requires_status` on the same pair |
| `contradicts_both_high` | `contradicts` edge with both ends `verified`/`supported`, or both credences at or above `highCredence` (0.7) |
| `rivals_jointly_untenable` | `rival_explanation` link with credences summing past `1 + rivalTolerance` (0.1) (§21); the likelier side is primary |
| `stale_vs_neighbor` | parent assessed before a `requires`/`contradicts` child's current assessment, and the child's status at the parent's `assessed_at` (from assessment history) differs from now. A child first assessed after the parent does not count: that ordering is the pipeline's normal course |

Two exclusions keep it a shortlist: a primary already `pending`/`running`
for its Steward is left out (a flag on it would repeat queued work), and
only live claims (`active`, not merged) with a current assessment take part.
A `supports_inverted` kind was considered and dropped: a `supports` child
carries no logical commitment strong enough to shortlist on.

Not mechanical, left to the agent: dependents that presuppose different
verdicts on a shared upstream claim (needs the traces), and tensions the
traces already acknowledge.

`coherenceStats({ tagId? })` returns the population (assessed claims,
assessed edges) and counts by kind. Both are served by **`GET /coherence`**
(`?tag=<slug>&limit=&offset=`, read-only, `src/routes/coherence.ts`), so the
incoherence rate is observable before any agent spend and after it. Tests:
`tests/db/coherence-candidates.test.ts` (one fixture per kind plus the
negative controls), `tests/unit/routes/coherence.test.ts`.

### 3.3 Agent (`src/llm/agents/consistency-checker.ts`, `src/llm/prompts/consistency-checker.ts`, `src/llm/tools/consistency-tools.ts`)

Same loop shape as the Lookout. Tools:

- Reads: `getGraphReadToolDefinitions()` (`search_claims`, `get_claim`,
  `get_decomposition`, `get_dependents`), plus
  - `list_candidates(offset)`: this sweep's pre-filter shortlist, paginated;
  - `compare_assessments(claim_ids)`: side by side, for up to ~8 claims:
    status, credence, confidence, assessed_at, model, a trace excerpt, and
    every edge or link among them with its relation and reasoning. The
    tool built for the question, so the agent does not reassemble it from
    six `get_claim` calls.
- Writes (candidates, never conclusions):
  - `flag_inconsistency({ kind, primary_claim_id, claim_ids, rationale, urgency })`;
  - `dismiss_candidate({ kind, claim_ids, reason })`;
  - `finish_sweep({ note })` (records the note on the sweep row; also the
    loop's natural terminal).
- The standard report and finding channels (`createReportTools`,
  `createFindingTools`), as every agent carries.

Prompt: constitution + role block. The role block says what coherence
means along each relation type (drawing on `RELATION_GUIDANCE` and §21),
that a tension the trace already weighs is not a defect, that an edge
mischaracterizing a dependency is a structural defect to say so in the
rationale (the Steward escalates to the Curator), and that flagging is
allocation demand, so urgency is relative to everything else the platform
could fund. Domain skills: `skillsForDomains` over the sweep's dominant
claim domains, role key added to `SKILL_ROLES` only if a skill actually
carries a section for it.

Model: `CONSISTENCY_MODEL`, default Sonnet (the Curator's tier). Reading
traces and judging joint tenability is more than the flash tier's job; the
mechanical pre-filter is what keeps the run count small.

Loop bounds: `maxIterations` ~24 with the iteration budget notice, flags
capped per sweep.

### 3.4 Flag write path (`src/services/consistency-service.ts`)

`flagInconsistency()` mirrors `flagReassessment()` step for step:
validate, fold into an open flag on the same primary claim if one exists
(status `open`/`running` on its action), then `enqueueSteward({ trigger:
"consistency_flag", context })`, `ensureAssessActions(primary)`,
`setMandateValuations(generalMandate.grantId, [{ action_id: standard,
value: min(urgency, ceiling), rationale: "[consistency] ..." }])`, insert
the flag row. Refactor opportunity: lift the common "value a standard
assess action on a mandate" helper out of lookout-service so both call it.

The Steward context names the other claims and their assessments, e.g.
"A consistency sweep finds this claim (verified, credence 0.85) cannot
stand with its `requires` premise <id> (contradicted, credence 0.15):
<rationale>. Reconcile: change this verdict, or record why the tension is
apparent, or if the edge mischaracterizes the dependency, escalate to the
Curator."

`consistencyPrecision()`: flagged / ran / moved, same query as
`lookoutPrecision` over `consistency_flags`.

### 3.5 Scheduler (`src/workers/consistency-scheduler.ts`)

`consistencySchedulerTick(now)`, exported for tests, started from
`src/index.ts` beside the audit and allocation schedulers:

1. Return early if `consistencySweepIntervalHours <= 0`.
2. Enforce `consistencyMaxSweepsPerDay` from `consistency_sweeps`.
3. Pick the next partition: tags with live claims ordered by
   `never swept` first, then by (assessments written in the tag since its
   last sweep) desc, then importance mass desc; the untagged bucket
   competes on the same terms.
4. Insert the `consistency_sweeps` row (`running`) and run the agent inline
   under `runWithUsageContext` (Phase 1), or, in Phase 2, open a
   `consistency_sweep` action for the engine executor.
5. Mark the sweep `done`/`error` with counts.

Idempotency: a `running` sweep younger than a reclaim window blocks a
second sweep of the same tag; an older one counts as abandoned.

### 3.6 Steward side

- `StewardMessage.trigger` gains `"consistency_flag"` (queue-service.ts).
- `src/llm/prompts/claim-steward.ts` trigger list gains a paragraph:
  reconcile with the named neighbors; the fix may belong to the other
  claim (say so in your trace and, if material, notify its dependents /
  escalate), or to the edge (escalate_to_curator), or the tension may be
  real and defensible (record why; no change is a fine outcome).

### 3.7 Config (`src/config.ts`)

| key | env | default |
|---|---|---|
| `consistencySweepIntervalHours` | `CONSISTENCY_SWEEP_INTERVAL_HOURS` | 0 (off) until Phase 0 numbers are in |
| `consistencyMaxSweepsPerDay` | `CONSISTENCY_MAX_SWEEPS_PER_DAY` | 6 |
| `consistencyMaxCandidatesPerSweep` | `CONSISTENCY_MAX_CANDIDATES_PER_SWEEP` | 40 |
| `consistencyMinTagClaims` | `CONSISTENCY_MIN_TAG_CLAIMS` | 10 |
| `consistencyMaxFlagsPerSweep` | `CONSISTENCY_MAX_FLAGS_PER_SWEEP` | 5 |
| `consistencyFlagMaxValue` | `CONSISTENCY_FLAG_MAX_VALUE` | 6 (the Lookout's default ceiling) |
| `consistencyModel` | `CONSISTENCY_MODEL` | `MODELS.sonnet` |

Add `CONSISTENCY_MODEL` to the production-required-model list only if the
role is enabled in prod.

### 3.8 Docs and web

- `admin_constitution.md` Part VIII: one role bullet, "Consistency Checker:
  the sweep §21 calls for. It reads assessments along the graph's edges and
  raises, as candidates on the ledger, the places where they cannot all
  stand; it writes no verdict and owns no claim." Cross-reference from §21.
- `docs/allocation.md`: a "Consistency sweeps" section next to "Lookouts"
  describing the flag channel and its ceiling.
- `scripts/sync-frontend-content.ts`: add the agent to `AGENTS` (stage
  after Lookout, group governance) so `web/content/agents/consistency-checker.{role,full}.md`
  and `index.json` regenerate; the drift test enforces this.
- `docs/architecture.md`: one line in the agent roster.

### 3.9 Tests

- `tests/db/coherence-candidates.test.ts` (built): one fixture per kind and
  the negative controls. Phase 1 adds: a dismissed candidate stays
  suppressed until an assessment it named changes.
- `tests/unit/workers/consistency-scheduler.test.ts`: interval off, daily
  cap, partition choice, reclaim of an abandoned sweep (mocked `rawQuery`,
  like audit-scheduler.test.ts).
- `tests/unit/services/consistency-service.test.ts`: flag folds into an
  open one, valuation clamped to ceiling, Steward enqueued once with the
  right trigger, general mandate absent = flag recorded without valuation.
- `tests/unit/llm/consistency-checker.test.ts`: tool wiring with a mocked
  `toolUseLoop` (like lookout.test.ts), flag cap enforced in the executor.
- Existing: the frontend-content drift test and any test enumerating
  Steward triggers.

## 4. Phasing

**Phase 0: measure before spending. Built.** `coherence-service.ts`,
`GET /coherence`, `tests/db` cases. No LLM spend, no schema change,
read-only. Next step is operational: read `GET /coherence` on production
to learn the incoherence rate by kind. If the mechanical pass finds almost
nothing, loosen the thresholds; if it finds a lot, the agent's first sweeps
have a known workload, and the counts set the per-sweep caps.

**Phase 1: the agent.** Schema (sweeps, flags, dismissals), agent + prompt +
tools, flag service, Steward trigger + prompt paragraph, scheduler with
config caps, constitution and docs, tests. Ships with the interval set to 0
and is switched on per environment.

**Phase 2: fold into the ledger and close the loop.** `consistency_sweep`
action kind funded by the General mandate (engine-executor branch, same as
`lookout_run`), precision surfaced on the mandate page and to the Audit
Agent's read-only ledger view, and the eval twin: the same `coherence-service`
checks emitted as a stability-scorecard section in `scripts/corpus`
(#273/#295's compositional-credence property), so a prompt regression that
makes Stewards incoherent shows up in CI, not only in production sweeps.

## 5. Open points for the maintainer

- Whether the checker may also flag a **structural** defect straight to the
  Curator (`enqueueCurator` with `steward_escalation`) when the tension is
  plainly an edge problem, or must always route through the Steward. The
  plan routes through the Steward (one owner, one boundary); a direct
  Curator route is a two-line addition if preferred.
- The `requires_credence` margin and the `rival` tolerance are judgment
  calls about how much slack counts as noise. Phase 0's numbers should set
  them.
- Whether the General mandate is the right funder for every flag, or a
  topical mandate should value flags in its own scope (a flag could write
  on the mandate whose scope holds the tag). Phase 1 uses General only.
