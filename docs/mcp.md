# Remote MCP server

Minerval exposes the claim graph as a **remote MCP server** (Model Context
Protocol over streamable HTTP), so any MCP client — Claude Code, Claude.ai /
Cowork, Cursor, ChatGPT — can query claims, quantities, and questions,
inspect decompositions and assessments, fact-check text, and submit contributions from an agentic
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

### The label a connection works at

In a members-only deployment that holds material at more than one label
([accounts.md](accounts.md), "The label a request works at"), a key or a
token works at one label, which the person chose when they minted the key
or approved the client. The server's instructions say which, and
`get_my_labels` says who reads it. Every call reads what that label reads
and files what it adds there. No tool takes a label: a tool that starts
something new files it at the connection's label, and a tool that acts on
an existing thing is refused, with the reason, when that thing carries
another label. The endpoint is not for a signed-in session, which has no
label of its own.

## Metering

Tool calls follow the same free-vs-metered split as the REST API (#70):

| Tier | Tools | Cost |
|------|-------|------|
| Free reads | `search_claims`, `list_tags`, `get_claim`, `get_argument`, `get_decomposition`, `get_dependents`, `list_graph_changes`, `get_contribution_status`, `get_bounty_terms`, `get_page_analysis`, `get_text_analysis` | never metered |
| Agentic | `match_claim`, `extract_claims`, `assess_text` | charged in owls as `text_analysis` (cap `CAP_TEXT_ANALYSIS_OWLS`, settled to metered cost); rate-limited; `INSUFFICIENT_OWLS` when the balance doesn't cover the cap. `extract_claims` and `assess_text` run in the background (read them with the free `get_text_analysis`); the quota is checked before they start, and the charge is taken when the work starts |
| Writes | `submit_contribution` | free for good-faith contributors; goes through the contribution review pipeline and reputation rules (#71) — capped at 10 an hour, 3 for new/low-reputation accounts (`CONTRIBUTION_RATE_LIMITED`), stated in the tool description; priced proposals (`propose_claim`, `submit_source`) are bounded by the caller's balance instead and don't count, and an account flagged for suspected bad faith is blocked with `DEPOSIT_REQUIRED` until the flag is appealed |
| Feedback | `raise_issue` | free; attributed and rate-limited (`REPORT_RATE_LIMITED`). Reports about the server or its tools land in the same `agent_reports` table as the internal agents' own reports (#366) and are triaged separately as external testimony; in production each is also filed as a GitHub issue labelled `origin/external` |
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
line in `ROUTE_TOOLS`. A route behind a feature that is switched off
(docs/architecture.md, "Features") is not mounted and is therefore not a
tool; `list_features` says which features a deployment has.

The routes for permissions, parties and labels are mounted only by a
members-only deployment (docs/accounts.md, "Members-only deployments"), so
their tools exist only there, and the parity test builds that app too.
Their reads are tools; their writes are excluded, because a change to who
may do what takes a signed-in session. In such a deployment a tool whose
route needs a permission is offered only to a caller whose account holds
it, and the server's instructions name the tools left out and say why.
The routes for connections to an organization's systems
(docs/connections.md) are in the same case: `list_connections`,
`get_connection` and `list_connection_calls` are tools for a caller who
holds `administer`, and adding a connection, changing one, and picking
which of its tools the graph's agents are offered take a session. So are
the routes for file sets (docs/file-sets.md): `list_file_sets`,
`get_file_set`, `list_file_set_files` and `list_file_set_commands` are
tools for a caller who holds `direct`, and adding a set, uploading into
one, closing one and switching one off take a session. Registering a
directory as a set takes a session and `administer`.
`get_setup_checklist` is the administrators' read of how far the
deployment's setup has got (docs/setup-checklist.md).

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
  `submit_contribution` with `propose_argument` is the reviewed path);
- it is protocol plumbing (OAuth, discovery, Stripe's webhook, health) or a
  rendering of something MCP already has (the Atom feed), or another
  client's own protocol (the browser extension's page analysis and chat,
  whose MCP equivalents are `assess_text` and `extract_claims`, and its
  private prefix lookup; the shared analysis itself, and what the graph
  recorded from a page it read as a source, are `get_page_analysis`, which
  takes the URL and hashes it on the server).

"It spends owls" is not a reason: owls are the limiter on both surfaces,
and the tool description says what a call spends.

## Tools

`search_claims`, `get_decomposition` and `get_dependents` are defined once,
in `src/services/graph-read-service.ts`, and served both here and to the
graph's own agents (`src/llm/tools/graph-read-tools.ts`), as `get_claim` is
from `src/services/claim-view-service.ts` and `get_argument` from
`src/services/argument-view-service.ts`, so the two cannot drift (#726).
The definitions differ only in a description suffix: a caller is told the
read is free, an agent which signals allocation turns on.

- **`search_claims`** `{query, limit?, kind?, tag?, assessed?,
  min_importance?, claim_type?, with_prizes?}` — hybrid vector + keyword
  search over canonical claims, quantities and questions (all three live in
  `claims`). Each result carries its `kind`, importance, `contestation`,
  current assessment status/confidence (a question's `standing`, a
  quantity's `estimate` and `unit`), `days_since_assessed`, `since_assessed`
  (what has changed under its judgment since it was written, read for every
  hit in one query and served in a short form, since most hits have nothing
  to say: `{changed: false}`, or `{changed: true}` with only the counts
  above zero, or `{recorded: false}` for a judgment that predates the
  record, which is unknown, not unchanged; a node with no judgment has no
  such key; `get_claim` has every count), its topic
  `tags`, and a `minerval.ai` page link. It also carries `prize_micro_usd`
  (the live bounty on the claim, or null) and `checked` (`proof`,
  `disproof`, or null: whether a machine-checked argument stands on the
  claim, the same derivation as the badge on the claim page). `tag` (a
  slug) narrows the search to one topic, `kind` to one kind, `claim_type`
  to one type, and `with_prizes: true` to claims with an open bounty;
  `assessed` judges each kind by its own verdict.
- **`list_graph_changes`** `{after?, since?, under?, tags?,
  min_credence_delta?, material_only?, limit?}` — the change stream (#562,
  first slice): one entry per material change to a node's verdict, oldest
  first (a first assessment, a status moving on the ladder, a credence
  moving by at least the monitors' material delta), each with its size
  (`status_steps`, `credence_delta`), the node's id, text and page link, and
  a cursor; `next_cursor` resumes after the page. `under` narrows it to
  claims and everything beneath them, `tags` to topics. Defined once in
  `src/services/graph-change-service.ts` and served here, at `GET /changes`,
  and to the graph's own Correspondents (#563), so a Correspondent built
  outside Minerval reads exactly what ours do: read the changes in a scope
  from a kept cursor, open what matters with `get_claim`, and report.
- **`list_tags`** `{query?, limit?}` — the topic vocabulary (#272): the tags
  claims carry, with how many claims carry each; with `query`, ranked by
  meaning. A tag says what a claim is about, never whether it holds.
- **`get_claim`** `{claim_id, include?: ["arguments"|"subclaims"|"provenance"|"dependents"|"related"|"findings"|"proofs"|"judgment_inputs"], dependents_limit?, dependents_offset?}`
  — one node as the graph records it. This is the same tool, with the same
  description and payload, that the graph's own agents call
  (`src/services/claim-view-service.ts`, #774), so a skill that names
  `get_claim` means one thing to every reader. Every read returns `claim`
  (`kind`, canonical form, type, state, importance, contestation, tags,
  page link, `steward_state` and `stewarded_at`), `assessment` (its `id`,
  status, confidence, credence, reasoning, `run_id`), the kind's record,
  `coverage` (what examination the node has had: `examined`, whether a
  judgment of it is in force, and `on`, what that judgment was made on:
  `public_evidence`, and `evidence_not_shown` when a source it was recorded
  against had been read as reporting a result from evidence it has not
  published; on a node not examined `on` is empty and `note` says that this
  is not a finding either way),
  `since_assessed` on a node with a judgment in force (what has changed
  under that judgment since it was written, as counts: premises judged
  again, added or removed, sources added or removed, notices on its
  sources; `recorded: false` means the judgment predates the record, which
  is unknown, not unchanged), `preliminary_seed`
  while the node is unassessed, the formalization record, `requests`,
  `subclaim_count`, `instance_count` and `source_map` (the Steward's account
  of what the support rests on, with `material` saying whether the claim page
  shows it). Nothing else is
  included by default; `include` adds sections:
  - `"arguments"`: each argument with its written form, its current
    evaluation, and the check record behind a machine-checked one.
  - `"subclaims"`: the direct subclaims, one row per argument each serves,
    with the edge's reasoning, their standing and their `coverage` (the short form, as on a
    node of `get_decomposition`), and `subclaims_assessed`. `get_decomposition`
    walks deeper.
  - `"provenance"`: the instances, each with its `stance` (`affirms`,
    `denies`, `poses` an open question, or `mentions`: it cites the claim or
    reports the debate without taking a side, and is never a vote for either
    side) and the Steward's `reading` of its source (whether the source's own evidence bears its assertion, the
    mechanical quote check, whether it is worth reading closely; null until
    recorded), plus `provenance_edges` (which assertions draw on which
    documents, with fidelity) and `source_relationships` (documents that are
    one voice), per #286. None of it is a score.
  - `"dependents"`: one page by importance (`dependents_limit`, default 25,
    at most 100; `dependents_offset`), with `dependents_total`.
  - `"related"`: lateral see-also links with the reason for each; never
    dependencies.
  - `"findings"`: findings already noted on the node.
  - `"proofs"`: every Lean check record on any version of the statement.
  - `"judgment_inputs"`: the record behind `since_assessed`, input by input:
    the same view `get_judgment_inputs` serves. The graph's own agents have
    no `get_judgment_inputs`, so this section is how they read it.

  A merged id resolves to its survivor (#884). A merge leaves the absorbed
  node as an alias "so that existing references still resolve" (constitution
  §5), so `get_claim` on an absorbed id returns the survivor's view, with
  `claim.id` the survivor's, and `resolved_from: {id, canonical_form,
  stance_relation, merged_at}` first in the payload: the id asked for, its
  own wording, how it stood to the survivor, and when it was merged.
  `stance_relation` is `same`, or `opposed` when the node was merged with its
  negation, in which case the survivor's status, credence and argument
  stances are about the opposite of what the caller's id stated; it is
  composed over the chain when the id was absorbed in more than one step,
  and null where a merge's record does not say. The same holds for
  `get_decomposition`, `get_dependents`, the `claim://` resource, the cards
  (where `resolved_from` is always present, null for a node's own id) and
  every read route on `/claims/:claim_id`, which also set the
  `x-minerval-resolved-from` header, including on exports that are not JSON;
  `fields` never trims `resolved_from` away. One function follows the
  pointer for all of them (`resolveClaimId`,
  `src/services/claim-alias-service.ts`; the routes through
  `src/server/plugins/claim-alias.ts`). Three kinds of read answer with the
  row the id names instead: the formal statement routes
  (`/claims/:claim_id/formalization`, `.lean`, `/formalizations`), and the
  bounty, prize-claim and solver-attempt reads, because those records are
  pinned to the absorbed node's own formal statement, which a merge does not
  move and an opposed merge would invert. A write addressed to a merged id
  is never redirected: it is refused (REST: 409 `CLAIM_MERGED` with
  `merged_into`) and names the survivor, since the writer composed it for
  the node it named.

  `formalization` is returned beside `assessment`: the published Lean 4
  statement, its pin (toolchain and Mathlib revision), both hashes, the
  correspondence note, and the review-period end, or null when the claim has
  none; `formalization_pending`, `formalization_history`, `verification` and
  the newest `lean_checks` ride beside it. A formal statement is the graph's
  own rendering of the proposition and is what prizes, solver attempts, and
  machine-checked arguments bind to; the assessment beside it remains the
  Steward's judgment of the claim as worded.
  The node's `kind` rides on `claim`: a quantity carries a `quantity`
  record (definition, the graph's estimate with its work, stated figures,
  figures not yet recorded, readings, cut claims) and no assessment, a
  question a `question` record (standing, answers, presuppositions,
  subquestions), a cut claim `threshold_of`, and every node its `requests`,
  as `GET /claims/:id` serves them. The estimate's record (`quantity.assessed`)
  and the standing's (`question.assessment`) carry their own `id`, as a
  claim's `assessment` does.
- **`get_argument`** `{argument_id, include?, instances_limit?, instances_offset?}`
  — one argument (#541): its conclusion, stance or what it shows about a
  quantity, written form, and retirement if retired. `include` adds
  `evaluation` (current and history, each with `stale`), `premises` (with
  their standing), and `instances` (where sources make, attack or mention
  it, with each passage's `reading`). Served at `GET /arguments/:id` too.
- **`get_decomposition`** `{claim_id, max_depth?}` — the subclaim tree with
  per-node assessment status: unsettled-vs-settled structure at a glance.
  Each node carries `coverage` in a short form, so the parts of a case that
  were never examined are told apart from the parts examined and found
  sound: `examined`, and `on` listing only what the judgment was made on
  beyond public evidence (`["evidence_not_shown"]`), left out when there is
  nothing beyond it; `get_claim` on the node lists everything. A quantity or a
  question carries no assessment status whether judged or not; `coverage`
  says it for every kind.
- **`get_dependents`** `{claim_id, max_depth?}` — the walk up: everything
  that rests on the claim, ranked by importance, with each one's distance.
  Being load-bearing is not being important (constitution §19).
- **`match_claim`** `{assertion, context?, kind?}` — run a free-text assertion
  through the Matcher agent → the canonical claim it states, negates, or
  asks about (`stance`: `affirms`, `denies`, `poses`) plus its assessment,
  `matched: false` for a claim the graph does not hold, or
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
  (`verified`, `supported`, `inconclusive`, `doubtful`, `contradicted`, or
  `unknown` from the graph's assessments, `unknown` being an assessed
  finding of insufficient evidence; `unassessed` if matched but not yet
  assessed; `not_in_graph` if the graph has no such claim, a value of its
  own since #752; `undecided` if the Matcher reached no verdict for that
  claim). At most 50,000 characters and 20 judged claims a call, so one
  call stays within the `text_analysis` charge.
  A figure's verdict is `estimated` when its quantity has an estimate
  (beside it as `estimate`); a question's verdict is its standing
  (`answered`, `leaning`, `open`, `ill_posed`, `unknown`).
  Verdicts come from pre-computed assessments, not model recollection. When
  `stance` is `"denies"`, the passage asserts the claim's negation, so the
  assessment applies inverted; `"poses"` means it asks the question and
  asserts neither side.
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
- **`submit_contribution`** `{claim_id?, contribution_type, content,
  evidence_urls?, merge_target_claim_id?, argument_id?,
  merge_target_argument_id?, proposed_canonical_form?,
  request_id?}` — file any of `contribution_type`'s values: challenge,
  support, add_instance, propose_argument, propose_merge, propose_split,
  propose_edit, add_estimate (a source's figure for a quantity),
  propose_answer (a candidate answer to a question), propose_request, and
  answer_request. `claim_id` is required for every type but
  `propose_request`, which may bear on several nodes, sources, or something
  the graph does not hold yet (#724). `argument_id` makes the contribution
  about one of the node's arguments (#541): `add_instance` (a source that
  makes, attacks or mentions it), `propose_split`, or `propose_merge` with
  `merge_target_argument_id` (two arguments on the node are one); both
  arguments must be on `claim_id`'s node, else `ARGUMENT_TARGET`. An `answer_request` names the request
  it is offered for in `request_id` (the request must bear on `claim_id` and
  be open); the id is carried to the reviewer at the head of the content,
  since accepting one needs it (#723). Requires a key bound to a contributor
  identity; enters the standard Contribution Reviewer pipeline and is
  subject to suspension and reputation policy (#71). `POST /contributions`
  takes the same `request_id`.
- **`get_contribution_status`** `{contribution_id}` — the contribution in
  the shape `GET /contributions/:id` serves (an accepted proposal carries
  `became_claim_id` and `page_url`, the node it became), and the review
  decision, reasoning, and policy citations once the reviewer has ruled. A
  caller that has lost an id finds its own contributions with
  `list_contributions` and `mine: true`.
- **`get_bounty_terms`** `{claim_id}` returns the machine-readable terms of
  the live bounty on a claim, the same `terms` object `GET /claims/:id/bounty`
  serves: the amount and status, the formal statement's id, version, pin,
  and both hashes, the resolution sought (`proof`, `disproof`, or either),
  the allowed axioms and a summary of the static policy a submission must
  pass, the state of any challenge window, the rules version in force with
  its link, open-since and expiry dates, the count of submissions so far,
  and the platform's own attempt disclosure. A claim with no live bounty
  is a `NO_BOUNTY` tool error, with the claim's `page_url`. An outside solver needs nothing else
  to know what would count as a solution; the statement file itself is at
  `GET /claims/:id/formalization.lean`.
- **`get_page_analysis`** `{url}` — what the graph holds about a web page.
  The shared analysis of a public page (`GET /extension/shared/:url_hash`):
  the claims a reader of the browser extension found on it, matched into
  the graph, with a verdict on how the page words each. And `recorded`
  (`GET /extension/recorded/:url_hash`): the passages the graph itself took
  from the page when it read it as a source, each with its claim, quantity
  or question and the stance the instance records, with no verdict on the
  page; `null` when the graph has not read it. A page only the graph read
  comes back with `shared: false` and no annotations. Statuses are read
  now. The URL is normalized and hashed on the server, as the extension
  does; a page with neither is `NOT_SHARED`. Free.
- **`raise_issue`** `{kind, severity, title, body, surface?, context_refs?,
  joins?}` — report a problem with this server or its tools
  (`system_failure`, `tool_gap`) or a concrete improvement idea
  (`improvement`), never a judgment about a claim. Severity is `blocking` /
  `degraded` / `annoyance` / `idea`. Always recorded in one call: repeats
  of the same title collapse into one report with an occurrence count, and
  a new report comes back with `related`, the reports on record that read
  like it; if one of them is yours, raise again with `joins` set to its id
  and your body is added to it as a sighting instead. Free and
  attributed, and so limited to `REPORT_RATE_LIMIT_PER_HOUR` (default 5)
  reports an hour, stated in the description with its reason: each one
  takes maintainer attention nothing prices. Returns the report id. Its
  field descriptions are the agents' own (`REPORT_FIELD_GUIDANCE` in
  `src/llm/tools/report-tools.ts`), so an outside report is titled the way
  the agents' are and collapses with theirs.

### Route tools

Generated from the REST routes (see [Parity](#parity-with-the-rest-api));
each tool's description is its route's summary plus the route it runs.

**`fields` on read tools.** Every tool generated from a GET route that
answers with a JSON object takes an optional `fields`: a comma-separated
list of dotted paths (`"results.id,results.text,next_cursor"`), and the
result is pruned to them, so an agent can keep a read out of its context
without losing the parts it needs. It is the REST API's `fields` parameter
(docs/architecture.md, "The API"; `src/server/plugins/partial-response.ts`),
reaching the tool through the route's querystring schema like any other
input: a path through a list applies to each item, a path that matches
nothing is left out, a null on the way stays null, and malformed input is a
`VALIDATION_ERROR`. The export tools, whose results are not JSON objects,
do not take it (`export_claim_nanopub`, `export_claim_scasp`,
`export_claim_mira`, `get_formalization_lean`); `cite_claim` applies it to
its JSON format only. The hand-written tools above do not take it either:
`search_claims`, `get_decomposition`, `get_dependents` and `get_claim` are
defined once for callers and the graph's own agents, with the same inputs
on both sides, and `get_claim` already narrows with `include`. For a small
read of a claim, use a card.

- **Claims:** `list_claims`, `get_claim_card` (the graph's judgment of one
  node, whole, in a small fixed shape: text, kind, state, status and its
  confidence, a question's standing or a quantity's estimate and unit,
  contestation, when it was last assessed and last changed, and its page
  link, with every key always present and nulls for a node not yet
  assessed; prefer it to `get_claim` when you need where a claim stands and
  not the reasoning behind it), `get_claim_cards` (`{ids}`, comma-separated,
  up to 100: the cards in the order asked, with ids the graph does not hold
  listed in `not_found`; one call where a list of claims would otherwise
  take a `get_claim` each), `cite_claim`, `get_claim_provenance`,
  `export_claim_nanopub`, `export_claim_scasp`, `export_claim_mira`,
  `get_claim_record`, `get_assessment_history`, `get_assessment_trajectory`,
  `get_judgment_inputs` (what a node's judgment in force was made against,
  and what has changed since: premises judged again, added or removed,
  sources attached or detached, corrections and retractions on its sources;
  `get_claim` and `search_claims` carry its counts as `since_assessed`, so
  this is the read for which premises and which sources),
  `get_claim_events`, `propose_claim` (a claim, a question or a quantity by
  its optional `kind`, reviewed by the Contribution Reviewer before anything
  enters the graph).
- **Funding:** `order_assessment`, `fund_claim_assessment` (commission a
  claim's next assessment whole, at a budget you choose; what it does not
  spend comes back),
  `fund_deep_decomposition`, `list_orders`, `get_order`, `cancel_order`,
  `list_budget_jobs`, `get_budget_job`, `top_up_budget_job`,
  `cancel_budget_job`.
- **Grants and mandates:** `start_grant_conversation`,
  `list_grant_conversations`, `get_grant_conversation`,
  `get_platform_grant_conversation`, `send_grant_message`, `fund_grant`,
  `list_grants`, `get_grant`, `approve_grant_plan`, `top_up_grant`,
  `cancel_grant`, `list_mandates`, `get_mandate`, `get_mandate_allocation`
  (the mandate's operations: its operating policy, commissions, decisions
  and petitions), `fund_mandate`, `withdraw_from_mandate` (take back your
  share of a mandate's uncommitted money), `get_mandate_lookout`.
- **Correspondents (#563):** `list_correspondents` (with `claim_id`, the
  ones covering a claim), `get_correspondent`, `list_correspondent_updates`,
  `get_correspondent_update`, `poke_correspondent` (the mandate's manager).
  The Atom feed (`GET /correspondents/:id/feed`) is the same updates as
  `list_correspondent_updates`, and is not a tool.
- **Sources:** `submit_source` (reviewed before extraction), `get_source`,
  `get_source_context`, `get_source_examinations`, `get_source_document`,
  `get_job`.
- **Contributions:** `list_contributions`, `submit_appeal`, `get_appeal`,
  `list_contributors`, `get_contributor`.
- **Your account:** `get_account` (balance, entitlement, the cap list),
  `get_usage`, `list_owl_packs`, `get_owl_ledger`, `list_api_keys`.
- **Requests:** `list_requests`, `get_request`, `fund_request_work`
  (commission the work on a request whole, at a budget you choose: its
  scoping pass, or the full work; it runs at once, and what it does not
  spend comes back, all of it if the request closes first).
- **Reading with SQL:** `query_sql` (one read-only SELECT over the public
  views: nodes, assessments, edges, the ledger and commissions, messages,
  mandates and their decisions, the change stream and more; one query at a
  time per account, a daily allowance of free database time, then priced
  by the second; see the `sql` caller skill).
- **The setups agents run under:** `list_setup_parts` (every version of the
  constitution, each role prompt and each tool, with the commit it first ran
  under; filter by kind, name or hash), `get_setup_part` (one version, with
  its text when public, and the version before it to compare against),
  `get_prompt_set` (the prompt set this deployment runs: one hash over the
  constitution, every role prompt and every skill, with each one's own hash,
  to check a run's setup against), `list_features` (the optional parts of
  the product, each with whether this deployment has it on and what
  switching it off removes; a tool this document names that the deployment
  does not list belongs to a feature that is off).
- **Agent runs:** `get_run` (a run's agent, times, outcome, cost, commit and
  setup by version; a run that read private data answers `public: false`
  with its reasons and nothing else), `list_run_steps` (its steps as
  one-line summaries, a page at a time, filterable by kind or tool),
  `get_run_step` (one step in full, with its hash and the hash of the step
  before it), `verify_run_log` (whether the run's stored steps still chain
  to the seal it closed with, and where they first do not; see
  [run-log.md](run-log.md)). An assessment's `run_id` names the run that
  wrote it.
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
- `minerval://constitution` — the constitution, verbatim.
- `minerval://skills/{name}` — the caller skills (below), listed with their
  descriptions.

## Principles for callers (#620)

An agent using the graph should come away working by its principles, not
only with access to its tools. The administrators get this from the
constitution and the skills in `skills/`; callers get it, as advice rather
than governance, from the **caller skills** in `plugin/skills/`:

- `claim-checking`: which tool to use, and how to report what the graph
  says: its judgment kept apart from the caller's, uncertainty not rounded,
  the crux found through decomposition, provenance read, silence treated
  as a gap to contribute to, the graph quoted accurately even in writing
  that takes a side.
- `commissioning-research`: funding work in good faith: what kinds of
  mandate are appropriate and which the Grantmaker declines, how to hold
  the granting conversation, what is public, and what money buys.
- `sql`: how to read the graph with `query_sql`: the views, what each
  column means, and queries that stay inside the limits.
- `using-minerval`: the product itself, for an agent helping someone use
  it: the surfaces, the site page by page, how to connect over MCP, and
  how owls are bought and spent.
- `writing-from-the-graph`: facts that bear on making a document from the
  graph: sizing a territory, what importance means, pinned citations,
  requests.
- `minerval-constitution`: a reader's guide to the constitution, with the
  constitution itself bundled as `constitution.md`.
- `administrator-skills`: the administrators' own skills and role prompts,
  verbatim, with a generated catalog, so a caller can read exactly what the
  Grantmaker or the Contribution Reviewer works under.

They reach callers three ways, from one set of files:

- **As Agent Skills**, in the Claude Code / Cowork plugin.
- **As resources** (`minerval://skills/{name}`, `minerval://constitution`),
  for clients that load resources but not skills.
- **In the initialize instructions** (`MCP_INSTRUCTIONS` in
  `src/mcp/caller-skills.ts`), the shortest form of the principles, which
  every client is shown, with pointers to the resources.

The Assistant (#646, docs/accounts.md) is a caller too. Its tools are this
server's, built in process for its user at the trust of an API key
(`src/llm/tools/assistant-tools.ts`), so it can do nothing a user's own
agent over MCP could not, and it loads these same files with `load_skill`.
A route added to `ROUTE_TOOLS` reaches it with no further change, except
that a tool which is not a read must be classified there as held for the
user or as running without asking, with the reason;
`tests/unit/llm/assistant-tools.test.ts` fails until it is. Its own
conversations are readable over MCP (`list_assistant_conversations`,
`get_assistant_conversation`, `get_assistant_allowance`), and pages are
saved and read there (`save_page`, `list_pages`, `get_page`); deleting a
page is excluded, as the user's own act. Writing to one is
excluded (an agent that wants an agent can delegate to its own), and so is
releasing a held action or changing what is allowed, which need the signed-in
user so that the Assistant cannot press its own cards.

### Keeping them current

The skills describe things that change: the constitution, tool names, the
administrators' skills and prompts, the site. Three checks in
`tests/unit/plugin/caller-skills.test.ts`, and a fourth in
`tests/unit/plugin/using-minerval.test.ts`, keep them from drifting:

- **Vendored copies.** The constitution and the administrators' skills and
  role prompts are copied into `plugin/skills/` (a plugin ships only its own
  directory) by `npx tsx scripts/sync-frontend-content.ts`, the same script
  that vendors them into `web/content/`. The test regenerates them into a
  temporary directory and fails on any difference. So changing the
  constitution, a skill in `skills/`, or a role prompt means re-running the
  script in the same change.
- **Tool names.** Every tool a caller skill or the instructions name (a
  backticked `verb_noun`) must be a registered native tool or in
  `ROUTE_TOOLS`. Renaming a route tool fails here until the skills follow.
- **Constitution sections.** Every `§N` a caller skill cites must be a
  section of the constitution. Renumbering fails here until the skills
  follow.
- **Site pages.** `using-minerval` lists the site's pages. Every page under
  `web/app` must be in its table or excluded in the test with a reason, and
  every route in the table must exist. Adding, moving or removing a page
  fails here until the skill follows.

What no test catches is a skill that still names the right things but
describes them wrongly. When you change how a tool behaves, how the
Grantmaker decides, or what a status means, read the caller skills that
mention it and update them in the same pull request.

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
