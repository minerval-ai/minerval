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
Fable 5. Any agent can be pointed at OpenAI or OpenRouter instead with a
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
causal, and normative claims are all represented the same way and all decompose
into subclaims. Two formulations are the *same* claim when they turn on the
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

Importance is a 0 to 1 judgment of consequence-if-wrong times contestability.
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
splice in the relevant operational policies). The assembled prompt is sent as a
single cached block, so the constitution is paid for once per agent rather than
once per call. The prompts live in `src/llm/prompts/` and are vendored verbatim
into this site (see the [agents](/docs/agents) page).

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
  or a staleness check. Effort scales with importance; consequential or
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

### Models

Model choice follows the value of the judgment, not a single default:

| Agent | Production model |
|-------|------------------|
| Matcher | DeepSeek V4 Flash (via OpenRouter) |
| Extractor · Contribution Reviewer · Extension Agent | Claude Sonnet 5 |
| Claim Steward · Curator · Dispute Arbitrator · Audit Agent · Grantmaker | Claude Fable 5 |

The Matcher's judgment is narrow ("same proposition?") over candidates it
retrieves itself, so a small model suffices; it is the first agent routed to a
non-Anthropic model. The load-bearing epistemic work
(stewardship, structural adjudication, arbitration, audit) runs on Fable 5,
with a server-side fallback to Opus 4.8 so a safety-classifier refusal degrades
gracefully instead of failing the job. Background assessments carry a
standard-model and a strong-model variant on the action ledger, and the
upgrade is bought exactly when its marginal gain justifies its marginal cost
(docs/allocation.md) — so the most capable model is spent where it buys the
most; what goes unfunded is the tail.

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
| `claude-…` | Anthropic direct (`@anthropic-ai/sdk`) | `claude-fable-5` |
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

### Workers and failure handling

Ingestion and the governance pipelines ride SQS queues in production and an
in-memory runner locally, with identical handlers. Stewardship is the
exception: it has no message queue at all. A claim's steward-state column
marks it a CANDIDATE (idempotently — a claim re-triggered while already
pending coalesces into one run), the action ledger holds its priced
assess/reassess actions, and the executor runs whatever the allocations on
that ledger cover (docs/allocation.md), claiming work with
`FOR UPDATE SKIP LOCKED` so concurrent workers never collide.

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
queued work.

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
(`submit_contribution`, `get_contribution_status`), plus claim resources and
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

---

## Deployment

The API runs as a container on ECS Fargate behind an application load balancer
at `api.claimgraph.io`, with RDS PostgreSQL (pgvector) and SQS, all provisioned
by CDK; a push to main deploys after typecheck and tests, and migrations run at
container start. The web app deploys separately to Vercel at `minerval.ai`.
Local development uses docker-compose Postgres and the in-memory queue runner,
so the whole pipeline runs on a laptop with no AWS dependencies.

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
