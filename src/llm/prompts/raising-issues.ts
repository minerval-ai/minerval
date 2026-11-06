/**
 * Guidance for the issue tools (#366): raise_issue, update_issue,
 * search_issues and get_issue, shared by every agent that carries them.
 *
 * Only what the tool descriptions cannot say lives here. What to report,
 * how to word it, joins, search tips and withdrawal are in the descriptions
 * (tools/report-tools.ts), which every carrier of the tools reads; repeating
 * them in ten role prompts cost attention on every run (#770). There is no
 * per-run cap on reports, so this block names none.
 */

export const RAISING_ISSUES = `## Raising Issues

raise_issue is your channel to the people who maintain this system; its
description says what to report and how. Before working around a failure,
search_issues for it.`;
