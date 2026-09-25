# Production monitors

Continuous signals over the live graph and its trace substrate (#334 S9).
Every signal here is a **read**: it computes a number or lists candidates
from records the system already wrote, and it changes nothing. Two of them
(performed settling, empty chairs — from #289) are *candidate detectors*
whose hits can be handed to the Audit Agent as **input**; the rest are
numbers an operator reads. None is a verdict mechanism. The constitution's
"judgment over mechanism" holds throughout: a monitor picks *what to look
at*, and every conclusion belongs to an agent run or a person.

Surfaces:

- `GET /monitors` — the overview JSON (public read, like `GET /queue`);
  `GET /monitors/:signal` for one signal. `?limit=N` caps candidate lists.
- `npm run monitors [-- --corpus] [--signal=<name>] [--json] [--limit=N]` —
  the same as tables, against `DATABASE_URL` or, with `--corpus`, the
  isolated corpus DB (so a drained corpus run can be read the way
  production is).
- `startMonitorScheduler` (`src/workers/monitor-scheduler.ts`) — feeds the
  two candidate detectors to the Audit Agent. **Off by default.**

The code: `src/services/monitor-service.ts` (the SQL, reproduced below
verbatim; a unit test fails if this file and the code drift),
`src/services/monitor-math.ts` (the pure aggregation), `scripts/monitors.ts`
(the CLI), `src/routes/monitors.ts`.

## Thresholds

All from config (`MONITOR_*` env), overridable per call.

| knob | env | default | used by |
|---|---|---|---|
| settled confidence | `MONITOR_SETTLED_CONFIDENCE` | 0.8 | performed settling |
| settled statuses | — | verified, contradicted | performed settling |
| material credence delta | `MONITOR_MATERIAL_CREDENCE_DELTA` | 0.1 | overturn rate, cascade health |
| recent challenge window | `MONITOR_RECENT_CHALLENGE_DAYS` | 30 | performed settling |
| min. disagreeing sources | — | 2 | performed settling |
| empty-chair min. instances | — | 2 | empty chairs |
| monotonicity tolerance | `MONITOR_MONOTONICITY_TOLERANCE` | 0.05 | evidence monotonicity |
| monotonicity horizon | `MONITOR_MONOTONICITY_HORIZON_DAYS` | 30 | evidence monotonicity |
| monotonicity window | — | 90 days | evidence monotonicity |
| overturn min. sample per side | — | 10 | overturn rate |
| cascade window | — | 14 days | cascade health |
| snapshot points | — | 48 | queue health |
| candidate list cap | `?limit=` / `--limit=` | 25 | all lists |
| sweep interval | `MONITOR_SWEEP_INTERVAL_HOURS` | 0 (off) | scheduler |
| reflag window | `MONITOR_REFLAG_DAYS` | 14 | scheduler |
| flags per sweep | `MONITOR_SWEEP_MAX_FLAGS` | 5 | scheduler |

## How a candidate reaches the Audit Agent

`flagMonitorCandidates()` reads the two candidate detectors (capped at
`MONITOR_SWEEP_MAX_FLAGS`, most important claim first, both signals
interleaved) and calls `requestAudit` for each hit with
`auditType: "anomaly_investigation"`, `triggeredBy: "monitor_signal"`, and a
context that names the signal, the claim, the record that fired, and says
in words that the hit is a candidate: *read the claim
(`get_claim_with_context`) and judge whether the confidence is earned; if
the record already answers the dissent there is nothing to flag; do not
change the claim yourself.* The Audit Agent's normal tools apply — a
finding, a re-review recommendation — and its normal posture: the monitor
may be wrong and the verdict may hold.

Rate limiting needs no new table: the `audit_runs.dedupe_key` is
`monitor:<signal>:<claim_id>:<bucket>` where the bucket is
`floor(now / MONITOR_REFLAG_DAYS)`, and the partial unique index on that
column makes a re-flag inside the window a no-op (`requestAudit` returns
null), across any number of processes. `monitorSchedulerTick` runs the sweep
at most once per `MONITOR_SWEEP_INTERVAL_HOURS`; 0 disables the scheduler and
the signals stay readable.

What this is **not**: a queue of things to fix. A hit is a claim worth a
second look, and most second looks should end with "the verdict holds".
A detector that produced mostly real problems would be evidence the
Steward is broken, not that the detector is good.

---

## performed_settling — candidate detector

**Is:** a claim whose current assessment reads as settled — status
`verified` or `contradicted` at confidence ≥ 0.8 — while its own record
shows *live disagreement*, on any of three grounds:

1. `opposed_instances` — instances on both stances (`affirms` and `denies`)
   from at least 2 distinct sources;
2. `recent_accepted_challenge` — a `challenge` contribution accepted by the
   reviewer within the last 30 days;
3. `contested_requires_child` — a claim it `requires` whose current status
   is `contested`.

This is #289's "performed settling": a verdict that declares a winner while
the cruxes it depends on remain contested. The mechanical detector for what
constitution §1 warns against — an admin imposing false resolution.

**Is not:** a finding. The assessment may already weigh and dismiss the
dissent (a fringe denial, an accepted challenge that turned out minor, a
contested subclaim that is not load-bearing). The Audit Agent decides.
Nothing about the claim changes on a hit.

Ordered by importance; parameters `$1` settled statuses, `$2` settled
confidence, `$3` recent-challenge days, `$4` min. disagreeing sources, `$5`
limit.

```sql
WITH settled AS (
  SELECT c.id, c.text, c.importance, a.status, a.confidence, a.claim_credence, a.assessed_at
    FROM claims c
    JOIN assessments a ON a.claim_id = c.id AND a.is_current
   WHERE c.state = 'active'
     AND a.status = ANY($1::text[])
     AND a.confidence >= $2
),
stances AS (
  SELECT ci.claim_id,
         COUNT(*) FILTER (WHERE ci.stance = 'affirms')::int AS affirms,
         COUNT(*) FILTER (WHERE ci.stance = 'denies')::int  AS denies,
         COUNT(DISTINCT ci.source_id) FILTER (WHERE ci.stance IN ('affirms', 'denies'))::int AS sources
    FROM claim_instances ci
    JOIN settled s ON s.id = ci.claim_id
   GROUP BY ci.claim_id
),
challenges AS (
  SELECT co.claim_id, MAX(r.reviewed_at) AS last_accepted_challenge_at
    FROM contributions co
    JOIN contribution_reviews r ON r.contribution_id = co.id AND NOT r.superseded
    JOIN settled s ON s.id = co.claim_id
   WHERE co.contribution_type = 'challenge'
     AND r.decision = 'accept'
     AND r.reviewed_at >= now() - make_interval(days => $3::int)
   GROUP BY co.claim_id
),
contested_children AS (
  SELECT cr.parent_claim_id AS claim_id, COUNT(*)::int AS n
    FROM claim_relationships cr
    JOIN settled s ON s.id = cr.parent_claim_id
    JOIN claims ch ON ch.id = cr.child_claim_id AND ch.state = 'active'
    JOIN assessments ca ON ca.claim_id = ch.id AND ca.is_current AND ca.status = 'contested'
   WHERE cr.relation_type = 'requires'
   GROUP BY cr.parent_claim_id
)
SELECT s.id, s.text, s.importance, s.status, s.confidence, s.claim_credence, s.assessed_at,
       COALESCE(st.affirms, 0) AS affirms, COALESCE(st.denies, 0) AS denies, COALESCE(st.sources, 0) AS sources,
       ch.last_accepted_challenge_at,
       COALESCE(cc.n, 0) AS contested_requires_children
  FROM settled s
  LEFT JOIN stances st ON st.claim_id = s.id
  LEFT JOIN challenges ch ON ch.claim_id = s.id
  LEFT JOIN contested_children cc ON cc.claim_id = s.id
 WHERE (st.affirms > 0 AND st.denies > 0 AND st.sources >= $4::int)
    OR ch.claim_id IS NOT NULL
    OR cc.claim_id IS NOT NULL
 ORDER BY s.importance DESC, s.assessed_at DESC
 LIMIT $5::int
```

## empty_chairs — candidate detector

**Is:** a claim whose current status is `contested` but whose record
carries only one side: every instance on one stance (at least 2 of them),
or every named argument on one stance (`for` / `against`). The assessment
says the question is open; nobody sitting in the other chair is on record.
#289's coverage / omission probe, speaking to §18 (representing disagreement
fairly).

**Is not:** proof that a side is missing from the world. The other side may
not exist in the sources ingested so far, may live in the assessment's
reasoning or in a subclaim rather than as an instance or argument, or the
`contested` status may itself be the Steward's honest reading of thin
evidence. The Audit Agent (or the Steward) decides whether to seek the
missing side. Nothing changes on a hit.

Parameters `$1` min. instances, `$2` limit.

```sql
WITH contested AS (
  SELECT c.id, c.text, c.importance, a.status, a.confidence, a.claim_credence, a.assessed_at
    FROM claims c
    JOIN assessments a ON a.claim_id = c.id AND a.is_current
   WHERE c.state = 'active' AND a.status = 'contested'
),
inst AS (
  SELECT ci.claim_id, COUNT(*)::int AS n, COUNT(DISTINCT ci.stance)::int AS stances, MIN(ci.stance) AS stance
    FROM claim_instances ci
    JOIN contested c ON c.id = ci.claim_id
   WHERE ci.stance IN ('affirms', 'denies')
   GROUP BY ci.claim_id
),
args AS (
  SELECT ar.claim_id, COUNT(*)::int AS n, COUNT(DISTINCT ar.stance)::int AS stances, MIN(ar.stance) AS stance
    FROM arguments ar
    JOIN contested c ON c.id = ar.claim_id
   WHERE ar.stance IN ('for', 'against')
   GROUP BY ar.claim_id
)
SELECT c.id, c.text, c.importance, c.status, c.confidence, c.claim_credence, c.assessed_at,
       COALESCE(i.n, 0) AS instances, CASE WHEN i.stances = 1 THEN i.stance END AS instance_stance,
       COALESCE(ar.n, 0) AS arguments, CASE WHEN ar.stances = 1 THEN ar.stance END AS argument_stance
  FROM contested c
  LEFT JOIN inst i ON i.claim_id = c.id
  LEFT JOIN args ar ON ar.claim_id = c.id
 WHERE (i.n >= $1::int AND i.stances = 1)
    OR (ar.n >= 1 AND ar.stances = 1)
 ORDER BY c.importance DESC, c.assessed_at DESC
 LIMIT $2::int
```

## overturn_rate — continuous check (#295 tier 2)

**Is:** endogenous overturn-rate discrimination. Every assessment that has
a successor on the same claim is binned by the credence it recorded (ten
bins of 0.1), and the bin's *reversal share* is how often the next
assessment materially reversed it — a status change, or |Δcredence| ≥ 0.1.
The report compares the confident bins (credence ≤ 0.2 or ≥ 0.8) with the
uncertain ones (0.4–0.6): `discriminating` is true when confident
assessments reverse less often, false when they reverse as often or more,
and null until each side has 10 assessments. This is the one falsification
signal for the graph's unresolvable core that needs no external labels — if
0.9-claims reverse as often as 0.6-claims, the credences are not
discriminating. Runs over the whole history.

**Is not:** calibration against truth (deliberately out of scope, #295
non-goals) and not a statement about any single assessment — a reversal
may be the system learning, which is what it is for. Both a low and a high
reversal rate can be healthy; only their *ordering by credence* is the
signal.

Parameter `$1` material credence delta.

```sql
WITH ordered AS (
  SELECT a.claim_id, a.status, a.claim_credence,
         LEAD(a.status) OVER w AS next_status,
         LEAD(a.claim_credence) OVER w AS next_credence
    FROM assessments a
    JOIN claims c ON c.id = a.claim_id AND c.state = 'active'
  WINDOW w AS (PARTITION BY a.claim_id ORDER BY a.assessed_at, a.id)
)
SELECT width_bucket(claim_credence, 0, 1, 10) AS bin,
       COUNT(*)::int AS n,
       COUNT(*) FILTER (WHERE next_status <> status
                           OR abs(next_credence - claim_credence) >= $1)::int AS reversed
  FROM ordered
 WHERE next_status IS NOT NULL AND claim_credence IS NOT NULL
 GROUP BY bin
 ORDER BY bin
```

(`width_bucket` returns 11 for a credence of exactly 1.0; the aggregation
folds it into bin 10.)

## evidence_monotonicity — continuous check (#295 tier 2)

**Is:** directional sanity of updates. For every `support` or `challenge`
contribution the reviewer **accepted** in the last 90 days, take the
claim's last assessment at or before the acceptance and its first
assessment within 30 days after. An accepted support followed by a credence
that *fell* by more than the tolerance (0.05), or an accepted challenge
followed by one that *rose*, is a violation. Sign, not magnitude.

**Is not:** a gate, and not proof the Steward erred. A challenge can
expose that the *supports* were weaker than thought and the credence can
still move the "wrong" way for a right reason; the violation list is where
to read the Steward's reasoning, which is why it carries the claim text and
both assessments. Contributions accepted but not yet re-assessed within the
horizon are reported as `unassessed`, not as violations.

Parameters `$1` horizon days, `$2` window days.

```sql
WITH accepted AS (
  SELECT co.id AS contribution_id, co.claim_id, co.contribution_type, r.reviewed_at
    FROM contributions co
    JOIN contribution_reviews r ON r.contribution_id = co.id AND NOT r.superseded
   WHERE r.decision = 'accept'
     AND co.contribution_type IN ('support', 'challenge')
     AND co.claim_id IS NOT NULL
     AND r.reviewed_at >= now() - make_interval(days => $2::int)
)
SELECT ac.contribution_id, ac.claim_id, c.text, ac.contribution_type, ac.reviewed_at,
       before.claim_credence AS credence_before, before.status AS status_before,
       after.claim_credence  AS credence_after,  after.status  AS status_after,
       after.assessed_at AS assessed_after_at
  FROM accepted ac
  JOIN claims c ON c.id = ac.claim_id
  LEFT JOIN LATERAL (
    SELECT claim_credence, status FROM assessments
     WHERE claim_id = ac.claim_id AND assessed_at <= ac.reviewed_at
     ORDER BY assessed_at DESC, id DESC LIMIT 1
  ) before ON true
  LEFT JOIN LATERAL (
    SELECT claim_credence, status, assessed_at FROM assessments
     WHERE claim_id = ac.claim_id
       AND assessed_at > ac.reviewed_at
       AND assessed_at <= ac.reviewed_at + make_interval(days => $1::int)
     ORDER BY assessed_at ASC, id ASC LIMIT 1
  ) after ON true
 ORDER BY ac.reviewed_at DESC
```

## cascade_health — from the L0 enqueue events

**Is:** the empirical branching factor of stewardship propagation, per day
over the last 14 days. A steward run *materially changed* its claim when an
assessment recorded inside the run's window differs from the previous one
(status change or |Δcredence| ≥ 0.1) or is the claim's first. A run
*caused* another when an `enqueue_events` row on the steward lane carries
the first run's id as `source_run_id` and the second run is the next
steward run on that claim. **R** for a day = materially-changed runs caused
÷ materially-changed runs started that day; pooled R over the window is
reported with `supercritical` (R ≥ 1) — #295's cascade-stability property,
which wants R < 1 so a change peters out. Beside it, the **coalescing
share**: the fraction of steward enqueues absorbed into an already-pending
slot, which is what #182's lossless coalescing saves.

**Is not:** complete lineage. A notification sent outside a traced agent
run (TRACE_LEVEL=off, or a tool called from the harness) has no
`source_run_id` and is invisible here, so R is a lower bound in a partially
traced deployment. A caused run that changed nothing does not count toward
R — that is the second damping gate working, not missing data. And a high
R on a day with two runs is noise; read the counts beside the ratio.

Parameters `$1` window days, `$2` material credence delta.

```sql
WITH runs AS (
  SELECT r.id, r.claim_id, r.started_at, r.finished_at, date_trunc('day', r.started_at) AS day
    FROM agent_runs r
   WHERE r.agent = 'steward'
     AND r.claim_id IS NOT NULL
     AND r.finished_at IS NOT NULL
     AND r.started_at >= now() - make_interval(days => $1::int)
),
assessed AS (
  SELECT a.claim_id, a.assessed_at, a.status, a.claim_credence,
         LAG(a.id) OVER w AS prev_id,
         LAG(a.status) OVER w AS prev_status,
         LAG(a.claim_credence) OVER w AS prev_credence
    FROM assessments a
   WHERE a.claim_id IN (SELECT claim_id FROM runs)
  WINDOW w AS (PARTITION BY a.claim_id ORDER BY a.assessed_at, a.id)
),
material AS (
  SELECT ru.id, ru.day
    FROM runs ru
   WHERE EXISTS (
     SELECT 1 FROM assessed x
      WHERE x.claim_id = ru.claim_id
        AND x.assessed_at >= ru.started_at AND x.assessed_at <= ru.finished_at
        AND (x.prev_id IS NULL
             OR x.prev_status <> x.status
             OR abs(COALESCE(x.claim_credence, 0) - COALESCE(x.prev_credence, 0)) >= $2)
   )
),
children AS (
  SELECT m.id AS parent_id, m.day, ch.id AS child_id
    FROM material m
    JOIN enqueue_events e ON e.source_run_id = m.id AND e.queue = 'steward' AND e.claim_id IS NOT NULL
    JOIN LATERAL (
      SELECT r.id FROM runs r
       WHERE r.claim_id = e.claim_id AND r.started_at >= e.created_at
       ORDER BY r.started_at ASC LIMIT 1
    ) ch ON true
)
SELECT ru.day,
       COUNT(DISTINCT ru.id)::int AS runs,
       COUNT(DISTINCT m.id)::int AS material_runs,
       (SELECT COUNT(DISTINCT c.child_id) FROM children c
          JOIN material cm ON cm.id = c.child_id
         WHERE c.day = ru.day)::int AS material_children
  FROM runs ru
  LEFT JOIN material m ON m.id = ru.id
 GROUP BY ru.day
 ORDER BY ru.day
```

Coalescing, parameter `$1` window days:

```sql
SELECT date_trunc('day', created_at) AS day,
       COUNT(*)::int AS enqueues,
       COUNT(*) FILTER (WHERE coalesced)::int AS coalesced
  FROM enqueue_events
 WHERE queue = 'steward'
   AND created_at >= now() - make_interval(days => $1::int)
 GROUP BY 1
 ORDER BY 1
```

## queue_health — operational

**Is:** the steward lane by state right now (`pending`, `running`, `done`,
`error`, `deferred`); the oldest pending claim and how long since its last
non-coalesced enqueue; the `queue_depth_snapshots` trend over the last 48
points (earliest, latest, delta, least-squares slope per hour); and the
claims parked in `error` with their last error, most important first —
the #97 failure mode (81 of 142 parked with nothing surfacing it) kept
visible.

**Is not:** about content. A deep queue under a corpus drain is expected;
a growing one on an idle deployment is not. Read the slope with the
snapshot cadence in mind.

```sql
SELECT steward_state, COUNT(*)::int AS n
  FROM claims
 WHERE state = 'active'
 GROUP BY steward_state
```

```sql
SELECT c.id, c.text, c.importance, last.created_at AS enqueued_at,
       EXTRACT(EPOCH FROM now() - last.created_at)::float8 AS age_seconds
  FROM claims c
  JOIN LATERAL (
    SELECT created_at FROM enqueue_events e
     WHERE e.claim_id = c.id AND e.queue = 'steward' AND e.coalesced IS NOT TRUE
     ORDER BY created_at DESC LIMIT 1
  ) last ON true
 WHERE c.state = 'active' AND c.steward_state = 'pending'
 ORDER BY last.created_at ASC
 LIMIT 1
```

```sql
SELECT period_key, steward_pending, created_at
  FROM queue_depth_snapshots
 ORDER BY created_at DESC
 LIMIT $1::int
```

```sql
SELECT id, text, importance, steward_error, steward_attempts, stewarded_at
  FROM claims
 WHERE state = 'active' AND steward_state = 'error'
 ORDER BY importance DESC, stewarded_at DESC NULLS LAST
 LIMIT $1::int
```

## agent_rollups — operational

**Is:** per agent, over the last 24 hours and 7 days: LLM calls and metered
cost from `llm_usage` (the same rows production bills through), and runs,
errors and error rate (errors ÷ finished runs) from `agent_runs`. Ordered
by 7-day cost.

**Is not:** the committed scorecard history — that lives in
`corpus/scorecards/`, not the database, and is out of this surface's reach.

Parameter `$1` hours (24 and 168):

```sql
SELECT agent, COUNT(*)::int AS calls, COALESCE(SUM(cost_micro_usd), 0)::bigint AS cost_micro_usd
  FROM llm_usage
 WHERE created_at >= now() - make_interval(hours => $1::int)
 GROUP BY agent
```

```sql
SELECT agent, COUNT(*)::int AS runs,
       COUNT(*) FILTER (WHERE outcome = 'error')::int AS errors,
       COUNT(*) FILTER (WHERE finished_at IS NULL)::int AS running
  FROM agent_runs
 WHERE started_at >= now() - make_interval(hours => $1::int)
 GROUP BY agent
```

## Tests

- `tests/unit/services/monitor-math.test.ts` — the aggregation (bins,
  monotonicity classification, R, trend, rollups).
- `tests/unit/workers/monitor-scheduler.test.ts` — the hand-off: audit
  type, trigger, dedupe key, cap, off-switch, context wording.
- `tests/db/monitors.test.ts` — real SQL: each situation seeded beside a
  control that must not fire.
- `tests/unit/services/monitor-docs.test.ts` — this file carries every
  query verbatim.
