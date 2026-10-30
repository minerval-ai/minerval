# Remote MCP server

Minerval exposes the claim graph as a **remote MCP server** (Model Context
Protocol over streamable HTTP), so any MCP client — Claude Code, Claude.ai /
Cowork, Cursor, ChatGPT — can query claims, inspect decompositions and
assessments, fact-check text, and submit contributions from an agentic
workflow (issue #73). It keeps **parity with the REST API**: anything an
account can do through the API, it can do over MCP, unless a stated reason
says otherwise (see [Parity with the REST API](#parity-with-the-rest-api)).

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
  the MCP surface the consent page describes, never the REST API directly —
  that's what API keys are for. Because MCP keeps parity, the MCP surface
  reaches every account affordance through its tools (route tools dispatch
  in-process, carrying the identity the `/mcp` request resolved), but the
  token itself is refused anywhere but `/mcp`. A broader scope would have to
  be advertised, consented to, and enforced before tokens work elsewhere.

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
| Free reads | `search_claims`, `list_tags`, `get_claim`, `get_decomposition`, `get_contribution_status`, `get_bounty_terms` | never metered |
| Agentic | `match_claim`, `extract_claims`, `assess_text` | charged in owls as `text_analysis` (cap `CAP_TEXT_ANALYSIS_OWLS`, settled to metered cost); rate-limited; `INSUFFICIENT_OWLS` when the balance doesn't cover the cap. `extract_claims` and `assess_text` run in the background (read them with the free `get_text_analysis`); the quota is checked before they start, and the charge is taken when the work starts |
| Writes | `submit_contribution` | free for good-faith contributors; goes through the contribution review pipeline and reputation rules (#71) — new/low-reputation accounts get a tighter hourly cap (`CONTRIBUTION_RATE_LIMITED`), and an account flagged for suspected bad faith is blocked with `DEPOSIT_REQUIRED` until the flag is appealed |
| Feedback | `raise_issue` | free; attributed and rate-limited (`REPORT_RATE_LIMITED`). Reports about the server or its tools land in the same `agent_reports` table as the internal agents' own reports (#366) and are triaged separately as external testimony |
| Route tools | everything listed under [Route tools](#route-tools) | exactly what the REST route charges, because the route runs: reads are free, `propose_claim` / `submit_source` / `order_assessment` charge their caps, funding tools escrow owls ([accounts.md](accounts.md)) |

## Parity with the REST API

**The rule: MCP has every affordance the REST API offers an account, unless
there is a good, written reason it should not.** An agent connected through
Claude.ai has only this surface (its OAuth token is refused off `/mcp`), so a
route missing here is something those users cannot do at all. The burden is
on exclusion, not inclusion.

Every REST route is decided in `src/mcp/route-tools.ts`, in exactly one of:

- `ROUTE_TOOLS` — exposed as a generated tool (the name is chosen there; the
  input schema and description come from the route's own schema);
- `NATIVE_TOOL_ROUTES` — covered by a hand-written tool in `src/mcp/server.ts`;
- `MCP_EXCLUDED_ROUTES` / `MCP_EXCLUDED_PREFIXES` — not on MCP, each with its
  reason.

`tests/unit/mcp/parity.test.ts` builds the real app and fails when a route is
undecided, decided twice, or a table names a route that no longer exists. So
adding a REST route means adding its MCP side in the same change: usually one
line in `ROUTE_TOOLS`.

**How a route tool runs.** It does not reimplement the route: the call is
injected into the same Fastify app (`src/mcp/dispatch.ts`), so the route's
guards, owl charges, validation, and serialization are the ones REST callers
get, and the two surfaces cannot drift. The identity the `/mcp` request
resolved is parked under a single-use random nonce for the duration of the
injected request; the auth plugin trades the nonce back for that identity,
and refuses a nonce it does not hold. A route's refusal comes back as a tool
error carrying the route's `code`, `message`, HTTP `status`, and whatever
else the route sent (an entitlement, owl packs, a cap).

**Good reasons to exclude**, as the table currently records them:

- the route needs a credential no account holds — the service key
  (provisioning, triage, system usage) or the operator key (anything that
  moves platform or prize money);
- the route needs a signed-in dashboard session on purpose (minting API
  keys, Stripe checkout), so a leaked key, an MCP credential included,
  cannot do it;
- a person must read and make something (filing a prize claim: declarations,
  residency, documents, one-time codes);
- the route bypasses governance that MCP's equivalent applies
  (`PATCH /claims/:id` writes an argument without review;
  `submit_contribution` with `argument` is the reviewed path);
- it is protocol plumbing (OAuth, discovery, Stripe's webhook, health) or a
  rendering of something MCP already has (the Atom feed), or another
  client's own protocol (the browser extension's page analysis and chat,
  whose MCP equivalents are `assess_text` and `extract_claims`).

"It spends owls" is not a reason: owls are the limiter on both surfaces,
and the tool description says what a call spends.

## Tools

- **`search_claims`** `{query, limit?, assessed?, min_importance?, tag?, kind?}` — hybrid
  vector + keyword search over canonical claims, quantities and questions
  (all three live in `claims`). Each result carries its `kind`, its
  current assessment status/confidence (a question's `standing`, a
  quantity's `estimate` and `unit`), its topic `tags`, and a
  `minerval.ai` page link; `tag` (a slug) narrows the search to one topic
  and `kind` to one kind. `assessed` judges each kind by its own verdict.
- **`list_tags`** `{query?, limit?}` — the topic vocabulary (#272): the tags
  claims carry, with how many claims carry each; with `query`, ranked by
  meaning. A tag says what a claim is about, never whether it holds.
  Each result also carries `prize_micro_usd` (the live bounty on the claim,
  or null) and `checked` (`proof`, `disproof`, or null: whether a
  machine-checked argument stands on the claim, the same derivation as the
  badge on the claim page), and the input accepts `with_prizes: true` to
  restrict results to claims with an open bounty.
- **`get_claim`** `{claim_id, include?: ["provenance"|"arguments"|"dependents"]}`
  — canonical form, current assessment (status, confidence, reasoning),
  source instances, arguments, dependents, page link. With `"provenance"`,
  each instance carries the Steward's `reading` of its source (whether the
  source's own evidence bears its assertion, the mechanical quote check,
  whether it is worth reading closely; null until recorded), and the payload
  carries `source_map` (the Steward's account of what the support rests on,
  with `material` saying whether the claim page shows it), `provenance_edges`
  (which assertions draw on which documents, with fidelity), and
  `source_relationships` (documents that are one voice), per #286. None of
  it is a score. `formalization` is
  returned beside `assessment`: the published Lean 4 statement, its pin
  (toolchain and Mathlib revision), both hashes, the correspondence note,
  and the review-period end, or null when the claim has none. A formal
  statement is the graph's own rendering of the proposition and is what
  prizes, solver attempts, and machine-checked arguments bind to; the
  assessment beside it remains the Steward's judgment of the claim as
  worded. `include` also accepts `"proofs"`, which adds, to each argument
  that carries one, the public check record (verdict, gates, pin, hashes,
  and the submission source once public) behind a machine-checked proof or
  disproof.
  The node's `kind` rides on `claim`: a quantity carries a `quantity`
  record (definition, the graph's estimate with its work, stated figures,
  readings, cut claims) and no assessment, a question a `question` record
  (standing, answers, presuppositions, subquestions), a cut claim
  `threshold_of`, and every node its open `requests`, as
  `GET /claims/:id` serves them.
- **`get_decomposition`** `{claim_id, max_depth?}` — the subclaim tree with
  per-node assessment status: unsettled-vs-settled structure at a glance.
- **`match_claim`** `{assertion, context?, kind?}` — run a free-text assertion
  through the Matcher agent → the canonical claim it states (or negates — see
  `stance`) plus its assessment, `matched: false` for new/unknown, or
  `matched: null` when the Matcher ran out of search budget without a
  verdict (not a finding that the claim is new; retry). `kind` (`claim`,
  the default, `quantity`, or `question`) says what the assertion is: a
  figure matches the quantity it is a value of. A matched node carries its
  `kind` and its own judgment: a claim's `assessment`, a quantity's
  `estimate`, a question's `standing`; a new node carries `proposed_kind`,
  which the Matcher may change (a question asking how much is a quantity).
- **`extract_claims`** `{text, source_type?, max_claims?}` — run text through
  the Extractor agent → discrete checkable claims with proposed canonical
  forms, each with its `kind`.
- **`assess_text`** `{text, max_claims?}` — the judgment surface: extract the
  passage's claims, match each into the graph, and return per-claim verdicts
  (`well_supported`/`disputed`/… from the graph's assessments, `unassessed`
  if matched but not yet assessed, `unknown` if the graph has no such claim,
  `undecided` if the Matcher reached no verdict for that claim).
  A figure's verdict is `estimated` when its quantity has an estimate
  (beside it as `estimate`); a question's verdict is its standing
  (`answered`, `leaning`, `open`, `ill_posed`, `unknown`).
  Verdicts come from pre-computed assessments, not model recollection. When
  `stance` is `"denies"`, the passage asserts the claim's negation, so the
  assessment applies inverted.
- **`get_text_analysis`** `{job_id}` — `extract_claims` and `assess_text` run
  in the background, because an extraction plus a Matcher loop per claim
  takes minutes, longer than an MCP tool call should be held open. Each
  returns a `job_id` at once; this reads it: `processing` (with the result
  so far, for `assess_text` the judgments made so far), `complete` with the
  full result (`{claims}` / `{claims_extracted, judgments}`), or `failed`
  with an `error`. Only the account that started an analysis can read it,
  and the text itself is not stored. The public `GET /jobs/:id` does not
  serve these jobs. Free. A running analysis keeps a heartbeat; one whose
  process died reads as `failed` and is started again.
- **`submit_contribution`** `{claim_id, contribution_type, content,
  evidence_urls?, merge_target_claim_id?, proposed_canonical_form?}` — file a
  challenge / support / merge / split / edit / instance / argument. Requires
  a key bound to a contributor identity; enters the standard Contribution
  Reviewer pipeline and is subject to suspension and reputation policy (#71).
- **`get_contribution_status`** `{contribution_id}` — review decision,
  reasoning, and policy citations once the reviewer has ruled.
- **`get_bounty_terms`** `{claim_id}` returns the machine-readable terms of
  the live bounty on a claim, the same `terms` object `GET /claims/:id/bounty`
  serves: the amount and status, the formal statement's id, version, pin,
  and both hashes, the resolution sought (`proof`, `disproof`, or either),
  the allowed axioms and a summary of the static policy a submission must
  pass, the state of any challenge window, the rules version in force with
  its link, open-since and expiry dates, the count of submissions so far,
  and the platform's own attempt disclosure. Returns `bounty: null` when
  the claim carries no live bounty. An outside solver needs nothing else
  to know what would count as a solution; the statement file itself is at
  `GET /claims/:id/formalization.lean`.
- **`raise_issue`** `{kind, severity, title, body, surface?, context_refs?,
  joins?}` — report a problem with this server or its tools
  (`system_failure`, `tool_gap`) or a concrete improvement idea
  (`improvement`), never a judgment about a claim. Severity is `blocking` /
  `degraded` / `annoyance` / `idea`. Always recorded in one call: repeats
  of the same title collapse into one report with an occurrence count, and
  a new report comes back with `related`, the reports on record that read
  like it; if one of them is yours, raise again with `joins` set to its id
  and your body is added to it as a sighting instead. Free, attributed,
  rate-limited; returns the report id.

### Route tools

Generated from the REST routes (see [Parity](#parity-with-the-rest-api));
each tool's description is its route's summary plus the route it runs.

- **Claims:** `list_claims`, `cite_claim`, `get_claim_provenance`,
  `export_claim_nanopub`, `export_claim_mira`, `get_claim_record`,
  `get_assessment_history`, `get_assessment_trajectory`, `get_claim_events`,
  `propose_claim` (reviewed by the Contribution Reviewer before anything
  enters the graph).
- **Funding:** `order_assessment`, `fund_claim_assessment`,
  `fund_deep_decomposition`, `list_orders`, `get_order`, `cancel_order`,
  `list_budget_jobs`, `get_budget_job`, `top_up_budget_job`,
  `cancel_budget_job`.
- **Grants and mandates:** `start_grant_conversation`,
  `list_grant_conversations`, `get_grant_conversation`,
  `get_platform_grant_conversation`, `send_grant_message`, `fund_grant`,
  `list_grants`, `get_grant`, `approve_grant_plan`, `top_up_grant`,
  `cancel_grant`, `list_mandates`, `get_mandate`, `get_mandate_allocation`,
  `fund_mandate`, `get_mandate_lookout`.
- **Sources:** `submit_source` (reviewed before extraction), `get_source`,
  `get_source_context`, `get_source_examinations`, `get_source_document`,
  `get_job`.
- **Contributions:** `list_contributions`, `submit_appeal`, `get_appeal`,
  `list_contributors`, `get_contributor`.
- **Your account:** `get_account` (balance, entitlement, the cap list),
  `get_usage`, `list_owl_packs`, `get_owl_ledger`, `list_api_keys`.
- **Requests:** `list_requests`, `get_request`.
- **Tags, findings, platform health:** `get_tag`, `list_findings`,
  `get_finding`, `get_consistency_record`, `get_queue`, `list_monitors`,
  `get_monitor`.
- **Formal mathematics and prizes:** `get_formalization_lean`,
  `list_formalizations`, `get_lean_check`, `list_solver_attempts`,
  `get_attempt_stats`, `get_solver_attempt`, `list_prizes`,
  `get_prize_rules`, `get_prize_rules_version`, `list_prize_claims`,
  `get_prize_claim_eligibility`, `get_prize_claim`, `challenge_prize_claim`.

Claiming a prize over MCP (`claim_prize`) is deferred until the first prize
has been paid. The tool is thin once the JSON route exists (Lean source as
a string; documents would not be accepted over MCP), but a prize claim
carries declarations, a residency statement, and a rules version that a
person must read and make, and the first claims should go through the
form, where those are shown, before a headless path is offered. Until
then, `get_bounty_terms` tells an agent what a solution must be and the
claim page's form (`/claims/:id/prize/claim`) is where one is filed.

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

## Minerval as MCP client: domain tools for the Steward (#299)

The mirror image of this server: Minerval is an agentic *user*, not a
builder, of external evidence infrastructure. The first connector is
**Elicit** (scientific literature) — the Claim Steward consumes Elicit's
remote MCP server as a client, via the adapter in
`src/llm/tools/elicit-tools.ts`.

- Only Elicit's quick search tools are exposed (`elicit_search_papers`,
  `elicit_search_trials`); the long-running report / systematic-review tools
  are deliberately excluded — that tier belongs to the researcher subagent
  (#298) if it is ever warranted.
- The tools are offered whenever the connector is configured, with their
  per-call price in each definition. Elicit is likely overkill for most
  claims, and the Steward is instructed to reach for it only when ordinary
  `web_search` proves insufficient and the claim warrants the cost; a call
  the run's budget cannot cover is declined before it is sent
  (docs/allocation.md, "Agents work to a budget they can see").
- Provider failures degrade gracefully (§20): discovery failure omits the
  tools, a failed call returns a structured error the Steward routes around.

Configuration:

- `ELICIT_API_KEY` — enables the connector (empty = disabled; calls cost
  real money, so this is opt-in per deployment; see #300 for the external-
  spend budget this will fold into).
- `ELICIT_MCP_URL` — Elicit's MCP endpoint (default
  `https://elicit.com/api/mcp`).
- `ELICIT_USD_PER_CALL` — what one Elicit search costs, metered per call
  into `llm_usage` (provider `elicit`) so the caller's cost meter, its
  ceiling, and the daily caps see it, and the price the tool states and
  the run's budget must cover. Default `2`.

In production the key comes from Secrets Manager
(`episteme/elicit-api-key`, wired through the CDK stacks like the other
API keys). Until the real key is set the secret holds a CDK-generated
placeholder, which fails tool discovery and leaves the connector
effectively off:

```
aws secretsmanager put-secret-value \
  --secret-id episteme/elicit-api-key --secret-string '<key>'
```

GDELT (provenance) and FutureSearch (forecasts, gated on the #296
calibration concern) are the other connectors named in #299; they are not
wired yet.
