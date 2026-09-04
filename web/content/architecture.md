# Minerval Architecture

This document describes the Minerval system as it is built today: the domain
model, the agent pipeline that populates it, the data layer underneath, and the
surfaces that serve it. It is a description of the running architecture, not a
roadmap. Where a design decision has interesting consequences, the reasoning is
given inline.

The companion documents are the [constitution](/docs/constitution), the text
every administrator agent is bound by; the [agents](/docs/agents) pages, which
show each agent's actual system prompt verbatim; and the operational policies
further down this page, which translate the constitution into concrete rules
for each agent.

---

## System Overview

Minerval turns documents into a queryable graph of claims. Ingestion is the
expensive, write-side work: an LLM pipeline reads a source, pulls out atomic
claims, decides whether each is new, decomposes it into its supporting
structure, and assesses its validity. Serving is the cheap, read-side work: the
graph is queried directly, with no LLM in the read path. The few surfaces that
invoke agents on demand (submitting a source, the browser extension's page
analysis, the MCP assessment tools) are authenticated, rate-limited, and
metered per account.

```
   SOURCE               INGESTION                    GRAPH
 ┌─────────┐   ┌───────────────────────────┐   ┌───────────┐
 │ URL or  │──▶│ Extractor → Matcher →     │──▶│ Postgres  │
 │ document│   │ onboard → Claim Steward   │   │ + pgvector│
 └─────────┘   └───────────────────────────┘   └─────┬─────┘
                                                     │ read
   GOVERNANCE (ongoing)                              ▼
 ┌──────────────────────────────────────┐      ┌───────────┐     web ·
 │ Claim Steward (decompose + assess) · │◀────▶│    API    │──▶  extension ·
 │ Curator · Contribution Reviewer ·    │      │ (Fastify) │     MCP clients
 │ Dispute Arbitrator · Audit Agent     │      └───────────┘
 └──────────────────────────────────────┘
```

The work is done once, at ingestion, and reused everywhere a claim recurs: the
same claim appears across thousands of documents but is decomposed and assessed
a single time. Nor does every claim get the full treatment immediately. Each
claim carries an importance score that anchors the expected-value estimates
the allocation engine funds work by (docs/allocation.md), so the most
consequential claims draw assessment first while minor ones remain
searchable stubs until an allocation covers them.

The stack is TypeScript end to end: a Fastify API, background workers driven by
a job queue (AWS SQS in production, an in-memory runner locally), and
PostgreSQL with the `pgvector` extension as the single store, carrying vector
search and full-text search alongside the relational data. Anthropic Claude
models sit behind every agent by default; model ids are centralized in
`src/llm/models.ts`, and in production the load-bearing agents run on Claude
Fable 5.1. Any agent can be pointed at OpenAI or OpenRouter instead with a
single env var — the Matcher runs on DeepSeek V4 Flash this way — see
[Providers](#providers).

---

## The Domain Model

Six entities carry the epistemic content. The rest of the schema records
accounts and governance (contributors, contributions, reviews, appeals,
arbitration, reputation) and operations (sources, jobs, usage metering). The
epistemic core, where `──<` reads "has many":

```
  Source ──< Instance >── Claim ──< Relationship >── Claim
                            │           (decomposition edge;
                            │            argument_id groups edges
                            │            into a line of reasoning)
                            ├──< Assessment   (verdict history; one is_current)
                            │
                            └──< Argument      (a named line of reasoning;
                                                relationship edges point back
                                                to it via argument_id)
```

### Claims

A **claim** is the atomic unit: a proposition that can be true or false.
Empirical claims (directly verifiable or derived), definitional, evaluative,
causal, normative, and mathematical claims are all represented the same way
and all decompose into subclaims. Two formulations are the *same* claim when they turn on the
same considerations: nothing could count as evidence or argument bearing on one
without bearing equally on the other (identical decomposition is a useful
diagnostic, not the definition). This is the basis for deduplication, and it
extends to negation. A claim and its denial are one node, and each recorded appearance
carries a stance saying which side it takes.

Each claim carries its canonical `text`, a `claim_type`, a lifecycle `state` (a
claim merged into another records the target in `merged_into` rather than being
deleted), counters for how many of its children have been assessed, an
`embedding` (a 1536-dimension vector) and a `text_search` column for retrieval,
and an `importance` score.

Importance is a 0 to 1 judgment of consequence-if-wrong times liveness, how actively the claim is disputed or consulted.
It is explicitly not a count of dependents: a settled fact cited everywhere
scores low, a load-bearing contested premise scores high. The Extractor supplies
a prior at ingestion; the claim's Steward sets the authoritative value once it
has decomposed the claim and seen its neighborhood. Importance decides both how
soon a claim is stewarded and how much effort its Steward spends.

Two further signals complete the picture (issue #172): `contestation` on the
claim, how live the dispute is stated unfused from the consequence half, and
`marginal_yield` on each assessment, the Steward's exit judgment of how much
another, stronger pass would improve it. Both are live inputs to the
expected-value estimate the allocation engine funds work by
(docs/allocation.md): value = importance × contested-factor × expected
quality gain, with cost on the other side of the ratio.

Two of the claim's fields carry two different judgments about its kind.
`claim_type` is the proposition-kind facet that the page eyebrow, the cards,
the map's bedrock logic, and the territory listing read; its values include
`mathematical`, a proposition of mathematics, true or false by proof rather
than by observation, settled by a proof others can check and most firmly by
one a machine has checked. `domains` is a separate tag list
(`claims.domains`, with `domains_source` recording whether the tag came
from the Extractor, the Matcher, inheritance from a parent subclaim, a
Steward's `set_claim_domains`, or the backfill) that selects which domain
skills and tools a run on the claim carries (docs/policies.md, "Skills").
The two are independent on purpose: a claim about the economics of a
theorem is `causal` in type and carries `mathematics` among its domains; a
theorem is `mathematical` in type and `mathematics` in domain. The Steward
sets both, and neither the funding mandate nor importance gates the tools a
domain brings.

### Arguments

An **argument** groups decomposition edges into a coherent, named line of
reasoning. A single claim routinely has several:

- **Philosophy**: "God exists" has the cosmological argument, the teleological
  argument, the argument from evil, and others.
- **Policy**: "We should raise the minimum wage" has a poverty-reduction
  argument (for) and an unemployment argument (against).
- **Science**: "The universe is ~13.8 billion years old" is supported
  independently by the CMB, stellar evolution, and nucleosynthesis.

Forcing these into one flat set of edges would lose the structure of which
subclaim belongs to which line of reasoning. An argument has a `stance` (`for`,
`against`, `neutral`), an optional `name` and `description` (a short label),
its `content` (the written form, below), any `evidence_urls`, and provenance.

**The written form.** A name is not an argument: the grouping records *which*
subclaims belong together, but not *how* they combine to bear on the parent
claim. Every named argument therefore carries a written form in `content`: one
to three sentences of logically straightforward prose stating the inference,
with every subclaim referenced inline as `[[claim:<uuid>]]` (or
`[[claim:<uuid>|inline phrasing]]` when grammar demands it). For example:
"Because [[claim:a]] and [[claim:b]], and given [[claim:c]], the claim
follows." The links make the prose and the grouping mutually checkable: every
subclaim edge in the argument should appear in the written form, and every
reference must be an edge in the argument (the Steward's `write_argument` tool
enforces the latter and warns on the former). Renderers resolve the ids to the
claims' canonical text at display time, following `merged_into`, so links never
dangle after a merge. The connective language that the claim bar expels from
claim texts ("therefore", "because", "given that") lives here and only here.

**The evaluation.** The written form deliberately withholds judgment; the
judgment lives in a separate steward-maintained evaluation
(`argument_evaluations`, one `is_current` row per argument with prior rows
kept as history). It records a verdict on the inference itself: `holds`,
`holds_with_caveats`, `fails`, or `contested` (the framework's validity is
itself live-disputed), plus two to four sentences of reader-facing prose
saying whether the inference goes through granting its premises and which
premises, given their current assessments, the argument lives or dies on,
with those load-bearing premises linked inline exactly as in the written
form. The evaluation is derived within the claim's assessment process, not
as a fire-once verdict: the Steward's `evaluate_argument` tool stamps each
evaluation with the assessment it was derived under, so an evaluation left
behind by a later reassessment is detectably stale, and the assessment tool's
result nudges the Steward to bring evaluations current whenever it records a
new verdict.

Two design decisions follow:

- **The written form is structural; the evaluation is epistemic.** The written
  form states the inference, never a verdict on whether it holds; the verdict
  and the load-bearing analysis live in the evaluation, which is maintained as
  part of the claim's assessment and follows the same transparency rules
  (reasoning visible, open to challenge). It is reader-facing prose, not a
  discussion surface: contributor exchanges stay in the contribution record.
- **Arguments are optional and non-exhaustive.** A claim with one natural
  decomposition needs no explicitly named argument; edges simply carry a null
  `argument_id`. Admins create arguments when a line of reasoning is live in
  the discourse, not preemptively.

When the *validity of an argument's framework* is itself disputed in the
discourse, "this framework is valid" is added as a subclaim within that
argument, typically with an `assumes` relation, and the evaluation marks
the verdict `contested`. The meta-dispute itself stays inside the claim
layer, where decomposition, assessment, and contribution already operate.

### Decomposition edges

Decomposition is recorded as **claim relationships**: directed edges from a
parent claim to a child claim. Each edge has a `relation_type`, a free-text
`reasoning`, a `confidence`, and an optional `argument_id` linking it to the
argument it belongs to. A child can appear under multiple arguments (shared
subclaims); a uniqueness constraint prevents duplicate parent/child/relation
triples, and self-edges are rejected outright. The relation types are:

| Relation | Meaning |
|----------|---------|
| `requires` | The child is a load-bearing premise: the parent is false without it. |
| `supports` | The child provides evidence for the parent without being logically required. |
| `contradicts` | The child weighs against the parent. |
| `specifies` | The child narrows or makes precise part of the parent. |
| `defines` | The child fixes the meaning of a term in the parent. |
| `assumes` | Background the parent's framing takes as given (often a framework or scope claim): if it fails the parent is ill-posed rather than simply false. Renamed from `presupposes` (#205). |

### Assessments

An **assessment** is a verdict on a claim at a point in time, and it is written
for two audiences at once. The `summary` is the reader-facing verdict: a short
paragraph, shown at the top of a claim page, saying what the evidence
establishes and where the weight rests. The `reasoning_trace` is the audit
record: how the evidence and decomposition were weighed, kept so the judgment
can be reviewed, not so it can be read. Splitting them means neither has to
compromise; a trace written to be skimmable makes a worse audit record, and an
audit record shown to readers makes a worse summary.

Alongside these sit the `status` and `confidence`, a `subclaim_summary`
snapshot of the children at judgment time, and the `trigger` (and
`trigger_context`) that prompted the assessment. Assessments are append-only
history: exactly one row per claim is flagged `is_current`, enforced by a
partial unique index, so the timeline of *why* a claim's status changed is
fully recoverable. The statuses and how they propagate are described under
[Assessment](#assessment) below.
### Formal statements and machine-checked arguments

A mathematical claim may carry a **formal statement**: the graph's own
rendering of the proposition as a Lean 4 `def Statement : Prop`, elaborated
against a pinned Mathlib revision and toolchain. It lives in its own table
(`claim_formalizations`) rather than in columns on `claims`, because it has
a lifecycle with more than one live row (a draft beside the published one),
prizes and attempts pin it by id and hash, and its provenance needs columns
of its own. Each row records the pin (`pin_id`, `lean_toolchain`,
`mathlib_rev`, `image_digest`), the statement source verbatim, two hashes
(`source_hash`, which anyone can recompute from the published text and the
pin, and `expr_hash`, over the elaborated body, which the checker compares),
the pretty-printed proposition, the Mathlib constants it references, whether
a witness `example` for satisfiable hypotheses elaborated, a reader-facing
correspondence note in the graph's voice saying how the formal and informal
statements relate and what the formal one leaves out, and a status of
`draft`, `reviewed`, `published`, or `retired`. A partial unique index
allows one `published` statement per claim. Publication is two-pass: the
`formalize` action runs the Steward once to draft, elaborate, and record
`reviewed`, then a fresh-context Steward pass with trigger
`formalization_review` either publishes or returns it to `draft`. This is
the defense against a statement whose every line is correct and whose
theorem is the wrong one. A published statement carries
`review_period_ends_at`, and no bounty may bind to it before then; a
canonical-form change on the claim returns the statement to `reviewed` in
the same transaction and moves any open bounty to `rebinding`.

A **machine-checked argument** is an ordinary argument with stance `for`
(or `against`, for a disproof) whose evidence is a `lean_checks` row the
checker accepted. `lean_checks` is the server-side record of every check
the platform runs, in three modes (`prize`, `attempt`, `steward`), with the
verdict, the per-gate record, diagnostics, resource use, the pin, the image
digest, and the metered cost; repeated checks of the same statement,
submission, checker version, and mode return the stored row. The claim page
derives the machine-checked badge at read time from the argument, its
evaluation, and the check. It is not a seventh status: the six statuses are
constitutional and closed in code. The badge says the proof checks against
the statement; the verdict beside it is still the Steward's judgment of the
claim as worded.


### Instances and sources

A **source** is a retrieved document (URL, title, content hash, raw content,
type). An **instance** links a canonical claim to one place it actually
appeared: the exact `original_text` quote, the surrounding `context`, a brief
`summary_context` describing the circumstances ("said during a Senate hearing
on banking regulation, in response to questioning about derivatives
oversight"), a `stance` recording whether the quote affirms or denies the
canonical claim, and a `confidence` that the quote really expresses it.
Instances are how a single canonical claim accumulates provenance from many
documents, and the stance field is what lets a claim and its negation share one
node without losing track of who said which.

### Contributions and governance

Anyone can contribute — but the graph is a governed space: open to
*suggestions*, never to direct writes. A **contribution** targets a claim with
a type (`challenge`, `support`, `propose_merge`, `propose_split`,
`propose_edit`, `add_instance`, or `propose_argument`) plus content and
evidence. Contributions flow through review (`contribution_reviews`), can be
appealed (`appeals`), and escalated to arbitration (`arbitration_results`).

Two **intake** types extend the same machinery to brand-new content:
`propose_claim` (a suggested claim plus its supporting argument) and
`propose_source` (a document submitted for extraction). These have no target
claim while pending — nothing touches the claims table — and only an accepted
review materializes them: a proposed claim is canonicalized through the
Matcher (so a duplicate or a negation lands on the existing node) and only
then created live and handed to its Steward, with a deliberately conservative
importance prior; a proposed source is only then queued for extraction. The
review gate judges good faith and claim quality (is this a single, disputable,
canonical-formable proposition?), never subject matter. Internal seeding by
direct service callers (corpus runs, case studies) is the one path that
writes without review.

A third family, the **prize claim** (`claim_prize`), is the one contribution
type that carries files. It is created only by its own multipart route,
never by `POST /contributions`, and its verification and money state live on
a linked `prize_claims` row; the contribution row gives it the identity
gate, the public record, review, appeal, arbitration, and audit that every
other contribution has, so prizes need no second governance system. The
flow is described under [the prize-check worker](#the-prize-check-worker-and-the-money-triggers).

**Contributors** are the account layer as well as the reputation layer; there
is one account table, and everyone on it is a potential contributor. Reputation
and kudos are kept as append-only event ledgers (`reputation_events`,
`kudos_events`) with denormalized totals on the contributor row, so every score
change traces back to the decision that caused it. Reviews can flag suspected
bad faith, and a contributor's standing feeds back into how much their
contributions are trusted. This is the machinery the governance agents operate;
the rules they apply live in the operational policies below.

---

## Assessment

### The six statuses

Validity is expressed honestly, never as a binary. The system implements all
six statuses the constitution defines:

| Status | Meaning |
|--------|---------|
| `verified` | Traces to reliable primary sources through a clear evidence chain. |
| `supported` | Evidence favors the claim, but the chain is incomplete or sources are secondary. |
| `contested` | Credible evidence or argument exists on multiple sides. |
| `unsupported` | No credible evidence found, though the claim is not contradicted. |
| `contradicted` | Available evidence actively weighs against the claim. |
| `unknown` | Insufficient information to assess. |

The colour treatment in the UI is deliberately muted and never a traffic light:
`supported` and `verified` are distinct shades of green, `contested` is amber,
`contradicted` is a clay red, and the rest are warm neutrals. Meaning never
depends on colour alone.

### Judgment-based propagation

Assessment is a holistic judgment by the claim's Steward, **not** a mechanical
roll-up of child statuses. An earlier design used hard aggregation rules ("if
any required subclaim is `contested`, the parent is `contested`"). At scale
that makes contestation infectious: almost every claim eventually inherits a
contested subclaim somewhere deep in its tree, and the status field becomes
useless.

Instead, the Steward weighs the status of subclaims across all arguments, the
*materiality* of each subclaim to the parent's truth, and the strength of each
argument as a whole, and documents the result in its reasoning. The
Steward prompt gives guidance and worked examples rather than rules, and is
explicit: *do not mechanically propagate status changes; assess materiality
first.*

Propagation is therefore self-limiting. When a Steward materially changes an
assessment, it notifies the Stewards of directly dependent claims, each of
which re-judges with the same materiality test. Most changes are absorbed
within a level or two, because a superior claim is rarely the right locus for a
dispute about one of its subclaims.

---

## The Agent Pipeline

Each agent is a model with a system prompt assembled in layers: the full
constitution first, then the agent's specific role (governance roles also
splice in the relevant operational policies), then the domain skills active
for the run, then the task. The constitution-plus-role prompt is sent as one
cached block, plus one per active domain skill, so the constitution is paid
for once per agent rather than once per call. The prompts live in
`src/llm/prompts/`, the skills in `skills/`, and both are vendored verbatim
into this site (see the [agents](/docs/agents) and [skills](/docs/skills)
pages).

### Processing stage

Ingestion runs three steps before governance takes over:

```
 Extractor ──▶ Matcher ──▶ onboard ──▶ Claim Steward
  read a       new claim    latch +     decompose + assess
  source for   or existing? enqueue     (a governance agent,
  its claims  (agentic search           below)
              over the graph)
```

- **Extractor**: reads a source and emits the discrete, reusable claims it
  asserts, in canonical form, each with a provisional importance prior and a
  confidence that the proposition is a well-formed claim at all. It is a
  structured extraction call rather than a tool-use loop, and it is deliberately
  selective: the claims a reader would want checked, not every sentence. A low
  confidence floor drops obvious non-claims before they enter the graph — a
  backstop against garbage, not a quality judgment, which stays with the
  agents.
- **Matcher**: the single decider of claim identity. For each proposition it
  searches the graph itself, under multiple framings including the negation,
  and decides match-or-create, recording the stance of the new appearance. It
  is also a **tool** the Steward and Curator call before creating anything. Two
  claims match when the same considerations bear on both; identical
  decomposition is a diagnostic, not the test. If the Matcher cannot reach a decision
  within its iteration budget, it defaults to "novel, low confidence": the
  failure mode is a duplicate the Curator can merge, never a lost claim.
- **Onboarding** is not an agent. A small dispatcher latches the new claim so
  redelivered messages cannot double-process it, then enqueues its Steward.

Decomposition and assessment are **not** separate processing agents: they are
the Claim Steward's job, because deciding what a claim depends on and whether
those dependencies hold is one open-ended judgment that belongs to the claim's
owner.

### Governance agents

These act through tools over the life of a claim and the graph:

- **Claim Steward** owns a single claim end to end: it **decomposes** the claim
  (calling the Matcher before minting any subclaim, so existing claims are
  linked rather than duplicated), maintains its canonical form and arguments,
  sets its authoritative importance, and **assesses** it, re-judging as
  evidence and depended-on claims change. Its triggers: first onboarding, a
  subclaim's assessment changing, an accepted contribution, a Curator change,
  a staleness check, and, on mathematical claims, a formal statement to
  publish or review, a completed solver attempt, or a prize claim to judge
  for fidelity. Effort scales with importance; consequential or
  contested claims get deeper search (including bounded web search) and an
  adversarial second pass, minor settled ones a light touch. Decomposition
  terminates without a depth cap because shared ancestors get linked, not
  re-created; recursion is bounded economically by the importance brake, and a
  per-run cap on newly minted subclaims backstops a single runaway pass.
- **Curator** is the graph-level counterpart: it owns the connective tissue
  *between* claims, merging duplicates and counterparts the Matcher missed,
  splitting conflated claims (§5), and suggesting cross-claim edges for the
  owning Stewards to adopt. It runs on Steward escalations and on sampled
  sweeps of the neighborhood around newly created claims. Every structural
  operation lands in an append-only reconciliation log with enough payload to
  reverse it, and the Curator never overrides a Steward's verdict.
- **Contribution Reviewer** evaluates each incoming contribution against policy
  (accept, reject, or escalate), including `propose_argument` contributions,
  and flags suspected bad faith. It is also the graph's **admission gate**:
  user-proposed claims and sources arrive as intake contributions, and its
  accept — judged on good faith and claim quality, never topic — is what
  admits them (materialization itself is mechanical: Matcher first, then
  claim creation or extraction).
- **Dispute Arbitrator** resolves escalations and appeals through careful
  adjudication, the highest-stakes governance call.
- **Audit Agent** is quality control over the governance system itself. Each
  run is invoked with an audit type (a decision audit of specific review
  decisions, a pattern analysis across recent ones, a contributor review, or an
  anomaly investigation) and a free-text context saying what prompted it.
  Runs are fed from two directions: event triggers at the places suspicion is
  generated (every arbitration overturn and every bad-faith flag requests a
  decision audit, at most once per contribution), and a scheduler that
  requests a periodic sweep over recent decisions plus a re-examination of
  any suspension that has stood unexamined too long — both idempotent through
  a DB dedupe key, so concurrent processes never double-run an audit.
  Findings are persisted rows (`audit_findings`, attached to their
  `audit_runs` row), and every consequence — a re-review, a reputation
  adjustment through the ledger, a suspension — requires the finding that
  justifies it. A re-review first neutralizes the superseded decision's
  consequences (reputation, counters, kudos, a still-active bad-faith flag)
  so the fresh review's effects don't stack on the old ones. Audit
  suspensions are severe but not one-way: the suspended contributor can
  still appeal their own contributions, and the Arbitrator can lift a
  suspension whose basis an appeal dissolves.

One agent lives outside governance entirely. The **Extension Agent** is the
read-only companion behind the browser extension: it judges the phrasings on a
live web page against graph state (verdicts range from "egregious" to "fine")
and powers the extension's chat, grounded in the same graph tools. It never
writes to the graph.

### The Lean checker

The checker is a Minerval-owned HTTP service, `lean-checker`, one container
image per pin (`lean-checker/`; the image, its contract, and its first
measurements are in `lean-checker/README.md`). It is an instrument, not an
admin: it answers one mechanical question about one formal statement, holds
no standing, and writes nothing to the graph; the API writes the
`lean_checks` row from what it returns.

It runs in **two lanes**, and the distinction is the security model. The
warm lane is a long-lived process with Mathlib imported, serving
`POST /v1/elaborate` (statement publication and vacuity signals),
`POST /v1/scratch` (the Steward's and the solver's iterative work), and
`POST /v1/search` (a proxy to a Loogle mirror pinned to the same Mathlib);
it takes semi-trusted input only, Steward- and solver-generated code, never
a claimant's file, and its results are never a verdict. The cold lane is
one fresh container per check from the pinned image: no network, read-only
root, Mathlib read-only, a temporary work directory, memory and heartbeat
limits inside Lean and a kill timeout outside, output capped and flagged
`truncated`, no secrets in the image or the environment. `POST /v1/check`
in `prize` mode queues a job and returns `202 {check_id}`;
`GET /v1/checks/:id` returns the record.

**The verdict rule**, in one paragraph. A submission is `accepted` when,
under the statement's pin, it passes the static policy (no `sorry`,
`axiom`, `native_decide`, `unsafe`, `partial`, extra `import`, custom
metaprogramming, or disallowed `set_option`) and compiles with no errors;
the target constant exists, is a `theorem` with no universe parameters,
and has a type alpha-equivalent to the published `Statement` constant (or
its negation, for a disproof), compared against the constant rather than
an unfolded body so that no reduction is involved and nothing is arguable;
its axiom closure lies within `propext`, `Classical.choice`, and
`Quot.sound`, and the submission adds no axiom or opaque constant; no new
constant is `unsafe`, `partial`, or externally implemented; and the new
declarations replay through the kernel. It is `rejected` when any gate
fails on the merits, and the failed gate is stated on the contribution page
in plain words. It is `error` when the checker could not decide (timeout,
memory, infrastructure), which is never evidence.

**Pins.** Each statement records its pin, and a submission is checked under
the statement's pin, never a newer one. The platform keeps at most three
live pins: the current monthly Mathlib tag, the previous one, and any pin
still referenced by an open bounty. When the pin advances, a migration job
re-elaborates every open statement and carries it forward without a new
version only if the elaborated body and the closure of the constants it
references hash the same; a statement with a live bounty never changes pin
without a new version and the notice the rules require, whatever the hash
says. Retired images stay in the registry so any historical verdict can be
re-run.

**No callback.** The checker never calls the API. The API polls
`GET /v1/checks/:id` from the prize-check worker and a recovery sweep, and
the checker's security group allows it no egress to the API's or the load
balancer's. A design in which the checker reported results back would have
to survive the checker being compromised by a submission; polling survives
it by construction. The API reaches the service over the VPC's private
addressing with a bearer token from Secrets Manager. A second opinion from
an outside hosted checker may be requested for a prize verdict and is
recorded beside it, never decisive; disagreement between the two is an
automatic human sign-off condition.

The Steward reaches the checker through four skill tools (`lean_search`,
`lean_elaborate`, `lean_check`, `publish_formalization`), present exactly
when the run carries the Mathematics skill and `LEAN_CHECKER_URL` is set,
with per-run caps as backstops and no importance gate; a checker
unreachable at run start yields no Lean tools and a note in the task, and a
failed call mid-run returns a structured error the Steward routes around.
Every checker call is metered into `llm_usage` as external usage (provider
`lean`, the pin as the model) so it lands in the escrow accounting of
whichever action funded it.

### The solver

`math_solver` (`src/llm/agents/math-solver.ts`) is the platform's own
prover: an agent over the same LLM seam, run as a ledger action of kind
`attempt_proof`, metered through the same chokepoint, traced into
`agent_runs` and `agent_steps` with tracing forced on, and published on the
agents pages like every other prompt. It is **an instrument, not an
admin**: it owns no claim, holds no standing, receives no constitution
(only the skill's `For the solver` section and a harness block), and writes
nothing to the graph. Its tools are fixed at run start: the three Lean
tools, with `lean_check` bound to the attempt's statement so it cannot
check against a different one; the provider's code-execution container as
the computer-algebra toolkit (no network, and it cannot hold Mathlib, which
is why Lean is a client tool); a notebook (`notebook_write`,
`notebook_read`) backed by `proof_attempts.notebook`; and a terminal
`report` with a strict schema. No web search: a proof found on the web is
not the platform solving the problem.

**What it may write:** `proof_attempts.notebook`, `lean_checks` rows through
`lean_check`, and its final report. It may not write to `claims`,
`assessments`, `arguments`, `argument_evaluations`, `claim_relationships`,
`claim_instances`, `contributions`, or any money table, and a unit test
asserts that no such write occurs under `withAgent("math_solver")`. The
harness validates the report: a `proof` outcome without an accepted check
from this attempt is downgraded to `partial`, and a computational
counterexample without a Lean disproof is a lead, not a result. The
solver's narrative is untrusted; the tool log is the record.

**Budgets and kill switches.** Every attempt has a dollar ceiling (the cost
estimate plus `ATTEMPT_OVERAGE_FRACTION`) read from the usage meter each
turn, Lean and container time included; a wall cap and an iteration cap; a
per-claim lifetime cap on attempt spend; and the mandate's day room like any
allocation. Independent of any mandate, a durable **breaker**
(`checkSolverBudget`, `src/llm/solver-budget.ts`) compares the day's solver
spend across processes against `SOLVER_DAILY_CAP_OWLS` and stops new
attempts when it is reached, because the in-memory tracker is per process
and exempts attributed calls. Three kill switches: `SOLVER_ENABLED` (the
worker exits its loop when false), a `solver_paused` row in
`platform_flags` polled every turn so an operator halts a run without a
deploy, and `POST /admin/attempts/:id/cancel`, also polled per turn. A
halted attempt completes its action with the metered amount and keeps its
notebook and transcript. The solver runs with server-side fallbacks off: a
refusal records `refused` and stops, since a maximum-effort attempt
silently continued on a different model would be a different product than
the mandate funded.

**Execution.** A dedicated worker (`src/workers/solver-executor.ts`, its own
process, `npm run worker:solver`) claims `attempt_proof` actions, runs the
attempt under a usage context whose job is the funding job, completes the
action with the metered amount, and then invokes the Steward **directly**
with trigger `attempt_completed` on the strong model, under the same job,
rather than enqueueing it: the steward queue coalesces triggers into one
pending slot per claim and would run the result as an ordinary reassessment
on the standard tier. The Steward reads the check rows the server wrote,
re-checks a prize-bearing result with a fresh replay, judges fidelity,
records the argument and the assessment, and, where a bounty is bound to
the statement, either closes it as solved by the platform or retires a
defective statement. Each turn updates the attempt's heartbeat and the
action's `updated_at`, so the reopen sweep reclaims only a dead worker's row
and marks its attempt `orphaned`. Every attempt is disclosed on the claim
page, and its report and notebook are published before any bounty opens on
the statement.

### The prize-check worker and the money triggers

A prize claim is filed through `POST /claims/:id/prize-claims` (multipart,
free of any owl charge), whose gate checks that the bounty is `open`, the
statement version is current, the claimant is eligible, no live claim by
the same claimant exists on this statement version, the rate limits and
cooldowns hold, the attachment policy is met, and the static Lean policy
passes as a word-boundary scan that turns away spam before anything runs.
One transaction inserts the contribution with `review_status = 'checking'`,
a status the ordinary review pipeline and its recovery sweep ignore, the
attachments, the `prize_claims` row (`queued`), and a `prize_review` action
funded from the bounty's reserve (docs/allocation.md, "Prizes and
attempts"); `submitted_at` is the priority timestamp.

**The check runs first**, before any agent, as a DB-backed job rather than
inside a tool loop, because a prize check may run fifteen minutes and a
strong-model run held idle for it would be lost with the process. The
worker (`src/workers/prize-check-pipeline.ts`) claims the `prize_review`
action, selects with `FOR UPDATE SKIP LOCKED` the oldest `queued` claim per
statement version whose statement has no other claim in flight (strict
per-statement serialization, so priority is never lost to a race), posts to
the cold lane in `prize` mode, and polls the record, with a recovery sweep
for rows `checking` past the reclaim window. `accepted` moves the claim to
`checked`, the bounty to `claim_pending`, and the contribution to `pending`
for the Reviewer; `rejected` closes the claim at stage `check` with the
gate summary public, no review row, and no reputation event; `error`
requeues up to a retry cap and then parks the claim in `check_error`, which
holds the statement's queue until an operator resolves it, so an
infrastructure failure never costs a claimant their priority. The worker
then runs the Reviewer itself, under the bounty's reserve job, with the
review claimed in the same statement that marks it `pending` (the ordinary
review pipeline and its recovery sweep skip `claim_prize`, so no second
Reviewer attributed to the claimant can race it), and on admission invokes
the Steward directly on `prize_claim`.

The worker is two-step so a twenty-minute check never holds the runner's
other lanes: a tick submits one claim to the checker and returns, and later
ticks poll each check in flight once, landing the first finished one. The
checker's check id has no column; it lives in an in-process map keyed by
prize claim id, and after a restart the worker re-submits each `checking`
row with `force: false`, which the checker dedupes against the record it
already holds, recovering the id without a second run (a retry after a
checker error forces a fresh run instead). Each poll heartbeats the row, so
the reclaim sweep trips only for a dead worker. The same tick carries three
bounded sweeps: a `checked` claim whose Reviewer run was lost is reviewed
again under the reserve; a claim the Audit agent sent back (returned to
`in_review` with its window cleared) is put in front of the Steward again
for a fresh decision, a new decision id, and a new audit; and an
`in_review` claim with no decision after 24 hours is re-invoked, at most
once a day, and listed on the operator page under `in_review_over_24h`.
Before any money trigger runs, the direct invocation resolves the claim's
skills and refuses, loudly, when the trigger's tools (`decide_prize_claim`,
`publish_formalization`, `get_proof_attempt`) are not among them, since a
run without its own tool would decide nothing.

**Six money triggers are invoked directly, never queued.** `formalize`,
`formalization_review`, `prize_claim`, `prize_claim_voided`,
`prize_window_closed`, and `attempt_completed` each call `runClaimSteward`
on `STEWARD_STRONG_MODEL` from the worker that owns the event (the engine
executor for the first two, the prize-check worker, the window closer, and
the solver worker), inside a usage context whose job is the funding job.
The steward queue is bypassed on purpose: it coalesces into a claim's
single pending slot and keeps an existing trigger over a new one, so a
`prize_claim` arriving on a claim already pending reassessment would run as
a reassessment on the standard tier, and a fidelity judgment on a prize
must not depend on which variant won an auction. Production refuses to run
any of them without `STEWARD_STRONG_MODEL`, the trigger is recorded on the
run, and direct invocation means a prize review never waits behind the
steward drain. The served model and whether a fallback ran are recorded on
the decision; the Audit agent treats a fallback-served acceptance as a
send-back.

After the Steward accepts, `requestAudit` is called with a dedupe key that
carries the decision id (a re-acceptance after a send-back must be audited
again), the challenge window opens, and `promotePayable` requires the
window to have closed, an audit outcome without a send-back, and, where the
amount, the importance, or any anomaly requires it, a human sign-off. The
payout itself is mechanical (docs/accounts.md, "Prizes paid in owls").

### Models

Model choice follows the value of the judgment, not a single default:

| Agent | Production model |
|-------|------------------|
| Matcher | DeepSeek V4 Flash (via OpenRouter) |
| Extractor · Contribution Reviewer · Extension Agent | Claude Sonnet 5 |
| Claim Steward · Curator · Dispute Arbitrator · Audit Agent · Grantmaker | Claude Fable 5.1 |
| Solver (`math_solver`) | Claude Fable 5.1 at effort `max` (`SOLVER_MODEL`), fallbacks off |

The Matcher's judgment is narrow ("same proposition?") over candidates it
retrieves itself, so a small model suffices; it is the first agent routed to a
non-Anthropic model. The load-bearing epistemic work
(stewardship, structural adjudication, arbitration, audit) runs on Fable 5.1,
with a server-side fallback to Opus 4.8 so a safety-classifier refusal degrades
gracefully instead of failing the job. Background assessments carry a
standard-model and a strong-model variant on the action ledger, and the
upgrade is bought exactly when its marginal gain justifies its marginal cost
(docs/allocation.md) — so the most capable model is spent where it buys the
most; what goes unfunded is the tail. The exception is the Steward's six money
triggers (`formalize`, `formalization_review`, `prize_claim`,
`prize_claim_voided`, `prize_window_closed`, `attempt_completed`), which
always run on the strong model whatever variant the ledger funded, because
a fidelity judgment with money behind it must not depend on an auction.

### Providers

Every agent talks to a model through five functions in `src/llm/client.ts` —
`complete`, `completeWithTools`, `completeStructured`, `completeStructuredList`,
`toolUseLoop`. Those signatures speak the Anthropic dialect and never change,
so switching an agent to another vendor is one env var and no code change:
`MATCHER_MODEL=gpt-5-nano`, `CURATOR_MODEL=qwen/qwen3-235b-a22b`.

Which backend serves a call is decided by the **shape of the model id**
(`src/llm/providers/routing.ts`, the single source of truth):

| ID shape | Provider | Example |
|----------|----------|---------|
| `claude-…` | Anthropic direct (`@anthropic-ai/sdk`) | `claude-fable-5-1` |
| `gpt-…` or `o<digit>` | OpenAI direct (Responses API) | `gpt-5.6-luna`, `gpt-5-nano` |
| contains `/` | OpenRouter (`vendor/model`) | `qwen/qwen3-235b-a22b` |
| anything else | rejected, at config load AND at call time | `us.anthropic.claude-…` |

Bedrock/Vertex-prefixed ids resolve to nothing and are rejected with a specific
message — they 404 against the Anthropic API (issue #11).

Each adapter in `src/llm/providers/` speaks its own platform's native dialect
rather than a lowest-common-denominator abstraction. Structured output, for
instance, is native `output_config.format` on Anthropic, a strict `json_schema`
`text.format` on OpenAI, and a forced `respond` function call on OpenRouter
(the most portable mechanism across its model zoo). Each provider also carries
its own temperature allowlist, since reasoning models reject sampling params.

**OpenAI direct speaks the Responses API**, not Chat Completions. Chat
Completions was the earlier choice because it maps 1:1 onto the seam's
Anthropic-shaped assistant turn; Responses wins anyway, because it is where
OpenAI's hosted server-side tools (web search, code interpreter) live and where
a reasoning model's chain of thought can be carried across turns of a tool
loop. Every GPT-5 model is a reasoning model, so that second point is not
optional. The adapter is stateless — `store: false`, full history resent every
call, `previous_response_id` never used — which means reasoning only survives a
tool loop if it is round-tripped explicitly: requests ask for
`include: ["reasoning.encrypted_content"]`, and the turn's whole `output` array
(reasoning items with their `encrypted_content`, message items, `function_call`
items) rides back through the seam's provider-opaque `rawContent` and is
replayed verbatim into the next request's `input`, in position, with tool
results appended as `function_call_output` items keyed by `call_id`. OpenRouter
has no equivalent surface for our purposes and keeps the Chat Completions
translation in `providers/openai-dialect.ts`; the dialect-independent helpers
stay shared between the two.

**Anthropic-only, by design:** server tools (`web_search`), container-backed
execution, ephemeral prompt-cache breakpoints, and the server-side Opus refusal
fallback. Routing an agent that uses a server tool — the Claim Steward does — to
a non-Anthropic model fails immediately with a message naming the capability,
rather than silently dropping it. OpenAI's own hosted tools are not wired up
yet, but they are ordinary entries in the Responses `tools` array, so the slot
for them is the one `toResponsesTools` already builds. OpenAI gets automatic
prefix caching with a stable `prompt_cache_key` per agent instead of explicit
breakpoints.

**Metering** stays at one chokepoint regardless of provider. Anthropic and
OpenAI calls are priced from the rate table in `src/llm/pricing.ts`; OpenRouter
reports its own computed cost per call, which overrides the table (no rate table
can cover its zoo). Unknown model ids fall back to the top-tier rate so nothing
ever meters as free. Every usage row records which provider served it.

Missing credentials fail as a clear configuration error at call time, not as an
opaque 401: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (shared with embeddings), and
`OPENROUTER_API_KEY`.
### The long-run loop

The five functions above are the provider-neutral contract every agent
depends on, and they do not change for the solver. The seam has a sixth,
`longRunToolLoop`, which is Anthropic-only by design: streaming (required
at the 128,000-token output ceiling), `effort` up to `max`, a moving cache
breakpoint on the last user message so a hundred-turn loop pays cache-read
rates for its history rather than the full input price every turn,
per-turn hooks (`beforeTurn`, `afterTurn`, `reminder`) through which the
solver's dollar ceiling, wrap-up notice, and kill switches act, and
`fallbacks: "none"`. The history is append-only, which the
preserved-thinking rule requires and a test pins. A second client with an
hour-long timeout serves it, because the default 180-second timeout with
retries would abort and re-issue a fifteen-minute turn several times, each
billable. The adapter reports the served model, whether a fallback ran, and
cache-read and cache-creation tokens on every result; the money decisions
record the first two.


### Workers and failure handling

Ingestion and the governance pipelines ride SQS queues in production and an
in-memory runner locally, with identical handlers. Stewardship is the
exception: it has no message queue at all. A claim's steward-state column
marks it a CANDIDATE (idempotently — a claim re-triggered while already
pending coalesces into one run), the action ledger holds its priced
assess/reassess actions, and the executor runs whatever the allocations on
that ledger cover (docs/allocation.md), claiming work with
`FOR UPDATE SKIP LOCKED` so concurrent workers never collide. Prize checks
and solver attempts are DB-backed jobs with workers of their own, never SQS
messages: a check can run fifteen minutes and an attempt six hours, far past
the queues' visibility timeout.

Failures are classified before they are counted. Transient API errors (rate
limits, server errors, network, exhausted budget) requeue the claim untouched
and do not count as attempts, and a run of consecutive transient failures trips
a circuit breaker that stops the drain rather than poisoning healthy claims.
Only genuine logic errors count toward the retry cap, after which the claim
parks in an error state for inspection. The distinction exists because an
earlier incident parked dozens of production claims over what turned out to be
a billing hiccup.

---

## Persistence

### PostgreSQL, not a graph database

The graph is stored relationally in **PostgreSQL**, accessed through Drizzle
ORM, not in a dedicated graph database. Claims are rows; decomposition is an
adjacency table (`claim_relationships`) whose `argument_id` column attaches
each edge to its line of reasoning; arguments, assessments, instances and
sources are their own tables. A relational store keyed by foreign keys is more
than adequate for the tree-shaped reads the product needs, and it lets the same
engine carry vector search and full-text search without a second system to
operate.

Tree-building (`src/services/tree-service.ts`) walks the relationship table
level by level with a visited set, so each node and edge is fetched exactly
once even where shared subclaims give the DAG a diamond shape. The walk is
bounded by a cap of 500 nodes per response (`MAX_TREE_NODES`); children
dropped by the cap are flagged on their parent (`children_truncated`), never
silently. Each edge's `argument_id`, `argument_name`, `argument_stance`, and
`argument_content` are carried onto the node, so a client can group a claim's
children by argument and render each argument's written form.

### Schema at a glance

```
claims ──< claim_relationships >── claims     (parent / child adjacency)
  │              │
  │              └── argument_id ─▶ arguments ──▶ claims
  │                                    └──▶ argument_evaluations
  │                                         (inference verdicts; one is_current per argument)
  ├──▶ assessments        (verdict history; one is_current per claim)
  ├──▶ claim_instances ──▶ sources   (provenance: quote + context + stance)
  └──▶ contributions ──▶ contribution_reviews ──▶ appeals ──▶ arbitration_results
                              contributors ─┘
```

Around that core sit the account and operations tables: `contributors` doubles
as the account table, `api_keys` holds hashed keys, `llm_usage` meters every
model call, `reputation_events` and `kudos_events` are the append-only score
ledgers, `reconciliation_events` is the Curator's reversible audit log,
`audit_log` is the Steward's append-only decision trail, `audit_runs` and
`audit_findings` are the Audit Agent's run ledger and durable findings (the
run ledger doubles as the dedupe gate for audit triggers), and `jobs` tracks
queued work. Mathematics adds `claim_formalizations` and `lean_checks` (the
formal statements and every check), `proof_attempts` (the solver's runs),
`prize_pools` and `prize_pool_entries` (the per-domain prize fund and its
ledger), `bounties`, `prize_claims`, `prize_payouts`, `attachments`, and
`platform_flags` (operator switches such as `solver_paused`).
### Attachments

Uploaded files (a prize claim's Lean source, documents, and data; a
winner's tax form) live in Postgres, in `attachments`, with `bytea` bodies
keyed by `contribution_id`: `kind` (`lean_source`, `document`, `dataset`,
`code`, `tax_form`), the sanitized filename, a content type determined by
magic bytes against an allowlist rather than from the client's header,
`size_bytes`, `sha256`, `visibility`, and a `storage` discriminator, `db`
today with `s3` and a `storage_key` reserved. Bodies are `restricted` at
submission; a Lean source becomes `public` when the Steward accepts the
claim, because the challenge window needs it, and a rejected source stays
restricted until the bounty closes so a near-miss cannot be patched by a
second account and refiled. Nothing is executed or parsed except the Lean
file inside the checker's sandbox; downloads are served as attachments with
`nosniff` and a sandboxing content-security policy. Postgres is the right
store at v1 volumes because one transaction landing the contribution, the
attachments, and the prize claim is what makes the priority timestamp
meaningful; the S3 path (a bucket, a gateway endpoint, presigned PUT and
GET, a backfill) needs no schema change and is triggered by files over
10 MiB, attachment storage past about 5 GB, or a second region
(docs/infrastructure.md).


### Search: vectors and full text

Postgres carries both retrieval paths the pipeline needs. Each claim has a
1536-dimension `embedding` (a `pgvector` column) for semantic neighbour search
and a `tsvector` column for keyword search. A query runs both recall paths at
once: a claim is a candidate if it matches the keyword query or falls within
embedding range. The two signals are deliberately not blended into one score;
results are ordered by cosine similarity, with keyword rank as a tiebreak, and
keyword matching serves to widen recall. If embedding generation fails, search
degrades to keyword-only. Every path serves only active, unmerged claims. This
hybrid search serves the public search API, the MCP `search_claims` tool, and
the agents' general search tool. The Matcher's candidate retrieval is the
exception: it uses embedding similarity alone, with a deliberately low floor,
and widens recall by re-searching under multiple framings rather than by
keyword rank.

---

## Serving Surfaces

### The API

A Fastify service at `api.claimgraph.io`. Reads are public and unauthenticated:
claim lookup and search, decomposition trees, dependents, assessment history,
contributor profiles. Anything that writes or spends model tokens
(`POST /sources`, `POST /claims/propose`, contributions, appeals, the
extension and MCP endpoints) requires a key. No user surface writes to the
graph directly: proposed claims and submitted sources become pending intake
contributions (HTTP 202) for the Contribution Reviewer, and only direct
service callers — internal seeding — keep the immediate path. Interactive OpenAPI documentation is served at `/docs` on the
API host.

### The web app

This site, a Next.js app at `minerval.ai`. It talks to the API server-side
with a service key, forwarding the signed-in user's identity through an
acting-user header, so browser traffic never carries API credentials.

### The browser extension

The extension analyzes the page you are reading: captured text flows through
the Extractor and Matcher, then the Extension Agent judges each on-page claim
against graph state and the verdicts are anchored as a non-destructive overlay,
with a chat popup grounded in the same graph. Analysis answers immediately when
the page was analyzed before; otherwise it returns a content hash the extension
polls until the pipeline finishes. The work is metered to the user's account,
and the key lives in the extension's background worker, never in the page.

### MCP

A remote MCP server, speaking streamable HTTP at `POST /mcp` on the API host,
exposes the graph to agentic clients under the same accounts and quotas: tools
for searching and reading claims (`search_claims`, `get_claim`,
`get_decomposition`), for the pipeline's judgments (`match_claim`,
`extract_claims`, `assess_text`), and for contributing
(`submit_contribution`, `get_contribution_status`), for the machine-readable
terms of a prize (`get_bounty_terms`), plus claim resources and
fact-checking prompts. Clients authenticate with an API key or via the OAuth
2.1 authorization flow — the API acts as an authorization server for the
`/mcp` resource, handing sign-in and consent to the web app — which is what
lets hosted clients such as Claude.ai connect. Every call is attributed to an
account either way.

---

## Accounts, Keys, and Metering

Users and contributors are the same thing: one account table, one identity.
Sign-in on the web app goes through Auth.js (GitHub or Google); the API never
sees OAuth, only a stable external id of the form `provider:subject`, against
which the account is provisioned on first sign-in.

API keys are prefixed `epk_`, stored only as hashes, shown once at creation,
and scoped `user` or `service`. Every model call in the system is metered at
the LLM client chokepoint: tokens are priced into micro-USD and recorded per
agent, user, and key. Spending runs on the owl economy (docs/accounts.md,
docs/allocation.md): one owl of spend covers a dollar of metered cost,
agentic operations charge a cap that settles to the metered actual, free
signup and monthly grants keep the entry free, and Stripe Checkout sells owl
packs. Rate limits at the API boundary are a runaway backstop; the real
spend guardrail is the owl balance and the escrowed budgets behind mandates.

Three credentials, not two, once money can move. The service key
(`MINERVAL_API_KEY`) is deployed to the web tier and acts for any user
through the acting-user header, so it cannot be the credential that moves
money. Eight routes require an **operator key** (`MINERVAL_OPERATOR_KEY`),
held outside the web deployment and used only from the operator's own
session: the prize-fund deposit (`POST /prize-pools/:domain/deposit`), the
bounty confirmation (`POST /bounties/:id/confirm`), the prize-claim
sign-off (`POST /prize-claims/:id/sign-off`), the void
(`POST /prize-claims/:id/void`), the sanctions screening
(`POST /prize-claims/:id/screening`), the owl grant
(`POST /prize-claims/:id/pay`), the release of a `check_error` hold
(`POST /prize-claims/:id/retry-check`), and the operator page
(`GET /operator/prizes`). Three routes act for a winner and require both
the dashboard session and a one-time code bound to the claim, the account,
and the purpose (issued to the owner's session by
`POST /prize-claims/:id/code`; email delivery is a transport change): the
payee step (`POST /prize-claims/:id/payee`), the tax form
(`POST /prize-claims/:id/attachments`), and the withdrawal of a claim
(`POST /prize-claims/:id/withdraw`), so a leaked consumer or service key
alone can neither redirect a prize nor abandon a winning claim. Every call
to a writing route among these is written to `audit_log` on the claim with
the credential kind and the acting person; the deposit, which has no
claim, is appended to the `prize_fund_deposits` platform flag instead. The
service key alone moves no money.

---

## Deployment

The API runs as a container on ECS Fargate behind an application load balancer
at `api.claimgraph.io`, with RDS PostgreSQL (pgvector) and SQS, all provisioned
by CDK; a push to main deploys after typecheck and tests, and migrations run at
container start. The web app deploys separately to Vercel at `minerval.ai`.
Local development uses docker-compose Postgres and the in-memory queue runner,
so the whole pipeline runs on a laptop with no AWS dependencies. The Lean
checker is a separate stack with a security group that reaches nothing, and
the solver worker is a second ECS service; both are described in
docs/infrastructure.md.

---

## Evaluation

The pipeline is graded against fixed corpora, not eyeballed. A harness runs the
real application (real routes, real workers, drained to quiescence) over
curated clusters of source documents and records every agent message. An LLM
judge, deliberately a different model from the agent under test, then scores
the assessed claims against the constitution on axes like readability,
reasoning fit, impartiality, and decomposition granularity. Runs are compared
release over release, so prompt and model changes are judged by what they do to
the graph, not by how they read.

---

The operational policies that follow turn the constitution's principles into
concrete, per-agent rules: the shared policy vocabulary every governance
decision cites, the acceptance criteria the Contribution Reviewer applies, and
the reasoning obligations every agent carries.
