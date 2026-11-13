# Showing a page to readers who do not read its label

Often the best evidence for something is more sensitive than the thing
itself. A deployment that holds material at more than one label
([architecture.md](architecture.md), "Labels and clearance") can show what
an agent concluded from evidence without showing the evidence. A node's
page written at one label is shown to readers who may not read that label,
at another label inside the deployment or outside it, with what was removed
marked in its place, and in a form those readers can check.

A node's page is one kind of thing that passes a gate, and the gate is the
same at every boundary ([the-gate.md](the-gate.md): its acts, its settings,
what flows, who pays, the backlog). Showing what was concluded at one label
to the readers of another, and showing it outside the deployment, are the
same steps with a different destination. This document describes a page's
own part of those steps as built: what a page is, its parts, the policy,
the fingerprint, and what its readers see. A showing outside goes through every step below, and what it
releases is then carried out of the deployment in a signed package and read
on the public graph: [published-pages.md](published-pages.md).

The public graph has one label, which everyone reads. Nothing below exists
there: the routes are not mounted, the tables are empty, and no run is told
any of it.

In the code this is called showing a page below its label. Labels are not
ranked, and nothing a person or an agent reads says "below": a page is
shown to readers who do not read its label.

## What is shown

The ordinary page of a claim, a quantity or a question at one label: the
version of its judgment at that label (the status, estimate or answer, with
its confidence and any credence, the summary and the reasoning), its
arguments with their written forms, stances and evaluations, the readings of
its sources, its subclaims with how each bears, the requests it records, and
a stated view where one is recorded. No run produces it and no table holds
a special form of it. It is read from the rows the Steward's ordinary work
wrote (`readPage` in `src/services/showing-service.ts`).

A showing covers the rows at the page's label and no others. A row that the
page's label merely reads belongs to that other label's page: where the
destination reads it too it has it already, and where it does not, showing
it is a showing across that other boundary, under that boundary's policy.

## Asking

A person who holds the permission to direct the graph sets a flow of pages
at a label they read toward a named label, or outside (`POST /showings`):
for one node, a node with what sits under it, every node one mandate's
work assessed, or every node assessed at the label
([the-gate.md](the-gate.md), "What flows"). The destination must not already read the page's label.
The two labels need not be related in any other way: a page at one label
can be shown at another that neither reads nor is read by it.

- **Once or standing.** Shown once, the page goes as it stands, dated, and
  nothing is undertaken about later versions. Shown standing, each later
  version follows: a page is opened for it and goes through the same steps.
- **The node alone, or the node with what sits under it.** Under the wider
  scope a node that later comes to sit under the shown node is covered from
  then, as not yet assessed. A node that leaves stays in the showing's
  record with the date and the reason, which is one of a fixed list read
  from the record (the link was removed, the node is no longer active, the
  showing ended). A node that also sits under other things appears once, in
  its place under the shown node.

No page is offered to a gate that no flow covers. Ending a standing flow is
a dated event with a reason from a fixed list; what was shown stays shown.

Every act on a showing is a row that names who did it and the permissions
they held then (`showing_acts`), so a reader on the other side can see when
a person who directed the work also released it.

A part that rests on no outside party's material is the organization's to
release, so the organization itself must be a party
(`parties.is_own_organization`). It is from setup, and the person who set
the deployment up holds `release` for it ([accounts.md](accounts.md)). A
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
whenever the page is shown and never without it: the verdict with its
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
(`src/services/coverage-service.ts`). On a shown page the reader is the
destination: a page made on sources at its own label says the second. A
judgment at the destination label that took a shown page in says both, on
that node's ordinary page as well. Where `public` is the only label coverage
reads as it always did.

A reader needs to know that an interested outside party supplied a source in
order to weigh the page, and does not always need the name. So the
supplier's name and the words of the interest are a part, resting on that
source's party: a name that cannot be shown is held where the reader sees it
is held, and the page is still shown.

## The policy

The policy says what a Redactor removes. It is a document for one boundary,
and a boundary is a pair: the label the page was written at and where it is
shown. Labels are rows and are not ranked, so a deployment has as many
boundaries as it shows pages across.

Every boundary starts from one text (`DEFAULT_CATEGORIES` in
`src/services/redaction-policy.ts`), whose categories are worded for any
organization: personal data; security detail; privileged or third-party
confidential material; unreleased product detail; commercial figures;
internal identifiers; weaknesses in others' systems; detail that would help
cause serious harm; test content. A deployment's administrators save later
versions with the categories they want (`PUT /redaction-policies`). Two
sections of every version are written by the code and are the same at every
boundary: how removal works, and what is shown whenever a page is shown.

A version is refused when it is saved, with the reason, if a category is
worded by how a passage reflects on someone ("anything unfavorable to the
organization"), or names something that is always shown ("verdicts"). The
check is a list of phrases and catches the plain cases. A category worded
to get round it is not caught by it. What stands against that is that the
policy is read by everyone a page is shown to, that the Redactor is told a
passage's favor is no ground for removal, and that Audit reads what was
removed. That nothing is removed from what is always shown does not rest on
the check at all: no tool can remove anything from it.

Each version is two rows with the same text, one at the page's label and
one on the destination side, because the two sides may share no label. The
Redactor, Audit and the assessing Steward read the first; everyone a page
is shown to reads the second. Every removal records the version it was made
under.

## Redaction

Where the gate is open for a page, no Redactor runs: the page is
fingerprinted as written and goes. Otherwise a ledger row is opened for the
page's redaction (kind `redact`), at the page's label, and is paid for at
once from the budget of the work that produced the page, with no person's
act ([the-gate.md](the-gate.md), "Who pays"). A standing flow opens one
for each new version. A version replaced before its redaction ran is not
redacted, and stays in the flow's history as that.

A page is recorded from a finished version. While a Steward's pass on the
node at the page's label is running, a standing showing does not record the
page, and takes it in at the next look after the pass has ended; a page
asked to be shown once is refused until then, with that reason.

The Redactor (`src/llm/prompts/redactor.ts`) works at the page's label. Its
tools:

- `get_redaction_policy`: the policy for the boundary.
- `get_page_to_redact`: the page part by part as written, what is always
  shown, and the sources the page rests on with their labels; with a
  source, that source's stored text. The sources are the set the gate works
  out whose release is needed from ("The gate", below), recorded when the
  page is opened (`showing_pages.source_ids`): what the version rests on
  and what each part rests on, so a reading or an analysis kept in work on
  the node, and a source cited through an argument or a subclaim, can be
  opened whether or not an instance on the node was recorded from them. The
  sources listed as always shown are among them.
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
anyone decides what is released (`src/services/page-fingerprint.ts`, which
gives the construction in full).

A released part is then shown with its salt, and a held part with its hash
and its kind. A reader rebuilds the root from what they were shown and
compares it with the root recorded earlier. A match says that every part
they read is what was written, with the marked removals inside it; that the
parts are in the order recorded; that none was added or dropped; and that a
held part is of the kind it is said to be. `GET /showings/:id/pages/:page_id`
returns the result of that check with everything needed to redo it.

Released text is exactly what was written. Nothing normalizes it: spacing,
markup and line ends are part of what is hashed.

`verifyShownPage` is a pure function. The standalone verifier of a page
shown outside rebuilds the same tree from a signed package
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

## The gate

After the check the page is at the gate, and the gate's setting decides
what happens to each part for each party it rests on
([the-gate.md](the-gate.md), "Settings"): under the Redactor's decision,
what the Redactor let through goes; under a person's decision as well, it
waits for that party's holders of `release`.

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

A source the destination already reads takes no release. A source with no
party on record is the organization's. A part that rests on no party's
material is the organization's. A part that rests on two parties' material
needs both.

`release` is granted for one party, by the deployment's administrators, to
whoever they choose. The design does not decide who that is, and one person
may hold `direct` and `release`.

- **No act changes a word.** A part is let through, has a passage removed
  and marked, is held or is delayed: by the Redactor or by a person, with
  the same acts. A person's removal records the part's hash and the page's
  fingerprint again, and can be made until the page itself is shown.
- **A hold** carries who, when and a reason from a fixed list; it shows on
  the other side in place of the part ("An argument against, held by
  <party>", or "held by the Redactor"); it can be lifted; and it stays on
  the record. A release is not taken back. A person who directs the graph
  may hold a page that has not been shown.
- **A part nobody has released shows as held**, with how long it has
  waited, and is counted in the gate's backlog.
- **The queue** (`GET /gate/queue`) lists what waits on a person: the
  items whose gate is set to a person's decision, and those the Redactor
  or a person holds or has delayed. It shows each item as it would be
  shown if released: the part after the Redactor's removals, with the
  marks, and with it what is always shown of the page and the node's
  wording as they would be shown. The parts the Redactor was least sure of
  come first, and each item has its removals by category and Audit's
  answer. Every holder of `release` for a party is shown that, whether or
  not they read at the page's label: it is the text their decision would
  release, to readers who read less than they are trusted to decide for,
  and a gate held by someone who cannot see what passes through it is not a
  gate. A holder who also reads at the page's label is given the part as
  written, each removed passage with the Redactor's note, and why a part
  was flagged. One who does not is given none of those, since they were
  written at the page's label, with one exception: a passage removed from a
  part that rests only on the material of outside parties they release for
  is those parties' own, and is shown to them with its category and without
  the note. The organization's own party is not counted there. A part that
  rests on no outside party's material is the organization's by default, so
  for a holder of `release` for the organization the exception would open
  every removed passage of every such page, at a label they do not read.
  They see that a part was flagged and not why. The queue says what they
  are and are not shown on each such item and once for the whole answer.
- **Settings took the place of standing rules.** A party's holders of
  `release` set the gate for that party's material to the Redactor's
  decision or to a person's, for the whole boundary or a narrower scope.
  Each release the gate makes under a setting is recorded as made under
  it. A deployment that had the two earlier rules has them as settings:
  "release what rests on our material alone" became the Redactor's
  decision for that party, and "release it only where nothing was removed"
  became a person's decision, which releases nothing the party had not
  allowed. A gate that existed before settings did keeps a person's
  decision until its administrators change it.

The page is shown when every party its verdict rests on has released it,
by the gate's setting or by a person, and neither the Redactor nor a
person who directs the graph holds it. From then each part shows as
its text once every party it rests on has released it.

## What the destination sees

For every node under a showing, one of four states, and no private content
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

Every version made while a standing showing stands is in the showing's
history, the held ones included. The record gives the date the node came
under the showing and the date it was first assessed at the page's label,
so a reader can see which came first.

A destination-side row does not name the page's label. The name of a label
is not shown to people who may not read it.

## Arrival inside the deployment

At a destination label the shown page becomes a source like any other
there, of the kind `shown_page`: its text is the page as shown, with the
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
(`minerval_only_shown_pages_between`): everything in the page was already
in front of the version it was shown from.

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
  on every node, because a page is worth showing only when its writer
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
  that the nodes shown were chosen without sight of their verdicts. The
  dates in the record are what bear on the second.
- **The phrase check on a saved policy** catches plain cases only, as
  above.
- **Whose release a part takes is worked out from what is recorded.** A run
  that read a document without recording it as a source of the node leaves
  no trace for this to find. The same goes for a call through a connection,
  or a command over a set of files, that the run made and did not keep: its
  party is not asked. Those calls are on record with their run and their
  party, so asking every party whose material a node's runs read, kept or
  not, could be built; it would ask parties about pages that rest on
  nothing of theirs. A file kept from a set and cited nowhere on the node
  is not found either: the row that keeps it names no run and no node.

## Routes and tools

Every route is an MCP tool (`src/routes/showings.ts`,
`src/mcp/route-tools.ts`). Each act at a gate takes its permission
(`release` for a party, `direct`, `administer`) and is recorded with the
account that made it. The account may act from a signed-in session or
through a key or token of its own, so the person a gate's authorities put
there can use their own agent or a script. The Assistant holds each act for
its user, under the kind "Act at a gate".

## Not built here

- What the web pages for this ([accounts.md](accounts.md), "The web app")
  could not be given: what the next piece of work on a page is expected to
  cost, so the person paying for a redaction names a budget with no figure
  beside the field. A reader of the page's label is told which kinds of
  part wait on which party (`waiting_on` on `GET /showings`: kind and
  party, never text), a queue item names its node and carries the reason
  and date of a hold already placed, and the lists of hold and end reasons
  are served with `GET /showings` and `GET /gate/queue`.
- A node at the destination label for a page whose node the destination
  cannot read.
- Additions a deployment makes to a role's prompt. The record names none
  because none can be made yet.
