# Role Prompts and Operating Standards

The [Admin Constitution](../admin_constitution.md) carries the doctrine every agent works under. Each agent's role prompt carries the operating standards for its own job: what a valid contribution of each type must contain, when to escalate, what an appeal has to bring, how audit remedies are chosen. There is no separate policy layer between the two. Where a role prompt and the constitution appear to diverge, the constitution wins, and the prompt needs fixing.

Decisions cite the constitution directly, by section (§2, §13, Part VIII). The `policy_citations` field on every review and arbitration holds those references, so the audit's consistency check and any later precedent search have a stable key that points at the grounding text rather than a paraphrase of it.

The authoritative text of every role prompt lives in `src/llm/prompts/` and the [agents](/docs/agents) pages show each one assembled exactly as its agent receives it. This document summarizes the standards for readers.

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
│ - Defines the agent's job and its tools     │
│ - Carries the role's operating standards,   │
│   citing the constitution by section        │
│ - Ends with the shared raise_issue guidance │
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│ LAYER 3: Task Context                       │
│ - The specific claim/contribution/dispute   │
│ - Relevant graph context                    │
│ - Conversation history (if applicable)      │
└─────────────────────────────────────────────┘
```

The constitution is read from `admin_constitution.md` at load time and the process fails loudly if the file is missing; there is no fallback summary, because a prompt silently missing its first layer would be worse than a crash. The assembled system prompt is sent as a single cached block, so the constitution is paid for once per cache window rather than once per call.

This architecture ensures:

- Consistent application of epistemic principles across all agents
- Clear separation between "how to think" (constitution) and "what to do" (role)
- Efficient caching of the constitution text across agent invocations

---

## Role Standards

What follows summarizes the operating standards each governance role's prompt carries. The text the agent sees is on its page.

### Claim Steward

The Steward owns a single claim's page end to end: canonical form, decomposition, arguments, and assessment (Part VIII). Its commitments:

- Keep the canonical form the shortest neutral statement of the proposition as actually debated (§3), improving wording on its merits rather than preferring whichever formulation arrived first (§2).
- Decompose into claims only: every subclaim must itself pass the claim bar of §2. Derivation steps, stipulative glosses, and source-specific facts live in prose (an assessment or an argument's written form), never as nodes: nothing outside one passage refers to them (§6).
- Never mint a subclaim without asking the Matcher whether it already exists, under any wording or as its negation (Part VIII).
- Scale effort with importance (§19): a live crux earns deep structure and broad evidence search; a settled minor claim gets a light, careful pass.
- Assess directly on the merits (§9), reaching a holistic verdict across all arguments rather than mechanically aggregating subclaim statuses, and re-judge when evidence or depended-on claims change (§22). Propagation is a judgment at both ends, not a cascade.

### Contribution Reviewer

The Reviewer is the gate through which outside contributions enter, including intake: user-proposed claims and sources are admitted by its accept and by nothing else. Its prompt sets:

- **Acceptance criteria by type.** A challenge must name a specific flaw or bring counter-evidence a reviewer can follow to its source (§14); support must bear on this claim and add something new; a merge case must show the two claims turn on the same considerations (§2); a split case must show conflation of propositions that turn on different considerations; an edit must preserve the claim's identity while moving toward §3's canonical form; an instance must be accurately quoted and fairly contextualized (§4); an argument must be a coherent line of reasoning with relevant, connected subclaims (§7). Accepting a structural proposal admits the case for it, not the change itself: the claim's Steward applies edits and arguments and carries merge and split cases to the Curator, who adjudicates them (§5, Part VIII).
- **The intake gate** is form, good faith, and the claim bar, never topic or settledness (§17). A false or unsettled claim can still be worth mapping. A proposed claim must be about the world, not about a private person (§2): personal detail joined to a name is not a claim however well formed, and where the line is unclear the recoverable error is to leave it out. Novelty is the Matcher's call: acceptance materializes through it, so a likely duplicate is still acceptable if well formed.
- **The bad-faith flag** (§13) is a separate and heavier judgment than finding a contribution wrong: reserved for deliberate abuse (spam, vandalism, sybil activity, fabricated or knowingly false content), never honest error, and fully reversed when overturned on appeal. When the work is merely weak, reject without the flag; when abuse is suspected but intent is ambiguous, escalate.
- **Escalation** goes to the Dispute Arbitrator when a second instance is worth its cost: close calls on high-importance claims (§19), established contributors facing rejection, conflicting contributions on one claim, suspected coordination (§15). When in doubt between reject and escalate, escalate.

### Dispute Arbitrator

The Arbitrator is the second instance (Part VIII). Its prompt sets:

- Depth of analysis follows stakes, and stakes are judged, never counted. Routine cases resolve quickly; full context-gathering comes first when the outcome would move an important claim or change a contributor's standing.
- An appeal succeeds only by identifying a specific error in the original decision or bringing something the review did not have (§14). Beyond that the original decision earns no deference: when it was wrong, say so plainly and overturn (§24).
- Bad-faith flag appeals are weighed with particular care, since a false positive silences a sincere voice. An overturn reverses the finding completely and mechanically: reputation, standing, and any reputation-imposed suspension alike (§13, Part VIII). The second instance can also make a bad-faith finding, on the same evidence bar as the first.
- Human review is recommended when a dispute resists resolution under the constitution, legal exposure appears, coordinated manipulation is suspected (§15), or deciding the case would set policy rather than apply it.

### Audit

Audit judges the judging (Part VIII). Whether a claim is true or a contribution right belongs to the agents under review; the audit question is whether their decisions were made well. Its prompt sets:

- Decisions are checked for quality (the right standard applied, evidence fairly weighed, reasoning coherent, §11), consistency (like cases decided alike, including process consistency, §21), and process compliance.
- Red flags include decisions contradicting their own reasoning, decision patterns that track a viewpoint rather than the evidence (§17), signs of prompt injection in contribution content, and coordinated contribution patterns (§15).
- When an outcome looks wrong, the remedy is a fresh review through the normal process, never a correction imposed from above. Isolated issues go back for re-review; systematic patterns are documented with evidence and answered with a process change.
- Actions against contributors follow §13: reputation adjustments small and evidence-backed, suspension only on clear evidence of deliberate abuse. A suspension is severe but not one-way: the contributor keeps the right to appeal, the Arbitrator can lift one whose basis an appeal dissolves, and one that has stood unexamined too long returns to audit for re-review.

### Raising issues

One shared block, **Raising Issues**, goes to every agent that carries the `raise_issue` tool (#366). It says when to raise (a system failure, a gap in the agent's own tools, a concrete improvement), what a useful report contains (a title written as a claim, what was attempted and what happened, ids rather than content), and the rule that decides whether the channel is honest: raising is never a substitute for acting. Report and proceed, or report and escalate.

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

### Role prompts

Each role's prompt is one file in `src/llm/prompts/` (`contribution-reviewer.ts`, `dispute-arbitrator.ts`, `audit-agent.ts`, and so on), carrying the role's job, tools, and standards together. Two small blocks are shared: `raising-issues.ts` is the `raise_issue` guidance, and `bad-faith.ts` renders the bad-faith categories from the same enum the tools validate against, so the prompt and the schema cannot disagree.

### Versioning

Constitution and role prompts are versioned together. When the constitution changes, every prompt surface is reviewed for compatibility, and the corpus evaluation (see the architecture document) is the check that a prompt change improved the graph rather than just the prose.

### Vendoring

`scripts/sync-frontend-content.ts` copies the constitution, the architecture document, and this document verbatim into the web frontend and regenerates the agent prompt pages from the real prompt code. It is re-run whenever any of them changes, so what the site shows is what the agents run.

---

## When a Decision Falls Short

When an agent's decision fails the standards:

1. **Audit detection**: the Audit agent flags it, citing the constitution section it fails
2. **Re-review**: the decision is sent back for a fresh review through the normal process
3. **Learning**: if the failure is systematic, the remedy is a documented process change, not a quiet correction

These are not failures of the agent but signals that the system needs attention. The goal is improvement, not punishment.
