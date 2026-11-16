# A shown page leaves the deployment and is read on the public graph

Often the best evidence for something is more sensitive than the thing
itself. [showing-a-page.md](showing-a-page.md) describes how a deployment
shows what an agent concluded from evidence without showing the evidence:
redaction under a policy, Audit's check, a fingerprint recorded before
anyone decides what is released, and a release gate. For a showing outside
the deployment those steps end with what was released recorded inside, at
`public`. This document is the rest of the way: out of the deployment in a
form anyone can check, onto the public graph as a source its publisher
submits, and in front of a reader of the public node's page.

The public graph gives such a page no special trust and no special
standing. It is a source. It can be strong evidence, and how strong is the
judgment of the node's Steward there, from what the page's record shows.

One codebase serves both sides. A deployment uses the side it is on.

## The package

A package is one JSON document: one node under one showing outside, as the
outside is to read it, at the moment it was built
(`src/published-page/verify.ts` has the whole form).

| Field | |
| --- | --- |
| `format` | `minerval-published-page/1` |
| `publisher` | The signing key: its id and its 32 bytes |
| `deployment` | Where the deployment runs, as one of three fixed words (the organization's own machines; Minerval's; a third party's), and what outside the publisher's control attests to the run. Today nothing can, and the field says so |
| `showing` | Its id, form (once or standing), scope, when it was asked for, how its packages are sent, and its ending with date and reason |
| `node` | The node's id on the public graph, when the showing came to cover it, when it was first assessed at the page's label, which came first, and its leaving |
| `sequence`, `previous_hash` | 1, 2, 3, ... for this node under this showing, each naming the one before |
| `state` | The node's state now: not yet assessed, released whole, released in part, or held |
| `page` | The latest version that is shown: what is always shown, as hashed, with its salt; each released part with its text, marks and salt; each held part with its hash, its kind, who holds it, any reason given and since when; the fingerprint. Where no version has been shown, the latest version as held, by kind and hash alone |
| `policy` | The version the page was redacted under, in full |
| `record.made` | The prompt-set hash, the model that assessed and the model that redacted, any addition to a role's prompt, the seal of the assessing run's log with whether its chain checked out, and how the assessment was paid for |
| `record.acts` | Everything a person, a rule or the process did on the showing, each with the permissions the person held. People are numbered; no name crosses |
| `record.versions` | Every version made while the showing stood, held ones as held; for each version released, `released_under`: for each party it rests on, how the publisher's gate was set when it went (open, the Redactor's decision, or a person's as well), how wide the setting was and the day it was set |
| `hash`, `signature` | sha256 over the canonical JSON of everything above; Ed25519 over the hash |

The record is facts the system stamps. Nobody writes a word of it.

A package is built whenever what the outside would read has changed: a page
shown, more of it released, a hold placed or lifted, a later version opened
or held, a node come under the showing or left it, the showing ended. It
is built by comparing, so nothing has to remember to build one. A later
version that is held does not take the last shown page away: the package
says the node is held, lists the held version in its history, and still
carries the page last shown.

### Nothing else crosses

The package is built by work at `public` (`runAtLabel`), on a connection the
database holds to `public` alone, from the rows the gate wrote there
(`outsideRecord` in `release-gate-service.ts`,
`buildOutboundPackages` in `outbound-service.ts`). A row at any other label
cannot be read by that work, whatever the code asks for. So what a package
can hold is what the destination side of a showing outside holds: fixed
words, ids of the showing and its pages, dates, hashes, counts, party
names, and the text of a part once every party it rests on has released
it. `tests/db/published-pages.test.ts` tries to make other content cross
(a held part's text, a removed passage, a removal's note, a row written at
another label under the same page, a label's name, a person's name, the
deployment's own id for a node that exists only inside) and finds none of
it in any package.

Two things are added to what is always shown with a page, because the
record needs them and they are known only at the page's label: the seal of
the assessing run's log with whether its chain checked out, and how the
assessment was paid for. Both are in fixed words. A funder's declared
stake is said to exist or not; its words stay inside.

### The key

`PUBLISH_SIGNING_KEY` is an Ed25519 private key in PEM form, made the way
the mirror's is ([mirror.md](mirror.md)):
`npx tsx scripts/published-page.ts keygen`. `DEPLOYMENT_HOSTING` says
where the deployment runs (`own_machines`, `minerval`, `third_party`). It
has no default, and no package is built until it is set.

## The check

`verifyPublishedPage` (`src/published-page/verify.ts`) checks a package
against itself. It imports nothing and uses only Web Crypto, so the same
file is the command-line verifier, what the public graph runs at
admission, and what a reader's browser runs from the claim's page (the web
app carries a copy, and a test fails when the two differ).

```sh
npx tsx scripts/published-page.ts verify <file> [--key=<publisher's public key>]
```

No database and no network. It confirms: that nothing in the package
changed after it was signed; that the signature is good, and, given the
publisher's key from somewhere else, that it is that key; that each
released part is word for word what was fingerprinted when the redaction
finished, with each removal marked where it was made; that each held part
is in the recorded place and of the recorded kind; that the policy is the
text its hash names; and that the record is well formed and agrees with
the page.

It also says, every time, what a check of this kind cannot show:

- that the assessment in the log was the only one made, where the publisher
  controls the machine;
- that the run's log is whole, since the log stays in the deployment;
- what the held parts say, and what was removed inside the released ones;
- that the dates and permissions in the record are true: the signature
  shows who states them;
- that the prompt set is one the reader knows.

## Inside the deployment

Mounted where `READS=members`, beside the showing routes
(`src/routes/outbound.ts`).

### Which node on the public graph

A page of a mirrored node goes to that node: the mirror gives its id. A
node that exists only inside has no page on the public graph to appear on.
It is first proposed there, as any contributor would propose it:

1. A person who holds `direct` writes or approves the words
   (`POST /outbound/proposals`). Left unsaid, they are the node's own
   wording.
2. Each party the node's wording rests on releases them
   (`POST /outbound/proposals/:proposal_id/release`), unless they are word
   for word a wording those parties already released at the gate.
3. The proposal is sent with the next send. On the public graph it is an
   ordinary proposal under the organization's account: reviewed, and placed
   by the Matcher, which may find that the public graph already holds the
   node.
4. Once the public graph holds the node, packages are built for it.

Meanwhile `GET /outbound` tells a member where it stands, in fixed
sentences: nothing proposed yet; words written and waiting on named
parties; ready to send; proposed on a date and under review there; or not
admitted, with the date. No package exists for the node until step 4, so
nothing of it is outside.

### Sending

The deployment is a client of the public graph's ordinary API, with the key
of the organization's own account there (`PUBLIC_GRAPH_API_URL`,
`PUBLIC_GRAPH_API_KEY`). It holds no other standing.

- **The gate's setting sends.** The gate to outside is the same gate as
  any other ([the-gate.md](the-gate.md)), and whether what it releases is
  sent as each package is built is one of its settings
  (`send_as_released` on `PUT /gates/:gate_id`, an administrator's). It
  starts on: what is released outside is sent with nobody sending each
  package. It is stated in every package. What it shows outside is in
  `SEND_CHOICES` (`outbound-service.ts`).
- **Or a person sends**, where the gate is set for that
  (`POST /outbound/send`, the tool `send_pages_outside`): someone who
  holds `direct`, from a signed-in session or by pressing the card the
  Assistant shows for an outward act. A key or a token alone is refused
  for this one route: it speaks in the organization's name on the public
  graph, and the setting above is how sending is automated.
- **Or a person carries a file**
  (`POST /outbound/packages/:package_id/file`, or
  `scripts/published-page.ts export <dir>`), where the network does not
  join the two. The public graph checks it the same way however it arrives.

Every send and every handing over is a row with who did it, what the
public graph answered, and whether it went under the gate's setting
(`outbound_sends`).

### Limits

- A package larger than `PUBLISHED_PAGE_MAX_BYTES` (4,000,000 by default) is
  not built and not admitted. It is a backstop: a page is one node's
  assessment with its arguments and readings, and the route that receives
  one parses it whole before it can check the signature.
- A statement of interest at registration is at most 1,000 characters: it
  is shown whole beside every page.
- Nothing else is counted. Submissions are bounded by what they cost.

## On the public graph

`src/routes/published-pages.ts`, `src/services/published-page-service.ts`.

### Who a publisher is

An account that has registered a deployment's signing key
(`POST /publishers`). The request carries the key's signature over a
statement that names the account and where the deployment runs, so nobody
registers a key they do not hold; the deployment produces it
(`POST /outbound/registration`, or
`scripts/published-page.ts registration <account>`). The registration, the
key, the hosting words and anything the publisher says of its own interest
are a public record (`GET /publishers/:account_id`, and the account's
contributor page). Registering a key again retires the earlier
registration, which stays on record.

Anyone can run a deployment and register a key. A registration says who
submits pages under the key and nothing about how far they are to be
believed.

### Admission

`POST /published-pages` takes a package from the account that registered
its key.

1. The package is checked with `verifyPublishedPage` against the
   registered key. One that does not check out is refused with what failed,
   and nothing of it is kept. So is one whose key is registered to no
   account or to another, whose hosting differs from the registration, whose
   node this graph does not hold, or that is not the next in its sequence.
2. It is kept as signed (`published_page_packages`). Every package received
   is kept; a later one is a later row.
3. Where it carries a shown page, the page becomes a source of the kind
   `published_page`, whose text is the page with its record and what the
   check confirmed and could not show. The publisher's interest in the node
   is recorded on the source, as a fact about it: it chose to show this
   page.
4. Nothing attaches itself. The first package for a node under a showing
   files an ordinary contribution on that node, which the Contribution
   Reviewer reviews as any contribution: that it is made in good faith and
   that the page is a page of this node. It is charged as a source
   submission, refunded if it is not admitted.
5. When the Reviewer admits it, the page is attached to the node as a
   source and the node's Steward is told. That opens a reassessment on the
   ledger, which runs when someone funds it. The publisher may fund it like
   anyone.
6. Whether the source stays on the node's page is that Steward's judgment,
   as for any source. A page the Steward has taken off is not attached
   again by a later package.
7. Later packages of an admitted publication are kept in order, the newest
   takes the earlier one's place on the node, and the Steward is told each
   time, including when a later version is held.

### What the Steward is told

The provenance text both Stewards carry already said to look for a
published assessment made on evidence a source has not shown, and to put
to it the questions put to any examination. One paragraph was added after
it, on what a source of the kind `published_page` is and what its record
says (`PROVENANCE_BODY` in `src/llm/prompts/claim-steward.ts`). The
Contribution Reviewer's prompt gained a few lines under `add_instance`.

### Reading

- `GET /published-pages?node_id=`: the published pages of a node, each with
  its state and where it stands on the node (whether its submission was
  admitted, whether it is on the node's page, and which package of it the
  node's own assessment was made on).
- `GET /published-pages/:id`: one page in the shape of a node's page
  (`src/published-page/shape.ts`): summary and reasoning by paragraph,
  arguments with their evaluations, readings, sources, subclaims, each
  released part as written with `[redacted: <category>]` where a passage
  was removed, and each held part in its place as what it was, who holds it
  and any reason given. With it: the record, the history of versions, and
  the check.
- `GET /published-pages/:id/package`: the package exactly as signed.

### On the claim's page

The public assessment is the page's default and stays the one assessment of
everything public, the published page included once the Steward has weighed
it. A line under the verdict says whether it has.

A published page that is on the node's page is a second tab, "Redacted
assessment on sealed evidence". It is the claim page's own reading column
(`ClaimView`) fed the published page: the same verdict band, Assessment,
Full reasoning, Decomposition and Provenance, drawn by the same components.
What differs is marks and holds. A removal is marked inline. A held part
stands where the part stood, in ink and no status colour, with who holds
it. One line near the top says what was taken out. "How this page was
published" is closed to one line at the foot and opens to the record, the
history of versions and the release check, where "Check this page" fetches
the signed package and runs the check in the reader's browser.

## A published mandate

An organization can publish a mandate of its own graph on the public graph
as its face there ([the-gate.md](the-gate.md), "A published mandate"). It
arrives in a package of the same kind as a page's, signed with the same
registered key (`format` `minerval-published-mandate/1`;
`src/services/published-mandate-service.ts`): the mandate's name and terms
as the gate let them through, held parts named in place, and `face`, the
gate's settings for the mandate's work as the publishing deployment stamped
them, with the same words about money on every one. Packages of one
mandate are numbered and chained as a page's are, and each is kept as
received, so `GET /published-mandates` shows every change with its date.
A package is checked before anything is kept: its form, its hash, the
signature against the registered key, the account, and its place after the
one before. It is the publisher's own statement on its own record and is
not reviewed as a contribution is, and nothing checks that the publisher's
gate is set as stated: each page it publishes says which setting it was
released under, and the two can be read side by side. A request on the
public graph is addressed to it by giving its `face_id` as the request's
addressee; the request's record (`addressed_to_mandate`) then shows what
the publisher did about it.

## What this does not do

- **What else passes between the two graphs** is in
  [outward-acts.md](outward-acts.md): what the public says back about a
  published page, requests taken up in public, public mandates and funding
  from inside, keeping the public version current, and a publisher's
  record.
- **A subclaim that is a public node** is shown with how it bears and
  without saying which node it is: the part's text leaves the wording out
  because the destination already reads it, and the node's id is not
  carried.
- **A proposal that the public graph places on the denial of a node.** The
  Matcher may find that a proposed node is the negation of one it holds.
  The page then appears on that node, with its own wording as its first
  part, and the Steward is told the verdict is of that wording. Nothing
  reverses it.
- **Inside a members-only deployment** the receiving routes are mounted, as
  every route of the public graph is, and have not been exercised there.
