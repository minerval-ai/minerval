# The gate

A deployment that holds material at more than one label
([architecture.md](architecture.md), "Labels and clearance") is built to
three statements. The graph at a label is its own rows plus the graph at
the labels it reads. Information and funding go up freely: everything at a
label can be read by the labels that read it. And information going the
other way, of any kind, passes a gate.

There is one kind of gate, and one gate for each boundary: the pair of the
label a thing was produced at and where it goes, which is a label that does
not read the first, or outside the deployment. The boundary between two
inside labels and the boundary to the public graph are the same gate with a
different destination. This document describes the gate as built.
[releasing-a-page.md](releasing-a-page.md) describes one kind of item, a node's
page, in full: its parts, the policy, the fingerprint. What a page released
outside then does is in [published-pages.md](published-pages.md).

The public graph has one label, which everyone reads. Nothing here exists
there: the routes are not mounted, the tables are empty, and no run is told
any of it.

## What goes down

Every kind of thing is an item at the gate with the same stages and the
same acts (`GATE_KINDS` in `src/services/gate-kinds.ts`).

| Kind | What it is | Offered when | What its arrival does |
| --- | --- | --- | --- |
| `page` | A node's page at the label | A flow covers the node and a version is finished | A source at the destination, attached to the node, and a pass opened there |
| `taken_up` | That a request filed on the other side was taken up here | It is taken up | The request there reads as taken up (`taken_up_above`) |
| `answer` | Where that request stands here, and what work on it found | Work with an outcome is recorded on it, or it is closed | A row in the asking request's work log; a source on each node the request bears on, and a pass opened there, so the Steward that asked reads it on a later pass |
| `statement` | What was spent on that request, or put into a mandate made for it, and what went back | The request is closed, or the mandate closes | A row in the asking request's work log |
| `petition` | What a run here asks of the mandate on the other side that pays for it: how much more, and why | The run petitions | An item in that mandate's inbox, for its officers |
| `message` | The answer a pass here gave to a message sent on the other side | The pass answers it | A reply in the sender's inbox |
| `mandate` | That a mandate exists here, with its name, terms and budget | It was made for a request from the other side (when made, activated and closed); a person who directs offers it; or everything flows | A row in the asking request's work log where a request asked; listed among what came through (`GET /gate/items`) |
| `funding` | A mandate here paying for a pass on a node on the other side | The mandate's side asks for it, or the gate names it to keep the other side current | The pass is commissioned there from the mandate's budget, or opened for that label's funders where the budget cannot pay |

An item is recorded the way a node's page is: a short list of what is
always shown of it, and its parts as written, each resting on the parties
whose material it draws on. An answer's parts are where the request stands
with its keeper's note, one sentence for each piece of work, and each
paragraph of what the work found. Every part is text exactly as an agent
or a person wrote it at the label, or a sentence in fixed words. The
Redactor, Audit's check, the fingerprint and consent then work on any item
as they do on a page.

Work offers an item with one call, `offerToGate` in
`src/services/gate-service.ts`, naming the rows and passing no text. The
work that takes up a request, records its result or answers a message
calls it itself.

## The acts, and who performs them

One set of acts (`GATE_ACTS`): let a part or the item through; remove a
passage and leave its category's mark; hold a part or the whole item, with
a reason from a fixed list; delay it until a time; lift a hold or a delay.
None changes a word.

Two kinds of actor have them, and each has all of them:

- **The Redactor**, a run at the item's label working under the boundary's
  policy (`src/llm/prompts/redactor.ts`). Its tools are `redact`,
  `restore`, `hold_part`, `delay_part`, `lift_hold`, `refer_to_person` and
  `finish_redaction`. What it does not hold, delay or refer it lets
  through.
- **A person** the gate's authorities put there: someone who holds
  `consent` for a party the item rests on. They act through
  `decide_at_gate` (`POST /gate/decisions`), with `consent`,
  `approve` (everything nobody
  holds, as the Redactor left it), `remove`, `hold`, `delay` and `lift`.
  They may act from the web app, or through a key or token of their own
  account, so their own agent or a script can do it: the queue
  (`GET /gate/queue`) carries what is needed to decide each item (where
  it crosses, and the policy it was redacted under with the categories a
  passage can be removed under), a call
  takes up to 500 items, and sending the same decision again changes
  nothing.

Every act is a row (`release_acts`) naming who made it: the person and the
permissions they held, the Redactor's run, or the gate's setting. A hold
stays on the record after it is lifted. A consent is not taken back.

A person's removal is the Redactor's act: the passage is replaced by the
category's mark, the part's hash and the item's fingerprint are recorded
again, and the fingerprint before it stays on the record. It can be done
until the item itself has been released, because what is always shown counts
the removals. After that a part not yet released can be held.

### Asking a person

The Redactor has one act a person does not: `refer_to_person`, which asks
the people who consent for an item's parties to decide a part, or the
whole item, and says what the Redactor would do (`let_through` or `hold`,
`REFER_RECOMMENDATIONS`) with a note of why. A referral holds whatever the
gate is set to: under the Redactor's decision, the gate's setting lets
nothing referred through, and it waits for a person like any item under a
person's decision. It removes nothing and keeps nothing back of itself; it
is recorded as an act (`referred`, with the recommendation in `reason`)
and the note joins what the Redactor was least sure of, at the page's
label. A person's act on what was referred answers it: approving lets it
through as the Redactor left it, and holding it holds it. The queue puts
what was referred first, with `referred_by_the_redactor` and, to a reader
of the page's label, `why_referred`; the backlog counts it under
`referred`. The other side is not told of it: they see a part waiting, as
any part a person has not decided waits.

The Redactor refers where the boundary's policy says to (its guidelines
for asking a person, `refer_when`, below in "The policy" of
[releasing-a-page.md](releasing-a-page.md)), and wherever else a decision
is a close call that someone who knows the organization should make. It
does its own work first, so that a person who agrees only approves. This
is how a gate can be left to the Redactor and still bring its people the
cases they want to see.

Audit checks each round of the Redactor's work before the item goes on
(`redaction_fidelity`): whether anything the policy protects passed,
whether anything was removed or held that the policy does not name, and,
for a page, whether what remains still supports the verdict. It is the
check on the Redactor, and it needs no person.

## Settings

A gate treats an item in one of three ways (`GATE_MODES`):

- **`open`**: it goes as written. No Redactor runs, nothing is removed, and
  nothing is paid.
- **`redactor`**: the Redactor works, Audit checks its work, and what the
  Redactor let through goes, with nobody waiting on a person.
- **`person`**: the Redactor does the same work as a proposal, and each
  part then waits for the people who hold `consent` for the parties it
  rests on. They approve it as proposed, in one act for a whole item, or
  change it with the same acts.

**Where a gate starts.** A person decides after the Redactor, for every
kind that carries text written at the label (`STARTING_MODE` in
`src/services/gate-kinds.ts`). The Redactor deciding alone is where a gate
is meant to end up: a gate that waits on a person for each item moves at
that person's pace, and the point of a deployment is that what a label
learns reaches the labels below it and the public. But a deployment has no
reason yet to trust a Redactor it has not watched apply its policy, so each
gate starts with the people who consent approving what the Redactor
proposes, and its authorities hand a kind to the Redactor once its
proposals are ones they approve as they stand ("Toward the Redactor's
decision", below). Nothing written at a label leaves it unread by a person
until someone has chosen that it should.

Two kinds start open, because they carry no text from the label. The bare
fact that a request was taken up tells the asker not to pay for the same
work twice. A statement of what was spent is figures in fixed words about
the payer's own money, which the payer's own account already shows as it
moves. At the gate to outside the first is the organization's own public
statement on the public graph, in its name, so there it starts with a
person too (`STARTING_MODE_OUTSIDE`).

A gate that existed before gates started with a person keeps working as it
did: for each kind whose starting position changed, the old one was
written down as a setting for the whole boundary (migration
`0185_gates_start_with_a_person`), shown on its Rules tab as carried over,
which its authorities can end.

**Refunds are not the gate's.** Money that was not spent returns to its
payer by the ordinary settlement, as soon as it is released, and the payer
sees it in its own account. A full refund soon after asking therefore tells
the asker that the work was declined or cost nothing, before any words
come through. Holding a payer's own money at a gate to hide that was
judged worse than the signal: the gate governs the account of what was
done, and the money stays the payer's.

A setting is for one kind of thing or every kind; for the whole boundary,
one mandate's work, a node and everything under it, or one request; and
for one party's material or for every party that has not said
(`PUT /gates/:gate_id/settings`). A party's own setting is taken before
one for the gate as a whole, since consent is a party's to give. Within
either, the narrowest scope that covers the item is taken, and a setting
for the item's kind before one for every kind. A setting applies from when
it is set to everything not yet released, so loosening one lets through
what was waiting on it.

A gate has two sets of authorities. The deployment's administrators set
the gate as a whole. The holders of `consent` for a party set it for that
party's material. Most tightening and loosening is done in neither place
but in the boundary's redaction policy, which says what the Redactor
removes ([releasing-a-page.md](releasing-a-page.md), "The policy").

Three things are set for the gate as a whole (`PUT /gates/:gate_id`): what
flows to it, whether its backlog is shown, and, for the gate to outside,
whether what is released is sent to the public graph as it is released.

## What flows

A flow is set once and then offers things to the gate as they are
produced.

- **What was asked for from the other side flows by default**: that a
  request was taken up, the answer to it, the answer to a message.
- **A node's page flows where a flow was set for it**
  (`set_page_flow`, `POST /releases`, people who direct): one node, a node with what sits
  under it, every node one mandate's work assessed, or every node assessed
  at the label. Standing, each later version follows as it is finished.
- **Everything** is one setting of the gate (`flow: everything`): a
  standing flow of every page at the label, and each mandate there offered
  with its terms. It starts off.

The reason it starts off is cost and the outer boundary. Under the
Redactor's decision each version of a page costs a Redactor's run and
Audit's check of it, charged to the budget of the work that produced the
page, so "everything" roughly adds those two runs to every assessment at
the label, whether or not anyone below wants the page. And the gate to
outside is the same gate with the same starting position: a gate that
started with everything flowing would publish every inside page.

## Who pays

The Redactor's run and Audit's check are paid for with no person's act
(`payForGateWork` in `src/services/release-service.ts`). Sending a result
down is part of the work that produced it, so it is paid from that work's
budget: the mandate the offer named; else the mandate whose budget paid
for the judgment a page carries, or for the work on the request an answer
reports; else the General mandate at the item's label, which pays for that
label's upkeep. The budget placed is the run's estimated cost, and what
the run does not spend goes back.

Where none of them can pay, the item waits. The other side is told in
fixed words that it is waiting for funds, the backlog counts it so, and
each look of the scheduler tries again, every `STANDING_ORDER_RETRY_MINUTES`
and not only at the six-hourly sweep, since what it waits on (a budget
topped up, a pace's window opening) comes at any time. The rest of the
gates' upkeep runs on the same look (`followTheGates` in
`src/workers/allocation-scheduler.ts`): following standing releases, letting
through what a delay was keeping, and the outside's packages. A page let
through to outside under a gate set to send what is released is packaged
and sent at once (`followReleaseOutside`), and what the public graph says
back is taken in when the mirror batch that carries it is applied
(`afterMirrorApplied`); the scheduler is the backstop for both. A person who holds `fund` can also
pay by hand (`fund_release_work`, `POST /releases/:release_id/pages/:page_id/commission`).

## Toward the Redactor's decision

The record already says whether a gate's people can trust its Redactor:
each item a person decided was either let through as the Redactor
proposed, or changed. `gateAgreement` (`src/services/gate-trust-service.ts`)
counts the two by kind over the last 90 days. An item counts as changed
where a person removed a passage, held, delayed or lifted anything, or
let through what the Redactor referred with a recommendation to hold. A
kind with at least 20 items decided and at least 90% let through as
proposed is marked `suggests_the_redactor`. The figures choose when a
suggestion is shown; they decide nothing.

They are given with each gate on `GET /gates` (`agreement`), at the head
of a boundary's Rules tab beside a button that hands a kind to the
Redactor (a setting for the whole boundary, which can be ended), in the
setup checklist's `gates` area, and on the Health page, which also raises
a gate where 10 or more items wait on a person or the oldest has waited 48
hours (needing someone now past a week), pointing at the policy. Those
thresholds are for people's attention and limit nothing.

### Trying the Redactor

`POST /gates/:gate_id/trials` (`try_the_redactor` on MCP, the boundary's
Try the Redactor tab in the web app) runs the Redactor on a sample under
the boundary's policy, or a draft of its next version (`categories`,
`refer_when`), and answers with what it did: each part as it would be
released, each removal with its category and note, each hold, delay and
referral with what the Redactor would do, and what it was least sure of.
The run is the Redactor's own prompt and tools, at the label the
boundary's pages are written at, so it reads that label's policy and
destination as a real run does; its tools act on a page held in memory
(`src/services/redactor-trial-service.ts`). Nothing is released, recorded
at the gate or saved as a policy, and a draft is checked as a save would
check it. It is open to an administrator or a holder of `consent` who
reads the label the pages are written at, on the run log at that label,
and paid from the person's balance within the budget they name, which the
Redactor is shown; what it does not spend is returned. A sample is at most
20,000 characters, a halting bound for a request a person waits on. The
tab can save the draft it tried as the next version.

## The backlog

`GET /gate/backlog` says, for each gate toward a label the caller reads,
how many items have not gone through, of what kinds, for how long, and what
each waits on: the budget, the Redactor's run, Audit's check, the
Redactor's hold, a person's hold or decision (by party), a referral by the
Redactor to a person, a delay. Each gate also says how many items wait on
a person (`items_waiting_on_a_person`) and how many of those the Redactor
referred (`items_referred`). It is
counts and fixed words. No item, node, request or mandate is named, and
nothing of any item's text is in it. The label things come from is named to
those who read it and to administrators. To anyone else it is the face
that label shows on their side (`label_faces`, how a label above is
addressed from below), or nothing where it shows none.

With it comes what the reader's labels asked of labels above and what has
come back (`asked_from_here`): for each face asked, how many requests,
with how many owls behind them, and for how many the gate has let through
that they were taken up, an answer, or nothing yet.

It is shown to the readers of the destination label unless the gate's
administrators turn that off. A long wait on the Redactor's hold or on a
person says that the policy or the setting needs changing, and the people
waiting are the ones placed to notice. Boundaries (`/gates`) in the web
app shows it, and a boundary's page (`/gates/:id`) shows its authorities
the rules and settings beside it.

## Outside

The boundary to outside is the same gate: the same kinds, settings, acts
and payment. Its destination side has a label of its own, `published`
([architecture.md](architecture.md), "The three layers at the bottom"): what
the gate lets through, its settings and policy, and the record of what was
sent and what came back are kept there, where anyone may read them and only
the gate and the outbound work write. A thing is at `published` once it has
passed the gate, whether or not it has been sent: passing the gate is the
decision that the world may read it, and sending only carries it there. A
release to every member is a different destination, the label `members`,
and a release that names `public` or `published` as its destination is
refused (`NOT_A_DESTINATION`): nothing here writes at the public graph's
label, and what is published gets there by going `outside`.

Two things truly differ from a gate between two labels. The public graph is another
deployment, so arrival there is a signed package or a call to one of its
ordinary routes under the organization's own account, never a row this
deployment writes (`src/services/gate-outside.ts`). And owls do not
convert: public owls pay for nothing inside, and inside owls for nothing
on the public graph. Whether what the gate lets through is sent as soon as
it is through, or waits for a person to send it, is the gate's
`send_as_released`, which starts on.

What goes outside, by kind:

| Kind | What leaves | How it arrives |
|---|---|---|
| `page` | the node's page as released | a signed package ([published-pages.md](published-pages.md)) |
| `mandate` | a mandate's name and terms as released, with how this gate is set for its work (below) | a signed package on the publisher's record (`POST /published-mandates`) |
| `taken_up` | nothing but the request's public id | the account's statement on the request's record that it takes it up |
| `answer` | a reason from the public graph's fixed list | the account's statement that it will not do the work. What work found goes as the page of each node the request bears on |
| `funding` | the node's public id | a public mandate the organization funds is asked for a fresh public assessment (keeping public versions current, below) |
| `report` | an agent's report about Minerval's machinery: facts in fixed words always shown, its words as parts | filed on the public graph's report route, marked private |
| `proposal` | the words a node held only inside is proposed in | sent as any account proposes a node, once through |

A message, a petition and a statement answer something asked from a label
inside, and do not go outside. Every send is a row in the log of acts on
the public graph (`outward_acts`), saying what was sent and whether a
person or the gate's setting sent it.

### A published mandate: the organization's face

A mandate offered to the gate to outside (`POST /gate/offers` with
`outside`) is the organization's face on the public graph. Once through,
it stands on the publisher's record there, and a request on the public
graph can be addressed to it (its `face_id`, which is the offer's id
here). The organization's commitment is what it publishes: the mandate's
terms say what it takes up, and the gate's settings for the mandate's work
say what it releases. Those settings travel with the mandate, stamped by
this deployment from the gates' own rows (`src/services/gate-face.ts`):
for the statement that a request was taken up, the statement that it will
not be worked, and the page of a node a request bears on, whether the
gate is open, leaves it to the Redactor, or has a person decide as well,
how wide the setting is and the day it was set. Nobody writes them as
prose. Changing a setting of the gate to outside offers every published
mandate again, and the public graph keeps each package with its date, so
a change is shown as a change. Ending the offer withdraws the mandate
there.

A request addressed to a published mandate arrives with the mirror
(`feed_requests.asked_of_face_id`) and is put in the mandate's inbox at
its label (`deliverAddressedRequests`). Its Grantmaker decides under the
mandate's terms, as it decides anything put in front of it: `fund_request`
takes it up and pays for the work; `decline_asked_request` declines it
with a reason from the fixed list. No person acts for each one. The item
goes to the Grantmaker directly, as an officer's escalation does, and not
to officer sittings, which are off unless a deployment turns them on: a
live Grantmaker session is woken, and a mandate with none is given a
review pass. That it
was taken up, or will not be worked, goes to the gate to outside like any
`taken_up` or `answer`; the page of each node it bears on flows to the
gate from the label that took it up, and from any label above that took
that request up in turn, as each version is finished. The request's
public record then shows what followed: taken up, declined with its
reason, a page published, or a page held with since when.

**Money.** Work on a request the mandate takes up is paid for inside, from
the mandate's own budget. A member of the public who wants to push a
question funds the public side: the public graph's own assessment of the
node, which weighs the published page when it arrives. Every published
mandate says this in the same words.

### Keeping public versions current

A gate can name a mandate that is asked to pay for a fresh assessment on
the other side each time a version here changes on a node the other side
holds (`PUT /gates/:gate_id`, `keep_current_mandate`;
`src/services/keep-current.ts`). Between two labels it is a mandate at the
label things come from, which pays `keep_current_owls` for a pass below.
At the gate to outside it is a public mandate the organization funds,
which pays on the public graph. Each asking is an item of the kind
`funding`, under the gate's setting for that kind: open, the Redactor, or
a person; for the whole boundary, one mandate's work, or a node and what
sits under it; with a standing delay or batches where the setting has
them. No mandate is named where a gate starts. Every page released outside
says whether its gate asks.

### Delay and batches

A setting can keep what it lets through back for `delay_hours` from when
it was produced, then send it at the next multiple of `batch_hours`, so
that when a thing was made is not told by when it arrived. The delay is an
act of the gate's setting on the item, shown like any delay, and a person
at the gate may lift it.

## What is not built

- **A trial takes pasted text only.** Trying the Redactor again on an item
  that already crossed, to compare with what a person decided, is not
  built.

- **Whose material a message, a mandate or a funding item rests on is not
  traced.** Their parts are taken to be the organization's own. An
  answer's findings rest on the parties of the sources the request bears
  on, the connections its run called and the file sets it had mounted,
  each paragraph on all of them, since a run's log does not say which
  sentence came from which.
- **A petition that comes through is not waited for.** It reaches the
  paying mandate's officers as an item in their inbox; the run that
  petitioned has usually ended by then, and adding to what was asked
  funds further work.
- **An answer to a message reaches a sender that is a Steward.** For any
  other sender it is listed among what came through
  (`GET /gate/items`).
- **A holder of `consent` who does not read the label things come from**
  is shown its face, or "a label you do not read" where it shows none.
  The destination's name is shown to them: they were put at that gate.
