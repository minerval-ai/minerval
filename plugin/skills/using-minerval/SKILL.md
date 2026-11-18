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
  Reads give the site's link for what they return (`page_url` on a node,
  a mandate or a granting conversation; `funder_url` on a mandate for
  its funder, their page with its Grantmaker): link those rather than
  building paths from the table below.
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
  `/docs` on that host, guides at minerval.ai/docs/api): reads are open;
  writes take an API key.

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
| `/` | Search, the live claim map, and how Minerval works. In a private deployment, the deployment's own most-used topics, and the map opened on the most important assessed node the reader can read (none until something is assessed) |
| `/ask`, `/ask/c/:id` | The Assistant, laid out as a chat: a sidebar of the user's conversations, saved pages and mandates; the conversation with the composer, model choice, bill and stop button at the bottom; and a panel on the right that shows a cited node when its citation is pointed at, or a saved page opened from the conversation. In a private deployment with more than one label, a new conversation names the label the Assistant works at before its first message; starting a mandate and proposing a node on `/claims` ask the same |
| `/p/:token` | A page its owner shared by link: readable by anyone who holds the link, signed in or not, with its embedded nodes live. Not listed anywhere |
| `/ask/mandates/new`, `/ask/mandates/c/:id`, `/ask/mandates/:id` | A conversation with a Grantmaker, in the same chat layout and listed in the Ask sidebar under Mandates. `new` starts a mandate: the user says what they want, the Grantmaker drafts it and quotes a cost, and a card offers to fund it; talking costs nothing, and the conversation is public from its first message, as the page says before it is sent. `c/:id` is a draft not yet funded. `:id` is the manager's conversation with the Grantmaker of a mandate they fund, charged to the mandate's budget, with the mandate at a glance beside it (budget, pace, reserve, open runs, whether its Grantmaker is waiting) and the controls to approve the plan, top up and withdraw; the pace is changed by telling the Grantmaker. A Grantmaker works for the graph, not for the user, and is a different agent from the Assistant |
| `/ask/pages/:id` | A page saved for the user with `save_page`: markdown with embedded nodes shown as the graph holds them now and marked where they have moved since. Edit, export as markdown, share by link (and stop sharing), delete. Private to the user unless shared |
| `/claims` | Search and browse nodes (claims, questions, quantities and lists), with filters for kind, assessment, importance, prizes, type and topic |
| `/claims/:id` | A node: status or estimate or standing (for a list, constitution §7b: its criteria, its fidelity, whether it is stale, its entries in order with each one's own verdict and why it qualifies, and what was considered and left out), the assessment and its reasoning, the views people and organizations have stated on it, findings, decomposition, provenance, citation, contributions, and the funding disclosure. Order an assessment, deepen the subtree, contribute, or state your own view from here. Where another graph has published its page of the node and the page is among the node's sources, a second tab, "Redacted assessment on sealed evidence", shows that page as written, with removals marked and held parts in place, how it was published, and a check of its signed package that runs in the browser. That tab also lists what readers have said back through the page, each with whether the publishing graph received it and whether a version made since is published or held, and offers "Challenge this page, or propose through it". In a private deployment, under a node the mirror holds: "Assess it here", an assessment at one of the person's own labels beside the public one, paid in the deployment's owls and sent nowhere; and "Fund this on the public graph" |
| `/claims/:id/map`, `/claims/:id/history` | The decomposition as a map; every past assessment |
| `/claims/:id/prize/claim`, `/claims/:id/attempts/:attemptId` | Claim an open prize on a formal statement; one solver attempt |
| `/arguments/:id`, `/sources/:id` | One argument with its evaluation and instances; one source with what was read from it |
| `/runs/:id`, `/runs/:id/steps/:seq` | One agent run, linked as "the run" beside a verdict: its setup by version and its steps; one step in full. A run that read private data is withheld, with the reasons (`get_run`, `list_run_steps`, `get_run_step`) |
| `/requests`, `/requests/:id` | Requests for work: the most important first (by the importance of the page each would settle), with where that page stands now, who could do the work, and whether it waits for a funder; ways in for what waits for a funder, what is put to a particular party, what is being worked on and what was met; searched, and narrowed by state, topic, whom it is asked of and funding (`list_requests` with `order`, `tag`, `asked`, `waiting`, `facets`). One request: its ask headed by its first sentence with its parts listed, what it would settle and why that matters, what would satisfy it and who could do it, and at the side a button to take it up (`take_up_request`), a box to fund the work, and a link to contribute what it asks for. A request an account has said it is taking up shows who, when, and what followed: a page it published, its statement that it will not do the work, or nothing yet |
| `/mandates`, `/mandates/:id`, `/mandates/:id/updates` | The list of mandates, in tabs (the user's own when signed in, the ones Minerval runs, everyone's), each searched by title or objective, narrowed by state (active, paused, finished, and for the user's own what needs them), ordered, and read 25 at a time, with a button to start one; one mandate: its title, who funds it and its figures (budget, completed work, open runs, pace) first, then what is happening now (its Grantmaker's current direction and latest update, what its Grantmaker waits on, links to its latest sittings on the run log, where one under way can be watched step by step, and open work), the mandate itself (its objective, with the rest of its text and its strategy folded under it), its actions with each standing order's state, its agents with the instructions each works under, its spending (pace, reserve, backers, a box to back it), its completed work by kind (assessments of claims, questions and quantities, sources read, requests, research, nodes proposed, mandates funded) with its findings, and its history. Its manager also sees what waits on them, with approve, top up and withdraw; every update its Grantmaker has left. In a private deployment, people who direct can offer an active mandate to the gate to outside ("Offer this mandate on the public graph"), so that it stands on the organization's record there and public requests can be addressed to it. In a private deployment the list is the deployment's own mandates, followed by the organization's mandates on the public graph, marked as public, with its balance of public owls |
| `/mandates/conversations/:id` | A granting conversation as anyone may read it: the transcript between a Grantmaker and the funder (shown as "a reader" unless they chose to be named), whether it was funded, declined or neither, with a link to the mandate it became. Every conversation begun since directing the public graph was made public is here from its first message; an older one, whose funder was promised privacy, is not |
| `/findings`, `/findings/:id`, `/tags` | What the administrators noted in their work: a list to search and to filter by topic, the claim's status, importance, who noted it and when; one finding, its account with the records it links beside it; topics |
| `/prizes`, `/prizes/rules` | Open prizes and their rules |
| `/account` | Owl balance, packs and history; prizes; grants; ordered assessments and funded jobs; API keys; usage by agent and key; contributor standing. In a private deployment with more than one label, a new key names the label it works at for its life, and the key table shows each key's label |
| `/account/jobs/:id` | One funded job, such as a deep decomposition |
| `/account/organizations` | The organizations the account belongs to, with its role in each (`list_organizations`); making one, which costs nothing and gives nothing; and the requests that name the account as first admin of a shared login becoming an organization, to accept (`list_account_conversions_for_me`) |
| `/account/organizations/:id` | One organization, for its members: overview (its public owls, members, and the old API keys a converted account still holds, `list_organization_old_keys`), members and invitations (`list_organization_members`, `list_organization_invitations`), its connected deployments, with the hosting each states, its grants and the writes it signed lately (`list_organization_deployments`), and its log (`get_organization_log`). For its admins also: renaming, inviting, changing roles and removing; Public acts, where an admin acts as the organization (opening a public mandate in conversation with the public Grantmaker and funding it, adding owls to its mandates, paying for a claim's assessment), recorded under the organization in public and under the admin on its log; and Billing, buying owls for it. Changes are made from a signed-in session only, never by a tool |
| `/account/convert` | Make a login several people share into an organization in place, naming a person's own account as first admin, who accepts from their session (`get_account_conversion`). The account keeps its id, record, pages, owls and keys; the shared login stops reaching it |
| `/connect` | The link a private deployment shows when it asks to be connected to an organization: the code, the key id's first eight characters, the name it suggests and the hosting it states, and for an admin of an organization, approving it with the grants they choose (`read_feed`, `report_usage`, `publish`, `act`) or denying it. Approve only a deployment of one's own that shows that code now |
| `/join/:token` | An invitation link to an organization: what it is for, and accepting it as oneself. Used once |
| `/stated-views` | Views stated to the graph directly, each beside the assessment of its node: where they differ and which way, where the node was never assessed, where the two cannot be compared, and where they agree. `?speaker=<contributor id>` shows one account's (`list_stated_views`; `state_view` states one) |
| `/contributors`, `/contributors/:id`, `/contributions/:id` | Contributors; one contributor; one contribution with its review. A contributor that publishes pages from its own graph shows its record on this graph as counts and dates: pages published and in which form, what is held, what readers contributed through them and what followed, requests it took up, and where later assessments here moved; and the mandates it published, each with its terms, how its gate is set for the mandate's work, and every change with its date (`list_published_mandates`). A contribution made through a published page says what the publishing graph has said became of it |
| `/docs` and under it | The documentation, with a sidebar on every page. `/docs/connect`: adding the MCP server to a client. `/docs/concepts`: claims, quantities, questions, the statuses and what the numbers mean. Guides: reading a claim, fact-checking text, following what changes, SQL, citing and embedding, contributing, commissioning work, proofs and prizes, verifying a run. `/docs/auth`, `/docs/plugin`, `/docs/extension`. Reference: `/docs/tools` (every MCP tool, read from the server, with what it costs and the REST route it runs), `/docs/api`, resources and skills, owls and pricing, errors. The constitution, architecture, every agent's prompt, the skills, setup versions and evals. Self-hosting; `/docs/running-a-private-graph`, the guide for whoever runs a private deployment once it is installed (labels, people, budget, material, questions, what to say in public, bringing in another organization); and members-only deployments |
| `/about`, `/rewards`, `/contributor-terms`, `/terms`, `/privacy` | About the project; the rewards policy; terms |
| `/signin` | Sign in or create an account |

A private deployment, one that serves only its signed-in members, has these pages as well. The public site does not have them.

| Route | What is there |
| --- | --- |
| `/inbox` | For every member: what waits on them, from every part of the deployment, each with the act that answers it (a decision at the gate, a setup step, an unpaid redaction, a public request, a reader's reply, a package to send), beside the deployment's state, its owls and the newest acts of the log. A sidebar on every page of a private deployment lists the pages a member's permissions open, the graph's own among them |
| `/gate` | Review. For the people who consent for a party: what waits on them at a gate, a tab for each party, oldest first; the selected item as a document, each part as it would be released with its removals struck through, what the Redactor proposes, and the decisions to consent, approve, remove a passage under one of the boundary's categories, hold, delay or lift (`get_gate_queue`, `decide_at_gate`) |
| `/releases`, `/releases/:id`, `/releases/:id/pages/:page_id` | Releases. For every member, as far as their labels reach: the pages released to readers who do not read the label they were written at, or outside the deployment, with one status for each (redact, audit, consent, released); one release with its versions by node, the nodes it covers, what is leaving for outside and every act; one version as released, part by part, with its removals marked, its held parts named and the check against its fingerprint (`list_releases`, `get_release`, `get_release_page`). The old addresses under `/showings` redirect here. A node's own page has the same released page as a tab, beside a tab for the node's assessment at each label the reader reads |
| `/releases/new` | For holders of the permission to direct: release a node's page through a boundary, once or standing, finding the node by search or reached from the node's page (`set_page_flow`). It says what each choice releases and to whom |
| `/gates`, `/gates/:id` | Boundaries. For every member: each boundary between a label and another (or outside), how much waits at its gate and on whom (the Redactor, a person, a budget), with nothing of what it says (`get_gate_backlog`). One boundary: what waits; its rules by kind of thing, scope and party (open, the Redactor decides, or a person decides as well), with adding and ending one (`list_gates`, `set_gate_mode`); its redaction policy in full, with every version and who saved each (`list_redaction_policies` with `all`), saved as the next version by an administrator who reads the label the pages are written at; and its settings, what flows to it, which mandate keeps the other side current, sending outside as released (`set_gate`). The gate to outside is one of them: its settings for a published mandate's work are what that mandate states on the public graph |
| `/sources` | For holders of the permission to direct or to administer: the sources added at the labels they read, with whose material each is and where it stands, and adding a document by its address or its pasted text (`list_sources`) |
| `/file-sets`, `/file-sets/:id` | For holders of the permission to direct or to administer: the sets of files added for agents to explore in the deployment's sandbox; one set's files with their hashes, the commands agents ran, uploading into it and switching it off |
| `/admin/connections`, `/admin/connections/:id` | For administrators: the organization's systems the deployment reads through MCP; one connection's state, its tools to pick one by one, and the calls agents made with which were kept as sources |
| `/admin/outside` | The public graph. For every member: this deployment's connection to minerval.ai, with the organization it belongs to there and the grants it holds (`get_public_graph_connection`), and for administrators connecting it (a code an admin of the organization approves on minerval.ai) and disconnecting it; the organization's account on the public graph, its public owls, whether and under what its signing key is registered there, its public mandates, and every act the deployment made there, page sends among them, with who made it and exactly what was sent (`get_public_graph_account`, `list_acts_on_public_graph`). For people who direct also the drafts of public mandates not yet funded beside the funded ones, each linked to its conversation with the public Grantmaker (`list_public_mandate_conversations`), opening a new public mandate in their own words and adding public owls to one; for administrators, registering the deployment's key on the public graph, which signs the registration for the organization's account there and sends it through that account |
| `/admin/outside/mandates/:id` | For people who direct: the organization's conversation with the public graph's Grantmaker about a new public mandate, and funding the mandate it drafts with public owls |
| `/admin/outside/requests` | For every member: the public graph's requests, read from the mirror, with which were adopted here (`list_public_requests`). For people who direct also adopting one, and offering to the gate to outside that the graph is taking it up or that the work will not be done, with a note |
| `/admin/outside/said-back` | Replies. For every member: the contributions readers made on the public graph through pages the deployment published, each as it was written, repeats counted once, with where the reassessment it opened stands and the label of the page it was made through (withheld from a reader who does not read it), and for funders ordering that reassessment at that label (`list_public_contributions_received`) |
| `/outbound` | Outbox. For every member: each signed package built for a page released outside, whether it was sent and what the public graph answered, and the agents' reports written at labels they read, where each stands at the gate to outside and what came back from Minerval's maintainers (`list_agents_reports`). For holders of the permission to direct, sending, taking a package as a file, and the words a node that exists only in the deployment is proposed in |
| `/admin` | Health. For holders of the permission to administer: whether agent work runs, what needs someone now, each in a line that says whether the deployment's operator or an administrator puts it right, each part of the deployment's setup as it stands, and the deployment's own checks (`get_setup_checklist`) |
| `/admin/people` | For every member: what each permission covers and what the reader holds. For administrators also every member's access, the groups, who signed in holding nothing, and granting and removing |
| `/admin/activity` | For every member: the log of every grant, removal and administrative act, by day, to filter by kind, person and words (`get_permission_log` with `type`, `by`, `q`) |
| `/admin/labels` | For administrators: the labels and which label reads which, and which model providers and outside services each label may be sent to, as one table to tick (cleared there by a holder of `clear_providers`, unless the deployment's settings fix it) |
| `/admin/parties` | For administrators: the parties whose material sources are, who consents for each, and saying whose material a source is |
| `/admin/budget` | For every member: what an owl is in the deployment, how many its administrators created, what its runs spent, and the General mandate at each label. For administrators also creating owls, setting up a General mandate, the model prices, and what the deployment reports privately to Minerval of its owl spend, for billing on the metered price, with each report exactly as sent |

## Owls in the interface

Bought in packs on `/account` (larger packs are discounted), where the
owl history is also listed. New accounts get a signup grant and a small
grant each month they use the graph; `get_account` gives both
(`entitlement.signup_grant_owls`, `entitlement.monthly_grant_owls`), since a
deployment sets them. One owl covers $1.00 of metered work.
