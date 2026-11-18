# Releasing a page to readers who do not read its label

Often the best evidence for something is more sensitive than the thing
itself. A deployment that holds material at more than one label
([architecture.md](architecture.md), "Labels and clearance") can release
what an agent concluded from evidence and hold the evidence back. A node's
page written at one label is released to readers who may not read that label,
at another label inside the deployment or outside it, with what was removed
marked in its place, and in a form those readers can check.

A node's page is one kind of thing that passes a gate, and the gate is the
same at every boundary ([the-gate.md](the-gate.md): its acts, its settings,
what flows, who pays, the backlog). Releasing what was concluded at one label
to the readers of another, and releasing it outside the deployment, are the
same steps with a different destination. This document describes a page's
own part of those steps as built: what a page is, its parts, the policy,
the fingerprint, and what its readers see. A release outside goes through every step below, and what it
releases is then carried out of the deployment in a signed package and read
on the public graph: [published-pages.md](published-pages.md).

The public graph has one label, which everyone reads. Nothing below exists
there: the routes are not mounted, the tables are empty, and no run is told
any of it.

This was once called showing a page below its label (see "Old names in
the code", at the end). Labels are not ranked, and nothing a person or an
agent reads says "below": a page is released to readers who do not read
its label.

A *release* is the standing arrangement or the single act: a page, or a
flow of pages, going from one label to readers who do not read it, or
outside to the public graph. It is once or standing, and it ends. Each
party whose material a part rests on *consents* to that part going out,
and a part is *released* once every party it rests on has consented; until
then it is *held*. Authority over a release is holding the permission to
consent for a party.

## What is released

The ordinary page of a claim, a quantity or a question at one label: the
version of its judgment at that label (the status, estimate or answer, with
its confidence and any credence, the summary and the reasoning), its
arguments with their written forms, stances and evaluations, the readings of
its sources, its subclaims with how each bears, the requests it records, and
a stated view where one is recorded. No run produces it and no table holds
a special form of it. It is read from the rows the Steward's ordinary work
wrote (`readPage` in `src/services/release-service.ts`).

A release covers the rows at the page's label and no others. A row that the
page's label merely reads belongs to that other label's page: where the
destination reads it too it has it already, and where it does not, releasing
it is a release across that other boundary, under that boundary's policy.

## Asking

A person who holds the permission to direct the graph sets a flow of pages
at a label they read toward a named label, or outside (`set_page_flow`, `POST /releases`):
for one node, a node with what sits under it, every node one mandate's
work assessed, or every node assessed at the label
([the-gate.md](the-gate.md), "What flows"). The destination must not already read the page's label.
The two labels need not be related in any other way: a page at one label
can be released at another that neither reads nor is read by it.

- **Once or standing.** Released once, the page goes as it stands, dated, and
  nothing is undertaken about later versions. Released standing, each later
  version follows: a page is opened for it and goes through the same steps.
- **The node alone, or the node with what sits under it.** Under the wider
  scope a node that later comes to sit under the released node is covered from
  then, as not yet assessed. A node that leaves stays in the release's
  record with the date and the reason, which is one of a fixed list read
  from the record (the link was removed, the node is no longer active, the
  release ended). A node that also sits under other things appears once, in
  its place under the released node.
- **A mandate's work, or the whole boundary.** A flow for a mandate covers
  every node whose judgment at the label that mandate's budget paid for; a
  flow for the boundary covers every node assessed at the label. Both are
  standing. Its record, and a page published from it, say what it covers in
  those words (`releaseCovers`, `src/published-page/shape.ts`), naming the
  mandate and the label only to a reader of the label.

No page is offered to a gate that no flow covers. Ending a standing flow is
a dated event with a reason from a fixed list; what was released stays released.

Every act on a release is a row that names who did it and the permissions
they held then (`release_acts`), so a reader on the other side can see when
a person who directed the work also consented to it.

A part that rests on no outside party's material is the organization's to
consent to, so the organization itself must be a party
(`parties.is_own_organization`). It is from setup, and the person who set
the deployment up holds `consent` for it ([accounts.md](accounts.md)). A
deployment set up before that was so is refused, with the reason, until an
administrator adds the party.

## The parts of a page

The system divides the page into parts mechanically, from its structure
(`src/services/page-parts.ts`). No agent divides text or sorts it into
kinds.

| Kind | What it is |
| --- | --- |
| `wording` | The node's own wording, where the node itself is at the page's label and so cannot be read on the other side |
| `summary`, `reasoning` | One paragraph of the version's summary or reasoning: the blocks between blank lines, each exactly as written |
| `gap` | A request the page records, or a paragraph of what a question's assessment says remains open |
| `argument` | An argument with its written form, its stance and this label's evaluation of it. Its kind says which way it bears (`argument:against`) |
| `reading` | A source's reading: the passage, its context and how it was read |
| `supplier` | Who supplied one source, by name, and the words of any interest recorded for it |
| `stated_view` | A stated view recorded on the node |
| `subclaim` | A subclaim with how it bears |

An argument that is another label's row, evaluated at the page's label,
contributes this label's evaluation and not the argument's text.

**What is always shown** is not a part. It is the page's first leaf, shown
whenever the page is released and never without it: the verdict with its
confidence and any credence or estimate; coverage; that each source read at
the page's label exists, with its kind, its fingerprint, whether the
organization itself or an outside party supplied it, and whether an interest
in the node is recorded for it; the gaps the page records (that each request
exists and where it stands, and whether the assessment says what remains
open); how the page was made (the prompt set, the policy version, the model
that assessed and the model that redacted, the seal of the assessing run's
log with whether its chain checked out when the page was recorded, and
whether a mandate or a person's order paid for the assessment and whether
its funder declared a stake, in fixed words); and the count of removals by
category. Holding it holds the page.

Coverage is said to the reader it is served to. Where a deployment has more
than one label, a judgment's coverage lists `evidence_this_reader_can_read`
and `evidence_this_reader_cannot_read` in place of `public_evidence`, which
would be false of a judgment made on sources only some readers read
(`src/services/coverage-service.ts`). On a released page the reader is the
destination: a page made on sources at its own label says the second. A
judgment at the destination label that took a released page in says both, on
that node's ordinary page as well. Where `public` is the only label coverage
reads as it always did.

A reader needs to know that an interested outside party supplied a source in
order to weigh the page, and does not always need the name. So the
supplier's name and the words of the interest are a part, resting on that
source's party: a name that cannot be released is held where the reader sees it
is held, and the page is still released.

## The policy

The policy says what a Redactor removes. It is a document for one boundary,
and a boundary is a pair: the label the page was written at and where it is
released. Labels are rows and are not ranked, so a deployment has as many
boundaries as it releases pages across.

Every boundary starts from one text (`DEFAULT_CATEGORIES` in
`src/services/redaction-policy.ts`), whose categories are worded for any
organization: personal data; security detail; privileged or third-party
confidential material; unreleased product detail; commercial figures;
internal identifiers; weaknesses in others' systems; detail that would help
cause serious harm; test content. A deployment's administrators save later
versions with the categories they want (`PUT /redaction-policies`). Two
sections of every version are written by the code and are the same at every
boundary: how removal works, and what is shown whenever a page is released.
When the code's wording of those two sections changes, the next use of a
boundary saves a new version with the same categories, as any edit does
(`ensureBoundaryPolicy`). A page already released keeps the version, and the
hash, it was released under. The always-shown list names facts, never words: a
supplier's name, the words of a recorded interest and the words of a gap are
parts, and the policy says so after the list.

A version is refused when it is saved, with the reason, if a category is
worded by how a passage reflects on someone ("anything unfavorable to the
organization"), or names something that is always shown ("verdicts"). The
check is a list of phrases and catches the plain cases. A category worded
to get round it is not caught by it. What stands against that is that the
policy is read by everyone a page is released to, that the Redactor is told a
passage's favor is no ground for removal, and that Audit reads what was
removed. That nothing is removed from what is always shown does not rest on
the check at all: no tool can remove anything from it.

Each version is two rows with the same text, one at the page's label and
one on the destination side, because the two sides may share no label. The
Redactor, Audit and the assessing Steward read the first; everyone a page
is released to reads the second. Every removal records the version it was made
under.

`GET /redaction-policies` (`list_redaction_policies` on MCP) lists the
version in force at each boundary the caller reads either side of, once a
boundary, from the page's side where the caller reads the label the pages
are written at; with `boundary_id` it keeps to one boundary, and with
`all=true` it lists every version, newest first, `in_force` on the newest.
Each version, there and on `GET /redaction-policies/:policy_id`, says who
saved it, by display name (`saved_by`), or null where the system saved it:
the starting text, or the same categories saved again because the two
shared sections were reworded. The boundary's Policy tab lists every
version this way.

## Redaction

Where the gate is open for a page, no Redactor runs: the page is
fingerprinted as written and goes. Otherwise a ledger row is opened for the
page's redaction (kind `redact`), at the page's label, and is paid for at
once from the budget of the work that produced the page, with no person's
act ([the-gate.md](the-gate.md), "Who pays"). A standing flow opens one
for each new version. A version replaced before its redaction ran is not
redacted, and stays in the flow's history as that.

A page is recorded from a finished version. While a Steward's pass on the
node at the page's label is running, a standing release does not record the
page, and takes it in at the next look after the pass has ended; a page
asked to be released once is refused until then, with that reason.

The Redactor (`src/llm/prompts/redactor.ts`) works at the page's label. Its
tools:

- `get_redaction_policy`: the policy for the boundary.
- `get_page_to_redact`: the page part by part as written, what is always
  shown, and the sources the page rests on with their labels; with a
  source, that source's stored text. The sources are the set the gate works
  out whose consent is needed from ("The gate", below), recorded when the
  page is opened (`release_pages.source_ids`): what the version rests on
  and what each part rests on, so a reading or an analysis kept in work on
  the node, and a source cited through an argument or a subclaim, can be
  opened whether or not an instance on the node was recorded from them. The
  sources listed as always shown are among them.
- `look_at_destination`: what the readers on the other side already read:
  the labels the destination reads, the file sets and connections held
  there by name (with a set's paths), and, given words or a figure, the
  sources whose title, stored text or quoted passages contain them and the
  nodes whose wording or definition does. Outside the deployment it also
  gives the name everything is published under, the organization's own
  party, which the public graph's readers see on every package, and says
  whether the words looked for are in it. Names and ids only, no text
  (`whatTheDestinationHolds`). The policy protects what those readers do
  not already have, and the task message says so in one sentence; whether
  something found there makes a passage safe to leave is the Redactor's
  judgment. Audit has the same tool, by the page's id.
- `redact`: remove one passage, given exactly as it appears, under one of
  the policy's categories, with a note. The passage is replaced by
  `[redacted: <category>]`. Nothing else in the part changes.
- `restore`: take a removal back.
- `hold_part`: hold one part, or the whole page when no part is given, with
  a reason from the fixed list and a note. It is for what a removal cannot
  protect, such as something that is always shown. The destination sees
  that it is held by the Redactor, with the reason's fixed words.
- `delay_part`: keep a part or the page back until a time. `lift_hold`
  takes back a hold or a delay of its own.
- `finish_redaction`: end the pass, naming the decisions it was least sure
  of in either direction. What it did not hold or delay goes on under the
  gate's setting. It also names there a part whose wording looks
  arranged to carry something other than its sense ("What this does not
  protect against", below).

No tool writes a word onto the page. The Redactor's notes, its account of
what it was least sure of, and its note on a hold stay at the page's
label. `get_page_to_redact` tells it how the gate is set for the page:
whether what it lets through goes once Audit has checked its work, or
waits for a person.

The Redactor runs on the model `REDACTOR_MODEL` names, and on the Steward's
model (`STEWARD_MODEL`) where that is unset: it reads a page a Steward wrote
and has to see what a passage gives away as well as the writer could have.
Audit has its own setting (`AUDIT_MODEL`), so the check and the work need
not share a model. Like every model setting, it is checked when the
configuration loads (an endpoint it names must be declared), and a run is
served only by a provider cleared for the label it works at.

The Redactor is told its budget and a turn guard, as every agent is. It
works under no other limit: how many passages it removes, and how many
times a page comes back from Audit, are bounded by what the work is paid.

## The fingerprint

When the Redactor finishes, each part as it left it is hashed with a salt of
its own, and the hashes form a tree whose root is recorded on the
destination side at once, with each part's place, kind and hash, before
any party consents to anything (`src/services/page-fingerprint.ts`, which
gives the construction in full). The root is made under a named
construction, which the page's record keeps beside it
(`fingerprint_format`): `minerval-released-page/2` for a page recorded
now, `minerval-shown-page/1` for one recorded before the name changed. The
two differ in that name alone, and every check rebuilds a root under the
name its record gives.

A released part is then shown with its salt, and a held part with its hash
and its kind. A reader rebuilds the root from what they were given and
compares it with the root recorded earlier. A match says that every part
they read is what was written, with the marked removals inside it; that the
parts are in the order recorded; that none was added or dropped; and that a
held part is of the kind it is said to be. `get_release_page` (`GET /releases/:id/pages/:page_id`)
returns the result of that check with everything needed to redo it.

Released text is exactly what was written. Nothing normalizes it: spacing,
markup and line ends are part of what is hashed.

`verifyReleasedPage` is a pure function. The standalone verifier of a page
released outside rebuilds the same tree from a signed package
([published-pages.md](published-pages.md), "The check").

## The check

Audit checks each round of redaction before the page goes on (audit type
`redaction_fidelity`, a ledger row paid for as the redaction was). It reads the page as
written and as redacted, each removal with its category and note, and the
policy, and answers three questions: did anything the policy protects pass;
was anything removed or held that the policy does not name; does what
remains still support the verdict, as far as the policy allows.

It passes the work or returns it to the Redactor with reasons. Returned
work is redone on the ledger, and the destination sees that a round was
returned and the earlier root. Its reasons stay at the page's label. Its
answer to the third question is recorded as one of three fixed sentences,
so that the answer cannot itself give anything away:

- The reasoning shown supports the verdict.
- The reasoning shown supports the verdict in part.
- The reasoning shown does not show why the verdict was reached.

Audit checks the page as the Redactor left it. A person at the gate may
then remove more, or lift a hold the Redactor placed, and nothing checks
that again. Where one did, the answer is shown with fixed words after it,
for example "The check was made before a person at the gate removed 2
passages and lifted the Redactor's hold on the whole item, which it did not
check." (`auditAnswerWords`). The acts themselves are on the destination
side's record with who made them. Re-checking after each person's act was
the alternative; it would add a paid Audit run and a wait to every act at a
gate set to a person's decision, which is the setting where a person has
already read the page.

## The gate

After the check the page is at the gate, and the gate's setting decides
what happens to each part for each party it rests on
([the-gate.md](the-gate.md), "Settings"): under the Redactor's decision,
what the Redactor let through goes; under a person's decision as well, it
waits for the people who consent for that party.

A part rests on the parties whose material it draws on, worked out from the
record when the page is opened (`partiesFor`):

- a reading, and the part that names a source's supplier and interest, rest
  on that source's party;
- an argument rests on the sources of the passages recorded for it and on
  everything the nodes it cites as premises rest on;
- a subclaim rests on everything that node rests on;
- a paragraph of the summary or reasoning, a gap, the wording and the page
  itself rest on everything the version rests on. What a version rested on
  is recorded for the version and not for each paragraph, so a paragraph
  cannot be narrowed further;
- what a node rests on is the sources recorded against its judgment, and
  the same for every premise recorded against it, to the end. A judgment
  whose inputs were not recorded is taken to rest on what is attached to
  its node now;
- and the sources kept in work on the node: a reading made through a
  connection, or an analysis run over a set of files, that a run working on
  the node kept as a source ([connections.md](connections.md),
  [file-sets.md](file-sets.md)). An agent keeps one when a judgment rests
  on it, so it counts whether or not an instance was recorded from it. A
  reading rests on the party whose system it was read from. An analysis
  rests on the party of every set its command had mounted, since the
  deployment cannot tell which of their files a command opened.

A source the destination already reads takes no consent. A source with no
party on record is the organization's. A part that rests on no party's
material is the organization's. A part that rests on two parties' material
needs both.

`consent` is granted for one party, by the deployment's administrators, to
whoever they choose. The design does not decide who that is, and one person
may hold `direct` and `consent`.

- **No act changes a word.** A part is consented to, has a passage removed
  and marked, is held or is delayed: by the Redactor or by a person, with
  the same acts. A person's removal records the part's hash and the page's
  fingerprint again, and can be made until the page itself is released.
- **A hold** carries who, when and a reason from a fixed list; it shows on
  the other side in place of the part ("An argument against, held by
  <party>", or "held by the Redactor"); it can be lifted; and it stays on
  the record. A consent is not taken back. A person who directs the graph
  may hold a page that has not been released.
- **A part not every party has consented to shows as held**, with how long it has
  waited, and is counted in the gate's backlog.
- **The queue** (`GET /gate/queue`) lists what waits on a person: the
  items whose gate is set to a person's decision, and those the Redactor
  or a person holds or has delayed. It shows each item as it would be
  released: the part after the Redactor's removals, with the
  marks, and with it what is always shown of the page and the node's
  wording as they would be released. The parts the Redactor was least sure of
  come first, and each item has its removals by category and Audit's
  answer. Each item says where it crosses: the gate, where it goes (a
  label, or outside), and the label it was written at, named as the
  gate's settings name it (by its name to a reader of it or an
  administrator, else by the face it shows where things arrive, else not
  at all). It carries the policy it was redacted under, with the names of
  its categories: a person removes a passage under one of those, and
  `POST /gate/decisions` refuses any other with the policy's list.
  Everyone who consents for a party is shown that, whether or
  not they read at the page's label: it is the text their consent would
  release, to readers who read less than they are trusted to decide for,
  and a gate held by someone who cannot see what passes through it is not a
  gate. A holder who also reads at the page's label is given the part as
  written, each removed passage with the Redactor's note, and why a part
  was flagged. One who does not is given none of those, since they were
  written at the page's label, with one exception: a passage removed from a
  part that rests only on the material of outside parties they consent for
  is those parties' own, and is shown to them with its category and without
  the note. The organization's own party is not counted there. A part that
  rests on no outside party's material is the organization's by default, so
  for someone who consents for the organization the exception would open
  every removed passage of every such page, at a label they do not read.
  They see that a part was flagged and not why. The queue says what they
  are and are not shown on each such item and once for the whole answer.
- **Settings took the place of standing rules.** The people who consent
  for a party set the gate for that party's material to the Redactor's
  decision or to a person's, for the whole boundary or a narrower scope.
  Each consent the gate gives under a setting is recorded as given under
  it. A deployment that had the two earlier consent rules has them as settings:
  "consent to what rests on our material alone" became the Redactor's
  decision for that party, and "consent only where nothing was removed"
  became a person's decision, which consents to nothing the party had not
  allowed. A gate that existed before settings did keeps a person's
  decision until its administrators change it.

The page is released when every party its verdict rests on has consented to
it, by the gate's setting or by a person, and neither the Redactor nor a
person who directs the graph holds it. From then each part is released, and
shows as its text, once every party it rests on has consented to it.

## What the destination sees

For every node under a release, one of four states, and no private content
in any of them:

- **not yet assessed**;
- **released whole**: every part released (removals under the policy
  are counted beside it);
- **released in part**: how many parts of how many are held, and of which
  kinds;
- **held**: with why, in fixed words (waiting for its redaction, waiting
  for the check, waiting for funds, waiting on named parties, held by the
  Redactor, delayed until a time, or held by a person who directs the
  graph), and for how long.

Every version made while a standing release stands is in the release's
history, the held ones included. The record gives the date the node came
under the release and the date it was first assessed at the page's label,
so a reader can see which came first.

A destination-side row does not name the page's label. The name of a label
is not shown to people who may not read it.

## Arrival inside the deployment

At a destination label the released page becomes a source like any other
there, of the kind `released_page`: its text is the page as released, with the
verdict, the policy version, the removals by category, what is held and by
whom, and Audit's answer. Where the destination reads the node, the source
is attached to it and a reassessment of the node is opened at the
destination label, which runs when it is funded. It is evidence for that
label's Steward to weigh. It does not replace that label's judgment and is
not a version of it.

A page that has more of it released later arrives again as a new source,
since a source's text does not change; the earlier one is detached from the
node and kept.

Where the destination does not read the node at all (the node itself is at
the page's label), the source arrives attached to nothing and no
reassessment is opened: there is no node at that label to reassess. Giving
it one is ordinary intake, which this does not do.

A version at the destination label that changes only because its Steward
took in such a page does not make the version at the page's label read as
made against an earlier one, and no reassessment is opened for it
(`minerval_only_released_pages_between`): everything in the page was already
in front of the version it was released from.

The gate is the one way text reaches a label that does not read the label
it was written at.

## What this does not protect against

- **A page is released word for word, and words can carry more than they
  say.** A run that had been turned, for instance by text it read on the
  web, could encode what it knows in the wording of a page that is later
  released. Nothing here closes that. Rewording pages on the way out would
  close it and would end the check against the fingerprint, so it is not
  done. Keeping the text of sealed sources from the page's writer would
  limit it, and is not done either: a Steward reads the evidence it judges,
  on every node, because a page is worth releasing only when its writer
  examined the evidence. What there is: the Redactor's prompt says that
  the wording itself goes out and that it is the reader placed to notice
  wording that looks arranged to carry something other than its sense.
  Where a part looks that way, it names the part in `finish_redaction`'s
  `least_sure` with what it saw, which Audit is given and which the people
  at the gate who read the page's label see first on that part. The
  Redactor may not see it. Under the Redactor's decision a part it only
  named there goes on once Audit passes the work; a gate set to a person's
  decision is where a person looks at it first.
- **The check against the fingerprint shows that what was released is what
  was written. It does not show that the logged run was the only run**, or
  that the nodes released were chosen without sight of their verdicts. The
  dates in the record are what bear on the second.
- **The phrase check on a saved policy** catches plain cases only, as
  above.
- **Whose consent a part takes is worked out from what is recorded.** A run
  that read a document without recording it as a source of the node leaves
  no trace for this to find. The same goes for a call through a connection,
  or a command over a set of files, that the run made and did not keep: its
  party is not asked. Those calls are on record with their run and their
  party, so asking every party whose material a node's runs read, kept or
  not, could be built; it would ask parties about pages that rest on
  nothing of theirs. A file kept from a set and cited nowhere on the node
  is not found either: the row that keeps it names no run and no node.

## Routes and tools

Every route is an MCP tool (`src/routes/releases.ts`,
`src/mcp/route-tools.ts`): `list_releases`, `get_release` and
`get_release_page` read; `set_page_flow`, `end_page_flow`,
`hold_gate_item` and `decide_at_gate` act; `fund_release_work` pays for an
item's redaction or its check. Each act at a gate takes its permission
(`consent` for a party, `direct`, `administer`) and is recorded with the
account that made it. The account may act from a signed-in session or
through a key or token of its own, so the person a gate's authorities put
there can use their own agent or a script. The Assistant holds each act for
its user, under the kind "Act at a gate".

## Not built here

- What the web pages for this ([accounts.md](accounts.md), "The web app")
  could not be given: what the next piece of work on a page is expected to
  cost, so the person paying for a redaction names a budget with no figure
  beside the field. A reader of the page's label is told which kinds of
  part wait on which party (`waiting_on` on `list_releases`: kind and
  party, never text), a queue item names its node and carries the reason
  and date of a hold already placed, and the lists of hold and end reasons
  are served with `list_releases` and `get_gate_queue`.
- A node at the destination label for a page whose node the destination
  cannot read.
- Additions a deployment makes to a role's prompt. The record names none
  because none can be made yet.

## Old names in the code

What this document calls a release was called a *showing*, a party's
consent was called *release*, and what arrives on the other side was called
*shown*. The code, the API, the tables and the stored values say release,
consent and received now:

| Was | Is |
| --- | --- |
| `showings`, `showing_pages`, `showing_parts`, `showing_removals`, `showing_acts` | `releases`, `release_pages`, `release_parts`, `release_removals`, `release_acts` |
| `shown_showings`, `shown_nodes`, `shown_pages`, `shown_parts` (the destination side) | `received_releases`, `received_nodes`, `received_pages`, `received_parts`: what that side holds, a held part as well as a released one |
| `showing_id` (on every table that names a release) | `release_id` |
| a received page's `shown_at`, when it went through to that side | `released_at` (a received part's `released_at` already said the same of a part) |
| `gates.backlog_shown` | `backlog_visible` |
| `release_rules` | `consent_rules`, the rules that gate settings replaced |
| the permission `release`, and "release for <party>" in what a person held | `consent`, "consent for <party>" |
| the gate act `release` (`POST /gate/decisions`) and the recorded act `released` | `consent`, `consented` |
| `outbound_proposals.state` `waiting_for_release`, and its `releases` | `waiting_for_consent`, `consents` |
| the source kind `shown_page`, at `minerval:shown-page/<id>/<n>` | `released_page`, at `minerval:released-page/<id>/<n>` |
| a node's leaving `showing_ended`; a source attached or detached by `showing`; a Steward's trigger `page_shown`, sent as `shown:<source>` | `release_ended`; `release`; `page_released`, `released:<source>` |
| `minerval_only_shown_pages_between` | `minerval_only_released_pages_between` |
| `/showings`, `/showings/:showing_id`, ... and their OpenAPI tag `showings` | `/releases`, `/releases/:release_id`, ..., tag `releases` |
| in the API: `shown` (the releases received, the items let through), `shown_to`, `always_shown`, `shown_as_released`, `shown_state`, `a_page_shown`, ... | `received`, `released`, `released_to`, `always_released`, `seen_as_released`, `released_state`, `a_page_released`, ... |
| the fingerprint's construction `minerval-shown-page/1` | `minerval-released-page/2`, named by each page's `fingerprint_format` |
| `minerval-published-page/1`, with `showing`, `node.showing_began`, `always_shown`, `shown_at` | `minerval-published-page/2`, with `release`, `node.release_began`, `always_released`, `released_at`, and `page.fingerprint_format` |
| `src/services/showing-service.ts`, `src/routes/showings.ts` | `src/services/release-service.ts`, `src/routes/releases.ts` |

The old routes are not kept beside the new ones. Their callers are the web
app and the MCP tools, which change with them and run from the same
deployment; the tools had their new names already (`list_releases`,
`get_release`, `get_release_page`, `fund_release_work`; they were
`list_showings`, `get_showing`, `get_shown_page`, `fund_showing_work`). The
web app's old addresses, `/showings` and the pages under it, redirect to
`/releases`.

What keeps an old name is what a hash or a signature fixes, and the code
that reads it:

- **A page fingerprinted before the change** keeps its root under
  `minerval-shown-page/1`, and so does the `format` in what is always
  released with it, which is hashed as the tree's first leaf. Its record
  names that construction (`fingerprint_format`), and the three checks
  (`src/services/page-fingerprint.ts`, `src/published-page/verify.ts`,
  `web/lib/released-page-check.ts`) rebuild its root under it, and a new
  page's under the new one.
- **A package signed in `/1`** stays in `/1`: the check reads both formats,
  hashes a package under the format it names, takes every page in a `/1`
  package as fingerprinted under the old construction, and
  `currentPackage` reads it in the current names. Its acts, reasons,
  held-becauses and holdings keep their old words; the claim page says them
  in the new ones (`web/lib/stored-words.ts`), and an agent reads them as
  the package gives them.
- **A source already made** keeps its text, which is fixed and hashed, and
  its address under `minerval:shown-page/`, which the code still finds.
- **A saved version of a redaction policy** keeps its text, which removals
  name by hash.
- **An action the Assistant held before the rename** is stored as it was
  made: `fund_showing_work` runs as `fund_release_work`, a `showing_id` as
  `release_id`, and the decision `release` as `consent`
  (`src/llm/tools/assistant-tools.ts`).
- **What another graph sends or keeps.** A judgment mirrored from the
  public graph keeps the trigger it carries there until the public graph
  updates it, and the reason a request is declined, `cannot_be_shown`, is
  the public graph's fixed list, which deployments of every version send.

Unchanged, because they name outcomes and not the decision: a part
*released* or *held*, *released whole*, *released in part*, `released_at`,
`released_under` and `send_as_released`. "Release" for money, leases and
locks (`releaseHolds`, `releaseInboxLease`, ...) is that and nothing else,
and `press_release` is a kind of source. `release-gate-service.ts` is the
gate where a release's parts are consented to.

### For operators: the migrations

Migration `0175_release_ids` renames the tables, columns, indexes and
constraints of a release, and rewrites the stored values the code reads:
permission grants, recorded consents, proposals waiting for consent,
released pages' source kind and the nodes they attach to, and a node's
leaving. Migration `0176_received_ids` renames the destination side's
tables to `received_*`, a received page's `shown_at` to `released_at` and
`backlog_shown` to `backlog_visible`; records each page's fingerprint
construction, the old one for every page recorded until then; renames
`minerval_only_shown_pages_between`; and rewrites the words kept as plain
text: "release for <party>" in what a person held, the gate's words stamped
in `released_under`, and a Steward's trigger and its sender. Renaming keeps
every row, grant, trigger and row-level security policy, which belong to
the table and not to its name, so the label enforcement step has nothing to
redo (`npm run db:migrate` runs it all the same).

Deploy the API and the web app together: the routes and the API's fields
are renamed with no alias, so a web app of the earlier version, or a script
calling `/showings` or sending the decision `release`, is refused until it
is updated. After the migrations, the next build of packages for outside
makes one new package, in `/2`, for every node under every release outside,
since the format is part of what a package says. Where the gate to outside
sends what it lets through, they are sent as they are built; otherwise they
wait in the Outbox for a person to send them. The two sections of a
redaction policy the code writes say release and consent now, so each
boundary's policy is saved again, with the same categories, the next time
the boundary is used, as any change to those sections is
(`ensureBoundaryPolicy`); what was redacted under an earlier version keeps
that version.
