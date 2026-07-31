# Minerval plugin for Claude Code / Cowork

Claim lookup and graph-grounded fact-checking inside the agent's everyday
workflow. The plugin is thin packaging over Minerval's
[remote MCP server](../docs/mcp.md): it connects the server, and adds slash
commands, a fact-checker subagent, an auto-triggering skill, and an opt-in
hook on top.

## Install

The `minerval-ai/minerval` repository doubles as a plugin marketplace:

```
/plugin marketplace add minerval-ai/minerval
/plugin install minerval@minerval
```

## Authentication

The plugin connects to `https://api.claimgraph.io/mcp`. Two ways in; every
call is attributed to your Minerval account either way:

- **OAuth (default, zero config).** With no API key set, the server answers
  the first call with an OAuth challenge and Claude Code walks you through
  sign-in and consent in the browser (run `/mcp` to (re)authenticate). This
  is the whole flow for Claude.ai / Cowork too — add the endpoint as a custom
  connector and leave the client ID/secret empty.
- **API key.** Mint a key from the account dashboard and export it before
  starting Claude Code:

  ```bash
  export MINERVAL_API_KEY=<your key>
  ```

To point at a non-production server (e.g. local development), set
`MINERVAL_MCP_URL` (defaults to `https://api.claimgraph.io/mcp`; locally the
API serves `http://localhost:3000/mcp`).

## What you get

### Slash commands

- `/minerval:check <text or file>` — extract, match, and assess a passage;
  reports which claims are supported / contested / contradicted /
  misleading-as-written, each linking to its claim page.
- `/minerval:claim <id or assertion>` — look up one claim: canonical form,
  assessment (status, confidence, credence), and the decomposition showing
  where agreement ends and dispute begins.
- `/minerval:factcheck-diff [base ref]` — fact-check the prose introduced by
  the current diff (docs, comments, READMEs) before commit.
- `/minerval:contribute <claim + what you want to file>` — draft and submit a
  challenge, evidence, or merge/split/edit proposal; always confirms the
  final text with you before submitting.

### Subagent

`fact-checker` — a delegate restricted to the Minerval judgment surface. The
main thread hands it a document, diff, or assertion and gets back a
structured, worst-first verdict list grounded in the graph's assessments,
never model recollection. Same rubric as the browser extension's overlay
agent (stance inversion, misleading-as-written, silence-is-a-finding).

### Skill

`claim-checking` — background guidance that triggers when the agent writes or
reviews prose asserting disputable facts, steering it to the right Minerval
tool (and away from answering from recollection).

### Hook (opt-in, off by default)

A `PostToolUse` hook that, after Claude writes Markdown, nudges it to run the
new prose through `assess_text` and warn about high-confidence contradicted
claims. Off by default — it spends metered calls and most edits assert
nothing checkable. Enable with:

```bash
export MINERVAL_FACTCHECK_HOOK=1
```

## Metering

Tool tiers mirror the API (see [docs/mcp.md](../docs/mcp.md)): reads
(`search_claims`, `get_claim`, `get_decomposition`,
`get_contribution_status`) are free; agentic calls (`match_claim`,
`extract_claims`, `assess_text`) run models and are metered to your account
against the monthly free-tier grant; `submit_contribution` is free for
good-faith contributors and goes through the contribution review pipeline and
reputation rules.

## Development

The plugin is validated in CI with `claude plugin validate`. To try a local
checkout: `claude --plugin-dir ./plugin` (or add the repo root as a local
marketplace: `/plugin marketplace add /path/to/minerval`).
