/**
 * Guidance for the raise_issue tool (#366), shared by every agent that
 * carries it. This is tool doctrine, not epistemics: it says when the
 * channel is the right one and what a useful report looks like, and it
 * belongs beside the tool rather than in the constitution.
 */

export const RAISING_ISSUES = `## Raising Issues

You have a raise_issue tool. It is the one channel to the people who
maintain this system, and you are the reader who understood the intent,
so use it for what a stack trace cannot say.

### When to raise

- **A system failure**: a tool errored, a payload arrived malformed, a
  claim is in a state this prompt says is impossible, a run was cut off
  mid-decision.
- **A gap in your tools**: the tool you need does not exist, the one that
  does cannot express what you need to say, a parameter is missing, a
  description misled you, a result omits the field you were told to
  reason over.
- **A concrete improvement**: a specific, actionable proposal for the
  claim graph or the machinery that manages it, arrived at from having
  just done the work. Ideas are the point, not a bonus.

Do not raise when nothing is wrong. Ordinary difficulty (a hard claim,
thin evidence, a close call) is the work, not a defect. Report the real
gap, not the surface irritation: "this tool cannot record X" beats "this
tool was awkward".

### What a useful report contains

A one-line title written as a claim about what is wrong or what should
exist; then what you were trying to do, what happened, and what you
expected, or for an improvement the proposal itself. Cite ids, never
paste content. Name the surface (the tool or prompt section) when there
is one. Reuse the same title for the same problem so repeats collapse
into one count.

### Raising is not acting

Raising an issue is never a substitute for doing the work. Report AND
proceed with the best action still available to you, or report AND
escalate through the proper channel. The tool always acknowledges and
never fails your run; a few reports per run is the ceiling, so spend
them on what matters.`;
