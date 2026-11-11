# Allocating attention in claimspace — the owl economy

The living design document for Minerval's resource-allocation stack: how the
system decides where to spend scarce intelligence, how users and funders
direct it, and what the money mechanics may and may not touch. The vision it
implements is the essay *Allocating Attention in Claimspace*; the
constitutional frame is §19's "Allocating Attention and Paid Attention"
section.

## The standard

Every piece of work on the graph is an agent's run, and a run happens when
someone **commissions** it: decides the work is worth doing, sets the
budget it should have to be done properly, and pays that budget whole. The
run starts at once; its agent is told its budget and works to it; what it
does not spend goes back to whoever paid. One mechanism does this for every
funder, built as a hard split between MECHANISM and JUDGMENT.

**The mechanism is the action ledger** (`actions` +
`action_allocations`): one row per piece of work the system could do
(assess this claim, ingest that source, curate that region, audit that
decision), and money placed on those rows. A commission is an allocation
with `commissioned_by` set, a budget, the brief its payer wrote and the
reason it gave (src/services/commission-service.ts). The rule is short:

    a row with a live commission runs;
    a row whose allocations cover its estimated cost runs (a mandate's
      own upkeep, below);
    nothing else anywhere decides what runs.

Settlement is the ledger's: the run's metered cost is consumed from the
allocations that paid for it and the rest is released to each payer
(`completeAction`). The ledger holds no formula and no valuation. Whether
work is worth its cost is a judgment, made by agents and people who can be
asked why.

**The judgment is each payer's own.** A person commissions what they want
looked at. A running agent commissions other agents' runs from its own
budget. A mandate decides through agents: its Grantmaker writes an
**operating policy** in prose, and its **program officers** commission work
under it, within a limit the policy states, sending the rest to the
Grantmaker. A mandate's SCOPE IS ITS WORDS: which work falls under it is a
judgment its agents make, never a keyword filter's. Every decision is
logged with its reason (`mandate_decisions`) and shown on the mandate's
page.

Budgets are set at the high end of what work of that kind costs (the
costing skill), because a run that has what it needs finishes the work and
gives back the rest. When the work turns out to need more, its agent
**petitions** the mandate paying for the run and gets the answer in the
run. Neither a budget nor a petition is ever a verdict input: what a
mandate chose to pay for orders work and selects effort, and appears
nowhere in an assessment.

## Mandates start with a planning pass

A mandate under the agent policy, and every mandate another mandate
spawns, starts in `planning`: the ledger opens a `grant_planning` action,
self-funded from its escrow, and the engine executor runs the mandate's
Grantmaker in planning mode (llm/agents/grantor.ts). Nothing else runs and
no owl is spent until the funder approves the plan it proposes. The
planner has the review pass's survey affordances, because the first
territory survey is the same job as every later one: the graph
(search_claims, query_sql, list_requests) AND the open web (web_search,
read_page), the live price list (cost_sheet, from the costing skill), and
the mandate's workspace, so its survey notes become the mandate's opening
working memory. What it does not have is anything that spends or moves
money before the funder approves: no commissions, operating policy,
lookouts, contributions, research, or money moves. Its briefing is the mandate's
words, with any declared scope claim or query as a search aid rather than
the scope; a mandate told to "map the nutrition literature" reaches its
planner with no scope claim at all, and the planner's job is to find the
sources and propose them as ingest items. The plan carries every kind of
work a mandate can fund, is validated like any other, and is held to the
escrow at the same estimate the funder was quoted. The planning pass works
to the platform's default for a Grantmaker's pass
(`DEFAULT_REVIEW_PASS_BUDGET_OWLS`, 5), since it runs before the mandate
has an operating policy to name its own figure, and its briefing says so
("What a pass works to", below). The three modes of a
mandate's Grantmaker (the granting conversation, the planning pass, the
review pass) share one toolbox (llm/tools/mandate-tools.ts).

## Mandates steward themselves: the review pass

There can be no human bottleneck between a funded mission and the work.
On a cadence (and on demand — see continue_review), the ledger opens a
`mandate_review` action for every active mandate, self-funded from its
escrow, and the engine executor runs the mandate's Grantmaker in review
mode (llm/agents/mandate-review.ts) with the affordances anyone entrusted
with a budget and a mission would need:

- **read back what its money did**: the briefing opens with what the
  mandate commissioned since the last review and how those runs used their
  budgets, by kind; the outcomes on the nodes it paid for; the petitions it
  heard and how its officers answered; runs that spent their whole budget
  without asking; its officers' decisions and what deciding cost; the
  messages waiting on the nodes it pays for; and what its lookouts raised
  and commissioned (src/services/mandate-reflection-service.ts). It starts
  from what happened, not from scratch, and fixes causes in the operating
  policy rather than cases;
- **survey the territory**: the graph (search_claims, query_sql) AND the
  open web (web_search): finding where the good physics
  papers are is the agent's job;
- **a workspace** (`grants.workspace`): the agent's own durable working
  document, read back in full every pass — its map of the territory,
  source backlog, strategy. Mandate-scale missions are impossible
  without working memory. update_workspace replaces it whole, appends to
  it, or rewrites one section, so a large workspace never has to be
  re-emitted to change a line;
- **spend**: revise the operating policy its program officers carry out
  (write_operating_policy), commission work directly (commission), and
  take back a regrant (withdraw_regrant). This is its spending judgment;
- **see what its money bought** (allocation_report, the mandate's
  operations: policy, commissions, decisions and petitions;
  list_funded_assessments, claims_from_source, pipeline_report);
- **launch research and fund requests** (delegate_research,
  get_research_run, list_requests, fund_request), the same instrument and
  the same request funding the owner's chat carries;
- **grow its own plan** (extend_plan): append the ingest/assess items it
  discovered; each is priced, escrow-bounded, and executes through the
  ledger, a stewarding item as a standing order the mandate commissions
  (below, "A plan item is a standing order");
- **pace itself** (set_daily_rate), **add to the pass in hand**
  (add_to_pass_budget) and **chain passes** (continue_review): a pass
  that has more to do adds to its own budget from the escrow, or ends and
  runs another immediately; both are funded out of the mandate's day like
  the rest of its work, and the briefing says what the day has left: cost
  discipline lives in the money the agent can see, never in narrowed
  affordances;
- **tell the funder** (note_to_funder): what only the funder can decide
  (a move above the pass's cap, a bounty confirmation, a top-up), kept on
  the mandate and shown in the funder's chat and grant_overview;
- **move money** (regrant, spawn_mandate — below) and **close the
  mission** (complete_mandate): an exhausted plan is a waypoint, not an
  end; only the agent's judgment (or the funder) completes an
  agent-stewarded mandate;
- **keep watch between passes** (spawn_lookout, list_lookouts,
  update_lookout, poke_lookout — "Lookouts" below): the briefing lists
  every lookout the mandate funds, its precision, and every flag raised
  since the last pass.

Every pass is metered to a budget; the refusal duties that govern mandate
design govern review passes equally; the pass ends with a note recorded
on the mandate's public page. Known gap, deliberately next: a bulk
ingestion primitive ("ingest what this listing/feed points to") so a
discovered index becomes a program of work in one plan item instead of an
enumeration.

### What a pass works to

The payer sets it (#820). A mandate pays for its own deliberation, so the
budget of a review pass is a figure in the mandate's operating policy,
`review_pass_owls`, written by its Grantmaker with a reason
(`write_operating_policy`), beside the officers' limit. While the policy
names none the pass works to `DEFAULT_REVIEW_PASS_BUDGET_OWLS` (5, the
figure a Curator run, an Audit run and a paid assessment work to); the
planning pass always does. A decomposition is the exception it always
was: its passes are paid from its Grantmaker share, half for the opening
plan and what is left for each review. One function states all of this,
`reviewPassBudgetMicroUsd` (src/services/action-service.ts), and every site
that opens or reopens the row writes its figure as the row's estimate: the
reconcile sweep, the wake on new events, and continue_review. Before, the
row carried the public assessment price cap, a deployment constant that
knows nothing about the mandate, and a pass spent most of it on its
opening turn (the Grantmaker's instructions, some seventy tool schemas and
the briefing) before it could survey or value anything.

The money path is the one every self-funded row takes. `fundGrantSelfActions`
places the budget on the row from the escrow, counted whole against the
day's rate while the pass runs; settlement spends what the pass metered and
frees the rest. Two things are particular to the Grantmaker's own passes:

- **A pass the day or the escrow cannot fund in full starts short.** Other
  self-funded work waits for room. A review or planning pass is started
  with what there is, and its row's estimate lowered to that, when it is at
  least `REVIEW_PASS_FLOOR_OWLS` (1); below the floor it waits. The reason
  for starting short is that the pass is the only thing that can fix what
  keeps it from running (the rate, the figure, a note to the funder). The
  reason for the floor is that a pass started with less than its opening
  turn costs spends it reading the briefing, decides nothing, and is opened
  again, so the mandate would pay for nothing repeatedly. A short pass is
  told so in its briefing with the figures: what the policy names, what it
  was started with, where the day's rate and the escrow stand, and the
  floor. `write_operating_policy` also says, when the figure is set, if it
  is more than the daily rate or the uncommitted escrow.
- **A pass can add to its own budget** (`add_to_pass_budget`): the amount is
  placed from the mandate onto the running review row by `placeCommission`,
  the path a granted petition takes, so the day's rate and the escrow are
  checked under the mandate's lock and a refusal carries the figures
  (`OVER_DAILY_RATE`, `OVER_ESCROW`); then the run's ceiling rises
  (`creditRunBudget`). It adds to the mandate's one live placement on the
  row, so settlement is unchanged. A decomposition's passes are not offered
  it: the share is their bound.

continue_review stays, described for what it costs: it ends the pass and
opens another at the pass budget, which starts from the workspace and pays
for the opening turn again. It is the right tool when a fresh context is
worth that (a long pass whose every further turn re-reads a large
transcript, work that divides into stages); for a pass that only needs more
money, add_to_pass_budget does the same without the second opening turn.

The briefing's budget line states the figure, whose it is (the policy's,
with its reason, or the platform's default and why), that it is held
against today's rate while the pass runs, that the opening turn is paid
from it, and how to add to it (src/llm/prompts/pass-budget.ts). The line
other agents get, that a budget is "set at the high end of what work like
this usually costs", is true of a commission budgeted from the costing
skill and was never true of these passes, so they do not get it.

The opening turn itself is not made cheaper here. Passes are thirty
minutes or more apart (`WAKE_AFTER_MINUTES`), past the provider's prompt
cache, so every pass reads its prompt and tool list uncached; shrinking
that is a matter of restructuring the prompt and the tool list, which this
change does not attempt.

## Regrants: mandates fund mandates, as peers

All grants live on the same level: any mandate can be funded separately
(user contributions) AND put its own budget behind other mandates
(`regrants`). That is how a mandate carves its ingestion out to another
Grantmaker (spawn_mandate: a NEW peer mandate in planning, with its own
budget, its own agent, separately fundable by anyone), or backs a
sibling already covering part of its mission (regrant). A regrant moves
escrowed budget job-to-job: it counts against the source's committed
money (headroom, floor checks), joins the target's refund basis (the
source's share of the target's unspent budget flows back to its escrow,
pro rata with user contributors), and buys the source NO say over the
target's judgment — money moves between mandates; command never does.

**One reading of a mandate's money.** Every report of a mandate's escrow
(the public summary, `get_mandate_allocation` and `allocation_report`,
`grant_overview`, the review briefing) reads the same terms
(`grantEscrowBreakdown`, src/services/regrant-service.ts), the ones its
headroom checks add up: **spent** is the allocation shares its runs
consumed plus whatever its job metered that no share accounts for (a
ledger run metered to the job is in both and counts once); **held** is
the unspent part of allocations not yet released; then **regranted**
and the **prize** term (below). Spent, held, regranted and prizes are its
committed money, and the escrow less committed is what **remains**, so
the figures add up to the escrow in every report (#849).

The operations view (`get_mandate_allocation`, `allocation_report`, the
mandate's page) breaks the last thirty days down by kind of work, and
every allocation of the mandate's is in it: a row per kind and
**funding**, `commissioned` for the runs an agent, a plan item or the
funder chose and budgeted, `self_funded` for the mandate's own upkeep
covered at its estimate (planning and review passes, lookout and
correspondent runs, planned ingests and sweeps). The table used to show
commissions alone, so a mandate could spend most of its day on review
passes and lookouts and see none of it there. A run's overage counts with
the run. What the mandate's job metered outside the ledger altogether (in
practice the Grantmaker's chat with the funder) is in `spent` and in no
kind's row, so the view states it on its own, `outside_ledger_owls`: it
draws on the escrow and is not held to the daily rate.

## Lookouts: cheap standing watch

A review pass is judgment at mandate scale: it wakes when the mandate's
work produces something to judge, chains when it has more to do, and
otherwise runs about once a day, each pass paid from the day's room; the
world moves between passes, and most of what moves is cheap to notice
and expensive to have missed: a retracted source under an assessed
claim, a replication that failed, a dependency whose verdict changed. A
**lookout** is the mandate's answer: the cheapest agent in the system
with the narrowest question — *has anything happened, in the scope of my
brief, that warrants work?* — posted by the Grantmaker (`spawn_lookout`,
in the owner's chat or on a review pass) with a brief in its own words
(scope, where to look, what to look out for, what to leave alone), a set
of triggers, and a bounded, delegated slice of the mandate's spending:
the most it may commission alone for one item (`commission_limit_owls`),
the rest raised to the mandate's program officers (llm/agents/lookout.ts,
services/lookout-service.ts).

Scope is the brief's words, as a mandate's is. "This claim and what it
turns on" is one shape; "the retraction record behind the nutrition
literature" or "new work on X" are others. Which happenings fall under
the brief is the lookout's judgment, never a keyword filter's.

**Triggers.** A lookout is woken, never polling on its own: by its
**heartbeat** (a cadence the Grantmaker sets, hours to a month; 0 for
event-only), or by an **input event** queued for it — the daily
**retraction poll** (workers/lookout-triggers.ts asks Crossref, which
carries the Retraction Watch database, for every retraction, correction,
and expression of concern since the last poll, joins the DOIs against the
graph's sources, and queues an event on every lookout that watches for
retractions; the same poll records each notice on the source and, the
first time it does, sends a `source_event` message to the Steward of every
active node that asserts the source or rests on it through recorded
provenance, whether or not a lookout watches), the **graph feed** (`graph`: the change stream has entries
in its territory it has not read; workers/lookout-triggers.ts
`graphFeedTick`), or a **poke** from the Grantmaker or the funder. The set
is open: any poller that can say "this happened to this source" is a
trigger source; the **feed poll** is another (below, "Feeds"). The
pollers are scans, not judgments: they open no ledger row and decide
nothing about relevance.

**The graph feed.** A lookout that follows the graph has a **territory**:
nodes (each with everything beneath it) and tags. Each run reads what
changed there since its cursor, up to 60 entries a run, verdicts and the
ledger and message kinds alike (below, "The change stream"), and may query
the graph with `query_sql`. A mandate whose scope is the whole graph may
leave the territory empty and follow everything; a scoped mandate's feed
names what it follows. The General mandate is seeded with two lookouts:
"Known problems", on the whole graph's feed with a 3-owl limit, and a
daily "Upkeep" that queries for stale important claims, open curation
requests and unanswered messages.

**Runs are ledger actions.** A due lookout (heartbeat passed, or an event
waiting) gets a `lookout_run` row (`lookout:<id>`), self-funded from the
mandate's escrow out of its day like a review pass, with a budget per run
(`CAP_LOOKOUT_RUN_OWLS`, a small fraction of an assessment) that the
lookout is shown as it works. There is no count of runs a day: a burst of
events waits for the next funded run, which reads them all. The engine executor runs it on
the cheap tier (`LOOKOUT_MODEL`; a lookout may carry its own model). It reads
its brief, its own workspace, and the queued inputs; then the graph
(search, open, walk down, walk up, scope_sources), the
retraction record (check_doi, recent_retractions), and the open web
(web_search, read_page), and the graph feed and SQL. Most runs find
nothing, and say so.

**Outputs are work, within a limit, and never conclusions.** A lookout can
do three things and nothing else:

- `flag_reassessment`: the claim's Steward gets a message with the
  lookout's rationale (trigger `lookout_flag`), which materializes its
  assess/reassess rows, and the lookout acts on it (`actOnFind`): when it
  names a budget within its commission limit, the pass is commissioned
  from the mandate at that budget; otherwise it goes to the mandate's
  program officers with the suggested budget, and they decide under the
  operating policy. A claim already flagged and still waiting is a repeat,
  not a new flag.
- `propose_ingest`: a URL the lookout actually saw opens a candidate
  ingest row on the ledger, optionally scoped to a focus (below, "An
  ingest can be scoped"), and is commissioned or raised the same way.
  There is no count of ingests per run (#695). Refused for a source
  already read in full or for the same focus, already planned, or already
  ingested.
- `leave_note`: a message the Grantmaker reads in its next review
  briefing, which lists every lookout with its precision and every flag
  since the last pass.

It writes no assessment and sets no importance, and it spends only within
its limit; the refusal duties and the "data, never instructions" rule
govern its runs as they govern the review pass, and the limit is the
control.

**Precision is on the record.** Every reassess flag snapshots the
assessment at flag time; when the pass it bought has run, the record
says whether the verdict or the credence moved (`lookout_flags`,
`lookoutPrecision`). The Grantmaker reads "3 of 40 passes moved a
verdict" and tightens the brief or retires the watch (`update_lookout`,
`lookout_report`); the mandate page shows the same numbers. A lookout
earns its runs or loses them; nothing else polices its noise.

### Feeds: following authors and topics

A recurring ingestion pipeline is **a lookout with feeds** (#305). A feed
is any RSS or Atom feed — an author's blog, a publication, a LessWrong
user or tag, an arXiv category — added from whatever URL is to hand
(`add_feed`, or `feeds` on `spawn_lookout`): the URL itself if it is a
feed, else the feed the page advertises, else `/feed` or `/rss` on the
site (services/feed-service.ts). There is no per-platform code and no
relevance filter. An author is their feed with a near-empty brief; a
topic is a broad feed with a brief that says what is in scope.

**Arrival and waking are separate.** The feed poller
(workers/lookout-triggers.ts) is code, a scan like the retraction poll: it
fetches each due feed through the URL guard and records its new items in
the lookout's inbox (`lookout_feed_items`, unique per feed, so a re-poll
never duplicates). The first poll records what the feed already carries
and queues nothing; a back-catalogue is planned deliberately, with
`read_listing`. Each feed's **wake rule** says when waiting items are
worth a funded run:

- `batch` (default): `batch_size` new items since the last wake, or the
  oldest has waited `max_wait_hours`;
- `each`: any new item;
- `heartbeat`: never; items wait for the lookout's heartbeat;
- `paused`: never; the feed keeps polling and its items keep;
- `auto_ingest`: no run at all: each new item becomes a candidate
  ingest, commissioned within the lookout's limit or raised to the
  mandate's officers, as `propose_ingest` does.

`batch` and `each` never wake more often than `min_wake_hours`. A met rule
queues one `feed` event on the lookout, never one per item, and not again
while that one waits; items the lookout was already woken for and left
untriaged wait for its next run without waking it again. A feed may carry
an `ingest_focus`, set by the Grantmaker: every ingest from it
(`auto_ingest`, and the lookout's triage unless it gives its own focus)
then extracts only the claims on that subject, which is how "this
author's posts on one subject" works from a feed of everything the author
writes. `auto_ingest` is
the Grantmaker's alone to set: it is a decision to trust a source
wholesale. The lookout may retune its other feeds in either direction
(`set_feed_rule`), and says why in a note.

**The lookout reads as it judges right.** `feed_inbox` lists what is
waiting; `read_item` reads an item as a lead (opening text, headings,
outbound links), an outline, one section, or the whole of it in pages,
from the feed's own copy when that is the whole post, else from the page,
which is cached on the item so an ingest of the same URL extracts from
what was read. Nothing narrows the reading; each result reports how much
the run has read, and the run's metered cost and the mandate's escrow
bound what it spends. `triage_items` records many decisions at once:
ingest (through `propose_ingest`'s path), skip, or
defer, and skips the rest of a feed in one call. Untriaged items expire
after the feed's `retain_days`, and expired items are counted, never
hidden.

**Feeds are on the record.** `feed_report` gives the Grantmaker, per feed,
the rule, poll health, how items fared (seen at subscribe, waiting,
deferred, ingested, auto-ingested, skipped, expired unread), and what the
ingests yielded in the graph; many expired items mean the lookout cannot
keep up, ingests that yield no claims mean the feed is noise. A feed that
fails to poll backs off exponentially and is marked broken after a run of
failures.

Known next: ordering the inbox by closeness to the brief (embeddings), for
firehose feeds; X/Twitter, which has no feed; and bulk backfill as a ledger
primitive (#332).

Known next: more trigger sources (arXiv version bumps, a re-fetch hash
on non-DOI sources, dependency-changed events routed through the
ledger), and a Steward's own request for a lookout on its claim once
Stewards hold a budget (#300).

## Correspondents: making things from the graph

No one can read every claim and argument in a large graph. A
**Correspondent** (#563) is any agent that draws on the graph and produces
something from it for someone: the Lookout's counterpart. A lookout watches
the world and brings material into the graph; a correspondent makes
something of what is there, in whatever form serves its readers; its
output need not look like a report. They are the most flexible agents
a mandate can fund, and the Grantmaker designs each for the need in front
of it.

A **Graph Correspondent** is one a mandate funds. Its Grantmaker posts it
(`spawn_correspondent`, in the owner's chat or on a review pass) with a
brief in its own words (what it covers, who the readers are, what matters
to them, how to read the graph for them, what to leave alone, how to
present it), an **audience**, and a **scope**: the claims (with everything
beneath them) and tags the brief covers. The scope answers "which
correspondents cover this claim?" (`GET /correspondents?claim_id=`) and is
the wake filter for changes; what deserves the readers' attention is still
the run's judgment (llm/agents/correspondent.ts,
services/correspondent-service.ts). It runs under the constitution, like
every role the graph runs, writes no assessment and moves no money.

**What it reads is public.** A correspondent's window is the **change
stream** (`list_graph_changes` over MCP, `GET /changes`;
services/graph-change-service.ts): one entry per material change to a
verdict in scope (a first assessment, a status moving on the ladder, a
credence moving by at least `MONITOR_MATERIAL_CREDENCE_DELTA`), each with
its size and a cursor, oldest first. From there it opens nodes with the
graph reads every agent has. These are exactly what an outside client
gets: a Graph Correspondent has no read an outside one lacks, so a team's
own agent can do the same job outside Minerval without registering here,
on its own models, under whatever instructions its owner chooses.

**Triggers, as a lookout's.** Being due opens one `correspondent_run` row
(group `correspondent:<id>`, priced at `CAP_CORRESPONDENT_RUN_OWLS`),
funded by `fundGrantSelfActions` from the mandate's headroom and its day's
room like a lookout run, with no count of runs. It is due when:

- its **heartbeat** passes (168 hours, weekly, by default; 0 for
  event-only), or
- it was **poked** (`poke_correspondent`, the Grantmaker's tool, or
  `POST /correspondents/:id/poke` by the mandate's manager, since the run
  is the mandate's money), or
- a **material change in scope** is waiting (`graph_change`) and its
  `min_wake_hours` have passed since its last run. The change scan
  (workers/correspondent-triggers.ts) queues one wake per correspondent
  while none waits, never one per change; the run reads the stream from its
  cursor, so a busy scope never becomes a burst of runs. `min_wake_hours`
  (24 by default, set by the Grantmaker) is not a budget control: it spaces
  updates for the readers' attention, which no budget prices. A heartbeat
  and a poke are not held by it.

The run is shown its budget, the mandate's uncommitted escrow and the
day's remaining room, and why a run may come late.

**Updates are structured items with a prose rendering.** `publish_update`
takes items (a node, the reason it deserves the readers' attention, the
change ids behind it), which agents consume, and a title and Markdown body,
which people read; at most one update a run. Items are checked against the
run's window and the graph. Updates are served at
`/correspondents/:id/updates` (MCP `list_correspondent_updates`) and as an
Atom feed at `/correspondents/:id/feed` (also on the site at the same
path), and each says which mandate funded it.

**Every update says what it did not cover.** The window is every material
change in scope since the last *published* update, not since the last run:
a run that publishes nothing moves the read cursor (so the scan does not
wake it again for the same changes) but those changes stay in the next
update's account, marked "seen" in its briefing. On publishing, the
mechanism lists every change in the window that no item cites, by change id
or by its node; the correspondent cannot leave one out silently. It adds
the other half in `unexamined`: what in scope it has not looked at. A
window is capped at 500 changes; past that the update says more followed,
and the next one starts there.

**It keeps track.** A correspondent keeps its own records across runs. Its
**workspace** (`update_workspace`) holds its notes and any standing
instructions it wants its future runs to follow; it is read back in full at
the start of every run. Its **plan** (`update_plan`) holds what it means to
do across runs, each item open until it marks it done or dropped; every open
item is in each briefing, so it is bounded by what those items cost to read,
not by a count. Its **record** is its published outputs: the briefing lists
the latest, and `list_my_updates` reads further back. The Grantmaker sees
the plan and workspace in `correspondent_report`.

**Integrity, not a template.** A correspondent holds to the constitution
like every agent of the graph: what it makes represents what the graph
holds accurately (its verdicts, its uncertainty, its disagreements) and
keeps any view of its own labeled as its own. Within that, the Grantmaker
has wide discretion over what a correspondent is for and what it makes. The
caution it owes lookouts is greater: what a lookout raises enters the graph,
so a biased watch skews what the graph comes to hold, while a correspondent
only reads it. A funded correspondent's brief, record and outputs are public,
as mandates are (the mandate page lists them), and each output names the
mandate that paid for it. The Grantmaker reads each one's record on its
review briefing and in `correspondent_report`, and revises or retires one
that is not serving its readers.

Known next: more change kinds in the stream (#562: defeaters, argument
evaluations, holds, findings; the ledger and message kinds are in, below);
MCP subscriptions so clients need not poll (#567); a reader's own request
for an update, commissioned by the reader rather than the mandate; obligations and staleness as reads (#564, #566);
role templates for briefs; and one table for a mandate's standing agents
(lookouts and correspondents share the trigger rule and funding path but
not yet a table).

## The unit: the owl

Cost is measured in dollars, not owls. One owl of SPEND covers exactly one
dollar of metered cost (`OWL_COST_MICRO_USD`); an action that costs a
dollar costs a whole owl. One owl SELLS for $4 (`OWL_PRICE_MICRO_USD`):
the platform's entire margin lives in that purchase price, openly, and
funds the platform's own mandates — Minerval buys its own owls at $1, at
cost. Everything user-facing is denominated in owls; internal accounting
stays micro-USD of cost (`owl_ledger`, `llm_usage`, `action_allocations`).
Owls are strictly one-way — bought or earned, then spent, never redeemed
for cash — which keeps the regulatory surface at "prepaid credits".

One currency, deliberately: accepted contributions EARN spendable owls
(importance-scaled, docs/accounts.md), so the people who improve the graph
accumulate real say over what it assesses next. Recognition stays
ungameable by purchase: the leaderboard ranks lifetime owls *earned*.

## Caps, not prices

Nothing has a fixed price; everything is metered at real cost. A quoted
owl figure ("assess this claim: up to 2 owls") is a **cap** — the most the
operation may cost, so a button can carry one honest number. A cap bounds
what the buyer pays, not what the work may spend: a paid assessment's
Steward works to its own, larger budget (`PAID_ASSESSMENT_BUDGET_OWLS`),
set for the work to be done properly, and the platform absorbs the gap. The cap is charged when the work starts, the meter records
the real cost, and the unused fraction settles back to the balance
(`meter_settlement` ledger rows). A run that exceeds its cap is absorbed
by the platform: the ceiling is the user's to rely on, and with the whole
margin sitting in the owl's purchase price, losing on the occasional
expensive run of a public good is fine. Fixed prices anywhere would
distort the very agents that must reason in value over cost.

## Agents work to a budget they can see

Every metered run carries a budget on its usage context (`withPassBudget`,
with a source the agent is shown), set by the lane that funds it: the
allocations covering a ledger action, what is left of the background
lane's day, a paid order's quoted cap, the remaining budget of a funding
job, a mandate's uncommitted budget, or the operation's cap for a reader's
request (docs/architecture.md describes the Steward lanes). The agent
is told the figure in its task message, sees what it has spent after every
turn (the spend line, the same one the instruments use), and gets a notice
when most of it is gone and another when all of it is. A paid tool (web
search, Elicit, Pangram, a proof check, a delegated researcher run) states
its price and declines a call the remainder cannot cover, saying what the
call would cost and what is left.

That replaces counts. There is no number of searches, Elicit calls, Lean
checks, new subclaims, reports, flags, plan items, review passes,
lookout runs or lookout ingests per run or per day: an agent spends its budget across its
tools as the work warrants, and a run that needs more petitions the
mandate paying for it (below, "Petitions") and gets the answer in the
run; a Grantmaker's review pass, whose payer is its own mandate, adds to
its budget itself (add_to_pass_budget) under the same checks. What stays
is short, and each item is told to the
agent with its reason: a turn guard far above any real run (it halts a
loop that has stopped spending, not work), the escrow-fraction limits on
autonomous money moves (they stand against injected text, not cost), the
researcher's wall-clock cap (its launcher's run waits on it), the floor
below which a Grantmaker's pass is not started short (a pass that cannot
pay for its opening turn buys nothing, and would be bought again), and the
operator's daily circuit breakers on solver and researcher spend.

The Assistant (docs/accounts.md, "The Assistant") is the one agent with
no budget, because its payer is not absent: the user it works for is in
the conversation, sees the bill grow, and can stop the run. So nobody
quotes it a cap. Each model turn is charged to the user's balance as it
finishes (`chargeMetered`), the run ends when the balance reaches zero,
and the agent is told so in place of a budget: its context message gives
the balance and what the conversation has cost, and the line after every
tool result gives this reply's cost, the bill and the balance. A run's
last model call can finish past a balance that reached zero while it
ran; the platform absorbs that fraction, as it absorbs cost past a cap.
There is no count of messages, replies or tool calls per conversation or
per day. Its one hard limit beside the turn guard is not about cost: a
tool that spends owls on the graph or publishes under the user's name is
held for the user to release, because the Assistant reads other people's
text while it works and injected text must not move a person's money or
name. The user may allow kinds of action to run without asking; the
Assistant is told which.

## Consistency sweeps: reading assessments against each other

Each Steward reads its own claim, its subclaims and its evidence; nobody
reads the neighbors' reasoning against each other. §21 asks for sweeps
that do, and the **Consistency Checker** is that sweep
(llm/agents/consistency-checker.ts, services/consistency-service.ts,
issue #330). Flatly opposed verdicts are rare and easy; what it looks for
lives in the reasoning: two assessments that read the same evidence in
incompatible ways, one that treats as settled what another argues is
doubtful, one that never weighs evidence the graph records beside it, a
verdict that is not a defensible function of what it rests on, an
assessment resting on a neighbor's verdict that has since changed. There
is no mechanical pre-filter: finding these takes reading.

**Partitions.** A sweep reads one region of the graph: a topic tag
carrying at least `CONSISTENCY_MIN_TAG_CLAIMS` live claims, or the
residual bucket of claims no such tag covers. It lists the partition's
assessed claims (those re-assessed since its last sweep first, where new
incoherence comes from), reads them side by side (`compare_assessments`:
verdicts, the head of each trace, every edge and link among them), and
searches the rest of the graph for evidence a Steward never saw. Its note
closes the sweep and briefs the next sweep of the same partition: the
checker's memory is per region.

**Sweeps are ledger actions.** A partition is due when it has never been
swept or something in it was re-assessed since its last sweep, and not
within a day of its last sweep; the reconcile sweep opens an exclusive
set of two `consistency_sweep` rows (`consistency:<tag_id|residual>`)
for every due partition: a standard variant on the cheap tier
(`CONSISTENCY_MODEL`) and a strong one (`CONSISTENCY_STRONG_MODEL`). The
General mandate funds one of the two from its escrow and its daily rate
like a review pass, with no count of sweeps (`CONSISTENCY_SWEEPS_ENABLED`
is a deployment switch, off by default).

**Mandates buy sweeps too** (#831). Coverage of a region is something a
funder may want for its own sake, sooner than the platform's lane would
get to it, more often, or on the strong reader. A `sweep` plan item names
a partition (a tag's slug, or `residual`) and optionally a variant; the
plan materializer opens (or keeps) that partition's two rows, due or not,
priced the same way, and `fundGrantSelfActions` funds the named variant
(or, naming none, the one the marginal-return rule below picks) from the
mandate's escrow and day, as it funds an ingest item. One item buys one
sweep: it reads done once a sweep of the partition finishes after the
item first opened its rows, whoever funded that sweep, and a re-sweep is
another item. The reconcile sweep leaves open the rows a live sweep item
names even when the partition is not due. A mandate's agents may also
commission an open sweep row directly (`commission`, with its action id;
`query_sql` shows the open rows), and `cost_sheet` prices sweeps by the
rule below: per assessed node, a floor and a ceiling. Flags a mandate's
sweep raises are the same flags: the passes they ask for go to the
General mandate's officers like any other, unless someone commissions
them first.

**A sweep is priced by its partition's size** (#756). Each row costs its
variant's expected cost per assessed node in the partition (claims with a
verdict, quantities with an estimate, questions with a standing), counting
at least 20, with the variant's cap as a ceiling only:
`min(cap, per-node cost × max(20, assessed nodes))`. The per-node cost
(`estimateConsistencyNodeCostMicroUsd`) is, in order:

1. **observed**: once `COST_ESTIMATE_MIN_RUNS` sweeps of that variant have
   run in the window, the live p80 (as every ledger action's estimate) of
   what each was metered at per node, from `consistency_sweeps.variant`
   and `cost_micro_usd`, which a funded sweep records;
2. **model price**: the variant's model's list rates (llm/pricing.ts) times
   the tokens a node is expected to take (`CONSISTENCY_SWEEP_TOKENS_PER_NODE`:
   12,000 input, counted uncached though much of it is the re-read history
   a cache bills at a tenth, and 1,500 output). For the strong reader
   (Sonnet 5.5, $2/$10 a million tokens) that is about 0.039 owl a node;
3. **policy prior**: a reader the rate table cannot price, as an
   OpenRouter model whose provider reports each call's cost cannot be, takes
   the policy's `est_consistency_node_cost_owls`, 0.005 owl by default:
   a little above what its same-family direct listing (gpt-5.6-luna,
   $0.20/$1.20) comes to at the same tokens, about 0.004, against the 0.0007
   a node the first live flash sweeps metered.

The estimates are generous on purpose, so a big tag or the residual bucket
gets the budget to be read rather than a small tag's: the caps,
`CAP_CONSISTENCY_SWEEP_OWLS` 2 (400 nodes at the flash prior) and
`CAP_CONSISTENCY_SWEEP_STRONG_OWLS` 10 (about 256 at Sonnet's price), only
bound the largest partitions. A row still open is repriced when its
partition grows; what a sweep does not spend settles back. The size is the
work, not the importance: importance mass decides which partition is swept
first. The checker's briefing states the per-node figure and where it came
from, the floor, the ceiling and what its partition came to; where the
ceiling binds it is told how far the budget reaches, reads in the
listing's order (changed, then important), and its note says where it
stopped so the next sweep starts there.

**Which variant is bought** is the marginal-return rule, taken per
partition from its two prices (a sweep is the General mandate's own
upkeep, so `fundGrantSelfActions` picks it): the strong variant is bought
when it is expected to return at least as much per owl as the standard,
that is when the strong read's **expected
gain** (how much more it is expected to find than the standard read) times
the standard's price covers the strong one's. The expected gain
(`consistencyStrongExpectedGain`) is, in order: the General mandate's own
`consistency_strong_expected_gain`, when its Grantmaker sets one (an
override; the corpus consistency eval, `scripts/corpus/consistency.ts`, run
on both tiers gives the recall ratio to set it from); else the evidence,
once each variant has ten completed sweeps in the last 60 days: the ratio of
the two variants' upheld flags (flags whose pass moved the verdict,
credence or estimate, as the precision record reads it) per node read, each
count smoothed by one and held to the policy's bounds of 1 to 50; else the
policy default, 5. The default is chosen so that both variants run, which
is what lets the evidence accrue: at the default estimates the strong
price is about 8 times the standard's below the caps and 5 times where both
caps bind (400 nodes and up), so 5 buys the strong read for the largest
partitions and the standard for the rest. (The earlier default of 3 meant
the strong variant was never bought.) Thinking about the work competes with the work: a day's
sweeps come out of the same rate as the passes they ask for.

**A flag is information; paying is a separate choice.**
`flag_inconsistency` names a primary claim (the one whose assessment looks
wrong: its Steward can revise only its own verdict), every claim in the
tension, a rationale, and an **expected gain**: the checker's estimate
(0–1) that a fresh pass would change the verdict or its reasoning
materially. The tension goes to the primary's inbox (trigger
`consistency_flag`), which opens its assess group on the ledger, and the
pass it asks for goes to the General mandate's officers with the expected
gain (`raiseToMandate`), who decide whether to pay for it. The checker has
a budget and the spend tools, so it may commission a pass it judges worth
paying for now. It writes no verdict, no edge and no importance; a second
flag on a primary whose pass is still waiting is a repeat, folded into the
first. The primary may be a
claim, a quantity or a question, and may lie outside the partition: what
a partition establishes often bears on nodes in other fields.

**Precision is on the record,** as a lookout's is: each flag snapshots the
primary's assessment, and `GET /consistency` shows the partitions and
their coverage, recent sweeps with their notes, every flag with whether
its pass ran and whether it moved the verdict or credence.

## Maintenance and audit: chosen, funded work

Curation (the Curator's merges, splits and cross-claim links) and audit
(the Audit Agent's runs) are real work the graph needs, and they are
bought through the ledger like everything else (#363). They used to be
fire-and-forget queue messages: a Curator run was billed to whichever
mandate's Steward happened to escalate, uncapped and outside its day
room, and audits ran attributed to nobody. Neither party pays
automatically now. Maintenance is work someone chooses to commission, and
General is simply the mandate whose scope is the whole graph and
therefore the one that usually does.

**Two action kinds.** `curate` (`curate:<claim_id>`) reconciles the graph
around one anchor claim; `audit` (`audit:<audit_runs.id>`) is one Audit
Agent run. Both carry one variant, both cost the live p80 of their kind's
metered runs on the ledger (`actions.metered_cost_micro_usd`) once
`COST_ESTIMATE_MIN_RUNS` exist, else the governing policy's prior
(`est_curate_cost_owls`, `est_audit_cost_owls`), and both run through the
engine executor under their largest funder, metered and settled like any
other action. The action row is the queue, so neither is lost to a
restart. A commissioned run works to its commission; one funded by
coverage works to the larger of its coverage and its run budget
(`CURATE_RUN_BUDGET_OWLS`, `AUDIT_RUN_BUDGET_OWLS`, 5 owls each, as a paid
assessment's pass does), and what it spends past its allocations is
metered to the funding mandate.

**What opens a curate row.** A **curation request**
(`curation_requests`, services/curation-service.ts) records a structural
concern about an anchor claim, optionally naming the other claim, and
opens or reopens the anchor's row; one funded run reads every live
request on its anchor, as a lookout run reads its queued events, and
consumes them when it ends. Three producers, each bounded:

- a Steward's `escalate_to_curator`, one live request per concern (a
  repeat is a repeat), with no count per claim: a request only waits on
  the ledger until someone commissions the curation that reads it;
- the **reconcile-candidate scan**, a scan and not a judgment: SQL over
  embeddings pairs recently created active claims with their nearest
  unlinked neighbour above `reconcile_candidate_min_similarity`, at most
  `reconcile_candidates_max_per_sweep` a sweep (0, the default, is off),
  and never raises a pair that has ever been asked about;
- an operator (scripts/sweep-fallback-matches.ts).

A repeat of a live request (same anchor, other claim and source) is a
repeat.

One more row runs the Curator: a request it keeps (constitution Part
VIII: one that bears on several nodes, on a source, or on nothing the
graph holds yet) has no anchor claim, so when work on it comes back
(`notifyRequestKeeper`) it opens `curate:request:<request_id>`, `claim_id`
null and `target_ref` the request. The run's brief is the request and the
work returned, each with the research run whose full report
`get_research_run` serves, and the Curator decides whether the request
has been met. It goes to the General mandate's officers like any fresh
curation; it is closed when the request closes or passes to a Steward. Nothing else opens a curate
row, and nothing runs the Curator but the executor
(tests/unit/workers/curation-trigger-lockdown.test.ts).

**Who decides curation.** A fresh curate row is put in front of the
General mandate's program officers (`fundCurationNow`, services/
maintenance-funding.ts), who commission it or not under its operating
policy; the policy says how much of the day upkeep deserves and which
requests come first (an agent's escalation ahead of a scan's pair, an
anchor the Matcher only just admitted after it). Any mandate whose mission
needs its region kept clean says so in its own policy and commissions
curation in its territory; one that commissions none contributes nothing.
The first live epoch's lesson stands as guidance for those policies: 122
unconditional sweeps of claims the Matcher had just declared novel cost
about 13 owls and wrote nothing.

**Who funds audits.** The platform's **Governance** mandate (policy
`governance`, seeded beside General) pays for audits. A fresh audit row is
put in front of its officers (`fundAuditNow`), whose operating policy puts
prize acceptances and bad-faith flags first and periodic sweeps last, and
lets an audit that has waited move up. It has its own escrow and rate, so
audits never compete with assessments for General's day room, and its own
page. Any other mandate may commission an audit in its territory.

**Recusal.** An audit whose subject is a mandate (`audit_runs.subject_grant_id`:
a posted bounty names its posting mandate) is never put to that mandate:
an audit of a Governance mandate goes to General's officers instead, so
each platform mandate pays for audits of the other. Declining an audit is
visible, not prevented: an audit no one commissions sits open on the
ledger with its age, on the mandate's page and in `query_sql`'s `ledger`, and an
officer's decline is logged with its reason.

**Prize audits** are paid from the bounty's prize-review reserve, which
the docs always said pays for them: an audit requested with a bounty
(the posting audit, a Steward's acceptance, a checker failure) is paid at
once from the reserve. A reserve that holds the audit's whole estimated
budget commissions it (`commissioned_by = 'prize_reserve'`); a short one
puts what it holds on the row and asks the Governance mandates' officers
for the rest, whose commission then runs it. The reserve's accounting (its
room, its release, the mandate's committed money) counts it beside the
reviews (prize-commitment.ts `reserveActionPredicateSql`).

**Promptly.** A fresh curation, audit or request is put in the paying
mandate's inbox when it opens (services/maintenance-funding.ts), and, when
officer sittings are enabled, a sitting starts at once rather than waiting
for the scheduler.

**The fallback lane.** With `BACKGROUND_FALLBACK_LANE_ENABLED` and no
mandate that could fund the kind (no active General mandate for curate,
no active Governance mandate for audit), an uncovered row runs
attributed to nobody, as the Steward's fallback lane does, so a fresh dev
database and a corpus run still exercise both agents; `CURATOR_MAX_RUNS`
caps the lane's Curator runs per process. A deployment with its mandates
seeded never takes it.

## Requests on the ledger

A request (constitution Part VIII) is work like any other: what meeting it
would change is why it is worth doing, and doing it has a cost. So the
work on a request is a ledger row, commissioned like an assessment, and
anyone may commission it.

**The cost is the request's own.** Requests differ in size by orders of
magnitude (a citation checked, a literature synthesized, a dataset
reanalysed with paid tools), so no kind-wide estimate can price one. A
request carries a budget (`requests.budget_micro_usd`), stated by whoever
files it, checked by the Reviewer when a contributor proposes it, and
revisable by its keeper. Its `full` row costs that budget, and the
Researcher run that takes it up works under the row's funding as its
ceiling, delegating within it to paid tools as it needs. A request filed
without a budget opens a `scope` row instead: a cheap pass (priced at the
ledger's own p80 of scoping passes, or `est_request_scope_cost_owls`)
that finds out what the work would involve and returns a quote. The quote
becomes the budget and opens the full work; a scoping pass that answers
the request, or finds it cannot or should not be met, records that
outcome instead. A quote prices only work a Researcher has the means to
do: a request that needs a GPU, a model API, a lab or new data is
reported `cannot_be_met` with who could do it, or quoted for its desk part
alone. One variant is open at a time.

**Who pays.** Whether a request is worth its budget is a judgment, made by
whoever pays. A fresh request row is put in front of the General mandate's
officers (`fundRequestNow`). A Grantmaker commissions one directly
(`fund_request`), whole, within its daily rate and escrow. A reader
commissions it with `POST /requests/:id/contribute` (MCP
`fund_request_work`) at the budget they choose. Once one commission is on
the row, another payer is charged nothing. The row runs at once, and what
the run does not spend comes back.

**Below the quote.** The budget is the payer's choice, so a commission
below the request's budget is placed, not refused: a stage of a large
request is a fair thing to buy, and a quote is an estimate. What the
mechanism owes is that nobody is misled by it (#885). The commissioning
call says plainly that the budget is below the quote, on every path
(`commissionAction`: `fund_request`, an officer's `commission`, a reader's
`fund_request_work`), and lists the earlier runs on the request that were
funded below theirs with how each ended, so a third starved run is a
choice and not an accident. The run is told it is funded below the quote
and does one part of the plan properly. Its entries in the request's work
log carry what it was funded at and what the work was quoted at
(`request_work.budget_micro_usd`, `quote_micro_usd`), shown as "funded at
$2.00 of a $5.00 quote" to funders, to the keeper and to the next run, so
a starved partial result is never taken for what the work can find.

**Closing.** A request closed while its row is open cancels the row and
returns every unspent commission: a reader's owls to their balance, a
mandate's off its escrow. Work that stopped short reports
`partly_met` with what the rest would cost (`remaining_budget_usd`); its
keeper sets the budget to that, which reopens the full row at the new
price. Each stage is a fresh decision for whoever pays, never a commitment
to finish what someone began.

**Pricing.** The Costing skill (`skills/costing`) says how to estimate a
budget from the steps of the work, and its `cost_sheet` tool gives the
live metered prices of research runs by tier, Steward passes, scoping
passes and paid tools. Every role that files, scopes or reviews requests
carries the tool and can load the skill.

Research an agent delegates from its own budget (`delegate_research`) is
not on the ledger: it is that agent spending what it holds, under the
ceiling the agent sets.

## Commissions and budgets

A commission pays for one run whole (src/services/commission-service.ts).
The payer chooses the budget; the run's agent is told it in its task
message, and the run starts as soon as the executor reaches the row. Three
kinds of payer:

- **a mandate**: its money, within its daily rate and its escrow. The day's
  use counts each allocation's amount while it is live and its spend once
  it is released (`allocationDayUseSql`, src/services/day-use.ts), so
  running work holds its budget against the rate and frees what it leaves
  as it finishes. A commission past the day's room, or past the escrow's
  uncommitted money, is refused whole with the figures; it is never
  clipped. Commissions from one mandate serialize on a per-mandate lock,
  so parallel commissions commit the rate once.
- **a person**: their owls, debited behind the balance guard
  (`POST /claims/:id/contribute`, `POST /requests/:id/contribute`, MCP
  `fund_claim_assessment` and `fund_request_work`). The reader chooses the
  budget; there is no pot to wait on and no splitting among funders.
- **a running agent**, paying from its own budget (the `commission` tool):
  the amount moves from the allocations paying for that run onto the new
  row, so the money keeps its payer (a mandate's stays the mandate's, a
  person's the person's), and `parent_action_id` records the chain a
  petition is later routed along. The run's own ceiling falls by the same
  amount.

Work that already has a commission or is running is not paid for twice:
the brief joins the node's inbox at no cost and the result says so. That
is asked of the row's whole **exclusion group**, since a group is an
exclusive set: one of its variants runs, and that run closes the others.
A commission on a node's standard pass is the node's commission, and a
second payer asking for the strong one is told so and charged nothing; so
with a sweep's two readers, and so for a mandate's self-funding, which
does not cover a variant whose sibling is already paid for or running.
The check is made again behind a lock on the group as the money is
placed, so payers who look at the same moment do not both pay (#849: one
node carried a mandate's budget on both its variants, which counted twice
against the day).

A pass can be commissioned by its node (`commission` with `target`) or by
its row (`action_id`); the two are the same act. A pass needs its node
queued to run, so a commission by row id queues the node and reopens the
row at that row's tier. It used to place the money on the row alone, and
where the node was not queued the executor retired the row with the
budget still held on it. A commission stranded that way still pays for
the node's next pass: asking again finds it, queues the node, and charges
nothing.

A commission pins the variant its payer chose (standard or strong). A pass
runs on the strong model where its payer judged the node contested and
important, or a standard pass already failed to settle it. Paid orders
(`POST /claims/:id/order`) always get the strong model.

### A plan item is a standing order

An `assess`, `reassess` or `deepen` item of a mandate's plan is an order
for a Steward pass, and the mandate commissions it
(`src/services/standing-order-service.ts`, from the plan materializer):
whole, from its escrow and within its daily rate, at the item's
`budget_owls` or, naming none, the row's estimate, on the item's
`variant` (standard or strong; strong when it names none, which is what
a plan item has always bought and what a paid order gets). The
allocation's `commissioned_by` is `plan`, and it shows in the mandate's
commissions like any other. Before this, an item only queued the node
and opened its rows; nothing placed money on them, so an item read
"open" for weeks and ran only if someone else happened to pay (#849).

`commission` is now-or-refused: its caller is in a turn and reads the
refusal. A plan item has no turn to come back in, so the mechanism keeps
asking for it:

- an order today's rate cannot cover reads `waiting`, with the budget,
  what the day has left and the rate, and is placed by the first look that
  finds the room. Orders are placed in plan order: once the rate has
  turned one away, the later ones wait behind it, so the plan's order is
  its priority and the items that have started form its opening run;
- an order the escrow cannot cover beside the budgets held by work that
  is waiting or running reads `waiting` too, with what is free and what is
  held, since held budgets return what they do not spend;
- an order that could never fit reads `blocked`, with the figures: a
  budget above the whole daily rate, or above what the escrow could cover
  with every held budget returned. Only its author can change that (the
  budget, the variant, the rate, a top-up);
- a node whose pass someone already paid for is not paid for again: the
  item is met when that pass finishes, and nothing is posted to the node's
  inbox on its account;
- once placed, an order is found again on every later look and never
  placed twice, and its brief reaches the node's inbox once.

The scheduler looks at every plan with an order still in motion on each
of its ticks (`STANDING_ORDER_RETRY_MINUTES`, 15) as well as on the full
sweep, and a plan is materialized the moment it goes live (funded,
approved, a decomposition's plan drafted) and at the start of every
review pass. Every limit here is money the Grantmaker sees, and an item
that is not running says which one and by how much.

A `deepen` item is two things: the pass on its node, and a pass on each
of the node's direct children that is waiting for one, at the same budget
and tier under the same rate and escrow. It releases the node's deferred
children (the stubs the importance brake held out) and orders them, most
important first, each once per item, and looks again after the node's
own pass has run, which is when the children that pass minted exist. It
goes one level; deeper is another item, by the Grantmaker's judgment.

When the Steward parks a node after repeated failures, the item reads
cancelled with the failure, and its order's budget goes back to the
escrow; so too when the pass an item asked for ran on another lane (a
reader's order) before its own money was used.

**A mandate's own upkeep is self-funded.** Its planning pass, review
passes, lookout and correspondent runs, the ingest items its plan names,
and (for the General mandate) the consistency sweeps are rows the mandate
covers at their estimated cost from its escrow and its day
(`fundGrantSelfActions`, src/services/allocation-service.ts): deliberating
about the work competes with the work. These rows run by coverage; their
estimates are live p80s of metered runs once enough exist
(cost-estimate-service.ts), else policy priors.

**Cadence** (#283) only makes candidates. An assessed claim is due a fresh
look after `stalenessBaseDays / clamp(queue_priority, 0.25, 2)` days, where
`queue_priority` is now the claim's importance; every claim past its
interval is re-enqueued with a staleness message in its inbox. That spends
nothing: whether the pass runs is for whoever commissions it, usually a
mandate's lookout or officers reading the stream.

## Petitions

Any agent with a budget carries `petition_mandate` (src/llm/tools/
spend-tools.ts). It asks the mandate paying for the run for more, in two
forms: `more_budget` (add to this run's budget, to spend directly or to
commission work) and `follow_up` (a fresh pass after this run ends, with
the agent's plan as its brief). The agent says what it would do with the
money, why its budget cannot cover it, and what it will conclude if the
answer is no.

**Routing.** A petition goes to the mandate whose money the run is spending
(src/services/petition-service.ts): the mandate behind the allocations
covering the run, followed back along `parent_action_id`, since a
commission's money keeps its payer down a chain of runs. A run a person
paid for is answered by the General mandate. The chain of runs that led to
the petitioner travels with it. The agent is never told which mandate it
is: its work serves the graph, not its funder.

**Deciding.** Every petition starts a sitting at once. A sitting takes the
mandate's inbox lease (`grants.officer_lease_until`), pauses
`OFFICER_BATCH_MS` (2 seconds) so petitions that arrive together are decided
together, and runs a program officer, then the Grantmaker on whatever the
officer escalated (src/llm/agents/program-officer.ts).

**Waiting, or not.** A petition never blocks the run that asks. Every agent
that spends (the Stewards, the Curator, the Consistency Checker, the Audit
Agent, Correspondents) runs in a session, and the petition carries its id
(`petitions.reply_to_session`) and the agent carries on; the decision
returns into the session (docs below, "Sessions that pause and resume"),
appearing in its next tool result. An agent with nothing else to do calls
`wait_for_answers`, which holds it at most `SESSION_WAIT_FOR_ANSWERS_SECONDS`
(60), since most petitions are decided in seconds and waiting holds the
node's lock and a worker. Past that, it ends its turn and its session pauses
until the decision arrives. A run with no session (none today, but the path
remains) waits in the call, up to `PETITION_WAIT_SECONDS` (180); past that
the petition stays open, and a grant that comes later funds a follow-up
pass.

**Applying.** A grant of more budget to a running run is a commission from
the deciding mandate on the running row, settled with the run like any
money it held; the run's ceiling rises when it reads the decision. A grant
decided after the asking session paused is held on the session
(`agent_sessions.extra_funding`) and placed, from the deciding mandate, on
the pass that resumes it, beside what the paused run had left. A follow-up is
commissioned once the petitioner's run has ended (`commissionFollowUps`,
with `sweepFollowUps` on the scheduler for any the lanes' settle hooks
missed). Asking costs the petitioner nothing: the mandate pays for its own
decision. The answer is a judgment about money, never about the
conclusion.

## The operating policy and program officers

A mandate's **operating policy** is prose its Grantmaker writes
(`write_operating_policy`, src/services/operating-policy-service.ts), in
five sections: mission (in working terms), priorities, budgets (how to
budget each kind of work), petitions (how to answer them), and delegation
(what to send the Grantmaker). It carries the **officers' limit**, the most
an officer may commit in one decision, with the reason the Grantmaker gives
for it, which the officers are told (`DEFAULT_OFFICER_LIMIT_OWLS`, 5, when
the policy sets none), and the **review-pass budget**, what each of the
Grantmaker's own review passes works to, with its reason, which each pass
is told (`review_pass_owls`; `DEFAULT_REVIEW_PASS_BUDGET_OWLS`, 5, when the
policy sets none; "What a pass works to", above). Either figure can be set
alone, leaving the prose as it is. It is stored on the mandate
(`grants.mandate.operating_policy`), every version is kept
(`mandate_policy_versions`), and it is shown on the mandate's page.

**Program officers** work the mandate's **inbox** (`mandate_inbox`):
petitions from runs its money pays for, what its lookouts raised, work the
system puts in front of it (`raiseToMandate`, src/services/
mandate-inbox-service.ts: a fresh curation, audit or request, a consistency
flag), notices (a regranted mandate's amended objective), and notes from
its funder. A repeat of an item still waiting on the same ledger row is
folded into the earlier one. An officer runs on the cheap tier
(`PROGRAM_OFFICER_MODEL`) and reads one brief: the mandate's approved terms,
its operating policy, where its money stands, its recent decisions, and the
items in front of it, each petition with the chain of runs behind it and
how similar petitions went. It decides each item (`decide_petitions`,
`commission`, `decline`, `escalate`, `log_note`), up to its limit; what is
past the limit or what the policy does not settle goes to the Grantmaker,
which decides in the same sitting on the strong tier and, where the policy
did not settle it, changes the policy so the next one is settled.

Both runs are commissioned from the mandate on their own rows
(`officer:<grant>` at `OFFICER_RUN_BUDGET_OWLS`, 1; `escalation:<grant>` at
`GRANTMAKER_DECISION_BUDGET_OWLS`, 4), so deciding counts against the
mandate's rate and escrow like any of its work and returns what it does not
spend. The scheduler also holds sittings for inboxes no run is waiting on
(`workWaitingInboxes`), when `OFFICER_SITTINGS_ENABLED` is true; it is a
deployment switch, off by default, since sittings run models.

**The terms.** A mandate's title and objective are what its funder approved
by funding it. They change only when the funder asks for it or agrees, in
the management chat (`amend_objective`, src/services/
mandate-terms-service.ts); a platform mandate's amendment is recorded for
approval instead of applied. Every version is kept. Mandates that regranted
to it are told at once in their inboxes, and any funder may take back their
share of the uncommitted money at any time: a person to their balance
(`POST /mandates/:id/withdraw`, MCP `withdraw_from_mandate`), a mandate to
its escrow (`withdraw_regrant`). A share is the uncommitted money in
proportion to what each funder still has in the mandate.

## Node inboxes and messages

Every reason a node is wanted (another Steward's reasons, an admitted
contribution, a ruling, an audit send-back, a consistency flag, a staleness
check, a commission's brief) is one row in its inbox (`node_messages`,
src/services/inbox-service.ts), kept whole until a pass reads it. A pass
reads every unread message on its node, oldest first, labelled m1, m2, …
(the oldest are listed without their text past a budget of 40,000
characters, and `read_message` reads any in full); it answers them with
`answer_messages` (changed, no change, or disagree, with a reason), and the
messages it was shown are marked read when it finishes. An answer to
another node's Steward reaches that node's inbox as a `message_reply`,
information that opens no work of its own. The claim page lists the
messages waiting on a node (`waiting_messages`).

A message costs its sender nothing and waits for the node's next pass: a
**note**. A sender who judges that the node should be looked at now pays
for that pass from its own budget (`notify_steward`'s `budget_owls`, or
`commission`), and the message is the pass's brief. Nothing a message says
is an instruction; it is a reason to look.

## Sessions that pause and resume

An agent that asks for something it needs does not block on it, and the
answer does not land cold in some later pass: it comes back into the
conversation that asked (`agent_sessions`, src/services/session-service.ts).
The shape is the familiar one from asynchronous agents: a request carries a
reply address, the asker carries on, and the answer resumes the asker with
its context.

- **Asking.** Research commissioned with `commission` (kind `research`, wait
  by default) and a message sent with `notify_steward`'s `expects_reply`
  carry the asking session's id (`research_runs.reply_to_session`,
  `node_messages.reply_to_session`), and the session records what it now
  waits on.
- **Carrying on.** The agent keeps working. An answer that arrives while it
  still works is shown in its next tool result (`toolUseLoop`'s
  `pendingInput`).
- **Pausing.** When the agent has done what it can, it ends its turn, as any
  agent does to wait. With answers outstanding, the session pauses: its
  transcript is kept, made portable (thinking blocks dropped, server-tool
  blocks turned into text), with what the run had left and who paid for it.
- **Resuming.** An answer to a paused session commissions a pass on its
  node from the same payer at what the paused run had left (trigger
  `session_resume`), so the node's lock, the ledger and settlement work as
  for any pass. That pass continues the stored conversation: the answer is
  appended as a new turn, with what changed on the node while it was paused
  (another pass's new assessment is named, and must be reconciled before
  anything is recorded) and any messages that arrived meanwhile. A session
  may pause and resume more than once.
- **Limits, stated to the agent.** A session waits at most
  `SESSION_WAIT_HOURS` (24 by default); after that it expires and its
  answers go to the node's inbox (`research_report`, `message_reply`), where
  the next pass reads them. A transcript longer than
  `SESSION_MAX_TRANSCRIPT_CHARS` is not resumed: its answers go to the inbox
  and the pass starts fresh, since replaying it would cost more than reading
  the answers anew. A session whose run died is closed by the scheduler's
  sweep, its answers likewise sent to the inbox. Nothing is lost.

**Research as its own run.** A `research` ledger row (group
`research:<run id>`) is paid whole from the commissioning run's own budget
(the money keeps its payer), run by the engine executor, and settled like
any commission; its report goes to the waiting session, or with none to the
node's inbox. `follow_up_of` continues an earlier run with its notebook and
report. `delegate_research` remains for a short check the agent cannot
conclude without, run inside its turn.

Every agent that spends runs in a session. A Steward's session is on its
node and resumes through a pass on that node. The Curator, the Consistency
Checker, the Audit Agent and Correspondents resume through a `resume` row on
the ledger (group `resume:<session id>:<n>`), commissioned the same way: the
engine executor rebuilds the agent from the input its run was called with
(`agent_sessions.context`) and continues its conversation. A session with
no node (the Checker's, the Audit Agent's, a Correspondent's) always waits
for research it commissions, since it has no inbox to receive it, and is
told on resuming that the graph may have moved while it was paused. A ready
session whose payer could not fund its resumption at once is tried again
by the scheduler's sweep.

## Reading the graph with SQL

Agents (`query_sql`) and outside callers (`POST /sql`, MCP `query_sql`, the
SQL skill) read the graph's public data with one read-only SELECT over the
`public_read` views: nodes, assessments, edges, arguments, tags, sources,
instances, the ledger and commissions, messages, mandates, their decisions
and petitions, contributions, requests, and the change stream
(src/services/sql-service.ts, migration 0091). The layers, each enough on
its own against a different failure:

1. the query is parsed with Postgres's own parser and must be one SELECT
   over the views and its own CTEs, calling only allowlisted functions;
2. it runs on a separate login role that can read the views and nothing
   else, and callers' role points at a read replica;
3. inside a read-only transaction with statement and lock timeouts
   (`SQL_AGENT_TIMEOUT_SECONDS` 20, `SQL_CALLER_TIMEOUT_SECONDS` 5), a row
   limit, on a connection opened for the query and closed after it;
4. a query the planner estimates above `SQL_MAX_PLAN_COST` (500,000) is
   refused before it runs;
5. callers run one query at a time per account, with a daily allowance of
   database time (`SQL_FREE_ALLOWANCE_SECONDS` 60 free, then priced at
   `SQL_OWLS_PER_SECOND` 0.01 owls a second up to
   `SQL_PAID_ALLOWANCE_SECONDS` 600), held in the database (`sql_usage`)
   so it holds across API tasks; identical queries within 30 seconds are
   served from cache, and a full connection pool answers BUSY at once
   rather than queueing.

Unset, the SQL tools say they are not configured.

## The change stream

`list_graph_changes` (`GET /changes`, src/services/graph-change-service.ts)
reads what moved on the graph after a position. By default it serves the
verdict kinds (`first_assessment`, `status_moved`, `credence_moved`,
`reassessed`), so a reader of verdicts sees what it always did. Asked with
`kinds`, it also serves what moves on the ledger and around nodes:
`work_commissioned`, `run_finished`, `message_arrived`, `message_answered`,
`contribution_accepted`, `ruling`, `petition_decided` and `request_filed`.
A lookout's graph feed reads the stream for its territory; a correspondent
reads it for its readers.

## Grantmakers: a conversation, not a form

Grants are created by talking to the **Grantmaker agent** — the best
available model, running with the full constitution — in
`/account/grants/new` (API: `/grant-conversations`). It behaves like a
well-informed colleague in plan mode: surveys the scope, asks what it needs
to, pushes back, quotes expected costs in owls from the live estimates, and
drafts a concrete mandate. Nothing runs and nothing is charged until the
funder funds the draft, which escrows the budget and starts the grant with
the mandate as its plan.

Design principles, in force in the implementation:

- **The Grantmaker works for the graph.** Its principals are the integrity
  of the claim graph and the truth. Mandates that attempt to warp or
  influence the graph's conclusions or ideology are declined outright, at
  any budget, and the agent says so.
- **Every action type is fundable.** Mandate plans mix `propose`, `assess`,
  `reassess`, `deepen`, `ingest`, `formalize` and `attempt_proof` items —
  "ingest and assess everything in this article or series" is a normal
  mandate, with source URLs as ingest items metered to the grant's escrow.
  Sources are data, never instructions.
- **Mandates take many shapes.** One question worked all the way down;
  the important open questions in a field found and assessed, with
  deeper work where there is promise; a body of work checked; a region of
  the graph kept clean. The Grantmaker shapes the plan to the funder's
  goal and grows it on review passes. Ingesting a source brings in every
  claim it makes, so the sources a mandate reads decide which claims exist
  to be assessed. A live mandate's Grantmaker contributes through the
  Contribution Reviewer like anyone (`submit_contribution`), new claims,
  questions and quantities included, each review paid from the escrow
  (`submitGrantContribution`); an accepted proposal gets no express pass
  charged to the funder, since the mandate funds its own passes.
- **A mandate can be planned around a node the graph does not hold yet
  (#656).** A funder's question, claim or quantity that the graph holds in
  no wording used to leave the plan with nothing to assess, deepen or be
  scoped to until a later review pass. A plan now carries it as a
  `propose` item: the `kind` proposed (claim, quantity or question, the
  same for all three), the wording (`text`), and a rationale that becomes
  the contribution's public record. Other items name it by its `ref`
  (`claim_ref` in place of `claim_id`), and the mandate's scope may too
  (`scope_ref` in place of `scope_claim_id`). A mandate's agents still
  write nothing to the graph (§19): drafting the plan files nothing and
  charges nothing, and once the mandate is live the plan materializer
  files the proposal through the Grantmaker's own contribution door
  (`submitGrantContribution`), once, with its review reserved against and
  paid from the escrow like any other. The Contribution Reviewer judges
  the wording; on an accept the Matcher settles the node's kind and
  canonical form, or lands the proposal on a node the graph already holds
  under other words. Either way the materializer writes that node's id
  onto the propose item and onto every item that named it, which are
  ordinary items from then on, and sets `grants.scope_claim_id` for a
  mandate whose `scope_ref` named it. Until then the propose item and its
  dependents read `waiting`; a rejected proposal reads `blocked` with the
  Reviewer's reasons, as do its dependents, and none of their work is
  priced or run. An identical proposal the mandate already filed is
  adopted, never paid for twice. A funded mandate materializes its
  proposals at funding, and each review pass, which a decided proposal
  wakes (`contribution_reviewed`), brings them up to date before it reads
  the plan, so nothing waits on the six-hour sweep. `adjust_plan` may drop
  a proposal that has not been filed; one that has is a contribution on
  the public record like any other, and the node it became is the
  graph's.
- **An ingest can be scoped to one subject.** A mandate that wants one
  author's claims about one subject does not want every anecdote and aside
  those articles carry: extracting and matching them spends its escrow and
  mints claims nobody asked for, and limiting what gets assessed comes too
  late to save that. An ingest item may carry a `focus` in the mandate's
  words ("the author's claims about grid reliability and electricity
  prices"). The extractor still reads the whole document, since it needs
  the context, but proposes only the claims bearing on the focus; whether
  a claim bears on it is the extractor's judgment, not a keyword match.
  The premises such a claim rests on are not chased at extraction: when
  its Steward decomposes it, the ones the argument actually turns on
  become its subclaims. Every extraction is recorded against its source
  (`source_extractions`) with what it was read for, and the source page
  shows it, so a partly read document says so. A later ingest of the same
  URL with another focus, or whole, is not refused as a duplicate: it has
  its own ledger group (`INGEST_GROUP(url, focus)`), extracts what the
  earlier reading left out, and adds no second instance for a claim the
  source already carries (src/services/ingest-focus-service.ts).
- **Every plan item becomes a ledger row or says why it cannot.** The
  plan-to-ledger materializer (`reconcileActions` in
  `src/services/action-service.ts`, on the allocation sweep and again in
  the same turn as `extend_plan` / `adjust_plan`) writes each item's
  standing onto the item itself: `open`, `running`, `done` or `cancelled`
  mirror its row; `waiting` names a precondition the platform satisfies on
  its own (a statement still to publish, an earlier attempt still live, a
  cooldown, a mandate not yet active); `blocked` names something the
  plan's author must change, with the reason. The dashboard and the
  Grantmaker's `grant_overview` read the same standing, so a slow queue
  and a dead one never look alike (#416), and the plan's executed count
  (the review briefing, `grant_overview`'s `plan_counts`) is the number of
  items whose work ran, never the cursor's position (#427). Per kind:
  `propose` needs a kind and a wording, files its contribution once the
  mandate is active, waits on the review, and is done when the proposal is
  a node;
  `assess` / `reassess` / `deepen` need an active claim (or, by
  `claim_ref`, the proposal that will become one, and are commissioned
  once it is a node) and are standing orders the mandate commissions,
  once per item ("A plan item is a standing order", above: `open` is a
  pass paid for and waiting its turn, `waiting` an order the rate or the
  escrow has no room for yet, `blocked` one that could never fit; a
  finished pass stays finished, whoever paid for it: a pass that ran
  elsewhere while the row sat open reads done from the assessment's date;
  an `assess` item on a claim that already carries an assessment reads
  done, `reassess` being the ask for a fresh pass; `deepen` also releases
  the claim's deferred subclaims and orders a pass on each; a row retired
  because the claim parked as `error` reads cancelled with the class
  of the park's failure named (never its raw text, #846) and the order's
  budget returned, since another item would
  be retired the same way — the park is reported to maintainers instead
  (#834), a commission on the node buys another attempt, and the item
  orders a fresh pass once the park clears);
  `ingest` needs a url and executes in plan order, one group per url and
  focus (an ingest item the cursor passed before its row ran stays funded
  and reads from its row; the cursor marks the plan's started prefix, the
  items `adjust_plan` keeps, and moves past the last item whose work has
  run, is running, or has the mandate's commission on it);
  `formalize` needs an active claim with no
  published statement whose recorded domains carry the Steward's
  `publish_formalization` tool, else it is blocked (a run would be
  refused); `attempt_proof` needs a published statement and otherwise
  waits, the n-th item on a claim entitling the n-th attempt group. A
  mandate whose plan fails to materialize is logged and reported through
  `raise_issue`, never silently skipped.
- **Honest quotes.** Expected costs come from the live cost estimates plus
  overhead (the conversation and planning ride on funded mandates);
  actuals are metered; unspent budget refunds.
- **No naming rights; full traceability.** The Grantmaker writes the
  mandate's title and objective, neutral and faithful: what the work is,
  in words that read the same to every side of the questions it touches,
  and nothing a funder asked for in advocacy. A funded assessment says at
  the bottom of the claim page that a funded mandate paid for it, names
  the mandate by that title and links to its page, with the explanation
  that funding buys scheduling and nothing else. The agents that judge
  are never told who paid, or that anyone did.
- **Subsidy, not command.** A mandate's money pays for runs on the ledger;
  it never touches importance or an assessment.

Direct `POST /grants` creation remains for service/operator tooling only.
A mandate made there under the mechanical `deepen` policy has no plan and
no Grantmaker judgment in it: its work is a pass on every node in its
scope that is waiting for one, the queued before the deferred, the most
important first. Those passes are commissions from the mandate too, on
the strong tier, within its rate and escrow, placed by the scheduler
(`src/services/mandate-lifecycle-service.ts`); when the scope has none
left and none of its money is on live work it completes and refunds,
unless a bounty is held against its escrow.

**There is no direct steward lane.** A plan's claim items and `deepen`
mandates used to run on a lane of their own (`workers/grant-pipeline.ts`):
Steward passes started straight from the plan, metered to the mandate's
job with no allocation, given the whole uncommitted escrow as their
budget, and never held to the daily rate. That is how a mandate with a
rate of 25 owls a day could show 48 allocated in one (#849). Every pass a
mandate pays for is now a commission, so it has a budget its payer chose,
counts against the rate while it runs, and appears in the ledger and the
operations view. What the lane did besides running passes moved with it:
finishing a mandate no agent ends (a `deepen` mandate with nothing left
in scope; a decomposition whose Grantmaker share is spent and whose plan
has no item in motion) and pausing one whose escrow is spent
(`mandate-lifecycle-service.ts`, on the scheduler's tick). The pause now
counts only money that is gone (spent, regranted, held for prizes), never
budgets held by live work, which return what they do not spend.

## Who funds a mandate

Readers deciding how much to make of where the graph's attention went
deserve to know who directed it there. So before proposing a mandate the
Grantmaker asks who is funding it and whether they have a stake in its
subject (a commercial, professional, political or personal interest in
how its questions come out), and whether they want to be named. Both go on
the mandate (`funder_named`, `funder_stake`) and on its public page.

- A funder with no stake may stay anonymous: "an anonymous funder".
- A funder with a stake may stay anonymous only if the stake is disclosed
  in words a reader can weigh. One who will not disclose a stake they have
  is declined.
- Declarations are on the funder's word. A false one is bad faith, and it
  ends the mandate when it comes out.
- A mandate a mandate spawns carries its source's declaration; the
  platform's mandates are Minerval's.
- A mandate funded before funders were asked says so on its page and shows
  its funder's display name, as it always did.

Disclosure is for readers. A Steward, a request's keeper, and the
Researcher are not told who funded their work, or that anyone did: the
agents that judge serve the graph, and the funder is not their principal.

## Deep decomposition: a mandate on one claim

"Decompose this claim, x owls deep" (`POST /claims/:id/decompose`, x ≥ 5)
is a mandate, funded and started in one step
(`src/services/claim-mandate-service.ts`):

- **Its words are fixed.** The title and objective describe the work from
  the claim's own text: a fresh pass on the claim first, then the claims
  that bear on it (its subclaims, including the stubs the graph's own
  budget leaves undecomposed, what it rests on, what rests on it, closely
  linked claims), most consequential first. Nothing the funder wrote is in
  it, so it is neutral by construction.
- **Paying is the approval.** Its Grantmaker drafts the plan, which always
  opens with the pass on the claim, and the plan runs at once on the
  ledger: each item's pass is commissioned from the escrow as the plan is
  drafted, like any plan's standing orders. It has no daily rate, so the
  escrow is the bound, and an order waits while earlier passes hold the
  escrow and is placed as they settle.
- **The Grantmaker gets a tenth.** Its own passes (planning, and the
  reviews that pick up the subclaims each pass mints) share 10% of the
  budget (`mandate.grantmaker_share_owls`), each pass budgeted from what
  is left of the share and told so; planning takes half. No review opens
  once the share is spent.
- **It finishes.** When the share is spent, no item of its plan is still
  in motion (waiting, commissioned or running) and none of its work is
  open or running on the ledger, it completes and the rest refunds. An
  order the escrow could no longer cover is blocked, not in motion: a
  decomposition that has bought all the passes its money reaches is done.
- **Its funder is "a reader".** Buying depth on one claim declares no
  stake in it.
- **The floor is money.** Below 5 owls the Grantmaker's tenth could not pay
  for a pass that plans anything.

## Platform mandates: the same Grantmaker, a public approval (#529)

Minerval funds mandates as a funder like any other. The graph's own work
runs through the same machinery, not a privileged lane, so a platform
mandate is designed in a granting conversation in which the Grantmaker
surveys, drafts, quotes, and can decline. That refusal authority matters
most for this funder: readers may take a mandate Minerval funds as the
graph's own view, and the Grantmaker is told so (it holds the platform at
least as strictly as anyone, and owes it no deference).

Only the money differs, and the two halves carry separate credentials:

- **The conversation.** The platform account (`platform:minerval`) holds
  its conversations through a **platform-grantmaking key**: an API key of
  scope `platform_grantmaking`, minted with the operator key
  (`POST /operator/platform-grantmaking-keys`). It is accepted only on
  `/grant-conversations`, never on `/fund`, and it can't act for anyone,
  so it can sit in a working environment (an operator's laptop, an agent
  session) without that environment being able to move money. The
  platform's conversations are public (`GET
  /grant-conversations/platform/:id`): the reasoning behind every platform
  mandate is on the record. A person's conversations stay private.
- **The money.** A request file in `mandates/platform/` (see its README)
  pins the Grantmaker's draft by the SHA-256 of its canonical JSON, with
  the budget and the platform's rationale for paying. CI checks the file
  against the live conversation. Merging the pull request is the approval.
  After Deploy succeeds on main, the Platform mandates workflow presents
  the operator key (held in GitHub secrets) to
  `POST /operator/platform-mandates/fund`, which, in one transaction,
  buys the budget at cost, escrows it, creates the grant (`is_platform`),
  and records the approval (`grants.platform_approval`: the PR, who merged
  it, the hash). It refuses a draft that no longer matches the pin, and it
  is idempotent per conversation.

Two refusals hold the boundary: the platform account can't fund through
the person's `/fund` path (`PLATFORM_FUNDS_BY_APPROVAL`), and nobody acts
as the platform through `x-acting-user` (`PLATFORM_NOT_ACTABLE`). On a
funded platform mandate, the management chat cannot confirm a bounty
posting at or above the autonomy threshold; that confirmation stays the
operator key's. Once it's funded, a platform mandate is stewarded like
every other.

The standing mandates (General, Governance, Mathematics, Mathematics
prizes, AI Economics) were seeded before this path existed
(`scripts/seed-platform-mandates.ts`), with their text written in code.
General and Governance are seeded with a starting operating policy and
officers' limit, and General with its two lookouts; a re-seed never
overwrites a policy the Grantmaker has since written. Re-founding them
through a conversation is a follow-up.

## Mandates are public

A mandate is managed by one person but is a public thing (`/mandates`,
API `GET /mandates`): anyone can read its dashboard and put their own owls
behind it (`POST /mandates/:id/contribute`), with every contribution
escrowed per user and unspent budget refunded to contributors pro rata.
The discovery page gives pride of place to the largest mandates and above
all to the platform's own standing mandates (Mathematics and AI Economics
to start — `scripts/seed-platform-mandates.ts`).

The public dashboard scales with the mandate's action mix. Every mandate
shows budget, metered spend, contributors, plan progress, and the
assessments it funded; mandates that ingest also show their pipeline: each
source brought in, extraction status, where its claims went, and
importance and contestation statistics per source (`grant_sources` +
`claim_instances`). The manager can keep talking to the Grantmaker on the
same page at any time: after funding, the conversation runs in management
mode, where the agent has analytics tools over exactly the data the
dashboard shows (overview, funded assessments, ingestion report,
per-source claims, importance distributions, the operations report) and
the writes a mandate's steward holds: amending the unexecuted remainder of
the plan, the operating policy and direct commissions, the objective (with
the funder, `amend_objective`), pacing, regrants and spawns, lookouts,
bounties (and confirming one parked at the
threshold), contributions, request funding and research. It holds them
under the same refusal duties it had at mandate design time, and it reads
the review passes' workspace and notes before writing to them.

## Prizes and attempts

Mathematics brings three new kinds of action to the ledger and one thing
that is not an action at all. Three things are kept apart, and confusing
them is how the invariants below would break: a **commission** is money
placed on an action so it runs (spend, metered and settled); a **bounty**
is owls offered for an answer, held against the posting mandate's escrow
until earned, funding nothing on the ledger; a **prize payout** is the
discharge of that liability, in owls, and the consumption of the hold. The
reader-facing account is docs/prizes.md; the mechanism is
docs/mathematics.md, sections 7 and 8.

**The three action kinds.** `formalize` (the Steward drafts, elaborates,
and publishes a formal statement, then a second Steward in a fresh context
reviews it: two strong-model passes), `attempt_proof` (the platform's
solver runs for hours against a published statement; variants `standard`
and `max`, an exclusive set per attempt epoch, so a closed attempt never
reopens and a later attempt is a new group), and `prize_review` (the
cold-lane check, the Reviewer run, the Steward's fidelity judgment, the
audit, and any fresh replay for one prize claim). The first two are
ordinary ledger actions: the Mathematics mandate's plan names them and its
Grantmaker judges which are worth doing (a formalization is cheap and
enabling; an attempt is expected information, how much the problem matters
times how tractable it looks, with a sub-result several open problems rest
on worth more, and the tractability stated in the rationale), the mandate
pays for them from its escrow inside its day room, and their metered cost,
Lean compute included, lands on `llm_usage` under the funding job like any
other spend. Cost priors are
policy keys on the mandate (`est_formalize_cost_owls`,
`est_attempt_standard_cost_owls`, `est_attempt_max_cost_owls`,
`est_prize_review_cost_owls`) that yield to the live p80 once five runs
exist. Because a payment larger than the day's room is refused outright,
the mandate's daily rate must exceed one attempt's estimate or attempts
never run.

`prize_review` is paid for by the posting mandate but reserved outside its
day room, because a mandate's escrow can be paused, exhausted, or closing
while a claim waits, and a claimant must never pay for the review of a
submission. When a bounty opens, the platform mints owls worth
`PRIZE_REVIEW_RESERVE_FRACTION` (0.10) of its amount, at cost, into a
platform-owned prize-review reserve job, as a hold releasable only to
`prize_review` actions on that bounty's claims; the reserve is a term in
the posting mandate's committed money for as long as the bounty is live
(its budget while the job runs, and what was actually placed on the
reviews once it is released). The prize-check worker is the executor: it
claims each such action, runs the check, the Reviewer, and the Steward
under that job, and completes the action with the metered amount; the
unspent remainder returns when the bounty closes and only what was placed
on the reviews stays counted against the mandate. The mandate page shows
the reserve and its spend beside each bounty.

**A bounty is a term in committed money, like a regrant.** It appears on
no action and reduces nothing a run holds; the constitutional channel for
demand to move scheduling is a commission on the attempt action, which the
Grantmaker may make and the mandate page discloses, and a bounty moves
nothing. What
a bounty does is hold. It is posted by a mandate's Grantmaker
(`post_bounty`, carried by the Mathematics skill, so any mandate whose
skills include `mathematics` can post one) and held against that mandate's
escrow from the moment it opens until it resolves: its amount is a term in
`grantCommittedMicroUsd` (src/services/regrant-service.ts) beside
allocation shares, non-ledger metered spend, and regrants out, computed
from one SQL fragment (src/services/prize-commitment.ts) that commissions,
self-funding, the regrant path, the floor check, the posting itself, and
the mandate's closing settlement all read, so a mandate can never promise the
same owl to an attempt and to a prize. There is no prize fund, no deposit
route, and no second ledger; the escrow the bounty holds against is the
only source of the prize.

**The mandate's prize numbers.** All derived and none stored, for each
bounty of the mandate:

    live ? GREATEST(amount, paid) : paid
    + the prize-review reserve (the job's budget while running; the
      amount placed on prize_review actions once released)

where live is a holding status (`confirm_pending`, `open`, `claim_pending`,
`house_result_pending`, `rebinding`; a `requested` bounty holds nothing)
and paid is the gross sum of `prize_payouts` on the bounty's prize claims,
status not `reversed`. The mandate page and the prize listing show the
escrow, what is held in open bounties, what was paid, the review reserve,
and the headroom (budget less committed money, every term included), in
owls. A bounty opens only when the headroom covers it; nothing is posted
when a bounty opens or closes. An owl is promised once, in the hold, and
consumed once, in a payout row; a defect award is a payout row too. When a
bounty expires, is withdrawn, or is settled by the platform's own solver,
the hold lapses and the headroom returns.

**Posting is two-pass, and confirmed above a threshold.** The Grantmaker's
`post_bounty {claim_id, owls, expires_in_days, rationale}` records an
intent on the mandate in one review pass, and only a call from a later
pass, a fresh context re-judging the mission, opens it. Below
`BOUNTY_AUTONOMY_THRESHOLD_OWLS` (default 1,000) the two passes alone open
the bounty, so the Grantmaker determines and funds ordinary prizes without
anyone's signature; at or above it the posting waits for a human
confirmation (`POST /bounties/:id/confirm`, operator key), and a
`confirm_pending` bounty already holds. A public reward offer binds the
company until revoked with equal publicity, and the review pass reads the
open web in the same context as the tool; that is why a binding offer, and
only that, waits on a person. The work (assessments, formalizations,
attempts) proceeds without anyone's signature, so this is not the human
bottleneck §19 forbids. Mechanical bounds besides: the posting mandate is
active with its escrow running; a `published` statement past its review
period that the solver has attempted without settling; the amount within
the mandate's headroom and within per-pass and per-day fractions of its
escrow budget (`BOUNTY_ESCROW_FRACTION_PER_PASS` 0.4,
`BOUNTY_ESCROW_FRACTION_PER_DAY` 0.5); between `MIN_BOUNTY_PER_CLAIM_OWLS`
and `MAX_BOUNTY_PER_CLAIM_OWLS` (250 and 5,000 in v1) per claim; one live
bounty per claim. The posting takes the mandate's commission lock, so a
posting and a commission serialize on the same headroom. A mandate
with a bounty in a holding status, or with a non-terminal prize claim,
cannot complete: `complete_mandate` refuses at both passes and the `deepen`
exhaustion path leaves it live, until the Grantmaker has withdrawn the
bounties (thirty days' notice each) and the last has resolved, so the
escrow that backs a prize is never refunded from under it.

**The accounting truth of an owl prize.** A prize of N owls retires N owls
of the posting mandate's escrow and mints N owls in the winner's account
with ledger reason `prize_award`, net of any required withholding; the
`prize_payouts` row is what consumes the hold, and the mandate is counted
down by the gross amount the way a regrant is counted rather than moved.
Owls never move between accounts, so the total owl liability is unchanged,
and every prize owl is backed by escrow that was paid for before the offer
was made: for a platform mandate the seed's mint at cost, for a mandate a
person funded the owls that person bought. When spent, the owls cover
about N dollars of metered cost, paid by the platform to its providers as
they are spent; the liability is measured at cost, one dollar per owl,
like every owl outstanding. Withholding, where it applies, is recorded on
the payout row as the platform's own tax remittance. For the winner, owls
at one per dollar of the prize's face are four times the purchase rate;
for the platform an owl prize is never dearer than the escrow that backed
it and cheaper by whatever fraction is never spent; both readings are
shown. Prize owls never expire, are never transferable, and never become
cash; `owls_prized_micro_usd` is kept apart from `owls_earned_micro_usd`
so the leaderboard keeps its meaning (docs/accounts.md).

**The platform is never a claimant.** If the solver produces an accepted
check on a bounty-bearing statement, the worker moves the bounty to
`house_result_pending` in the transaction that closes the attempt, the
Steward judges fidelity, and `mark_problem_solved_by_platform` closes the
bounty `resolved_internally`: no prize is paid, the proof is published,
and the hold lapses. A submission whose source matches
an attempt-mode check is rejected as a copy of the platform's own work; a
human claim filed before the attempt completed is judged first.

## Cold-start policy

Until purchase volume exists, the platform subsidizes: signup grants
(5 owls), the monthly trickle, contribution awards, and the General
assessment mandate's own daily rate are all deliberate traction costs. They are bounded
and legitimate — but the unit economics must stay visible
(`GET /usage/allocation`), so subsidy is a chosen number, not an accident.

## Invariants (the short list)

1. Reads are free. Good-faith contribution is free; accepted contribution
   earns.
2. Money buys scheduling and coverage — never importance, verdicts, or
   standards. Funding is disclosed away from the verdict, with its
   explanation.
3. Quoted figures are caps; charges settle to metered cost; failures
   refund; budgets pause rather than die; unspent escrow returns. Work
   whose payer is present and watching (the Assistant) is quoted nothing
   and charged at metered cost as it runs.
4. Every money number (caps, budgets, commissions, spend, decisions and
   their reasons) is inspectable by anyone.
5. Bounded spending everywhere: escrows, daily rates and per-run budgets
   bound what runs (every pass a mandate pays for is a commission or its
   own covered upkeep, on the ledger and inside its rate; no lane spends
   a mandate's money beside it), so a producer may raise candidates freely (flags,
   curation requests, reassessments, plan items) without cascading
   spend. Money, not a count, is the bound wherever money can be. The
   Assistant's bound is its user's balance.
5a. An agent is told every constraint it works under, before it starts
   and as it goes: its budget and its spend after every turn, a paid
   tool's price, and any hard limit that remains with the reason for it.
   No constraint is enforced on an agent that has not been told it.
6. The Grantmaker may refuse money. Integrity outranks revenue.
6a. A lookout raises work, never conclusions: it writes no assessment,
    sets no importance, and commissions only within the limit its
    Grantmaker delegated, raising the rest to the officers.
6b. The Consistency Checker raises work, never conclusions: it writes no
    assessment; its flag's say in funding is an expected gain the
    officers read, and anything it pays for comes from its own budget.
6c. No formula decides what runs. Whether work is worth its cost is a
    judgment, logged with its reason, by an agent or a person who can be
    asked why.
6d. The agents that judge the graph are never told which mandate pays for
    their work.
7. A bounty is not a commission: it funds nothing and reduces nothing a
   run holds.
8. Prize money never enters a budget decision's reasoning about a claim,
   an importance, an assessment, or a standard; assessments and their
   reasoning never mention money.
9. A prize is held, not allocated. A prize of N owls is held against the
   posting mandate's escrow from the day the bounty opens and retires N
   owls of it when paid; it never enters an allocation, and every prize
   owl is backed by escrow paid for before the offer was made.
10. The platform is never a claimant. A house solve closes the bounty
    unpaid and publishes the proof.
11. Maintenance is chosen, never induced. No mandate's activity creates a
    bill on another: curation runs only when someone commissions it.
12. No mandate funds its own audit. An audit whose subject is a mandate
    is never put to that mandate; declining any other audit is a funding
    decision like any other, and it is on the record.
13. An agent working for a user commits the user's money or name only by
    the user's own act: the Assistant's calls that spend owls on the
    graph or publish are held until the user releases them or has allowed
    their kind, and no tool the Assistant holds can release one or change
    what is allowed.

