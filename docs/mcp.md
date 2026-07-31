# Remote MCP server

Minerval exposes the claim graph as a **remote MCP server** (Model Context
Protocol over streamable HTTP), so any MCP client — Claude Code, Claude.ai /
Cowork, Cursor, ChatGPT — can query claims, inspect decompositions and
assessments, fact-check text, and submit contributions from an agentic
workflow (issue #73).

## Endpoint

```
POST https://<api-host>/mcp
```

Single stateless JSON-RPC endpoint (the current streamable-HTTP remote-MCP
transport). There is no SSE resumption stream and no session state: `GET` and
`DELETE` return 405. Locally the endpoint is `http://localhost:3000/mcp`.

## Authentication

Two ways in; every call is attributed to an account either way.

**OAuth 2.1 (hosted clients — Claude.ai / Cowork connectors).** The API is a
full authorization server for its own `/mcp` resource: discovery metadata
(RFC 8414 + RFC 9728), dynamic client registration (RFC 7591), the
authorization-code grant with mandatory PKCE S256, and refresh-token rotation
with reuse detection. The interactive login/consent half lives on the web
frontend (which owns sessions, #70): `GET /oauth/authorize` validates the
request and parks it, sends the browser to `minerval.ai/oauth/consent`,
the user signs in and approves, and the consent page redirects back to the
client with the code. Unauthenticated `/mcp` calls get a 401 with a
`WWW-Authenticate: Bearer resource_metadata=...` challenge so spec-compliant
clients discover the whole flow on their own.

- `GET /.well-known/oauth-authorization-server[/mcp]` · issuer metadata
- `GET /.well-known/oauth-protected-resource[/mcp]` · resource → issuer
- `POST /oauth/register` · dynamic client registration
- `GET /oauth/authorize` → consent page → `POST /oauth/token`
- Access tokens (`eoat_*`, 1 h) refresh via rotating refresh tokens
  (`eort_*`, 30 d); a replayed refresh token revokes the whole grant.
- Tokens are audience-bound to `/mcp` (scope `mcp`): they authenticate only
  the MCP surface the consent page describes, never the wider REST API —
  that's what API keys are for. A broader scope would have to be advertised,
  consented to, and enforced before tokens work elsewhere.

**API key** (minted from the account dashboard, see
[accounts.md](accounts.md)) — for clients where you can set headers:

- `x-api-key: <key>` header, or
- `Authorization: Bearer <key>`.

In local development with no `API_KEYS` configured, requests fall back to the
dev-bypass identity like the REST API.

### Connecting from Claude.ai / Cowork

Settings → Connectors → *Add custom connector* → URL
`https://<api-host>/mcp`. Leave the OAuth client ID/secret fields empty —
the connector registers itself and walks the sign-in/consent flow.

### Connecting from Claude Code

```bash
claude mcp add --transport http minerval https://<api-host>/mcp \
  --header "x-api-key: <your-key>"
```

(Or omit the header and let `/mcp` trigger the OAuth flow interactively.)

Easier still is the **Claude Code / Cowork plugin** (issue #74), which
bundles this connection plus slash commands, a fact-checker subagent, and an
opt-in doc-checking hook — the repo doubles as its marketplace:

```
/plugin marketplace add minerval-ai/minerval
/plugin install minerval@minerval
```

See [plugin/README.md](../plugin/README.md) for auth and usage.

## Metering

Tool calls follow the same free-vs-metered split as the REST API (#70):

| Tier | Tools | Cost |
|------|-------|------|
| Free reads | `search_claims`, `get_claim`, `get_decomposition`, `get_contribution_status` | never metered |
| Agentic | `match_claim`, `extract_claims`, `assess_text` | LLM tokens metered per account; rate-limited and gated on the monthly free-tier grant (402 `QUOTA_EXCEEDED` when exhausted) |
| Writes | `submit_contribution` | free for good-faith contributors; goes through the contribution review pipeline and reputation rules (#71) — new/low-reputation accounts get a tighter hourly cap (`CONTRIBUTION_RATE_LIMITED`), and an account flagged for suspected bad faith is blocked with `DEPOSIT_REQUIRED` until the flag is appealed |

## Tools

- **`search_claims`** `{query, limit?, assessed?, min_importance?}` — hybrid
  vector + keyword search over canonical claims. Each result carries its
  current assessment status/confidence and a `minerval.ai` page link.
- **`get_claim`** `{claim_id, include?: ["provenance"|"arguments"|"dependents"]}`
  — canonical form, current assessment (status, confidence, reasoning),
  source instances, arguments, dependents, page link.
- **`get_decomposition`** `{claim_id, max_depth?}` — the subclaim tree with
  per-node assessment status: contested-vs-settled structure at a glance.
- **`match_claim`** `{assertion, context?}` — run a free-text assertion
  through the Matcher agent → the canonical claim it states (or negates — see
  `stance`) plus its assessment, or `matched: false` for new/unknown.
- **`extract_claims`** `{text, source_type?, max_claims?}` — run text through
  the Extractor agent → discrete checkable claims with proposed canonical
  forms.
- **`assess_text`** `{text, max_claims?}` — the judgment surface: extract the
  passage's claims, match each into the graph, and return per-claim verdicts
  (`well_supported`/`disputed`/… from the graph's assessments, `unassessed`
  if matched but not yet assessed, `unknown` if the graph has no such claim).
  Verdicts come from pre-computed assessments, not model recollection. When
  `stance` is `"denies"`, the passage asserts the claim's negation, so the
  assessment applies inverted.
- **`submit_contribution`** `{claim_id, contribution_type, content,
  evidence_urls?, merge_target_claim_id?, proposed_canonical_form?}` — file a
  challenge / support / merge / split / edit / instance / argument. Requires
  a key bound to a contributor identity; enters the standard Contribution
  Reviewer pipeline and is subject to suspension and reputation policy (#71).
- **`get_contribution_status`** `{contribution_id}` — review decision,
  reasoning, and policy citations once the reviewer has ruled.

## Resources

- `claim://{claim_id}` — a canonical claim with assessment + decomposition
  tree, attachable as context.
- `claims://recent` — most recently updated claims.

## Prompts

- `fact_check_document(document)` — drive `assess_text` over a document and
  produce a grounded, cited report.
- `check_assertion(assertion)` — check one assertion via `match_claim` and
  explain its standing.

## Configuration

- `PUBLIC_WEB_BASE_URL` — base URL used for `page_url` links in tool results
  and for the OAuth consent page (default `https://minerval.ai`).
- `PUBLIC_API_BASE_URL` — this API's public base URL: the OAuth issuer and
  the base for `/.well-known` endpoint URLs (default `http://localhost:3000`,
  `https://api.claimgraph.io` in production).
- Quota knobs are shared with the REST API: `AGENTIC_RATE_LIMIT_PER_HOUR`,
  `FREE_TIER_MONTHLY_USD`.
