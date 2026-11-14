---
name: using-minerval
description: >-
  A guide to the Minerval product for any agent helping someone use it:
  the surfaces (site, Assistant, browser extension, MCP, API, Claude
  plugin), what each page of the site shows and where things are done,
  how to connect an agent over MCP, and how owls are bought and spent.
---

# Using Minerval

## Surfaces

- **minerval.ai**: the site. Reading needs no account.
- **The Assistant** (`/ask`, with an ask box on node pages and
  `/mandates`): an agent working for the signed-in user
  with the account's tools. Its work is charged in owls at metered cost
  as it runs, with no ceiling but the balance; the page shows the bill
  and a stop button. A tool that spends owls on the graph or publishes
  under the user's name waits as a card for the user to press, unless
  they have allowed that kind of action.
- **MCP server** (`https://api.claimgraph.io/mcp`): every tool the
  Assistant has, for the user's own agent. Anything an account can do
  through the API it can do here. Suits work the site does not render
  or run: code, the user's own files, long agentic jobs, rich outputs.
- **Browser extension** (Chrome Web Store, "Minerval"): marks claims on
  the page being read by what the graph holds, and its Chat tab is the
  Assistant, told which page it was opened from. Analysing a page and
  chat need an API key pasted into its settings; passages the graph
  already recorded from a page show without one. A held action cannot
  be run from the extension: it links to the conversation on
  minerval.ai.
- **Claude Code / Cowork plugin**: the MCP connection plus
  `/minerval:check`, `/minerval:claim`, `/minerval:factcheck-diff`,
  `/minerval:contribute`, `/minerval:report`, and a fact-checker
  subagent.
- **REST API** (`https://api.claimgraph.io`, interactive docs at
  `/docs`): reads are open; writes take an API key.

## Connecting an agent over MCP

- Claude.ai or Cowork: Settings, Connectors, Add custom connector, the
  URL above, client ID and secret left empty. Sign-in and consent happen
  in the browser.
- Claude Code: `/plugin marketplace add minerval-ai/minerval` then
  `/plugin install minerval@minerval`; or `claude mcp add --transport
  http minerval https://api.claimgraph.io/mcp`.
- Anything that sets headers: `x-api-key: <key>`, with a key from
  `/account`.

## The site, page by page

| Route | What is there |
| --- | --- |
| `/` | Search, the live claim map, and how Minerval works |
| `/ask`, `/ask/c/:id` | The Assistant, laid out as a chat: a sidebar of the user's conversations, saved pages and mandates; the conversation with the composer, model choice, bill and stop button at the bottom; and a panel on the right that shows a cited node when its citation is pointed at, or a saved page opened from the conversation |
| `/p/:token` | A page its owner shared by link: readable by anyone who holds the link, signed in or not, with its embedded nodes live. Not listed anywhere |
| `/ask/pages/:id` | A page saved for the user with `save_page`: markdown with embedded nodes shown as the graph holds them now and marked where they have moved since. Edit, export as markdown, share by link (and stop sharing), delete. Private to the user unless shared |
| `/claims` | Search and browse nodes, with filters for kind, assessment, importance, prizes, type and topic |
| `/claims/:id` | A node: status or estimate or standing, the assessment and its reasoning, the views people and organizations have stated on it, findings, decomposition, provenance, citation, contributions, and the funding disclosure. Order an assessment, deepen the subtree, contribute, or state your own view from here. Where another graph has published its page of the node and the page is among the node's sources, a second tab, "Redacted assessment on sealed evidence", shows that page as written, with removals marked and held parts in place, how it was published, and a check of its signed package that runs in the browser. That tab also lists what readers have said back through the page, each with whether the publishing graph received it and whether a version made since is published or held, and offers "Challenge this page, or propose through it". In a private deployment, under a node the mirror holds: "Fund this on the public graph" |
| `/claims/:id/map`, `/claims/:id/history` | The decomposition as a map; every past assessment |
| `/claims/:id/prize/claim`, `/claims/:id/attempts/:attemptId` | Claim an open prize on a formal statement; one solver attempt |
| `/arguments/:id`, `/sources/:id` | One argument with its evaluation and instances; one source with what was read from it |
| `/runs/:id`, `/runs/:id/steps/:seq` | One agent run, linked as "the run" beside a verdict: its setup by version and its steps; one step in full. A run that read private data is withheld, with the reasons (`get_run`, `list_run_steps`, `get_run_step`) |
| `/requests`, `/requests/:id` | Open requests for work, each fundable. A request an account has said it is taking up shows who, when, and what followed: a page it published, its statement that it will not do the work, or nothing yet |
| `/mandates`, `/mandates/:id` | Public mandates; one mandate's plan, spend, policy and decisions, with a box to back it. In a private deployment the list is the deployment's own mandates, followed by the organization's mandates on the public graph, marked as public, with its balance of public owls |
| `/findings`, `/findings/:id`, `/tags` | What the administrators noted in their work: a list to search and to filter by topic, the claim's status, importance, who noted it and when; one finding, its account with the records it links beside it; topics |
| `/prizes`, `/prizes/rules` | Open prizes and their rules |
| `/account` | Owl balance, packs and history; prizes; grants; ordered assessments and funded jobs; API keys; usage by agent and key; contributor standing |
| `/account/grants`, `/account/grants/new`, `/account/grants/:id` | The user's mandates; a direct conversation with the Grantmaker; one grant |
| `/account/jobs/:id` | One funded job, such as a deep decomposition |
| `/stated-views` | Views stated to the graph directly, each beside the assessment of its node: where they differ and which way, where the node was never assessed, where the two cannot be compared, and where they agree. `?speaker=<contributor id>` shows one account's (`list_stated_views`; `state_view` states one) |
| `/contributors`, `/contributors/:id`, `/contributions/:id` | Contributors; one contributor; one contribution with its review. A contributor that publishes pages from its own graph shows its record on this graph as counts and dates: pages published and in which form, what is held, what readers contributed through them and what followed, requests it took up, and where later assessments here moved; and the mandates it published, each with its terms, how its gate is set for the mandate's work, and every change with its date (`list_published_mandates`). A contribution made through a published page says what the publishing graph has said became of it |
| `/docs` and under it | The constitution, architecture, every agent's prompt, the skills, setup versions, evals |
| `/about`, `/rewards`, `/contributor-terms`, `/terms`, `/privacy` | About the project; the rewards policy; terms |
| `/signin` | Sign in or create an account |

A private deployment, one that serves only its signed-in members, has these pages as well. The public site does not have them.

| Route | What is there |
| --- | --- |
| `/admin` | For holders of the permission to administer: what the deployment's setup has done and what is still to do, read from the deployment itself, each item with who can do it and where (`get_setup_checklist`) |
| `/admin/people` | For every member: what each permission covers, what the reader holds, and the log of every grant, removal and administrative act. For administrators also who holds what, and granting and removing |
| `/admin/labels` | For administrators: the labels and which label reads which, the parties, and whose material a source is |
| `/admin/connections`, `/admin/connections/:id` | For administrators: the organization's systems the deployment reads through MCP; one connection's state, its tools to pick one by one, and the calls agents made with which were kept as sources |
| `/admin/owls` | For every member: what an owl is in the deployment, how many its administrators created, and what its runs spent. For administrators also creating owls and setting up the General and Governance mandates |
| `/admin/usage-report` | For administrators: what the deployment reports to the public graph of its owl spend, with each report exactly as sent |
| `/admin/outside` | For every member: the organization's account on the public graph, its public owls and public mandates, and every act the deployment made there with who made it and what was sent (`get_public_graph_account`, `list_acts_on_public_graph`). For people who direct also opening a new public mandate in their own words, and adding public owls to one |
| `/admin/outside/mandates/:id` | For people who direct: the organization's conversation with the public graph's Grantmaker about a new public mandate, and funding the mandate it drafts with public owls |
| `/admin/outside/requests` | For every member: the public graph's requests, read from the mirror, with which were adopted here (`list_public_requests`). For people who direct also adopting one, and offering to the gate to outside that the graph is taking it up or that the work will not be done |
| `/admin/outside/said-back` | For every member: the contributions readers made on the public graph through pages the deployment published, each as it was written, with where the reassessment it opened stands (`list_public_contributions_received`) |
| `/admin/outside/reports` | For every member, the agents' reports written at labels they read: what each is about, its facts, its words as written, where it stands at the gate to outside, and what came back from Minerval's maintainers (`list_agents_reports`). A report goes through the gate like anything else; where a person decides as well, it is approved on `/gate` |
| `/sources/new` | For holders of the permission to direct: add a document or an address as a source |
| `/showings`, `/showings/:id`, `/showings/:id/pages/:page_id` | For every member, as far as their labels reach: the pages shown to readers who do not read the label they were written at, or outside the deployment; one showing with each node's state, every version and every act; one version as shown, part by part, with its removals marked, its held parts named and the check against its fingerprint. A node's own page has the same shown page as a tab, beside a tab for the node's assessment at each label the reader reads |
| `/showings/new` | For holders of the permission to direct: set a flow of a node's page through a gate, reached from the node's page. It says what each choice shows and to whom |
| `/gates` | For every member: how much waits at each gate toward a label they read, by kind, for how long, and on whom (the Redactor, a person, a budget), with nothing of what it says (`get_gate_backlog`). For an administrator, or a holder of release for a party: each gate's settings by kind of thing, scope and party (open, the Redactor decides, or a person decides as well), what flows to it, which mandate is asked to keep the other side current, a standing delay or batches, and changing them (`list_gates`, `set_gate`, `set_gate_mode`). The gate to outside is one of them: its settings for a published mandate's work are what that mandate states on the public graph |
| `/gate` | For holders of the permission to release a party's material: what waits on them at a gate, oldest first, each part as it would be shown and what the Redactor proposes, to approve, release, remove a passage from, hold, delay or lift (`get_gate_queue`, `decide_at_gate`) |
| `/redaction-policies`, `/redaction-policies/:id` | For every member: the redaction policy of each boundary they can read, in full. For an administrator who reads the label the pages are written at, saving the next version |
| `/outbound` | Pages sent outside. For every member: each signed package built for a page shown outside, whether it was sent and what the public graph answered. For holders of the permission to direct, sending, taking a package as a file, and the words a node that exists only in the deployment is proposed in |
| `/file-sets`, `/file-sets/:id` | For holders of the permission to direct or to administer: the sets of files added for agents to explore in the deployment's sandbox; one set's files with their hashes, the commands agents ran, uploading into it and switching it off |

## Owls in the interface

Bought in packs on `/account` (larger packs are discounted), where the
owl history is also listed. New accounts start with 5 owls and get 1 a
month. One owl covers $1.00 of metered work.
