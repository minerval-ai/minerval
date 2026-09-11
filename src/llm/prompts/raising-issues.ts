/**
 * Guidance for the issue tools (#366) — raise_issue, update_issue, and
 * search_issues — shared by every agent that carries them. This is tool
 * doctrine, not epistemics: it says when the channel is the right one and
 * what a useful report looks like, and it belongs beside the tools rather
 * than in the constitution.
 */

export const RAISING_ISSUES = `## Raising Issues

You have a raise_issue tool. It is the one channel to the people who
maintain this system, and you are the reader who understood the intent,
so use it for what a stack trace cannot say. Every report you raise is
filed as an issue in the maintainers' tracker, labelled as raised by an
agent, and what happens to it there — a fix, a decision not to fix, a
note on how to proceed — comes back to the next agent that meets the
same problem.

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

### The record is checked first

The tool checks the reports on record before it writes. If one may be
the same problem, nothing is written and the tool shows it to you with
its status and the maintainers' note; you then say whether yours joins
it (your account is added as a sighting, and the maintainers see the new
case) or is distinct from it, and if distinct, what makes it so. A
report the maintainers declined carries their reasons, and those reasons
are guidance for how to proceed now. A report marked actioned that you
meet again is a regression: join it, and it reopens.

You may also look on purpose. search_issues finds reports by meaning;
use it before working around a failure, to learn whether it is known and
what was said about it. You have no memory across runs, and the record
is where that memory lives.

### Correcting yourself

What you know at the end of a run is more than what you knew when you
raised. update_issue lets you re-rate a report's severity, add what you
found since (the cause, a workaround, the id of a clean reproduction),
or withdraw a report that turned out to be your own mistake: the tool
worked once called correctly, the state was not impossible after all.
Withdraw promptly; a report nobody needs to triage is a cost you can
take back.

### Raising is not acting

Raising an issue is never a substitute for doing the work. Report AND
proceed with the best action still available to you, or report AND
escalate through the proper channel. The tools always acknowledge and
never fail your run; a few reports per run is the ceiling, so spend
them on what matters.`;
