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
[showing-a-page.md](showing-a-page.md) describes one kind of item, a node's
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
| `funding` | A mandate here paying for a pass on a node on the other side | The mandate's side asks for it | The pass is opened there |

An item is recorded the way a node's page is: a short list of what is
always shown of it, and its parts as written, each resting on the parties
whose material it draws on. An answer's parts are where the request stands
with its keeper's note, one sentence for each piece of work, and each
paragraph of what the work found. Every part is text exactly as an agent
or a person wrote it at the label, or a sentence in fixed words. The
Redactor, Audit's check, the fingerprint and release then work on any item
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
  `restore`, `hold_part`, `delay_part`, `lift_hold` and `finish_redaction`.
  What it does not hold or delay it lets through.
- **A person** the gate's authorities put there: someone who holds
  `release` for a party the item rests on. They act through
  `POST /gate/decisions`, with `release`, `approve` (everything nobody
  holds, as the Redactor left it), `remove`, `hold`, `delay` and `lift`.
  They may act from the web app, or through a key or token of their own
  account, so their own agent or a script can do it: the queue
  (`GET /gate/queue`) carries what is needed to decide each item, a call
  takes up to 500 items, and sending the same decision again changes
  nothing.

Every act is a row (`showing_acts`) naming who made it: the person and the
permissions they held, the Redactor's run, or the gate's setting. A hold
stays on the record after it is lifted. A release is not taken back.

A person's removal is the Redactor's act: the passage is replaced by the
category's mark, the part's hash and the item's fingerprint are recorded
again, and the fingerprint before it stays on the record. It can be done
until the item itself has been shown, because what is always shown counts
the removals. After that a part not yet released can be held.

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
  part then waits for the people who hold `release` for the parties it
  rests on. They approve it as proposed, in one act for a whole item, or
  change it with the same acts.

**Where a gate starts.** The Redactor decides, for every kind, with one
exception: the bare fact that a request was taken up starts open. A gate
that waited on a person for each item would not move, and the point of a
deployment is that what a label learns reaches the labels below it and the
public. A gate that let text through unread would not be a gate. The fact
that a request was taken up carries no text from the label that took it up,
and an asker who is not told may pay for the same work twice. A statement
of what was spent also starts open: it is figures in fixed words about the
payer's own money, which the payer's own account already shows as it moves.

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
one for the gate as a whole, since release is a party's to give. Within
either, the narrowest scope that covers the item is taken, and a setting
for the item's kind before one for every kind. A setting applies from when
it is set to everything not yet released, so loosening one lets through
what was waiting on it.

A gate has two sets of authorities. The deployment's administrators set
the gate as a whole. The holders of `release` for a party set it for that
party's material. Most tightening and loosening is done in neither place
but in the boundary's redaction policy, which says what the Redactor
removes ([showing-a-page.md](showing-a-page.md), "The policy").

Three things are set for the gate as a whole (`PUT /gates/:gate_id`): what
flows to it, whether its backlog is shown, and, for the gate to outside,
whether what is released is sent to the public graph as it is released.

## What flows

A flow is set once and then offers things to the gate as they are
produced.

- **What was asked for from the other side flows by default**: that a
  request was taken up, the answer to it, the answer to a message.
- **A node's page flows where a flow was set for it**
  (`POST /showings`, people who direct): one node, a node with what sits
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
(`payForGateWork` in `src/services/showing-service.ts`). Sending a result
down is part of the work that produced it, so it is paid from that work's
budget: the mandate the offer named; else the mandate whose budget paid
for the judgment a page carries, or for the work on the request an answer
reports; else the General mandate at the item's label, which pays for that
label's upkeep. The budget placed is the run's estimated cost, and what
the run does not spend goes back.

Where none of them can pay, the item waits. The other side is told in
fixed words that it is waiting for funds, the backlog counts it so, and
each look of the scheduler tries again. A person who holds `fund` can also
pay by hand (`POST /showings/:showing_id/pages/:page_id/commission`).

## The backlog

`GET /gate/backlog` says, for each gate toward a label the caller reads,
how many items have not gone through, of what kinds, for how long, and what
each waits on: the budget, the Redactor's run, Audit's check, the
Redactor's hold, a person's hold or decision (by party), a delay. It is
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
waiting are the ones placed to notice. `/gates` in the web app shows it,
and to a gate's authorities shows the settings beside it.

## Outside

The boundary to outside is the same gate: the same settings, the same
acts, the same payment. What differs is mechanical. What is released of a
node's page is built into a signed package and admitted on the public graph
([published-pages.md](published-pages.md)). Whether a package is sent as
it is built or waits for a person is the gate's `send_as_released`, which
starts on.

Only a node's page goes outside through the gate today. Three things that
are downward flow at the outer boundary still have their own paths:

- **Taking up a public request, and what followed**, are the
  organization's public statement and its published page
  ([outward-acts.md](outward-acts.md)). The public graph has no row for an
  answer to arrive on.
- **Keeping public versions current** (asking a public mandate for a fresh
  public assessment when an inside version of a public node changes) is a
  mandate's funding of work below, and has its own queue, its own delay
  and batching, and its own exceptions by mandate and node. Each maps onto
  a gate setting: on is the gate to outside open for `funding`, an
  exception is a setting scoped to a mandate or a node, and its delay is
  the gate's. It has not been moved because its rows and the sentence
  every published page carries about it would have to be moved with it.
- **An agent's problem report to Minerval's maintainers** has its own
  Redactor pass and release (`src/services/report-sending-service.ts`).

## What is not built

- **Money does not yet cross with funding.** A mandate's funding of a pass
  at a label that does not read it goes through the gate, and the pass is
  opened on the other side when it is through, in fixed words. The
  mandate's money is not placed on that pass: a budget is a row at the
  mandate's label, and work at the other label can neither read nor draw
  on it. The pass waits for that label's own funders.
- **Whose material an answer rests on is not traced.** A page's parts rest
  on the parties whose sources the judgment read. The parts of an answer,
  a message, a mandate or a funding item are taken to be the
  organization's own.
- **A petition that comes through is not waited for.** It reaches the
  paying mandate's officers as an item in their inbox; the run that
  petitioned has usually ended by then, and adding to what was asked
  funds further work.
- **An answer to a message reaches a sender that is a Steward.** For any
  other sender it is listed among what came through
  (`GET /gate/items`).
- **A batch is a shared time.** Items delayed to the same time go
  together. A gate has no standing schedule of batches.
- **A holder of `release` who does not read the label things come from**
  is shown its face, or "a label you do not read" where it shows none.
  The destination's name is shown to them: they were put at that gate.
