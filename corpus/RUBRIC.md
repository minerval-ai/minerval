# Ingestion Review Rubric

A distillation of the [Admin Constitution](../admin_constitution.md), [Policies](../docs/policies.md),
and the agent prompts into a set of standards for judging what comes out of a corpus run.

**This rubric is a lens, not a checklist, and explicitly not exhaustive.** For the early iterations the
standard is qualitative judgment against the constitution, not pass/fail on specific claims. The dimensions
below are the *known* things to look at; the most valuable observations will often be failure modes nobody
anticipated. Section H exists to capture those. When a new failure mode recurs, promote it into a named
item here so the next reviewer looks for it.

Scope: a corpus run drives the agent organization to a stable state — Extract → Match → Decompose →
Assess, plus the **stewardship propagation** those assessments trigger (section G). It does **not** yet
exercise community **contributions, conflict review, escalation, or arbitration**: those are driven by
contributions submitted through the API, which a corpus ingest does not generate. A separate contributions
scenario is needed to test that half of the organization (see section G and the README).

How to use it: read the run report top to bottom with these dimensions in mind. Each dimension gives the
**standard** (with citations), the **failure modes** to watch for, and **where in the report** to look.

---

## A. Extraction — what got pulled out of the document

**Standard.** Extract *all* substantive claims, faithfully and charitably, across every claim type.
Questions, commands, meta-text, stipulative definitions, and hedged non-assertions are not claims.
(Constitution §2, §4, §8; Policy 2, 3; Extractor prompt.)

**Failure modes.**
- **Under-extraction** — misses substantive claims, especially implicit assumptions and background factual
  claims the author treats as given. Claims are scarce relative to text (§2), but the propositions the
  document actually turns on must still surface; a missed central contested proposition is a red flag.
- **Over-extraction** — pulls meta-text ("in this post I'll argue…"), rhetorical questions, or hedged
  non-assertions as if they were claims; or inventories background facts the document merely leans on
  rather than the propositions it turns on.
- **Type skew** — extracts only empirical claims and drops normative/evaluative/causal ones. This violates
  uniform treatment (§8) and quietly biases the whole graph toward "facts."
- **Fidelity loss** — `original_text` is paraphrased rather than an exact quote, breaking provenance (§4).
- **Granularity drift** — one claim shattered into fragments, or several distinct claims fused into one
  `original_text` span.

**Where to look.** The per-source extraction counts; the list of `original_text` → `proposed_canonical_form`
pairs for a couple of posts you've read.

---

## B. Canonical form quality — how claims were normalized

**Standard.** The canonical form is the shortest neutral statement of the proposition as it is actually
debated: about fifteen words, rarely more than twenty-five, terse and frame-independent, self-contained,
and meaning-preserving. State the proposition at the precision the discourse debates it; do not sharpen it
with parameters the author never committed to, and do not mint placeholders for missing ones — the vague
proposition is the claim. (Constitution §3, §2; Policy 2; Extractor prompt.)

**Failure modes.**
- **Frame-bound restatement** — canonical form keeps one author's framing, hedges, or dialectical setup
  instead of the neutral statement both sides would accept. This is the most common quiet failure, and it
  directly degrades matching.
- **Hallucinated specificity** — invents thresholds, dates, or numbers not in the source. Violates
  faithfulness; worse than vagueness because it's confidently wrong.
- **Context-stripping** — the canonical form is self-contained but lost the meaning by dropping essential
  context (e.g. which AI system, whose definition of "alignment").
- **Inconsistent canonicalization** — the same proposition is normalized differently in different documents.
  This is the upstream cause of most matching failures in C, so watch for it there too.

**Where to look.** The canonical forms in the per-claim listing; compare canonical forms of claims you
*know* are the same proposition across posts.

---

## C. Matching / canonicalization / dedup — **the core test**

This is the dimension the corpus is built to stress. **All claim identity — top-level and subclaim —
is decided by the single agentic Matcher** (`src/llm/agents/matcher.ts`): top-level claims reach it via
`url-extraction.ts`, subclaims via the Steward's `match_claim` tool. Embedding similarity is retrieval,
not decision — each search returns the top `MATCHING_TOP_K` candidates (default 20) above a deliberately
low 0.4 cosine floor, and the Matcher LLM makes the match-vs-new call with reasoning, after searching
multiple framings including the negation. The two entry paths can still fail differently (the Steward
decides *when* to consult the Matcher for subclaims), so attribute a failure to the right stage.

**Standard.** Two formulations are the same claim when they turn on the same considerations: nothing could
count as evidence or argument bearing on one without bearing equally on the other. Identical decomposition
is a useful diagnostic, not the definition. A claim and its denial are one node, with each source recorded
as affirming or denying it. When unsure, create both and map the relationship — liberal creation, rigorous
mapping, conservative merging. (Constitution §2, §3, §5; Policy 4; Matcher prompt.)

**Failure modes.**
- **Over-merging (the worst failure).** Collapsing claims that turn on different considerations into one
  canonical node — e.g. "AGI will kill everyone" merged with "AGI poses serious catastrophic risk." This
  silently *destroys the disagreement the system exists to surface* (§1 clarity, §18 fair representation,
  §2 individuation). A claim and its denial are correctly one node, but only with the stance recorded —
  check that a negation the Matcher absorbs into an existing node carries the flipped stance.
- **Fragmentation / under-merging.** The same proposition, stated across several posts, ends up as multiple
  canonical claims because canonical forms diverged (see B) or embeddings fell below threshold. This defeats
  the core scaling premise that redundant claims collapse to one node (README). Watch the
  near-duplicate-canonical-pairs section.
- **Retrieval artifacts.** A miss caused by retrieval never surfacing the candidate (outside the top
  `MATCHING_TOP_K`, or below the 0.4 floor) rather than by the Matcher judging it and deciding wrongly.
  If a match decision hinges on whether the candidate was retrieved rather than on the meaning, flag it —
  the fix is retrieval tuning or canonical-form quality (B), not the Matcher prompt.
- **Order sensitivity.** Matching is stateful — the first phrasing ingested becomes the canonical node and
  later phrasings attach to it. Check that the "winning" canonical form is a good one and not an artifact of
  which post happened to be processed first.
- **Relationship neglect.** When two top-level claims are correctly kept separate but are related
  (specification, contradiction), the ingestion path creates **no relationship** between them — edges come
  from the Steward's decomposition and the Curator's sweeps. So related-but-distinct claims from different
  posts can sit as disconnected islands. That's "liberal creation" without the "rigorous mapping" half
  (§2). Note where it happens.

**Where to look.** Per-canonical-claim instance lists (what got collapsed, and whether it should have);
the near-duplicate-canonical-pairs section (fragmentation candidates); the Matcher reasoning traces for any
merge that surprises you.

---

## D. Decomposition — the dependency structure

**Standard.** *Neutral* decomposition: identify what a claim depends on, don't evaluate it. Decompose until
reaching genuine bedrock (bedrock fact / contested empirical / value premise). Surface definitional
subclaims (DEFINES) and hidden assumptions (ASSUMES). Include both supporting and contradicting
dependencies. Group distinct lines of reasoning into named arguments; don't manufacture arguments for simple
claims. Don't add subclaims that aren't logically necessary. (Constitution §6, §7; Policy 2; Steward prompt —
decomposition and assessment are one judgment owned by the Claim Steward, Part VIII.)

**Failure modes.**
- **Shallow decomposition** — stops early, marks a clearly compound claim atomic.
- **Runaway / filler decomposition** — generates generic boilerplate subclaims, or keeps splitting without
  ever reaching real bedrock. There is no fixed depth cap; the brake is economic (§19): subclaims below the
  importance threshold (`STEWARD_ENQUEUE_MIN_IMPORTANCE`) stay embedded stubs rather than being enqueued
  for their own stewardship, so watch for depth achieved by inflating subclaim importance.
- **Evaluation leakage** — decomposition judges validity instead of structure ("this subclaim is false…"),
  violating neutral decomposition. (The Steward does assess, but in the assessment — the decomposition
  itself stays neutral, §6.)
- **Missing definitional / assumption subclaims** — fails to surface what load-bearing terms mean
  ("aligned," "AGI," "sharp left turn"). These are exactly the hidden disagreements §6 wants exposed.
- **Argument structure misuse** — dumps everything into one default argument when distinct for/against lines
  exist, or invents named arguments for a simple claim.
- **Non-reconnecting subclaims** — subclaims phrased so idiosyncratically that the same underlying dependency
  never matches across parents, so no structure is shared (feeds into E).

**Where to look.** The decomposition trees; subclaim relation-type distribution; argument groupings; the
atomic_type tags on leaves.

---

## E. Cross-document graph structure — the scaling test

**Standard.** Redundancy should collapse and structure should be shared: claims that recur across posts
become one node, common dependencies become shared subclaims, and related/opposing positions are connected,
not siloed. The admin thinks at graph level — upstream, downstream, lateral. (README "why this is tractable";
Constitution §19, §21.)

**Failure modes.**
- **Per-document silos** — each post produces its own disconnected tree with no shared nodes, even where the
  posts plainly engage the same claims. The single strongest sign that scaling isn't working.
- **Shared-subclaim drought** — few or no subclaims with more than one parent across the corpus, despite
  heavy topical overlap.
- **Duplicate canonical nodes at scale** — the fragmentation from C, seen in aggregate.
- **Unrepresented contradiction** — posts that directly disagree (this corpus is built around a disagreement)
  produce no CONTRADICTS edges or contested structure linking the opposing claims.

**Where to look.** Shared-subclaim section; total canonical claims vs total instances (dedup ratio);
the cross-post relationship summary.

---

## F. Assessment — status and reasoning

Secondary for a disambiguation-focused run, but it runs, so sanity-check it.

**Standard.** Use the six statuses honestly (Verified, Supported, Contested, Unsupported, Contradicted,
Unknown); never round a genuinely contested claim up to verified or down to contradicted; every assessment
carries a substantive reasoning trace; assessment is holistic judgment, not mechanical aggregation.
(Constitution §1, §9, §10, §11, §22; Policy 1, 7, 8; architecture doc, "Judgment-based propagation".)

**Failure modes.**
- **Status collapse** — nearly everything lands on one status (all `contested`, or all `unknown`).
- **False resolution** — a genuinely contested AI-risk claim marked `verified` / `contradicted` (§1).
- **Empty reasoning traces** — boilerplate or missing traces (violates §11); note that the pipeline swallows
  assessment errors silently, so a missing assessment is itself worth flagging.
- **Confidence miscalibration** — high confidence on claims the trace doesn't actually support.

**Where to look.** Status distribution; a few full reasoning traces; claims left with no current assessment.

---

## G. Stewardship & propagation — the organization settling

**Standard.** Ingestion doesn't stop at the first assessment. When a parent claim is (re)assessed, the
**Claim Steward** is invoked to decide — by judgment, not mechanical rule — whether the change is material
enough to propagate to dependent claims, and to maintain canonical forms, arguments, and merge/split
proposals. Propagation should be **self-limiting**: most changes absorb within one or two levels, because
superior claims are not the locus for disputes about their subclaims. The run drains the steward queue (and
anything it triggers) to quiescence; this dimension judges whether that settling behaves well.
(Constitution §5, §19, §22; Policy: Claim Steward; architecture doc, "Judgment-based propagation".)

**Failure modes.**
- **Non-termination / runaway propagation** — stewardship keeps enqueuing more stewardship work and the
  run hits the safety cap instead of reaching quiescence (the run log prints `CAPPED`). A sign propagation
  isn't self-limiting.
- **Infectious contestation** — a single contested subclaim deep in the graph propagates upward and flips
  many ancestors to `contested`, exactly the failure the architecture doc's "Judgment-based propagation"
  section warns about. Watch the assessment distribution before vs. after the steward pass.
- **Inert steward** — the steward runs but never changes anything (no reassessments, no canonical-form
  edits, no merge proposals) across the whole corpus, suggesting it's a no-op rather than exercising
  judgment.
- **Spurious merges/splits** — steward-proposed merges that collapse genuinely distinct claims, or splits
  that fragment a good canonical claim (rubric C failure modes, but steward-initiated).
- **Handler errors** — steward invocations erroring out (the run log reports `handler errors`); since the
  pipeline swallows assessment errors, a steward that silently fails leaves propagation half-done.

**Where to look.** The per-post `agents:` line in the run log (how much steward/arbitration/audit work
fired, whether it `CAPPED`); the assessment-status distribution (section 7); claims whose assessment or
canonical form changed after their instances were first created.

> **Conflict, escalation, arbitration** are part of this organization but are **not exercised by ingestion**
> — they require contributions submitted via the API. Until a contributions scenario exists, treat their
> absence in a run as expected, not as a pass. The **audit** agent (#180) runs in production via
> `requestAudit` — scheduled sweeps, arbitration overturns, bad-faith flags, suspension reviews — but none
> of those triggers fire during a corpus ingest (the sweep scheduler starts only with the full server), so
> an empty audit queue in a run is likewise expected.

## H. Cross-cutting properties

Applies to every stage above.

- **Faithfulness / no hallucination** — nothing in any canonical form, subclaim, or trace that isn't grounded
  in the source. The single most important cross-cutting check.
- **Neutrality (§17)** — this corpus is politically/ideologically loaded (AI risk). Are canonical forms and
  decompositions tilted toward either doom or dismissal? The framing should be even-handed.
- **Charity (§4, §18)** — claims and arguments rendered in their strongest defensible form, not strawmanned.
- **Consistency (§21)** — similar claims treated similarly across the corpus (similar decomposition depth,
  similar canonicalization style, similar assessment).

---

## I. Field notes — emergent and unforeseen behaviors

**The point of this section.** The dimensions above are what we currently know to look for. The system will
do things we didn't predict. When you see behavior that feels wrong — even if it maps to none of A–G, even if
you can't yet articulate why — record it here. Don't force it into an existing category prematurely.

For each observation, note: what you saw, which run, and (if you can) a guess at which stage produced it.
When the same behavior shows up across runs, promote it to a named failure mode in the relevant section
above so it stops being a surprise.

> _(log observations below)_

**Run 2026-06-21, AGI Ruin only (caps 5/depth 1/3):**

- **[fixed] Governance layer 404'd on every call.** Steward fired 5×, all failed instantly with
  `404 not_found_error: model: us.anthropic.claude-sonnet-4-20250514` — stale Bedrock model IDs in the
  governance/arbitration/second-opinion config defaults, invalid for the Anthropic API. The whole governance
  layer (steward, audit, arbitrator, contribution-reviewer) was non-functional. Fixed by switching the
  defaults to Anthropic IDs. Stage: governance agents.
- **[fixed] Relation-type casing fragmented the taxonomy.** Decomposer emitted both `REQUIRES` (7) and
  `requires` (3), `SUPPORTS`, etc. — same relations stored as distinct strings. Now normalized to lowercase
  on write. Stage: decomposer → claim-pipeline.
- **[open — calibration] Assessment over-uses "contested" on near-bedrock claims.** 13/18 claims contested,
  including definitional/mechanical ones like "outer optimization selects parameters that minimize loss on
  training data" and the DEFINES claim "'capabilities' refers to task-performance competence." These read as
  bedrock/definitional, not genuinely contested. Early sign of the infectious-contestation risk
  (architecture doc, "Judgment-based propagation") at the leaf level. Watch across runs; likely an
  assessor-prompt calibration issue (rubric F). Stage: assessor. _(Persisted in the 2-post run: 25/32 contested.)_

**Run 2026-06-21, AGI Ruin + Christiano response (caps 5/depth 1/3, governance fixed):**

- **[open] No cross-document canonicalization — but mostly a cap artifact.** dedup ratio 1.00, 0 shared
  subclaims across 2 posts. Each post's 5 extracted claims are genuinely different propositions: Christiano's
  *response* makes meta-claims (Eliezer overconfident, pivotal-act misguided, alignment-difficulty unknown)
  rather than restating Yudkowsky's claims, and his engagements with Yudkowsky's specific claims were
  deprioritized by EXTRACTION_MAX_CLAIMS=5. The disambiguation test is suppressed by the tight cap — raise it
  to actually exercise cross-doc merging. Stage: extractor cap + matcher.
- **[revised — not a dedup miss] Apparent "duplicate" subclaims are all parent↔child pairs.** On closer
  analysis every unmerged pair at cosine ≥ 0.82 is an extractor claim and one of its OWN decomposer
  subclaims, connected by an edge — i.e. principled "related, not the same claim," correctly represented as
  a relationship rather than merged (and `excludeId` correctly stops a subclaim merging into its own parent).
  There were NO independent high-similarity pairs left unmerged. The earlier "weak subclaim reuse" read was
  an artifact of reading truncated tree text; id-level analysis does not support it. **The genuine
  cross-document dedup question was never exercised** (the cap made the two posts' top claims different), so
  there is still no evidence either way on whether the matcher misses true cross-doc duplicates — needs the
  higher-cap run.
- **[open — decomposition quality] Degenerate (circular) decomposition.** The one ≥ 0.9 pair (0.905) is a
  subclaim that nearly verbatim restates its parent ("The claim that X does not entail Y" → "The proposition
  X does not logically entail Y"), linked `requires`. The decomposer echoed the parent instead of breaking it
  into something more basic. Stage: decomposer.
- **[open — argument layer] Arguments mostly grouped, but some empty and some blur into claims.** 19/24
  arguments group ≥1 subclaim (21/30 edges carry an argument_id); 5 arguments group nothing (floating
  labels). Argument *descriptions* are themselves propositions ("Misalignment at existential capability
  levels produces human extinction"), which blurs the constitution's structural-not-epistemic line for
  arguments. Stage: decomposer.
- **[bug] Steward-created claims are orphaned.** The steward created 1 claim via its decomposition-edge tool;
  it's stuck `decomposition_status=pending`, never enqueued for decomposition/assessment. Stage: steward
  tools (no enqueueClaimPipeline on claim creation).
- **[watch] Steward reassessed nothing.** 8 steward invocations, 0 assessment changes (all still
  `pipeline_assessment`). Could be correct self-limiting propagation (§22) or an under-active steward —
  distinguish on a run where a subclaim genuinely flips. Stage: steward.
- **[MAJOR — over-elaborated canonical forms defeat cross-document matching].** Two posts in direct dialogue
  (Christiano responding to Yudkowsky) produced **two fully disconnected islands**: 0 edges between them, and
  the closest cross-post claim pair is only 0.672 cosine — below the 0.8 retrieval threshold, so the matcher
  never even evaluated a link. The two "first critical try" claims (Christiano explicitly rebutting
  Yudkowsky) sit at 0.567. Root cause: canonical forms average **36 words (max 61)**; each bakes in one
  author's full framing, so two authors discussing the SAME underlying claim produce divergent paragraph-long
  propositions that embed far apart. The §16 "make all parameters explicit" guidance, taken to the extreme by
  the extractor, is destroying the matchability that canonicalization exists to provide. This is the
  dominant, fixable cause of the zero cross-doc overlap (alongside the cap and the fact that some of
  Christiano's claims are genuinely distinct meta-claims that should be *linked*, not merged). Likely fix:
  tighten canonical-form generation (concise + explicit parameters, not run-on) and surface the shared
  underlying claim, not just each author's framing. Stage: extractor prompt / canonical-form guidance.
