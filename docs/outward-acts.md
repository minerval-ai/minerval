# The rest of the way out of a private graph, and what comes back

A private graph reaches the public graph in two ways. It can show a page
([showing-a-page.md](showing-a-page.md), [published-pages.md](published-pages.md)).
Or it can act there as any account does: take up a request, open or fund a
mandate, pay for a node's assessment, send its agents' reports of faults in
Minerval's machinery to the people who maintain it. This document is the
second way, and what comes back along both: what the public says about a
published page, and what the public record shows of a publisher.

Four things hold for every part.

- **A private graph acts on the public graph as an ordinary account and
  only as one.** Every act here is a call to a route any account could
  call, with the key of the organization's own account
  (`PUBLIC_GRAPH_API_URL`, `PUBLIC_GRAPH_API_KEY`). Where the public graph
  lacked such a route, one was added for every account ("What the public
  graph gained", below). Nothing on the public graph knows what a private
  graph is.
- **Every outward act shows something**, at least where the organization's
  attention is. So each is the act of a signed-in person who holds the
  permission for it, or follows from a standing choice such a person made
  after being shown, in words stored with the choice, what it shows
  outside. A person is present in a signed-in session, or by pressing the
  card the Assistant shows for an outward act
  ([accounts.md](accounts.md), "The Assistant"; kind `send_outside`). A key
  or a token alone does not act. Each act is a row in `outward_acts` with
  who, holding what, exactly what was sent, and what the public graph
  answered (`GET /outside/log`).
- **Nothing private crosses except through showing a page.** A call here
  carries ids the public graph already holds, amounts, a reason from a
  fixed list, or words a person wrote for the outside from a signed-in
  session. Words an agent wrote leave only after a Redactor's pass and a
  release. `tests/db/outward-acts.test.ts` tries to make something private
  cross by each route and fails.
- **Nothing reads the live public graph in a way that follows the
  deployment's attention.** What it needs to know of the public record
  comes with the mirror, which it pulls whole ([mirror.md](mirror.md)). The
  feed gained the public contribution record and requests for everyone who
  mirrors. The only reads of the public graph are of the organization's own
  account: its balance, its mandates, its conversation with the public
  Grantmaker, and the reports it filed.

Everything inside is mounted only where `READS=members`
(`src/routes/outward.ts`). The public graph's additions are mounted
everywhere, as all its routes are.

## Who may

`PUBLIC_ACTS_BY` names the permission whose holders may act on the public
graph in the organization's name: `direct` unless set (`fund` and
`administer` are the others). Sending an agent's report takes `release`
for the organization's own material instead, because it releases words
written at a label.

| Act | Takes | A person present | A tool |
| --- | --- | --- | --- |
| Adopt a public request (says nothing outside) | `direct` | session | no |
| Say in public that the graph is taking a request up; say later that it will not do the work | `PUBLIC_ACTS_BY` | session or card | yes |
| Open a public mandate; write to the public Grantmaker | `PUBLIC_ACTS_BY` | session | no: the words are a person's |
| Fund a drafted public mandate; add public owls to one; fund a mirrored node; ask a public mandate about a node | `PUBLIC_ACTS_BY` | session or card | yes |
| Set a standing choice | whoever could do each act it covers | session | no |
| Leave a mandate or a node out of keeping public versions current | `direct` | session | no |
| Send a redacted report to Minerval's maintainers | `release` for the organization itself, and reading the report's label | session or card | yes |
| Send the facts of a tool failure | `direct` | session or card | yes |
| Pay for the redaction of a report | `fund` | any credential | yes |

## 1. What the public says back

A reader of a published page can challenge it, and can propose to the node
it is a page of. That is the check the public has on structure it cannot
see, so it has to reach the Steward that can answer.

**On the public graph** it is an ordinary contribution on the node that
names the page (`about_published_page_id` on `POST /contributions` and
`submit_contribution`), from any account, reviewed by the Contribution
Reviewer like any other. The second tab of the node's page offers
"Challenge this page, or propose through it".

**Coming in.** The contribution arrives with the mirror
(`feed_contributions`). `takeInPublicContributions`
(`src/services/inbound-service.ts`) takes in those that name a page this
deployment published, once the public graph's own review has admitted
them. One whose text is the same as an earlier one's on the node is
recorded as a repeat of it and opens nothing: repeats count once. The check
is exact, on the text. Whether a contribution in other words says what an
earlier one said is the Steward's judgment (constitution §14).

**To the Steward.** `deliverPublicContributions` gives the contribution
itself to the node's Steward at the label the page came from: its text as
written, its type and date, the addresses it cites and its id on the public
graph, inside fixed sentences that say the text was written outside the
deployment. It is public text on the public graph, which that Steward
reads through the mirror already, and an agent that has not read a
challenge cannot answer it. Every agent is told that what it reads is
data; nothing more is said of that here. The message opens a reassessment
at that label, which runs when a mandate or a person pays for it. Under a
standing showing its result goes out as the next version by the path every
version takes.

Members read the same on `GET /outside/said-back` and on the page made
from it: each contribution as it was written, with where its reassessment
stands.

**What the outside is told.** No new kind of object. The page's next
package carries `record.said_back`: each contribution received by its
public id, whether it was counted with an earlier one of the same text,
and where the reassessment stands in fixed words (not paid for; paid for,
and not yet made; made). The public graph shows that on the contribution's
own record and on the second tab, beside the versions the package already
lists: received; unanswered, where no reassessment has been paid for; and,
once one is made, whether a version made since is published or held. No
word of a contribution is in a package.

## 2. Taking up a request in public

A request on the public graph can be addressed to whoever holds the
evidence, and what becomes of it is part of its record.

**Adopting.** The public graph's requests come with the mirror
(`feed_requests`, `feed_request_targets`; `GET /outside/requests`).
Adopting one (`POST /outside/requests/:public_request_id/adopt`) files an
ordinary request here, at a label the person reads, with the public
request's own words and the nodes it bears on, linked to the public one
(`adopted_requests`). It says nothing outside. The work is an ordinary
request and action: it runs when it is funded.

**Taking up in public.** A person who may act there says, in the
organization's name, that the graph is taking it up. The public graph
records that on the request (a `request_work` row marked `taken_up`, in
fixed words, with the account and the date). It commits the account to
doing the work well, not to a result; it funds nothing and does not move
the request's state. The request's page then shows what followed, read
from the record and not from the account: a page the account published on
a node the request bears on, its own statement that it will not do the
work with a reason from a fixed list, or nothing yet, with how long.

## 3. Public mandates and public owls

A private mandate cannot pay for public work and private owls do not
convert, so paying for public work is made easy from inside.

- `GET /outside/account`: the organization's balance of public owls and
  its public mandates. The mandates page lists them after the deployment's
  own, marked as public.
- **New public mandate** (`POST /outside/mandates`, then
  `POST /outside/mandates/conversations/:id/messages`): a conversation with
  the public Grantmaker in the person's own words, sent as written. Nothing
  from the deployment is filled in. These take a signed-in session and are
  not tools, because words an agent drafted would be an agent's words
  leaving without redaction.
- Funding the drafted mandate, adding public owls to a mandate, **Fund this
  on the public graph** on a mirrored node's page
  (`POST /outside/nodes/:node_id/fund`), and asking a public mandate about
  a node are calls to the public graph's ordinary routes, and are tools
  that wait for the user.

## 4. Keeping the public version current

When a version of a mirrored node changes at a label here, the deployment
can ask a public mandate the organization funds for a fresh public
assessment of the node, on public evidence. No private content moves: the
request is the node's id. What shows is which public nodes the
organization works on, and when.

- **The setting** is `keep_public_current` among the standing choices
  (`GET /outside/choices`, `PUT /outside/choices/keep_public_current`). It
  is on unless someone turns it off. It names the public mandate that is
  asked, a delay in hours, and an interval for sending in batches.
- **On, with nothing behind it, sends nothing.** Until a person has named a
  public mandate, on the screen that says what the setting shows outside,
  no version is noticed and nothing is sent, and no version made before
  then is sent afterwards. The setting's page, the setup checklist and
  `GET /outside/keep-current` say so in words.
- **How it asks.** `POST /mandates/:id/raise` on the public graph puts the
  node in front of the mandate's officers in fixed words, as one of its
  funders. It asks and does not command: the officers decide under the
  mandate's operating policy.
- **Left out.** A mandate's work, one node under it, or one node whoever
  pays, can be left out (`POST /outside/keep-current/leave-out`), recorded
  at the mandate's label or one the person names.
- **Stamped on every page shown outside.** A package's
  `deployment.keeps_public_versions_current` says whether the setting is on
  and whether a public mandate pays for it. Turning it off builds a new
  package for every node shown.

## 5. An agent's report, sent to Minerval's maintainers

In a deployment that keeps things inside, an agent's report stays inside,
at the run's label. So that Minerval still hears when its tools fail:

- **Two parts.** The facts (`factsOf`,
  `src/services/report-sending-service.ts`): which tool, only if it is one
  of Minerval's own by its name in the code; the kind of report and its
  severity, from the two fixed lists; the migration and prompt set the
  deployment runs; how often, and the first and last day. And the agent's
  words: the title and the body.
- **Audit's triage** says what a report is about (`about` on
  `triage_report`, offered only where reports stay inside): Minerval's
  machinery, or this deployment. Only the first kind is offered.
- **The Redactor's pass is done ahead** (action kind `redact_report`, at
  the report's label, under the policy for what leaves that label). The
  page shows the words as they would go.
- **One act sends them** (`POST /outside/reports/:sending_id/send`), to the
  public graph's `POST /reports` under the organization's account, marked
  `private`, which keeps the report out of anything the public can read.
- **Two standing choices, both off until turned on**: send the facts of
  tool failures with nobody acting; send redacted reports with nobody
  reading them first.
- **What came back** (`GET /reports/mine/:id`: status and the maintainers'
  note) is shown on the report, to people. No agent is given it.

## 6. A publisher's record

`GET /publishers/:account_id` adds `record`: what the public graph's own
record holds of the publisher, as counts and dates
(`src/services/publisher-record-service.ts`). Pages published and in which
form; how they stand; versions held and for how long; showings ended;
contributions made through them and what followed; requests taken up and
what followed; and where the public graph's later assessment of a node
moved toward or away from the credence a published page gave. It is
derived when read and is not a score. The same sentences are in the text of
a published page's source, for the publisher's other pages, so the node's
Steward reads them with the page.

## What the public graph gained, for every account

| Route | What |
| --- | --- |
| `about_published_page_id` on `POST /contributions` | A contribution made through a published page |
| `POST /requests/:request_id/take-up`, `.../take-up/decline` | Say that the account is taking a request up; say that it will not do the work |
| `POST /mandates/:id/raise` | A funder asks its mandate for a fresh assessment of a node |
| `POST /reports`, `GET /reports/mine/:id` | File a report over REST, optionally private; read what became of one's own |
| `record` on `GET /publishers/:account_id`; `said_back` on a published page; `taken_up` on a request | Reads |

The mirror's feed carries three more tables (`feed_contributions`,
`feed_requests`, `feed_request_targets`), filled on a publishing graph
before each cut from the public columns of its contribution record and its
requests, with no account.

## Settings

| Variable | |
| --- | --- |
| `PUBLIC_ACTS_BY` | The permission whose holders act on the public graph in the organization's name: `direct` (the starting value), `fund` or `administer` |

The three standing choices are set in the app and stored in
`outward_settings`.

## What this does not do

- No model has run any of it: the Redactor's pass over a report and
  Audit's `about` were driven through their tools, and no Steward has yet
  been given a public contribution in a run with a model.
- The contribution record's reasoning and the work on a request are not in
  the feed.
- A report's redaction has no check by Audit of its own, as a page's has:
  a person reads the words before sending, unless the organization chose
  otherwise.
- A publisher's record compares credences only; a quantity's estimate or a
  question's standing is not compared.
- The public Grantmaker's conversation is read by reloading the page.
