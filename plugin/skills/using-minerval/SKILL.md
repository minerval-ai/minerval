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
| `/ask/pages/:id` | A page saved for the user with `save_page`: markdown with embedded nodes shown as the graph holds them now and marked where they have moved since. Edit, export as markdown, delete. Private to the user |
| `/claims` | Search and browse nodes, with filters for kind, assessment, importance, prizes, type and topic |
| `/claims/:id` | A node: status or estimate or standing, the assessment and its reasoning, findings, decomposition, provenance, citation, contributions, and the funding disclosure. Order an assessment, deepen the subtree, or contribute from here |
| `/claims/:id/map`, `/claims/:id/history` | The decomposition as a map; every past assessment |
| `/claims/:id/prize/claim`, `/claims/:id/attempts/:attemptId` | Claim an open prize on a formal statement; one solver attempt |
| `/arguments/:id`, `/sources/:id` | One argument with its evaluation and instances; one source with what was read from it |
| `/runs/:id`, `/runs/:id/steps/:seq` | One agent run, linked as "the run" beside a verdict: its setup by version and its steps; one step in full. A run that read private data is withheld, with the reasons (`get_run`, `list_run_steps`, `get_run_step`) |
| `/requests`, `/requests/:id` | Open requests for work, each fundable |
| `/mandates`, `/mandates/:id` | Public mandates; one mandate's plan, spend, policy and decisions, with a box to back it |
| `/findings`, `/findings/:id`, `/tags` | What the administrators noted in their work: a list to search and to filter by topic, the claim's status, importance, who noted it and when; one finding, its account with the records it links beside it; topics |
| `/prizes`, `/prizes/rules` | Open prizes and their rules |
| `/account` | Owl balance, packs and history; prizes; grants; ordered assessments and funded jobs; API keys; usage by agent and key; contributor standing |
| `/account/grants`, `/account/grants/new`, `/account/grants/:id` | The user's mandates; a direct conversation with the Grantmaker; one grant |
| `/account/jobs/:id` | One funded job, such as a deep decomposition |
| `/contributors`, `/contributors/:id`, `/contributions/:id` | Contributors; one contributor; one contribution with its review |
| `/docs` and under it | The constitution, architecture, every agent's prompt, the skills, setup versions, evals |
| `/about`, `/rewards`, `/contributor-terms`, `/terms`, `/privacy` | About the project; the rewards policy; terms |
| `/signin` | Sign in or create an account |

## Owls in the interface

Bought in packs on `/account` (larger packs are discounted), where the
owl history is also listed. New accounts start with 5 owls and get 1 a
month. One owl covers $1.00 of metered work.
