---
description: Fact-check a passage against the Minerval claim graph
argument-hint: <text to check, or a file path>
---

Fact-check the input against the Minerval claim graph using the Minerval MCP
tools. Report what the graph's assessments establish — never your own
recollection of the facts.

Input: `$ARGUMENTS`

## Steps

1. Resolve the input. If it is a path to an existing file, read the file and
   check its prose. If it is inline text, check that. If it is empty, ask what
   to check.
2. Run the passage through the `assess_text` tool (Minerval MCP). It extracts
   the passage's disputable claims, matches each into the graph, and returns
   per-claim verdicts from the graph's pre-computed assessments. For passages
   over ~40k characters, chunk on section boundaries and assess each chunk.
   This is a metered call attributed to the user's Minerval account.
3. Interpret each judgment carefully:
   - The `verdict` comes from the graph: `verified`, `supported`, `contested`,
     `unsupported`, `contradicted` — or `unassessed` (the claim exists but has
     no assessment yet) or `unknown` (the graph holds no such claim).
   - Watch `stance`. `denies` means the passage asserts the **negation** of
     the canonical claim, so read the assessment inverted: denying a
     `contradicted` claim is fine; denying a `verified` one is the problem.
   - Flag **misleading-as-written** passages: a sentence that flatly asserts a
     claim the graph holds as `contested`, or that states a supported claim
     stripped of a qualification the assessment says it depends on. Use the
     assessment's `summary`/`reasoning_trace` (and `get_decomposition` where
     the dispute's location matters) to say precisely what is misleading.

## Report

Group the results, worst first:

- **Contradicted or unsupported as written** — passage sentences the graph's
  assessments weigh against (including denials of well-supported claims).
- **Misleading as written** — technically matched, but contested or
  over-asserted relative to the assessment.
- **Supported** — sentences the graph affirms.
- **Not in the graph** — `unknown`/`unassessed` claims; the graph is silent,
  which is not evidence either way. Offer `/minerval:contribute` if one seems
  worth filing.

For every matched claim, cite its canonical form, the verdict with its
confidence (and `claim_credence` when present), and link its `page_url`. End
with a one-paragraph bottom line for the passage as a whole.
