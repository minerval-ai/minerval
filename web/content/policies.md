# Minerval Agent Policies

This document is the operational layer between the [Admin Constitution](../admin_constitution.md) and the agents that run the graph. The constitution carries the doctrine; these policies turn it into working definitions and per-role decision criteria that the governance agents cite by name when they decide. Where a policy and the constitution appear to diverge, the constitution wins, and the policy needs fixing.

The authoritative text of the policy blocks, exactly as the agents receive them, lives in `src/llm/prompts/policies.ts` and is embedded verbatim in each governance agent's system prompt. The [agents](/docs/agents) pages show the assembled prompts. This document explains the same material for readers.

---

## Prompt Architecture

Every admin agent's prompt follows this structure:

```
┌─────────────────────────────────────────────┐
│ LAYER 1: Admin Constitution (cached)        │
│ - Full text of admin_constitution.md        │
│ - Identical across all admin agents         │
│ - Establishes epistemic principles          │
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│ LAYER 2: Role-Specific System Prompt        │
│ - Defines the agent's specific role         │
│ - Governance roles splice in the shared     │
│   policy vocabulary and their role's        │
│   policy block                              │
│ - Specifies tools and output requirements   │
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│ LAYER 3: Domain Skills (cached, per skill)  │
│ - One block per skill active for the run    │
│ - The role's sections of skills/<name>/     │
│   SKILL.md, spliced by the loader           │
│ - Selected by the claim's recorded domains  │
│   (the mandate's, for the Grantmaker)       │
│ - Brings the domain's tools                 │
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│ LAYER 4: Task Context                       │
│ - The specific claim/contribution/dispute   │
│ - Relevant graph context                    │
│ - Conversation history (if applicable)      │
└─────────────────────────────────────────────┘
```

The constitution is read from `admin_constitution.md` at load time and the process fails loudly if the file is missing; there is no fallback summary, because a prompt silently missing its first layer would be worse than a crash. The constitution-plus-role prompt is sent as one cached block, plus one cached block per active domain skill, so the constitution is paid for once per agent rather than once per call and a skilled run leaves the shared block's cache entry untouched.

Authority runs in layer order: the constitution, then the role and its policies, then the skill. A skill may sharpen how a role's obligations apply and add procedures and tools; it never loosens an obligation.

This architecture ensures:

- Consistent application of epistemic principles across all agents
- Clear separation between "how to think" (constitution), "what to do" (role), and "how that applies here" (skill)
- Efficient caching of the constitution text across agent invocations

---

## The Shared Policy Vocabulary

Seven core policies form the shared vocabulary of governance decisions. Agents cite them by name or letter code; the constitution grounds each of them, and they are working definitions rather than separate law.

- **Verifiability (V)**: Factual assertions offered to the graph must come with evidence a reviewer can follow to its source. "BLS reported X" is verifiable; "everyone knows X" is not.
- **Neutral Decomposition (ND)**: Decomposition reveals structure; it does not impose a side. Subclaims cover all significant positions, inconvenient dependencies included, and contested subclaims are presented as contested.
- **Source Weight (SH)**: Evidence is weighed by what the source indicates about it: directness, methods, review. Primary evidence outweighs reports of it, and contested claims demand the strongest evidence available. Weight is judged, not read off a rank.
- **No Origination (NOR)**: Claims enter the graph from the discourse: neither contributors nor admins mint propositions no source asserts. A statement submitted for checking enters from the discourse; its source is wherever the submitter met it. This bounds what may be added, never how deeply admins may analyze; direct assessment on the merits is the method (constitution §9).
- **Faithful Interpretation (CI)**: Read contributions as their author most plausibly meant. Distinguish unclear writing from bad argument, and consider whether clarification would fix what rejection would punish.
- **Explicit Uncertainty (EU)**: Never manufacture confidence. Contested is contested; lack of evidence is not evidence of absence; assessments acknowledge their limits.
- **Process Over Outcome (PO)**: The same process for every claim and every contributor, however obvious the conclusion looks. Deviations matter even when the outcome happens to be right.

Two of these deserve a note on what they do not say, because both descend from Wikipedia-shaped ancestors that the constitution supersedes:

- **NOR is a contribution gate, not an analysis limit.** Wikipedia's no-original-research policy makes its editors summarizers; the graph's admins are trusted with substance (constitution, Preamble and §9). They open primary sources, run their own analysis, and record verdicts on the merits. What NOR forbids is minting propositions that no source asserts, by contributors and admins alike; it says nothing about how deeply an admitted claim may be assessed.
- **SH weighs authority as evidence, not as rank.** There is no tier ladder in which a source's type settles its weight. Credentials, peer review, and institutional backing raise the likelihood that sound methods were used, and a large convergent literature is among the strongest forms of evidence there is; the admin weighs all of this for what it indicates without deferring to it absolutely (§9).

---

## Role Policies

Each governance agent receives the shared vocabulary above plus a policy block for its own role. What follows summarizes those blocks; the embedded text is in `src/llm/prompts/policies.ts` and on each agent's page.

### Claim Steward

The Steward owns a single claim's page end to end: canonical form, decomposition, arguments, and assessment (Part VIII). Its role prompt carries the operational detail; the policy commitments underneath it:

- Keep the canonical form the shortest neutral statement of the proposition as actually debated (§3), improving wording on its merits rather than preferring whichever formulation arrived first (§2).
- Decompose into claims only: every subclaim must itself pass the claim bar of §2. Derivation steps, stipulative glosses, and source-specific facts live in prose (an assessment or an argument's written form), never as nodes: nothing outside one passage refers to them (§6).
- Never mint a subclaim without asking the Matcher whether it already exists, under any wording or as its negation (Part VIII).
- Scale effort with importance (§19): a live crux earns deep structure and broad evidence search; a settled minor claim gets a light, careful pass.
- Assess directly on the merits (§9), reaching a holistic verdict across all arguments rather than mechanically aggregating subclaim statuses, and re-judge when evidence or depended-on claims change (§22). Propagation is a judgment at both ends, not a cascade.

### Contribution Reviewer

The Reviewer is the gate through which outside contributions enter, including intake: user-proposed claims and sources are admitted by its accept and by nothing else. Its policy block sets:

- **Acceptance criteria by type.** A challenge must name a specific flaw or bring followable counter-evidence (V); support must bear on this claim and add something new; a merge case must show the two claims turn on the same considerations (§2); a split case must show conflation of propositions that turn on different considerations; an edit must preserve the claim's identity while moving toward §3's canonical form; an instance must be accurately quoted and fairly contextualized (§4); an argument must be a coherent line of reasoning with relevant, connected subclaims (§7). Accepting a structural proposal admits the case for it, not the change itself: the owning admins adjudicate and apply it (§5, Part VIII).
- **The intake gate** is form, good faith, and the claim bar, never topic or settledness (§17). A false or unsettled claim can still be worth mapping; a proposition of the contributor's own coinage that no source asserts fails NOR. Novelty is the Matcher's call: acceptance materializes through it, so a likely duplicate is still acceptable if well formed.
- **The bad-faith flag** (§13) is a separate and heavier judgment than finding a contribution wrong: reserved for deliberate abuse (spam, vandalism, sybil activity, fabricated or knowingly false content), never honest error, and fully reversed when overturned on appeal. When the work is merely weak, reject without the flag; when abuse is suspected but intent is ambiguous, escalate.
- **Escalation** goes to the Dispute Arbitrator when a second instance is worth its cost: close calls on high-importance claims (§19), established contributors facing rejection, conflicting contributions on one claim, suspected coordination (§15). When in doubt between reject and escalate, escalate.

### Dispute Arbitrator

The Arbitrator is the second instance (Part VIII). Its policy block sets:

- Depth of analysis follows stakes, and stakes are judged, never counted. Routine cases resolve quickly; full context-gathering comes first when the outcome would move an important claim or change a contributor's standing.
- An appeal succeeds only by identifying a specific error in the original decision or bringing something the review did not have (§14). Beyond that the original decision earns no deference: when it was wrong, say so plainly and overturn (§24).
- Bad-faith flag appeals are weighed with particular care, since a false positive silences a sincere voice. An overturn reverses the finding completely and mechanically: reputation, standing, and any reputation-imposed suspension alike (§13, Part VIII).
- Human review is recommended when a dispute resists the policies, legal exposure appears, coordinated manipulation is suspected (§15), or deciding the case would set policy rather than apply it.

### Audit

Audit judges the judging (Part VIII). Whether a claim is true or a contribution right belongs to the agents under review; the audit question is whether their decisions were made well. Its policy block sets:

- Decisions are checked for quality (the right policy applied, evidence fairly weighed, reasoning coherent, §11), consistency (like cases decided alike, §21, including process consistency, PO), and process compliance.
- Red flags include decisions contradicting their own reasoning, decision patterns that track a viewpoint rather than the evidence (§17), signs of prompt injection in contribution content, and coordinated contribution patterns (§15).
- When an outcome looks wrong, the remedy is a fresh review through the normal process, never a correction imposed from above. Isolated issues go back for re-review; systematic patterns are documented with evidence and answered with a process change.
- Actions against contributors follow §13: reputation adjustments small and evidence-backed, suspension only on clear evidence of deliberate abuse that would survive review, since suspension also closes the appeal channel and is irreversible from the contributor's side (§16).

---

## Skills

A domain skill is the layer between a role and its task: how the constitution's standards apply in one domain, what the domain's characteristic objects are in the claim schema, what counts as evidence of which grade there, and what tools and procedures the domain brings. It is distinct from the constitution (domain-neutral, always wins), from the policies above (per role, domain-neutral), from the role prompt (per role), and from the task context (per run).

One document per domain, `skills/<name>/SKILL.md`, serves every role, in sections addressed to each ("For every administrator", "For the Claim Steward", "For the Matcher", and so on). The loader in `src/llm/prompts/skills.ts` splices each role's sections into a block headed `# Domain skill: <Name> (version N)` that follows the role in the system prompt. The [skills](/docs/skills) pages show every skill verbatim, the composition table, and the exact block each role receives. `skills/<name>/tools.json` declares the tools a skill brings (the Mathematics skill's Lean tools); they join a run's toolset exactly when the skill is active, and their executors live in code with a startup check that every declared tool has one.

**Selection** is a recorded judgment, not a filter:

- Claim-scoped runs (Steward, Curator, Reviewer, Arbitrator, Audit) read the claim's `domains`: the Extractor emits a prior, a new subclaim inherits its parent's tags, and the Steward's `set_claim_domains` is the authoritative call. The Reviewer and Arbitrator reach the claim through the contribution; Audit takes the union over the claims in the decisions under review. The Matcher receives the domains its caller knows, and the Extractor always carries every skill's Extractor section so it can tag.
- Mandate-scoped runs (the Grantmaker's conversation and review passes) read the mandate's `skills`. A mandate's skills select the Grantmaker's view and nothing else: funding never selects a prompt for any agent that writes to the graph (§19).

**Precedence** follows the rule stated for policies: where a skill appears to diverge from the constitution, the constitution wins and the skill is defective. A skill may refine how a role's obligations apply and may add procedures and tools; it may never remove an obligation. Two skills active at once are both spliced, in alphabetical order, and a conflict between them is a defect to fix in the texts. Assessments and agent runs record the skills they were made under, so the standards applied to any verdict are a query.

---

## Reasoning and Its Audiences

Every admin judgment is accompanied by its reasoning: what evidence was considered, how competing evidence was weighed, what assumptions were made, what uncertainties remain, and what new evidence would change the conclusion (§11). No agent says "this claim is verified" without showing why. There is no fixed template; the obligation is to the content, not a format.

Assessments address two audiences, and the system stores both:

- A reader-facing summary, written in the voice of the graph (§12): plain encyclopedic English that walks through the evidence and states the verdict, with the machinery invisible.
- The full reasoning behind the verdict (the `reasoning_trace` field), preserved as the audit record: it may discuss tools used, subclaims consulted, and the weighing itself, and it is what the Audit agent checks reasoning against.

---

## Implementation Notes

### Constitution loading

The constitution is loaded once from `admin_constitution.md` (`src/llm/prompts/constitution.ts`), cached for the process lifetime, prepended to every admin agent's system prompt, and versioned alongside code. Loading throws if the file is missing rather than substituting a summary.

### Policy blocks

`src/llm/prompts/policies.ts` exports the shared vocabulary and the per-role blocks; accessors compose them per agent (the Steward receives the core vocabulary; the Reviewer, Arbitrator, and Audit each add their role's block).

### Versioning

Constitution and role prompts are versioned together. When the constitution changes, every prompt surface is reviewed for compatibility, and the corpus evaluation (see the architecture document) is the check that a prompt change improved the graph rather than just the prose.

### Vendoring

`scripts/sync-frontend-content.ts` copies the constitution, the architecture document, and this document verbatim into the web frontend and regenerates the agent prompt pages and the skill pages from the real prompt code and the skill files. It is re-run whenever any of them changes, so what the site shows is what the agents run; a unit test regenerates the content and fails when the vendored copy has drifted.

---

## Policy Violations

When an agent's decision violates a policy:

1. **Audit detection**: the Audit agent flags the violation, citing the specific policy
2. **Re-review**: the decision is sent back for a fresh review through the normal process
3. **Learning**: if the violation is systematic, the remedy is a documented process change, not a quiet correction

Violations are not failures of the agent but signals that the system needs attention. The goal is improvement, not punishment.
