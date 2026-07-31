---
description: Fact-check the prose claims in the current diff before commit
argument-hint: "[base ref, e.g. main — defaults to staged + unstaged changes]"
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git merge-base:*), Bash(git rev-parse:*)
---

Fact-check the factual assertions introduced by the current changes — docs,
READMEs, comments, commit-worthy prose — against the Minerval claim graph
before they are committed.

Base ref (optional): `$ARGUMENTS`

## Steps

1. Collect the diff. With no argument, take both staged and unstaged changes
   (`git diff HEAD`; fall back to `git diff` + `git diff --cached` on a fresh
   repo). With a base ref argument, diff against its merge-base
   (`git diff $(git merge-base <ref> HEAD)`).
2. Pull out the **added prose**: new or changed lines in Markdown/text/docs
   files, doc comments and code comments, README and changelog entries,
   user-facing strings. Skip pure code, configuration, lockfiles, and
   generated files. If the diff adds no prose, say so and stop — do not
   assess code as if it were claims.
3. Concatenate the added prose (grouped per file) and run it through
   `assess_text` (Minerval MCP; metered — one call per file or chunk, staying
   under the tool's size limit). Claims are scarce relative to text; most
   lines will yield none, and that is the expected result, not a failure.
4. Interpret verdicts as in `/minerval:check`: verdicts come from the graph's
   assessments, `stance: denies` inverts the reading, `unknown`/`unassessed`
   means the graph is silent. Flag contested claims asserted as settled.

## Report

Per file, list each judged claim with its verdict, confidence, and `page_url`.
Then give a pre-commit bottom line:

- **Blockers** — added prose the graph's assessments contradict, or denials
  of well-supported claims. Quote the offending line and suggest a fix
  grounded in the assessment's reasoning.
- **Cautions** — contested or unsupported claims asserted flatly; suggest
  hedging or citing.
- **Clear** — everything else, including graph-silent claims (noted, not
  blocked).

Do not modify any files — this command reports; the user decides what to
change before committing.
