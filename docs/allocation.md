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
    nothing else anywhere decides what runs.

A mandate's own upkeep (its Grantmaker's passes, its lookouts' and
Correspondents' runs, its plan's ingests and sweeps) is commissioned by
the mandate itself at the row's estimate (`commissioned_by` `mandate`);
money placed without a commission runs nothing (`nextRunnableAction`).

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

Budgets are set at what the work needs to be done properly (the costing
skill), because a run that has what it needs finishes the work and gives
back the rest. cost_sheet's figures are what past runs spent while held to
their budgets, so they are read as a floor: a run told its budget is "the
high end of what work like this usually costs, so most runs finish well
inside it" economized, and the next estimate was built from those
economized runs, so budgets ratcheted down (a standard Steward pass was
priced at $0.85 in Nov 2026, with a median spend of $0.34 and the passes on
a breaking story stopping short; see the FAA ground-stop mandate). A run is
now told its budget is for doing the work properly and to use what the
work needs. When the work turns out to need more, its agent
**petitions** the mandate paying for the run, as soon as it sees that, and
gets the answer in its session, carrying on meanwhile. The spend line after
each turn counts the turns left only from 70% of the budget on, and the
notice that most of the budget is spent comes at 70%, with what is left and
the invitation to petition. Neither a budget nor a petition is ever a verdict input: what a
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
Every active mandate's Grantmaker works in one long session on it
(llm/agents/mandate-review.ts; "The Grantmaker's session", below), opened
by a `mandate_review` action self-funded from the escrow and run by the
engine executor, with the affordances anyone entrusted with a budget and a
mission would need:

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
- **commission research and fund requests** (`commission` kind
  `research`, with `research_tier` and, optionally,
  `contribution_budget_owls`; get_research_run, list_requests,
  fund_request), the same instrument and the same request funding the
  owner's chat carries; a research report returns into the session;
- **decide what its officers escalate** (decide_petitions, hold, decline,
  commission, naming each by id; "The Grantmaker's session", below);
- **grow its own plan** (extend_plan): append the ingest/assess items it
  discovered; each is priced, escrow-bounded, and executes through the
  ledger, a stewarding item as a standing order the mandate commissions
  (below, "A plan item is a standing order"); and **change what the plan
  has ordered** (amend_plan_items): the tier or budget of a standing
  order whose pass is not yet running, or its withdrawal, with any budget
  it held returned;
- **hold a reserve** (set_reserve; "Pace and reserve", below), **add to
  the sitting in hand** (add_to_pass_budget) and **begin again**
  (fresh_start): a sitting that has more to do adds to its own budget
  from the escrow, or ends its session and opens a fresh one from the
  workspace; both are funded within the mandate's pace like the rest of
  its work, and the briefing says where the pace stands: cost discipline
  lives in the money the agent can see, never in narrowed affordances.
  The pace itself is the funder's; the Grantmaker proposes a change with
  note_to_funder;
- **say what wakes it** (subscribe, unsubscribe, list_subscriptions;
  "Events and subscriptions", below);
- **tell the funder** (note_to_funder): what only the funder can decide
  (a move above the pass's cap, a bounty confirmation, a top-up), kept on
  the mandate and shown in the funder's chat and grant_overview;
- **move money** (regrant, spawn_mandate — below) and **close the
  mission** (complete_mandate): an exhausted plan is a waypoint, not an
  end; only the agent's judgment (or the funder) completes an
  agent-stewarded mandate;
- **keep watch between sittings** (spawn_lookout, list_lookouts,
  update_lookout, poke_lookout — "Lookouts" below): the briefing lists
  every lookout the mandate funds, its precision, and every flag raised
  since the last fresh briefing.

Every pass is metered to a budget; the refusal duties that govern mandate
design govern review passes equally; the pass ends with a note recorded
on the mandate's public page. The mandate keeps its latest hundred notes
(`grants.mandate.updates`, with the newest also at `last_review`; `GET
/mandates/:id/updates`, MCP `list_mandate_updates`), so a reader can go
back through how it got where it is; older ones are in the run log.
Known gap, deliberately next: a bulk
ingestion primitive ("ingest what this listing/feed points to") so a
discovered index becomes a program of work in one plan item instead of an
enumeration.

### The Grantmaker's session

A mandate's Grantmaker works as a person running a large project would:
it commissions work, carries on with what does not depend on it, and when
there is nothing more to do now it ends its turn. Its session
(`grants.grantmaker_session_id`, an `agent_sessions` row) then pauses with
the conversation intact until something it asked to be told of arrives
("Events and subscriptions", below). There is no review cadence.

- **When a fresh session opens.** The reconcile sweep opens the
  mandate's `mandate_review` row only when the mandate has no live
  Grantmaker session (running, waiting or ready): its first, after
  `fresh_start`, or after a session expired or closed. When something is
  escalated to a mandate with no live session, `openReviewsForEscalations`
  (src/services/mandate-event-service.ts, on the executor's tick) opens
  one at once rather than waiting for the sweep.
- **The first sitting does not wait for the sweep.** Funding a mandate
  (`fundConversationMandate`, `createGrant`, a decomposition, a regrant's
  spawn) or approving its plan opens its first sitting at once
  (`openMandateFirstSitting` in src/services/action-service.ts): the
  planning row of a mandate being planned, the first review row of an
  active one. The executor's next tick funds it (`fundGrantSelfActions`).
  The scheduler's tick between sweeps (`openFirstSittings`,
  `STANDING_ORDER_RETRY_MINUTES` apart) catches any mandate that has never
  had one. On 2026-11-13 a breaking-news mandate funded at 21:25 sat at
  21:31 only because a deploy restarted the process; without it, its
  first sitting would have waited for the six-hourly sweep, a cadence
  nobody had told the Grantmaker or the funder of.
- **What wakes it.** A fresh session holds two standing subscriptions:
  what its officers escalate (`escalated` events on its mandate) and what
  its funder writes (an `inbox_item` that is a funder note). Beyond those
  it subscribes to what matters to its mission (the runs it commissioned
  settling, nodes or subtrees moving, money committed past a figure) and
  sets check-ins. A turn that ends with no check-in held gets one
  `DEFAULT_CHECK_IN_HOURS` (24) out, which the briefing states, with the
  advice to set check-ins to the pace of the story: hours apart for a
  mandate whose horizon is hours or days.
- **The first wave.** When a mandate's first sitting ends with work in
  flight, its session gets one more subscription (`firstWaveSubscription`
  in src/llm/agents/mandate-review.ts): a `work_settled` condition that
  wakes it once, when nothing the mandate commissioned is waiting to run
  or running and no plan item waits for its ingests
  (`mandateWorkInFlight`). One wake for the wave rather than a
  `run_settled` delivery per run: each wake is a paid sitting that
  re-reads the conversation, and run-by-run outcomes are already in the
  mandate's inbox, which the next sitting reads. The FAA mandate of
  2026-11-13 set its next check-in five hours out and subscribed to
  nothing about its first wave while the story moved; this is the default
  that case wanted. A Grantmaker can ask for the same at any time
  (`subscribe` with `when_work_settled`).
- **Each wake is a sitting.** Resuming commissions a `resume` row from the
  mandate (`commissioned_by` `session_resume`) at the review-pass figure
  (below), so a sitting works to the same budget as a fresh pass. It reads
  a wake digest (`grantmakerWakeDigest`) beside what woke it: what is
  escalated and undecided, where the pace stands, how many of the
  mandate's events arrived since its last fresh briefing, and the
  transcript's size, since every sitting re-reads it.
- **Beginning again.** `fresh_start` ends the session, with its
  subscriptions and check-ins, and opens a fresh pass from the workspace
  at once. It pays for an opening turn again, so it is the right tool when
  the transcript has grown dearer than its context is worth;
  `add_to_pass_budget` serves a sitting that only needs more money.
- **Escalations are decided in the session.** There is no separate
  escalation sitting. What an officer escalates is recorded as an event
  and delivered into the session; the sitting reads each escalated
  petition and item as the officers saw it, labelled by its id
  (`escalationDigest`, src/llm/agents/program-officer.ts), runs waiting
  first, and decides with decide_petitions, hold, decline or commission.
- **The mandate's events** (assessments on nodes it funded, decisions on
  its contributions, sources it ingested, its lookouts' flags;
  `collectMandateEvents`) no longer wake it. A fresh briefing lists them
  and marks them read; a resumed sitting is told how many wait.

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
reconcile sweep, `openReviewsForEscalations`, and `fresh_start`; a resumed
sitting is commissioned at the same figure (session-service.ts,
`grantmakerSittingMicroUsd`). Before, the
row carried the public assessment price cap, a deployment constant that
knows nothing about the mandate, and a pass spent most of it on its
opening turn (the Grantmaker's instructions, some seventy tool schemas and
the briefing) before it could survey or value anything.

The money path is the one every self-funded row takes. `fundGrantSelfActions`
places the budget on the row from the escrow, counted whole against the
mandate's pace while the pass runs; settlement spends what the pass metered
and frees the rest. The Grantmaker's own passes may draw on its reserve.
Two more things are particular to them:

- **A pass the pace or the escrow cannot fund in full starts short.** Other
  self-funded work waits for room. A review or planning pass is started
  with what there is, and its row's estimate lowered to that, when it is at
  least `REVIEW_PASS_FLOOR_OWLS` (1); below the floor it waits. The reason
  for starting short is that the pass is the only thing that can fix what
  keeps it from running (the figure, the reserve, a note to the funder). The
  reason for the floor is that a pass started with less than its opening
  turn costs spends it reading the briefing, decides nothing, and is opened
  again, so the mandate would pay for nothing repeatedly. A short pass is
  told so in its briefing with the figures: what the policy names, what it
  was started with, where the pace's window and the escrow stand, and the
  floor. `write_operating_policy` also says, when the figure is set, if it
  is more than a steady pace's whole window or the uncommitted escrow.
- **A pass can add to its own budget** (`add_to_pass_budget`): the amount is
  placed from the mandate onto the running review row by `placeCommission`,
  the path a granted petition takes, so the pace and the escrow are
  checked under the mandate's lock and a refusal carries the figures
  (`OVER_PACE`, `OVER_ESCROW`); then the run's ceiling rises
  (`creditRunBudget`). It adds to the mandate's one live placement on the
  row, so settlement is unchanged. A decomposition's passes are not offered
  it: the share is their bound.

The briefing's budget line states the figure, whose it is (the policy's,
with its reason, or the platform's default and why), that it is held
against the pace while the pass runs, that the opening turn is paid
from it, and how to add to it (src/llm/prompts/pass-budget.ts). The line
other agents get, that a budget is "for doing this work properly", gives
way to that basis here, since the figure is the mandate's own.

The opening turn itself is not made cheaper here. Sittings are usually
further apart than the provider's prompt cache lasts, so each reads its
prompt, tool list and transcript uncached; the wake digest states the
transcript's size so the Grantmaker can judge when `fresh_start` is
cheaper than carrying on.

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
funder chose and budgeted, `self_funded` for the mandate's own upkeep,
which the mandate commissions itself at its estimate (`commissioned_by`
`mandate`: planning and review passes, lookout and correspondent runs,
planned ingests and sweeps). The table used to show commissions alone, so
a mandate could spend most of its money on review
passes and lookouts and see none of it there. A run's overage counts with
the run. What the mandate's job metered outside the ledger altogether (in
practice the Grantmaker's chat with the funder) is in `spent` and in no
kind's row, so the view states it on its own, `outside_ledger_owls`: it
draws on the escrow and is not held to the pace.

## Lookouts: cheap standing watch

The Grantmaker's session is judgment at mandate scale: it wakes on what it
subscribed to and on its check-ins, each sitting paid within the mandate's
pace; the world moves between sittings, and most of what moves is cheap to notice
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

**Limits are the stored fields, not the brief.** The heartbeat and the
per-item commission limit a lookout is held to are the ones set on
`spawn_lookout`/`update_lookout`. The tool's description and result say
so, and each run's task message states them under "Your delegated bounds"
as the figures that govern wherever the brief names another (a lookout of
2026-11-13 was briefed "commission at most about 4 owls in a day on your
own" while its stored limit was 1 owl an item, and it has no daily
allowance at all: its commissions come out of the mandate's pace). The
run is told why the limit exists: larger calls on the funder's money go
to the program officers, who weigh them against everything else the
mandate could buy.

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
provenance, whether or not a lookout watches; a notice of one of those
three kinds that the facts fetch finds when a document is first fetched
sends the same message, services/source-notice-service.ts), the **graph feed** (`graph`: the change stream has entries
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
waiting) gets a `lookout_run` row (`lookout:<id>`) on the scheduler's
next tick (`openDueAgentRuns`, every `STANDING_ORDER_RETRY_MINUTES`, and
at once when it is posted), never on the six-hourly sweep's cadence,
which nobody tells it of; a Correspondent's run opens the same way. It is
self-funded from the
mandate's escrow within its pace like a review pass, outside the
Grantmaker's reserve, with a budget per run
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
funded by `fundGrantSelfActions` from the mandate's headroom within its
pace, outside the reserve, like a lookout run, with no count of runs. It is due when:

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

The run is shown its budget, the sentence every mandate agent reads about
where the mandate's pace stands (`paceRoom`), and why a run may come late.

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
search, Elicit, Pangram, a proof check) states
its price and declines a call the remainder cannot cover, saying what the
call would cost and what is left.

That replaces counts. There is no number of searches, Elicit calls, Lean
checks, new subclaims, reports, flags, plan items, review passes,
lookout runs or lookout ingests per run or per day: an agent spends its budget across its
tools as the work warrants, and a run that needs more petitions the
mandate paying for it (below, "Petitions") and gets the answer in its
session; a Grantmaker's sitting, whose payer is its own mandate, adds to
its budget itself (add_to_pass_budget) under the same checks. What stays
is short, and each item is told to the
agent with its reason: a turn guard far above any real run (it halts a
loop that has stopped spending, not work), the escrow-fraction limits on
autonomous money moves (they stand against injected text, not cost), the
researcher's long wall-clock backstop (it ends a run that has stopped
making progress; nobody waits on it), a hold's latest end when a run
waits on the petition (a caller waiting on the result), the floor
below which a Grantmaker's pass is not started short (a pass that cannot
pay for its opening turn buys nothing, and would be bought again), and the
operator's daily circuit breaker on solver spend.

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
General mandate commissions one of the two from its escrow within its
pace like a review pass, with no count of sweeps (`CONSISTENCY_SWEEPS_ENABLED`
is a deployment switch, off by default).

**Mandates buy sweeps too** (#831). Coverage of a region is something a
funder may want for its own sake, sooner than the platform's lane would
get to it, more often, or on the strong reader. A `sweep` plan item names
a partition (a tag's slug, or `residual`) and optionally a variant; the
plan materializer opens (or keeps) that partition's two rows, due or not,
priced the same way, and `fundGrantSelfActions` funds the named variant
(or, naming none, the one the marginal-return rule below picks) from the
mandate's escrow within its pace, as it funds an ingest item. One item buys one
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
the strong variant was never bought.) Thinking about the work competes with the work: sweeps
come out of the same pace as the passes they ask for.

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
mandate's Steward happened to escalate, uncapped and outside the
rate it then had, and audits ran attributed to nobody. Neither party pays
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
restart. Like every run, each is commissioned; a run works to the larger
of what its commission placed and its run budget
(`CURATE_RUN_BUDGET_OWLS`, `AUDIT_RUN_BUDGET_OWLS`, 5 owls each, as a paid
assessment's pass does; `maintenanceBudget` in the engine executor), and
what it spends past its allocations is metered to the funding mandate.

**What opens a curate row.** A **curation request**
(`curation_requests`, services/curation-service.ts) records a structural
concern about an anchor claim, optionally naming the other claim, and
opens or reopens the anchor's row; one funded run reads every live
request on its anchor, as a lookout run reads its queued events, and
consumes them when it ends.

**Every request says what opened it** (#955), in fields, not only prose:
the **defect** suspected (`curation_requests.defect`: `duplicate`, the same
node in other words or as its negation; `conflation`; `wrong_kind`;
`mislabeled_edge`; `missing_link`; `bad_merge`; or `other`, which its
concern must name), the **other node** when there is one
(`other_claim_id`, whose text is read with the request), who **raised** it
(`source`, and `requested_by_claim_id` for a Steward escalating from
another node), the scan's **score** (`signal`), and the **concern** in the
requester's words. `requestCuration` refuses a request that names no
defect, and `ensureCurateAction` opens a row only on an anchor with a live
request, so no path opens a curate row with nothing to name. A node that is
only unassessed is not a curation: its assess row is already on the ledger
from the moment it is minted (the Steward pipeline opens it), and that is
where a mandate that wants it assessed buys it.

The producers, each bounded:

- a Steward's `escalate_to_curator` (defect required), one live request
  per concern (a repeat is a repeat), with no count per claim: a request
  only waits on the ledger until someone commissions the curation that
  reads it;
- a consistency sweep's `escalate_to_curator` (#742), the same;
- the Audit Agent's `recommend_recuration` (#784), carrying its finding;
- the **Matcher** at ingestion (#738): a node it minted on balance with a
  `curator_review`, a suspected `duplicate` of each near-miss the review
  names by id (every near-miss when it names none);
- the **reconcile-candidate scan**, a scan and not a judgment, a suspected
  `duplicate` with its similarity: SQL over embeddings pairs recently
  created active claims with their nearest unlinked neighbour above
  `reconcile_candidate_min_similarity`, at most
  `reconcile_candidates_max_per_sweep` a sweep (0, the default, is off),
  and never raises a pair that has ever been asked about;
- an operator (scripts/sweep-fallback-matches.ts, `duplicate`).

A repeat of a live request (same anchor, other claim and source) is a
repeat. Requests recorded before #955 have no defect except the Matcher's,
the scan's and the operator sweep's, which migration 0133 classified as
`duplicate`; the rest read as "not classified" beside their concern.

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
policy; the policy says how much of its money upkeep deserves and which
requests come first (an agent's escalation ahead of a scan's pair, an
anchor the Matcher only just admitted after it). Any mandate whose mission
needs its region kept clean says so in its own policy and commissions
curation in its territory; one that commissions none contributes nothing.
The first live epoch's lesson stands as guidance for those policies: 122
unconditional sweeps of claims the Matcher had just declared novel cost
about 13 owls and wrote nothing.

**What the officers read.** The inbox item for a curation lists each live
request on its row: the defect, who raised it, the other node with its
text, and the concern (cut at 800 characters; the Curator's run reads it
whole). Until #926 the item carried only the anchor's text, so on
2026-11-11 the officers declined Matcher near-miss requests as naming "no
concrete defect" and bought first assessments of the anchors instead. An
item is a snapshot taken when its row is raised, so each sitting
(`refreshCurationInboxItems`, at its start) and each reconcile sweep keep
the waiting ones true to the ledger: an item whose row has closed, or whose
row has no live request, is retired (handled by `ledger`, with the reason
in its `detail.retired`); every other is rewritten from its row's live
requests. Nothing is deleted. Curations the officers already declined on
the bare rendering are raised again only by an operator running
`scripts/reraise-curations.ts` (a dry run unless `--confirm`), which adds
one inbox item per such open row and changes nothing else.

**Who funds audits.** The General mandate, as upkeep. A fresh audit row is
put in front of its officers (`fundAuditNow`), whose operating policy funds
every audit that is not a duplicate and, when the pace leaves little room, takes
prize acceptances and bad-faith flags first and periodic sweeps last,
letting an audit that has waited move up. Any other mandate may commission
an audit in its territory.

A separate Governance mandate (policy `governance`) used to pay for audits,
so that audits would not compete with assessments for General's money
and so that General would never decide whether an audit of it ran. Neither
reason held up: audits are upkeep, which is what General's money is for, and
nothing audits General's decisions (the only audit that names a mandate as
its subject is a bounty's, and General posts none). It cost a second
mandate's sittings and review passes to fund about two owls of audits a
month, and production ran without it. It was folded into General; a row
seeded with policy `governance` is left alone, and nothing is routed to it.

**Recusal.** An audit whose subject is a mandate (`audit_runs.subject_grant_id`:
a posted bounty names its posting mandate) is never paid for by that
mandate: a trigger on `action_allocations` refuses it, and an audit whose
subject is General is raised to no one. Declining an audit is
visible, not prevented: an audit no one commissions sits open on the
ledger with its age, on the mandate's page and in `query_sql`'s `ledger`, and an
officer's decline is logged with its reason.

**Prize audits** are paid from the bounty's prize-review reserve, which
the docs always said pays for them: an audit requested with a bounty
(the posting audit, a Steward's acceptance, a checker failure) is paid at
once from the reserve. A reserve that holds the audit's whole estimated
budget commissions it (`commissioned_by = 'prize_reserve'`,
`fundPrizeAuditFromReserve`); a short one places nothing, and the audit
goes to the General mandate's officers, told what the reserve holds,
who commission the whole of it or decline it. One run never has part of
its budget from the reserve and the rest from a mandate. The reserve's accounting (its
room, its release, the mandate's committed money) counts it beside the
reviews (prize-commitment.ts `reserveActionPredicateSql`).

**Promptly.** A fresh curation, audit or request is put in the paying
mandate's inbox when it opens (services/maintenance-funding.ts), and, when
officer sittings are enabled, a sitting starts at once rather than waiting
for the scheduler.

**The fallback lane.** With `BACKGROUND_FALLBACK_LANE_ENABLED` and no
mandate that could fund the kind (no active General mandate, which owns
both curation and audit), an uncovered row runs
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
(`fund_request`), whole, within its pace and escrow. A reader
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

Research an agent commissions from its own budget (`commission` kind
`research`) is on the ledger too: a `research` row paid whole from that
agent's budget ("Sessions that pause and resume", below).

## Pace and reserve

A mandate's **pace** says how fast its money may be committed
(src/services/pace-service.ts, `grants.pace`). It is one of two kinds:

- `as_needed`, the default: the escrow is the only bound. Most mandates
  are projects (explore a question, ingest a source, map a literature)
  whose money is naturally spent as the work arrives, much of it at the
  start.
- `steady` {owls, period_hours}: at most that many owls committed in any
  rolling window of that many hours (24 for a day's worth, 168 for a
  week's), for upkeep that should spread its money evenly. The window is
  rolling, so there is no midnight at which a day's room appears at once.
  It counts each allocation's amount while it is live and its spend once
  it is released (`allocationDayUseSql`, src/services/day-use.ts), so
  running work holds its budget against the window and frees what it
  leaves as it finishes.

The funder agrees the pace when funding: the Grantmaker drafts it with
them (`propose_mandate`'s `pace`) and it is written when the draft is
funded (src/services/grant-conversation-service.ts). Only the funder
changes it: `amend_pace` works only in the funder's chat, and elsewhere the
Grantmaker proposes a change with note_to_funder. Platform mandates are
seeded with a steady pace per 24 hours where they had a daily figure
(scripts/seed-platform-mandates.ts).

Within the pace the Grantmaker holds a **reserve** (`set_reserve`;
`grants.reserve_micro_usd`, `reserve_reason`): money its program officers,
lookouts, plan orders and the mandate's routine runs cannot commit, and it
can. It is how a project mandate spends freely on the first wave of work
while keeping money back for the directions worth pursuing once results
are in. It says who may commit, never when; it is at most the uncommitted
escrow; the Grantmaker draws on it or lowers it whenever it judges. Its
own commissions and passes, the sittings that decide what to fund (an
officer's included: a mandate that cannot pay to decide could never
release its reserve either) and session resumptions may draw on it
(`committerFor`); everything else commits from outside it.

`paceRoom` is the one reading of the window, the reserve and the escrow:
every check of a mandate's money asks it (or its SQL twin,
`windowRoomSql`, where many rows are funded at once), and every agent that
spends a mandate's money reads the same sentence from it about where the
pace stands, with the figures and the reason. The pace, the reserve and its
reason are public on the mandate's page and in `public_read.mandates`
(`pace`, `reserve_owls`, `reserve_reason`).

## Commissions and budgets

A commission pays for one run whole (src/services/commission-service.ts).
The payer chooses the budget; the run's agent is told it in its task
message, and the run starts as soon as the executor reaches the row. Three
kinds of payer:

- **a mandate**: its money, within its pace and its escrow, and outside
  the Grantmaker's reserve unless the Grantmaker commits it ("Pace and
  reserve", above). A commission past the pace or the reserve
  (`OVER_PACE`), or past the escrow's uncommitted money (`OVER_ESCROW`),
  is refused whole with the figures; it is never clipped. Commissions
  from one mandate serialize on a per-mandate lock, so parallel
  commissions commit the same room once. A commission the platform
  cannot run yet, because a platform fault is stopping its kind of work
  (docs/architecture.md, "A platform fault makes the ledger row wait"),
  keeps its hold: it still counts against the pace from when it was
  placed, as any work not yet run does. Freeing it would let a mandate
  place a second window's worth of work behind the same fault, all of
  which would run, past the pace its funder set, the moment the fault
  cleared. The row says it is waiting and why (`waiting_on` in the ledger
  view, the note on the commission's result, the review briefing), which
  is the rule here: no limit is added and none is lifted, and the payer
  sees the state and its reason.
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
does not commission a variant whose sibling is already paid for or running.
The check is made again behind a lock on the group as the money is
placed, so payers who look at the same moment do not both pay (#849: one
node carried a mandate's budget on both its variants, which counted twice
against its rate).

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

### A stewarding item can wait for the plan's ingests

An ingest takes far longer than a pass: the extractions are read one
after another, so a plan of many sources has rows that run for hours. A
pass placed beside them runs first and judges its node without the
sources the plan bought for it, and nothing re-reads the node when they
land until a Grantmaker's later sitting asks. On 2026-11-13 the FAA
mandate's assess and deepen items ran at 21:44, before any of its ingests
had been read, and the next sitting was five hours away.

An `assess`, `reassess` or `deepen` item may therefore name, in `after`,
the urls of ingest items in the same plan (its own call's items or the
plan's existing ones; `validatePlanItems` refuses a url that names none).
The materializer (`ingestsGate` in src/services/action-service.ts) leaves
such an item `waiting`, placing nothing and holding no money, until every
ingest it names has been read: it has rows and none is open or running
(done, or cancelled as unreadable). The item's standing names the unread
ingests and the hour it waits until. The standing orders are looked at on
every scheduler tick, so the pass is placed within minutes of the last
ingest landing. It waits at most `AFTER_INGESTS_MAX_WAIT_HOURS` (12),
counted from when it could first have been placed (`after_wait_from` on
its standing): an extraction can queue for hours behind others, and a
pass that waits for sources that never land is worse than one that reads
without them, which a reassess item can correct. Money cannot serve as
that bound, since nothing is spent while the item waits. Past it the pass
is placed and its standing says which ingests it went without.

Why this and not a message to the node's Steward when an ingest lands
claims on it: the plan is where the Grantmaker states what it wants done
and in what order, and an explicit dependency on that plan is visible,
priced and amendable there. A message after the fact would buy a second
pass the plan never asked for, whose cost nobody stated up front. The
Grantmaker is told of `after` in its role prompt and in every plan tool's
rules (`PLAN_KIND_RULES`, `PLAN_ITEM_SCHEMA`).

### A plan item is a standing order

An `assess`, `reassess` or `deepen` item of a mandate's plan is an order
for a Steward pass, and the mandate commissions it
(`src/services/standing-order-service.ts`, from the plan materializer):
whole, from its escrow, within its pace and outside the Grantmaker's
reserve, at the item's
`budget_owls` or, naming none, the row's estimate, on the item's
`variant` (standard or strong). The allocation's `commissioned_by` is
`plan`, and it shows in the mandate's commissions like any other. Before
this, an item only queued the node and opened its rows; nothing placed
money on them, so an item read "open" for weeks and ran only if someone
else happened to pay (#849).

**An order names its tier.** Every stewarding item is stored with a
variant: the one its author names, or standard when it names none
(`normalizePlanItems`). The strong model costs several times the
standard one, so it is bought where a Grantmaker asks for it and nowhere
else. For a day this was the other way round: an item that named no
variant was commissioned strong, which is how items appended before
plan items were orders at all became strong orders at the estimate and
took most of a mandate's day (#956). An item stored without a variant
(any written before this rule) is therefore not commissioned on a tier
nobody chose: it reads `blocked`, its reason gives both tiers' current
estimates, and it places nothing, and releases none of a deepen's
children, until its Grantmaker gives it a variant (`amend_plan_items`).
An order it had already placed is left exactly as it was placed: its
tier and budget are on the item (`ledger.order`), and its Grantmaker can
change it like any other order that has not started.

`commission` is now-or-refused: its caller is in a turn and reads the
refusal. A plan item has no turn to come back in, so the mechanism keeps
asking for it:

- an order the pace's window or the reserve leaves no room for reads
  `waiting`, with its tier, the budget and what the pace has left, and is
  placed by the first look that finds room for it whole (the window frees
  as running work settles and commitments age out of it; the reserve when
  the Grantmaker lowers it or commissions the order itself). **It does
  not hold the items after it.** Each look goes through the plan in order
  and places every order the room covers, so plan order is first claim on
  the room and never a queue with one head. (For a day it was one: once
  the rate turned an order away every later one waited behind it, and a
  5.9-owl order kept twenty-nine 0.8-owl orders waiting beside 1.2 owls
  of unused room, #956, #961.) The cost of this choice is stated on the
  order that pays it: a large order can be passed over, look after look,
  while smaller ones after it take the room. What moves it is the
  Grantmaker's: its reserve, the order's budget or tier, or withdrawing
  what takes the room;
- an order the escrow cannot cover beside the budgets held by work that
  is waiting or running reads `waiting` too, with what is free and what is
  held, since held budgets return what they do not spend;
- an order that could never fit reads `blocked`, with the figures: a
  budget above a steady pace's whole window, or above what the escrow
  could cover with every held budget returned. Only its author can change
  that (the budget, the variant, a top-up), or the funder the pace;
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

**What a plan commits stays its Grantmaker's to change until it is being
spent** (`amend_plan_items`, `src/services/plan-amend-service.ts`; in
review passes and the funder's conversation alike). An item's work has
*started* once its pass is running. Until then, whether the order is
waiting for room, blocked, or placed and waiting its turn in the queue,
and wherever the item sits in the plan, the Grantmaker may give it
another variant or budget, or withdraw it. A budget the order already
holds is released at once, back to the escrow and the pace's room; an
amended order is asked for again on its new terms in the same call, and
a withdrawn item reads `cancelled` with the Grantmaker's note, stays in
the plan as a record, and is never asked for again. A pass that is
running or has run is left as it is: money being spent is not taken from
under a run. A deepen item is several passes, so the rule holds for each:
a change reaches every pass of the item that has not started. Items are
named by index and node, both checked, and a call is refused whole, with
each reason, if any of its changes cannot be made. Before this a plan
was append-only for the review pass, and `adjust_plan` could replace
only what followed the last started item, so the one way to stop an
order was to raise the daily rate (since replaced by the pace) and buy a throwaway pass on the same node
(#956). `adjust_plan` uses the same meaning of started: it keeps the plan
up to the last item whose work has run or is running, replaces the rest,
and withdraws the orders the replaced items had placed.

A Grantmaker can see what a list of items would commission before it
writes them: `extend_plan` and `adjust_plan` take `preview: true`, which
returns each stewarding item's tier and budget per pass, whether its
node's pass would be bought or is already met, the children a deepen
item would order by id, and the total against the pace's room and the
escrow, and writes nothing (`previewPlanOrders`).

A `deepen` item is two things: the pass on its node, and a **first
assessment for each of the node's direct children that carries no
judgment** and is queued for a pass, at the same budget and tier under
the same pace and escrow. It releases the node's deferred children (the
stubs the importance brake held out) and orders the unjudged ones, most
important first, each once per item, and looks again after the node's
own pass has run, which is when the children that pass minted exist. A
child that already carries a verdict, estimate or standing is never
ordered a fresh pass by a deepen item, however it came to be queued: the
cadence queues judged nodes as candidates all the time, and a deepen
item that took every queued child bought strong re-passes of week-old
verdicts (#961). A fresh pass on a child is a `reassess` item on that
child. The item's standing names the children it ordered (`children`)
and those it has not been able to commission yet (`children_waiting`),
and says how many judged children it left alone. A child the room cannot
cover does not hold its siblings. It goes one level; deeper is another
item, by the Grantmaker's judgment. The mechanical `deepen` policy
(mandate-lifecycle-service.ts) orders by the same rule across its scope.

When the Steward parks a node after repeated failures, the item reads
cancelled with the failure, and its order's budget goes back to the
escrow; so too when the pass an item asked for ran on another lane (a
reader's order) before its own money was used.

**A mandate's own upkeep is self-funded.** Its planning pass, review
passes, lookout and correspondent runs, the ingest items its plan names,
and (for the General mandate) the consistency sweeps are rows the mandate
commissions itself, whole, at their estimated cost (`cost_est_micro_usd`),
from its escrow within its pace (`fundGrantSelfActions`,
src/services/allocation-service.ts; `commissioned_by` `mandate`, with the
reason on its record): deliberating about the work competes with the
work. Only the Grantmaker's own passes may draw on its reserve, and only
they start short (above); other upkeep waits for room. The estimates are
live p80s of metered runs once enough exist (cost-estimate-service.ts),
else policy priors.

Before #991 the same pass placed this money with no commissioner, and a
row needed only to be covered to run. Migration 0143 records those
placements as the commissions they were: every allocation not yet
released that a mandate pinned to a row of one of those six kinds, with
no commissioner and no valuation of the row by that mandate, takes
`commissioned_by` `mandate` and the pass's reason for the kind. Amounts,
spend and release are not touched. Without it such a row could never run:
the placement still counts as the row's coverage, so the pass places
nothing new, and no executor picks a row without a commission (twelve
funded consistency sweeps stood open that way on 2026-11-13). What the
migration leaves without a commissioner is the allocator's old money
(#855 removed it), placed on a group as a whole or on a row its mandate
had valued, and a run's overspend, which is written already spent and
released.

An ingest row reads `running` from the moment the executor submits its
source until the extraction is read, and extractions are read one after
another, so a plan that names many sources at once has rows that read
`running` for hours. The reconcile sweep returns a `running` row to open
when its worker has died (60 minutes untouched; 24 hours for an ingest;
3 for a solver attempt). It leaves an ingest row alone while the
extraction job submitted for it is still pending or being read, however
long that is, up to the four days the queue keeps a message: reopened
earlier, the row would be submitted again and both extractions metered to
the same funders.

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
the agent's plan as its brief). The agent says what it has established so
far (`done_so_far`, required), what it would do with the money, why its
budget cannot cover it, and what it will conclude if the answer is no.

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
together, and runs a program officer (src/llm/agents/program-officer.ts).
What the officer escalates goes into the Grantmaker's session ("The
Grantmaker's session", above); a petition with a run waiting that the
officer neither decides nor holds is escalated when the sitting ends, so
the run is not left without an answer.

**Never blocking.** A petition never blocks the run that asks. Every agent
that spends (the Stewards, the Curator, the Consistency Checker, the Audit
Agent, Correspondents) runs in a session, and the petition carries its id
(`petitions.reply_to_session`) and the agent carries on; the decision
returns into the session (below, "Sessions that pause and resume"),
appearing in its next tool result. An agent with nothing else to do calls
`wait_for_answers`, which holds it at most `SESSION_WAIT_FOR_ANSWERS_SECONDS`
(60), since most petitions are decided in seconds and waiting holds the
node's lock and a worker. Past that, it ends its turn and its session pauses
until the decision arrives.

**Holding.** An officer or the Grantmaker may hold a petition or an inbox
item rather than decide it now (`hold`; `petitions.status` `held`,
`held_until`, `hold_refs`, `hold_reason`): until a time, or until named
runs on the ledger settle, whichever comes first, with what it waits to
learn. Holding is a decision, recorded with its criteria. The asking run
is told at once, without being woken, that its answer will come later and
why. A hold on a petition a run waits on must end before that run's
session deadline less `HOLD_MARGIN_MINUTES` (60), and the brief states that
latest time for each. When its time comes or its runs settle,
`releaseHolds` (petition-service.ts, on the executor's tick) returns it to
whoever placed it: an officer's to the officers, the Grantmaker's to its
session as an escalation, which wakes it. A held decision is never refused
by time passing.

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
six sections. `current` is its direction for now, beside the standing
policy (which branches look promising, what to grant and what to hold
until which work reports); it is dated when written, rendered first, and
rewritten as often as things change. The standing sections are mission
(in working terms), priorities, budgets (how to budget each kind of work),
petitions (how to answer them), and delegation (what to send the
Grantmaker). It carries the **officers' limit**, the most
an officer may commit in one decision, with the reason the Grantmaker gives
for it, which the officers are told (`DEFAULT_OFFICER_LIMIT_OWLS`, 5, when
the policy sets none), and the **review-pass budget**, what each of the
Grantmaker's own review passes and resumed sittings works to, with its
reason, which each is told (`review_pass_owls`; `DEFAULT_REVIEW_PASS_BUDGET_OWLS`, 5, when the
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
(`PROGRAM_OFFICER_MODEL`) and reads one brief (`buildBrief`):

- where the mandate's money stands (the pace sentence, from outside the
  reserve) and what deciding has cost over the last seven days;
- **what else the money could buy**: inbox items waiting beyond this
  brief, petitions held, plan orders waiting for room, and open, unpaid
  work on nodes the mandate has paid for before or their premises, with an
  estimate beside each, so each ask is weighed against these;
- the mandate's approved terms and its operating policy;
- its decisions over the last fourteen days, and every decision ever made
  on the nodes in front of it, so a branch is judged as a branch;
- each petition (`describePetition`) with the chain of runs that funded
  it, what it has established so far (`done_so_far`), what the run has
  already commissioned from its own budget and how that went, its plan,
  the node's neighbours (the other premises of the same parent, with their
  standing and any open asks on them), the return on past grants like it
  (of the granted petitions of that kind from that agent, how many were
  followed by an assessment and in how many the status or confidence
  moved: information gained, not a verdict the money bought), and, where
  a run waits on it, the latest time a hold may end.

It decides each item (`decide_petitions`, `commission`, `hold`, `decline`,
`escalate`, `log_note`), up to its limit; what is past the limit or what
the policy does not settle goes to the Grantmaker's session, where it is
decided on the strong tier and, where the policy did not settle it, the
policy is changed so the next one is settled. Research is commissioned by
the Grantmaker only, since its report returns into a session an officer's
sitting does not have.

A sitting is commissioned from the mandate on its own row
(`officer:<grant>` at `OFFICER_RUN_BUDGET_OWLS`, 1), so deciding counts
against the mandate's pace and escrow like any of its work and returns what
it does not spend. The scheduler also holds sittings for inboxes no run is waiting on
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
  agent does to wait. With answers outstanding, or holding a subscription
  that would wake it ("Events and subscriptions", below), the session
  pauses instead of closing: its
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
  `SESSION_WAIT_HOURS` (24 by default), or until an hour past its latest
  check-in when that is later; after that it expires and its
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
report. This is the only way research is launched (`delegate_research`,
which ran the Researcher inside the launcher's turn, is retired): agents
with a budget commission it from their own (spend-tools.ts), the
Grantmaker from its mandate (its `commission`, with `research_tier` and
`contribution_budget_owls`). Since nobody blocks on a research run, every
one gets the long wall-clock backstop
(`RESEARCHER_REQUEST_MAX_WALL_MINUTES`, 240), which ends only a run that
has stopped making progress; its budget is what bounds it.

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
`contribution_accepted`, `ruling`, `petition_decided` and `request_filed`,
and `state_changed`, a node archived, restored, merged or deprecated, read
from `claim_state_changes` with who did it, why and the successors (#962).
A lookout's graph feed reads the stream for its territory; a correspondent
reads it for its readers. The stream is computed from the tables at read
time; it is separate from the event log below.

## Events and subscriptions

**The event log** (`events`, src/services/event-service.ts) is one
append-only row per thing that happened that someone may want to be told
of, recorded by the code that makes the change, with the refs it touches:
`run_settled` (a ledger run settled), `run_closed` (a row closed without
running), `petition_decided`, `escalated` (an officer sent something to
the Grantmaker, or a hold the Grantmaker placed came back), `inbox_item`
(something raised to a mandate's inbox), `assessed`, `source_event` (a
source retracted, corrected or superseded), `message_answered` and
`mandate_changed` (its operating policy, pace, reserve or terms).
Recording never fails the change it describes.

**A subscription** (`subscriptions`, src/services/subscription-service.ts)
is a standing interest held by a subscriber: a session, a mandate's inbox,
a node's inbox or a lookout. It is one of four kinds:

- **an event**, by kinds and refs: runs by action id, nodes, everything
  under a node, the nodes over it (resting on it), tags, sources,
  mandates, and other refs an event carries (a petition, a research run,
  an item's kind). Every key a filter names must match, and within a key
  one of its ids is enough; to be told of either of two things, hold two
  subscriptions;
- **a time**: a check-in at a set time;
- **money**: once the mandate has committed a given amount since the
  subscription was made;
- **work settled**: once nothing the mandate commissioned is waiting to
  run or running and no plan item waits for its ingests
  (`mandateWorkInFlight`), for one wake when a whole wave has landed.

Delivery is `wake` (the default) or `queue`, and `once` ends a
subscription at its first delivery; a check-in and a threshold always end
when they fire. Holding a subscription costs nothing.

**The router** (src/services/subscription-router.ts) is plain code with no
model in it. It reads the log in order from where it last stopped, as
events are recorded and again on the engine executor's tick, and delivers
each event to every active subscription it matches; on the tick it also
delivers the check-ins that are due and the thresholds that have been
crossed. To a session, a delivery is an answer in its transcript, shown in
its next tool result if it is running; a `wake` delivery resumes it if it
has paused, and a `queue` one waits for its next turn. To a mandate's
inbox it is an item its officers read; to a node's inbox, a message its
Steward's next pass reads, never waking one; to a lookout, a queued input
for its next run (src/services/subscription-sinks.ts). A delivery carries
an event's text only when the event is public or was recorded at the
subscriber's own label; inboxes and lookouts receive only public events.

**Agents subscribe for themselves** with `subscribe`, `unsubscribe` and
`list_subscriptions` (src/llm/tools/subscription-tools.ts); the
subscriber is always the calling run's own session. A session that holds a
subscription that would wake it pauses when it ends its turn instead of
closing, and waits at least until an hour past its latest check-in. Each
wake is a resumption paid like any other and re-reads the conversation, so
the tool asks for a few subscriptions that matter over many that do not,
and for queueing what can wait. Today the Grantmaker is the agent that
carries these tools ("The Grantmaker's session", above).

## Grantmakers: a conversation, not a form

Grants are created by talking to the **Grantmaker agent** — the best
available model, running with the full constitution — in
the Ask section (`/ask/mandates/new`; API: `/grant-conversations`). It behaves like a
well-informed colleague in plan mode: surveys the scope, asks what it needs
to, pushes back, quotes expected costs in owls from the live estimates, and
drafts a concrete mandate. Nothing runs and nothing is charged until the
funder funds the draft, which escrows the budget and starts the grant with
the mandate as its plan.

A grant and the mandate it funds are one row and, on the site, one thing
with one name: a mandate. It has one page (`/mandates/:id`, where its
manager also sees what waits on them) and one conversation, which sits in
the Ask section beside the Assistant's and is listed there under
Mandates: `/ask/mandates/new` to start one, and `/ask/mandates/:id` for
the manager of a funded one, with the mandate at a glance beside it and
the controls to approve the plan, top up and withdraw. The Assistant
works for the user and a Grantmaker works for the graph, so the two are
kept as two conversations and each says which it is. The older addresses
(`/account/grants`, `/account/grants/new`, `/account/grants/:id`)
redirect. The API and MCP names keep "grant" (`list_grants`,
`top_up_grant`): they are what callers already use.

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
- **An ingest costs what ingests cost.** An ingest row is priced at the
  live p80 of finished ingests' metered cost (an extraction and the
  Matcher runs it makes), else the governing policy's prior,
  `est_ingest_cost_owls` (1 owl), as curation and audit rows are. It is
  not priced at `CAP_SOURCE_INGEST_OWLS`, which is the most a person
  submitting a source is charged: a mandate holding that ceiling on every
  ingest could fund few of them, and the old cap (0.1 owl) was a tenth of
  a typical ingest, so mandates' plans and costing read ingests as nearly
  free and the overrun was placed after the fact.
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
  pass paid for and waiting its turn, `waiting` an order the pace, the
  reserve or the escrow has no room for yet, `blocked` one that could never fit; a
  finished pass stays finished, whoever paid for it: a pass that ran
  elsewhere while the row sat open reads done from the assessment's date;
  an `assess` item on a claim that already carries an assessment reads
  done, `reassess` being the ask for a fresh pass; `deepen` also releases
  the claim's deferred subclaims and orders a first assessment for each
  direct child that carries no judgment; an item stored without a
  variant reads `blocked` until its Grantmaker names one; an item its
  Grantmaker withdrew reads `cancelled` with the note; a row retired
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
  run or is running: an order that is placed and waiting its turn has
  not started, and can still be amended, withdrawn or replaced);
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
the strong tier, within its pace and escrow, placed by the scheduler
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
counts against the pace while it runs, and appears in the ledger and the
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
  opens with the pass on the claim (added on the standard tier when the
  Grantmaker leaves it out; it puts its own first, with the variant and
  budget it chooses, where the claim warrants the strong model), and the
  plan runs at once on the
  ledger: each item's pass is commissioned from the escrow as the plan is
  drafted, like any plan's standing orders. Its pace is as needed, so the
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

The standing mandates (General, Mathematics, Mathematics prizes, AI
Economics) were seeded before this path existed
(`scripts/seed-platform-mandates.ts`), with their text written in code.
General is seeded with a starting operating policy and
officers' limit, and General with its two lookouts; a re-seed never
overwrites a policy the Grantmaker has since written. The seed finds each
row by its key (`mandate.seed_key`), so a mandate can be renamed in the
file. Changing one takes a pull request to the file, then the seed run
against production (`--update-mandate <key>`, as a one-off task with the
API's credentials): the merge is the platform's approval, so a changed
title or objective is applied and recorded as a terms version.
`--replace-policy --note "<why>"` also writes the file's operating policy
and lookout briefs over the live ones, through the versioned path, for
when the platform as funder changes what the mandate is for; the
Grantmaker revises from there. Re-founding them through a conversation
is a follow-up.

**General is a maintenance mandate.** Its money is the platform's, and
it buys what no topical funder would: consistency sweeps, curation,
audits, work someone is waiting on, passes where
something under a published verdict changed, and the unassessed premises
of published verdicts. It does not pay to extend coverage; first
assessments are for the mandates and readers whose scope they are. Its
operating policy gives that upkeep first claim on its money.

## Mandates are public

A mandate is managed by one person but is a public thing (`/mandates`,
API `GET /mandates`): anyone can read its dashboard and put their own owls
behind it (`POST /mandates/:id/contribute`), with every contribution
escrowed per user and unspent budget refunded to contributors pro rata.
The list (`/mandates`) is in three tabs, each of which can hold hundreds:
the reader's own (every mandate they fund, from its first draft, with what
needs them first), the platform's own standing mandates (Mathematics and
AI Economics to start, `scripts/seed-platform-mandates.ts`), and
everyone's, largest budgets first. A tab is searched by title and
objective, narrowed by state (active, paused on a spent budget, finished)
and read a page at a time. `GET /mandates` (MCP `list_mandates`) serves
the same: `scope`, `state`, `q`, `order`, `offset` and `limit`, with the
count in each state and scope; with no parameters it lists the mandates
open to backing, as it always has. A public scope holds only mandates that
have started.

The mandate's page (`/mandates/:id`) sets the mandate itself (title,
objective, strategy) as a document, and reports on it under it: what is
happening now, its actions (the items of its plan), its agents, its
spending, its completed work and its history. Text an agent wrote is on a sheet with a byline; everything else
is the page's own. A mandate that has not started (still being drafted,
or its plan awaiting approval) is readable by its funder alone, who sees
on the same page what waits on them and the controls to approve the
plan, top up and withdraw.

Completed work is counted whole and listed a page at a time, by kind
(`GET /mandates/:id/work`, MCP `get_mandate_work`;
`mandate-work-service.ts`): assessments, which are the judgments of
claims, questions and quantities alike, one row a node with the passes
paid for on it; sources read, with where their claims went and
importance and contestation statistics per source (`grant_sources` +
`claim_instances`); requests worked on; research; nodes proposed; and
the mandates it funded. The findings its agents noted stand beside them.
"Now" shows its Grantmaker's current direction (the dated first section
of the operating policy) and latest update, whether its Grantmaker is at
work or waiting and what will wake it (counts and times only: a
subscription's reason is its run's own words), its latest sittings as
links to the run log (`/runs/:id` reads itself again every few seconds
while a run is under way, so a sitting can be watched as it works; whether
a transcript is public is the run log's rule), the work that is open,
and any platform fault that is holding work up. The manager can keep talking to the Grantmaker on the
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
pays for them from its escrow within its pace, and their metered cost,
Lean compute included, lands on `llm_usage` under the funding job like any
other spend. Cost priors are
policy keys on the mandate (`est_formalize_cost_owls`,
`est_attempt_standard_cost_owls`, `est_attempt_max_cost_owls`,
`est_prize_review_cost_owls`) that yield to the live p80 once five runs
exist. Because a commission larger than a steady pace's whole window is
refused outright, a mandate on a steady pace must allow at least one
attempt's estimate per window or attempts never run.

`prize_review` is paid for by the posting mandate but reserved outside its
pace, because a mandate's escrow can be paused, exhausted, or closing
while a claim waits, and a claimant must never pay for the review of a
submission. When a bounty opens, the platform mints owls worth
`PRIZE_REVIEW_RESERVE_FRACTION` (0.10) of its amount, at cost, into a
platform-owned prize-review reserve job, as a hold releasable only to
`prize_review` actions on that bounty's claims; the reserve is a term in
the posting mandate's committed money for as long as the bounty is live
(its budget while the job runs, and what was actually placed on the
reviews once it is released). Each review is a commission from that
reserve (`commissioned_by` `prize_reserve`, `fundPrizeReviewAction`), at
its estimate or what the reserve still holds if less. The prize-check
worker is the executor: it
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
assessment mandate's own pace are all deliberate traction costs. They are bounded
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
5. Bounded spending everywhere: escrows, paces and per-run budgets
   bound what runs (every run a mandate pays for is a commission, its own
   upkeep included, on the ledger and inside its pace; no lane spends
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

