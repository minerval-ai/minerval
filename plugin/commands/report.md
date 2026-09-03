---
description: Report a problem with Minerval's tools, or an idea for improving the graph
argument-hint: <what went wrong or what should exist>
---

Help the user file a report with the people who maintain Minerval. This is
the channel for the system, not for claims: a tool that errored, a tool that
is missing or cannot express what was needed, a misleading description, or a
concrete, actionable idea for improving the claim graph or its machinery. To
dispute a claim or its assessment, use `/minerval:contribute` instead.

Input: `$ARGUMENTS`

## Steps

1. Settle what kind of report this is:
   - `system_failure` — a tool errored, returned something its description
     says is impossible, or a call was cut off.
   - `tool_gap` — the tool needed does not exist, a parameter is missing, a
     description misled, or a result omits what was needed.
   - `improvement` — a specific proposal for the graph or the tools.
2. Settle the severity: `blocking` (the task could not be completed),
   `degraded` (completed, worse than it should have been), `annoyance`
   (friction with no worse outcome), or `idea` (an improvement, not a defect).
3. Draft the report: a one-line `title` written as a claim about what is
   wrong or what should exist, and a `body` saying what was being attempted,
   what happened, what was expected, and for an improvement the proposal
   itself. Name the `surface` (the tool) when there is one, and put any
   claim or contribution ids in `context_refs`. Cite ids; never paste
   page text or private content into the body.
4. **Show the user the exact draft and get their explicit confirmation
   before submitting.** This is an attributed write to an external service.
5. Submit via `raise_issue` and report the returned report `id` and
   `occurrence_count` (a count above one means others have hit the same
   thing).

## Afterwards

Tell the user the report is queued for triage; there is no status endpoint
for reports over MCP. If submission is refused, relay the reason plainly:
the hourly report cap (`REPORT_RATE_LIMITED`), a suspended account
(`CONTRIBUTOR_SUSPENDED`), or a credential not bound to a contributor
identity (`NO_CONTRIBUTOR_IDENTITY` — sign in via OAuth or use a key minted
from the account dashboard).
