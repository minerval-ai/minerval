# Organizations on minerval.ai, and how a private deployment connects

The design agreed in #1118, with the questions its review raised
answered ("Decisions", at the end). Phase 1, organizations on minerval.ai,
is built ([accounts.md](accounts.md), "Organizations"); the phases after it
are not ("Phases", below). It replaces the shared login and the bearer keys a private deployment uses
to reach minerval.ai. It covers both kinds of private deployment: one an
organization runs itself (`own_machines`, or `third_party` for a host it
hires), and one Minerval runs for it (`minerval`). The two differ where
this document says so, and nowhere else.

## What is wrong today

A private deployment reaches the public graph through "an account on the
public graph that belongs to the organization" ([self-hosting.md](self-hosting.md),
"The public graph"). minerval.ai has no organization accounts. Sign-in is
GitHub or Google, so in practice someone makes a GitHub or Google login
for the organization and shares it. They sign in as it, make a full
account API key and paste it into `deploy/.env` three times:
`MIRROR_FEED_API_KEY`, `PUBLIC_GRAPH_API_KEY` and `USAGE_REPORT_API_KEY`.

That one bearer key does four things:

| What | Route on the public graph | Where the deployment calls it |
| --- | --- | --- |
| Fetch the mirror feed | `GET /mirror/feed/:sequence` | `src/services/mirror-apply-service.ts`, `urlSource` |
| Report usage for the metered price | `POST /usage-reports` | `src/services/usage-report-service.ts` |
| Publish pages and propose their nodes | `POST /publishers`, `POST /published-pages`, `POST /published-mandates`, `POST /claims/propose` | `outbound-service.ts`, `gate-outside.ts`, `outward-acts-service.ts` |
| Act in the organization's name | `POST /requests/:id/take-up[/decline]`, `/grant-conversations[...]`, `/mandates/:id/contribute`, `/mandates/:id/raise`, `/claims/:id/contribute`, `POST /reports`, contributions about a published page | `outward-acts-service.ts`, `gate-outside.ts` |

It also reads the account's own state: `GET /users/me`, `GET /grants`,
`GET /reports/mine/:id`, `GET /contributions/:id`,
`GET /grant-conversations/:id`.

This is wrong in five ways:

- **A shared login.** Someone holds the password. When they leave, the
  link to the public graph goes with them, or the password goes round.
- **The key can do anything the account can.** It can spend owls,
  contribute and comment, though the deployment needs only to read the
  feed, report usage and publish. It sits in a file on a server.
- **No control.** Nobody can say which people may act for the
  organization, what each key may do, or retire one cleanly.
- **The public record reads as a person.** Pages and acts appear under a
  login name. Nothing ties them to the organization's domain.
- **Setting up is a chore.** Make a login, sign in, copy a key, edit
  `.env`, restart.

What is right today and stays: on the public graph an organization is
one participant among others. Its registration says who submits under a
key, "and nothing about how far they are to be believed"
([published-pages.md](published-pages.md), "Who a publisher is"). It
gets no standing because it is an organization, has a verified domain,
or is hosted by Minerval.

## The shape

1. **An organization is an account of its own kind on minerval.ai.** People
   sign in as themselves and are made its admins or members. Nothing is
   shared, and nothing changes when someone leaves.
2. **A private deployment belongs to an organization and signs its own
   requests.** It holds an Ed25519 key that never leaves it. Every request
   it makes to the public graph is signed with that key. No bearer secret
   sits in `.env`.
3. **Each deployment may do only what it was granted.** An organization
   admin grants each one its permissions separately and can withdraw any
   of them.
4. **Connecting is a button.** The deployment shows a short code. An
   organization admin opens a link, signs in as themselves, and approves
   it with the permissions they choose. No file edit and no restart.
5. **The public record names the organization.** Acts on the public graph
   are the organization's, and published pages also name the deployment.
   Which person pressed the button stays in the deployment's own log
   unless the organization chooses to name them.
6. **Billing belongs to the organization.** Owls it buys, usage reports
   and the metered price attach to it, not to a login.
7. **Optionally the organization proves its domain** with a DNS TXT
   record, so its pages read "Acme Corp (acme.com)".

## Organizations on minerval.ai

### One row, a new kind

An organization is a row in `contributors`, like a person and like the
platform account (`platform:minerval`). Every table that names an
account (`owl_ledger`, `publishers`, `published_pages`,
`usage_reports_received`, mandates, contributions, the contributor page)
then works for an organization as it is. Nothing has to choose between
two kinds of owner.

- `contributors.kind`: `person` (the default, every row today),
  `organization` or `platform`.
- An organization's `external_id` is `org:<id>`. No sign-in provider makes
  that prefix, and `POST /users/provision` refuses it, so nobody can sign
  in as an organization.
- An organization holds no API keys and no OAuth tokens. Minting one for
  it is refused. It acts through its connected deployments, or through an
  admin acting for it from their own signed-in session on minerval.ai
  ("Acting from minerval.ai", below).

### Members and admins

`organization_members`: organization, account (a person), role (`admin` or
`member`), who added them and when, and who removed them and when. A
removal is a new value on the row, never a deletion, so the record of who
was an admin when stays.

| | admin | member |
| --- | --- | --- |
| See the organization's page, its deployments and their grants | yes | yes |
| Approve a deployment, change or withdraw its grants | yes | no |
| Add and remove members, make admins | yes | no |
| Buy owls for the organization, see its billing | yes | no |
| Spend its public owls from minerval.ai | yes | no |
| Verify a domain, change the name | yes | no |

Every change is a row in `organization_log`, readable by the
organization's members and by nobody else.

- **An organization always has an admin.** Removing or demoting the last
  admin is refused, and so is an admin leaving when they are the last
  one. If every admin's account is gone or suspended, the way back is the
  operator key (`POST /operator/organizations/:id/admins`), as for a
  deployment that lost its administrators ([accounts.md](accounts.md),
  "The first administrator"). It is logged as made with the operator key.
- **Adding a member** is an invitation: a single-use link, made by an
  admin, that expires after seven days. The person opens it signed in as
  themselves and accepts. An organization cannot add a person who has not
  accepted.
- **A member who leaves Minerval** (their account is deleted) leaves every
  organization. The organization keeps everything it did.

### Making one

Any signed-in person can make an organization (`POST /organizations`,
with a name). They are its first admin. Making one costs nothing and
gives nothing: no owls, no standing, no badge. A name is not unique and
proves nothing. A verified domain is what tells two organizations of the
same name apart.

### Acting from minerval.ai

An organization that runs no deployment, a funder for instance, still
needs to spend the owls it buys. So an admin can act for the
organization from their own session on minerval.ai, on the
organization's pages:

- open a public mandate with the public Grantmaker, fund it, and add owls
  to one;
- pay for a node's assessment, and ask one of the organization's
  mandates for a fresh assessment of a node.

These are the acts that spend money and nothing else. Contributing,
proposing nodes and publishing pages are not offered here: they are a
deployment's work, made under its grants. Each act appears on the public
graph as the organization's. The organization's log records which admin
made it. Only a person present in a session can do this: no key, token,
deployment signature or Assistant card acts as the organization on
minerval.ai, because a key alone would bring back the problem this
design removes.

The request carries `x-acting-organization: <id>` from the web tier,
beside the person's own `x-acting-user`. The API checks that the person
is an admin of that organization right now, then resolves the request
to the organization's account with `method: "organization_admin"`. A
route that is not one of those acts refuses the header.

### The organization's pages

The organization's pages on minerval.ai are drawn as tools, with the
same kit as a private deployment's workspace (#1133): the pieces in
`web/components/work/ui.tsx`, `WorkForm`, drawers, and the `w-` classes
in `web/app/workspace.css`. The root layout already loads that
stylesheet, so the public build has it. They sit under the account
pages (`/account/organizations/:id`), in tabs:

| Tab | What | Who |
| --- | --- | --- |
| Overview | Name, domain, members' count, owls, the deployments with their state | members |
| Members | Members and roles, invitations in a drawer | members read; admins change |
| Deployments | Each deployment's grants, allowance and what it has spent, with a drawer to change them; feed files for a deployment the network does not join ("The mirror", below); the old keys still live after a conversion | members read; admins change |
| Public acts | Mandates and funding, the forms for "Acting from minerval.ai" | admins |
| Billing | Owls bought, usage reports received per deployment, and uploading a report carried out by hand | admins |
| Domain | Domains, their TXT records and when each was last confirmed | members read; admins change |
| Log | `organization_log` | members |

The connect link (`/connect?code=...`) is a page of its own. It needs
only a signed-in person, and it lists the organizations they admin.

### Converting an existing shared account

Organizations that connected before this exist as person accounts behind
a shared login, with publishers, published pages, owls and a record. The
conversion keeps the row, and so keeps all of that.

While signed in as the shared login, a person presses "This account is an
organization" and names its first admin, a person account that accepts
from its own session. Then, in one transaction:

- `kind` becomes `organization`, and `external_id` becomes `org:<id>`.
  Signing in with the shared login afterwards makes a new, empty person
  account. It no longer reaches the organization.
- The named person becomes an admin.
- The account's API keys keep working until an admin revokes them or the
  last phase below removes bearer keys. The organization's page lists
  them under "Old keys still live", with when each was last used, so the
  admins can see when the deployments have stopped using them.

## A deployment's identity

### The deployment's own key

A deployment makes an Ed25519 key pair when an administrator first
presses "Connect to minerval.ai" (below). That is its **connection key**.

- The private key is kept in the deployment's database, in a table of its
  own (`public_graph_connection`). It is readable only on the owner role,
  carries no label, is not in the mirror, and no route or tool reads it.
  It is not in `.env`. It is in the database's backups, as everything the
  deployment holds is.
- It is not `PUBLISH_SIGNING_KEY`. That key signs a chain of packages, and
  a new one cannot continue the chain ([self-hosting.md](self-hosting.md),
  "No backups"), so it must almost never change. A connection key should
  change whenever there is any doubt about it, and doing so should cost
  only a reconnection. Keeping them apart means rotating one never touches
  the other. The publishing key is registered through the connection
  ("Publishing", below).
- Losing it costs a reconnection: connect again and approve again. Nothing
  public is lost.
- **Rotating it** ("Replace the connection key") needs no admin on
  minerval.ai. The deployment makes a new key and sends it in a request
  signed by the old key. The public graph moves the deployment to the new
  key, keeping its grants, and the old one stops working at once. A
  deployment that suspects its key has leaked should instead ask an
  organization admin to withdraw it, because whoever holds the leaked key
  can rotate too.

### Signed requests

Each request to the public graph carries one header:

```
Authorization: Minerval-Deployment key_id="<hex sha-256 of the public key>", created="<unix seconds>", nonce="<random>", signature="<base64>"
```

The signature is over this text, in the same style as the publisher
registration (`registrationStatement` in `src/published-page/verify.ts`):

```
minerval-request/1
<host>
<METHOD>
<path with query string, as sent>
<hex sha-256 of the body, or of nothing>
<created>
<nonce>
<key id>
```

The public graph checks it before any route runs, in
`src/server/plugins/auth.ts`, as a new method beside the API key, the env
key and the OAuth token:

- The key id names a live deployment, and the signature checks against
  its key.
- `created` is within five minutes of the server's clock either way.
- For a request that is not a `GET`, the nonce has not been seen with
  this key in the last ten minutes (`deployment_request_nonces`, pruned as
  it goes). A replayed write is refused. A replayed read only reads again
  what the deployment could read anyway, so reads are not tracked, which
  keeps the feed's many fetches off that table.
- The host is the one the request came to, so a request signed for one
  Minerval cannot be replayed on another.

The request then authenticates as the organization's account (`userId`
is the organization's row) with `method: "deployment"`, the deployment's
id and its live grants. It is not service-trusted, cannot send
`x-acting-user`, and is not a session, so every route that wants a
person's session (`requireSession`) refuses it, as it refuses an API key.

Why a format of our own and not HTTP Message Signatures (RFC 9421): both
ends are Minerval's code, the statement above is eight lines that anyone
can rebuild and check, and RFC 9421's canonicalization of component
identifiers adds code without adding anything we need. If a third party
ever needs to sign requests, it can be added beside this one.

### What each deployment may do

An organization admin grants each deployment any of four permissions:

| Grant | Routes |
| --- | --- |
| `read_feed` | `GET /mirror/feed/:sequence` |
| `report_usage` | `POST /usage-reports` |
| `publish` | `POST /publishers`, `POST /published-pages`, `POST /published-mandates`, `POST /claims/propose` |
| `act` | taking up and declining requests, the public Grantmaker's conversations and funding, `POST /mandates/:id/contribute`, `POST /mandates/:id/raise`, `POST /claims/:id/contribute`, `POST /reports`, `POST /contributions` |

Any live grant also lets the deployment read its own organization's
state: `GET /organizations/me` (below), `GET /users/me`, `GET /grants`,
`GET /reports/mine/:id`, `GET /contributions/:id`,
`GET /grant-conversations/:id`.

The map lives in one file, `src/server/deployment-grants.ts`, keyed by
route like `src/server/request-labels.ts`. **A route not in it refuses a
deployment's signature** (`403 NOT_A_DEPLOYMENT_ROUTE`), so a route added
later is closed to deployments until someone decides otherwise. A test
fails on a route that is in the map and does not exist.

A route in the map that the deployment lacks the grant for answers
`403 GRANT_NOT_HELD`, naming the grant and saying that an admin of the
organization gives it on minerval.ai.

**Money, not counts.** `act` spends the organization's public owls.
An admin can give a deployment an owl allowance: a sum of the
organization's owls that the deployment may spend. The allowance has no
period and does not renew. It goes down as the deployment spends, and up
only when an admin adds to it. A deployment with no allowance set
spends from the organization's balance as a whole. There is no count of
acts. The allowance and what is left of it are in
`GET /organizations/me`. The deployment shows them on its public-graph
Overview (`/admin/outside`) and on Budget (`/admin/budget`), and gives
them to its own agents whenever they may act outside (CLAUDE.md,
"Constraints on agents"). A spend beyond it is refused with the figures,
before anything moves.

**Withdrawing.** An admin can withdraw any grant, or retire the deployment
altogether, at any time. It takes effect on the next request. Grants are
rows with who granted and who withdrew and when (`deployment_grants`),
never edited.

### The deployment's own record on the public graph

`deployments`: organization, a name the admin gives it, its hosting as the
deployment stated it (`own_machines`, `minerval` or `third_party`), the
connection key, the identifier the deployment puts on its usage reports,
who approved it and when, and when it was retired and by whom.

`deployment_requests`: one row per signed request that wrote (method,
path, time, status), readable by the organization's members. Reads are not
logged here, for the reason the mirror feed gives in
[mirror.md](mirror.md): the public graph should keep no record of what a
deployment looks at.

## Connecting

The device-authorization flow of RFC 8628, with the key standing in for
the device code: the deployment proves it holds the key on every call, so
there is no polling secret to keep.

**On the deployment**, an administrator opens the public graph's
Overview (`/admin/outside`) and presses "Connect to minerval.ai". A
drawer opens, like the one that registers the signing key today. They
choose which permissions to ask for (all
four ticked by default, with what each means) and the address of the
public graph (Minerval's by default).

1. The deployment makes its connection key and calls
   `POST /deployments/connect` on the public graph, signed with it. The
   body says the name it suggests, its hosting words, the permissions it
   asks for and its usage-report identifier.
2. The public graph answers with a short code (`WDJB-MJHT`), a link
   (`https://minerval.ai/connect?code=WDJB-MJHT`) and an expiry of fifteen
   minutes.
3. The deployment's page shows the code, the link, the first eight
   characters of the key's id, and "waiting for an admin of your
   organization to approve". It checks every five seconds
   (`GET /deployments/connect/:code`, signed).

**On minerval.ai**, a person opens the link and signs in as themselves.

4. If they are an admin of more than one organization, they choose which
   one. If they admin none, they are told so and offered to make one.
5. They see what is asking: the suggested name, the hosting the deployment
   states (and that it is the deployment's statement, not checked), the
   key id's first eight characters, and each permission it asks for with a
   tick box. Above the button: "Approve only if a deployment of yours is
   showing this code and this key id now. Anyone can make a code and send
   you its link."
6. They approve, with the permissions they leave ticked, or deny.

**Back on the deployment**, the next check returns the deployment's id,
the organization's id and name, and the grants. The deployment stores
them beside its key. It is connected, with no restart. Who pressed
Connect, and when, is on `/outside/log` as an outward act; the public
graph records the organization admin who approved, on the organization's
own log.

A code is used once. An expired or denied one makes the deployment say
so and offer to start again. Pressing Connect on a connected deployment
asks first, since it retires the old connection.

**A deployment the network does not join to minerval.ai** (`MIRROR_FEED_DIR`,
`USAGE_REPORT_DIR`) connects by hand. It shows a connection request: the
same body, signed, as text. An admin pastes it into the organization's
page on minerval.ai and approves it there. The deployment needs nothing
back, since it sends nothing over the network. What it would have sent
leaves as files, and two kinds go two ways, because one is public and
the other is not:

- **Page packages**, from the Outbox, are for the public graph. A member
  of the organization submits one on minerval.ai, signed in as
  themselves, and it is checked and admitted as if the deployment had
  sent it, under the organization and the deployment.
- **Usage reports**, from Budget (`USAGE_REPORT_DIR`), are billing, sent
  privately to Minerval. An admin uploads them on the organization's
  Billing tab, the only place on minerval.ai that reads reports received.
  They are recorded against the organization and the deployment, as if
  sent, and published nowhere.

Acts that need the public graph's answer, such as taking up a request or
funding, cannot travel as files. An admin makes them from minerval.ai
instead ("Acting from minerval.ai").

**Disconnecting** from the deployment (`/admin/outside`,
administrators) retires the deployment on the public graph with one last
signed request and deletes the key. Withdrawing on minerval.ai does the
same from the other side. The deployment learns it on its next request
and says so on its pages.

## Publishing

Registering the publishing key (`POST /publishers`) moves onto the
connection and needs `publish`. The registration statement is unchanged
except that it names the organization's account and the deployment's id.
`publishers.deployment_id` ties the publishing key to the deployment that
registered it.

So a published page names the organization and the deployment: "Acme
Corp (acme.com), deployment Research, on the organization's own
machines". The deployment's name is shown because the hosting words, and
what a reader should make of them, belong to a deployment, not to an
organization that may run several.

Inside the deployment nothing changes: the gate, the sends, who may send
and `outbound_sends` stay as [published-pages.md](published-pages.md)
describes.

## Who acted

- **On the public graph**, an act made through a deployment is the
  organization's. The contribution, the funding, the mandate are under
  the organization's account. Which deployment made it is in
  `deployment_requests`, which only the organization's members read.
- **In the deployment**, `outward_acts` keeps who pressed the button,
  holding what, as it does now ([outward-acts.md](outward-acts.md)).
- **Naming the person outside** is the organization's choice: a gate
  setting, off unless set, that adds the person's name to an act, as
  written on their account in the deployment. With it off, the public
  record says "Acme Corp" and nothing else.
- **On minerval.ai**, an admin's own acts for the organization (approving
  a deployment, buying owls, the acts in "Acting from minerval.ai") are on
  the organization's log under their own account. On the public record
  they are the organization's, as an act through a deployment is.

## A verified domain

An admin adds a domain. The organization's page shows a TXT record to put
at `_minerval.<domain>`: `minerval-organization=<token>`, the token made
for this organization and this domain.

- The public graph checks it when the admin presses "Check now", and once
  a day after that.
- While it checks out, the organization's pages and acts show the domain
  beside the name, with the date it was last confirmed.
- If a check fails, the domain stays shown for seven days, marked as
  unconfirmed since the date, and the admins are told. After seven days
  of failures it is no longer shown. The record of when it was verified
  stays.
- One organization holds a verified domain at a time. The record names
  one organization's token, so two cannot both match.
- A domain says the organization controls DNS for it, and nothing more.
  It is not a reason to believe anything the organization says, and no
  agent is told to weigh it.

## Billing

Everything an organization pays or is paid belongs to its account.

- **Owls** it buys on minerval.ai (Stripe, as for a person) go to its
  ledger. Only admins buy. Owls a deployment creates for itself
  ([accounts.md](accounts.md), "Owls a deployment creates for itself")
  never become public owls, as now.
- **Usage reports** are sent with `report_usage`. The receiving route
  records them against the organization and the deployment that signed
  them. The report's format is unchanged: it still says one day's total
  and nothing else ([usage-report.md](usage-report.md)). Its `deployment`
  field remains the identifier the deployment made for itself. The
  deployment gives that identifier when it connects, and the public graph
  ties it to the organization. A report whose `deployment` field differs
  from the signer's is refused. So is a connection that gives an
  identifier another organization holds. A deployment that reconnects
  (after losing its key, say) gives the same identifier, so its reports
  continue the same record. A file a member uploads is checked the same
  way.
- **Who may read the reports received.** Today no route reads a received
  report back. Admins of the organization should be able to see what
  Minerval has recorded against it, since that is what it will be billed
  on. That is a new route, `GET /organizations/:id/usage-reports`, for
  admins only, shown on the organization's Billing tab. It shows exactly
  what the deployment's own Budget page (`/admin/budget`) already shows
  the deployment's administrators, so nothing new leaves anyone.
- **Invoices** wait on a price per owl, which is not decided. When one
  is, it bills the organization from the latest revision of each day, as
  [usage-report.md](usage-report.md) says.

## Hosted by Minerval

A private deployment Minerval runs for an organization is the same
software at a different address. This design asks it to connect the same
way as one the organization runs, and says what is different.

**The same path.** A hosted deployment makes its own connection key,
connects with a code an organization admin approves, signs every request,
pulls the whole feed and sends its usage reports over the network. It
does not get a shortcut because Minerval is on both sides. Reasons:

- The public graph's code, its logs and its staff should learn no more
  about a hosted deployment than about any other. If the public graph
  read a hosted deployment's database to bill it, or answered its reads
  of the live graph, the hosted deployment would show what it is working
  on. Through the feed and the report it shows only that it exists, when
  it pulls, and one total a day.
- Minerval's provisioning service should hold no standing to act in an
  organization's name. With the same flow, the only thing that ever
  grants a deployment anything is an organization admin's approval.
- One code path is tested by every deployment, hosted or not.

**What does differ.**

- **Who holds the machine.** Minerval does. Minerval can, in principle,
  reach the connection key and the publishing key, and everything else in
  the deployment. The design does not hide that. The hosting words
  `minerval` ("Minerval's machines") are in every package and on the
  deployment's record, and the approving admin sees them.
- **Hosting is checked, not badged.** The public graph knows which
  deployments Minerval provisioned. It refuses the hosting word
  `minerval` from a deployment Minerval did not provision, and refuses
  any other word from one it did. That holds at connection and at
  publisher registration. The words shown stay the same three, with
  nothing like "confirmed by Minerval" added. A badge would make a
  hosted deployment look more trustworthy than one on the organization's
  own machines, and being hosted by Minerval earns no standing ("What is
  wrong today", last paragraph). The attestation field in a package keeps
  saying that nothing outside the publisher's control attests to the run.
- **Signing in.** A self-hosted deployment brings its own OpenID Connect
  provider ([accounts.md](accounts.md), "Single sign-on and groups"). Many
  organizations that want Minerval to host for them will not have one.
  minerval.ai becomes an OpenID Connect provider for organizations: a
  deployment can set `AUTH_OIDC_ISSUER` to minerval.ai, and its members
  sign in with their minerval.ai accounts. The ID token carries the
  organization's id, and a `groups` claim with the person's role
  (`admin` or `member`). The deployment needs no code for this, since it
  already speaks OpenID Connect. Only members of the organization the
  client was registered for can sign in.
  - A role on minerval.ai grants nothing inside the deployment. The
    deployment's administrators grant permissions as now, and can grant
    to the `admin` or `member` group.
  - It is available to a self-hosted deployment too, as a choice. That
    deployment then trusts Minerval to say who its members are, and the
    setup checklist says so.
- **The first administrator.** Provisioning sets `FIRST_ADMINISTRATOR` to
  the identity, under minerval.ai's provider, of the organization admin
  who asked for the deployment. They land on the setup checklist, where
  "Connect to minerval.ai" is the first step. Since they are already
  signed in to minerval.ai, approving takes one click.
- **Billing** is on the organization's account for both the hosting and
  the metered price. The metered price is billed from the usage reports
  the deployment sends, as for any deployment, not from Minerval reading
  its database.
- **Leaving.** A hosted organization's connection stays with the
  organization if it moves to its own machines. It approves the new
  deployment, withdraws the hosted one, and its record continues, apart
  from each page's chain, which goes with the publishing key
  ("The deployment's own key", above).

Provisioning a hosted deployment (machines, databases, who at Minerval
may reach them) is its own piece of work and is not part of this design.
This design says only how such a deployment identifies itself and acts.

A deployment a third party hosts for the organization (`third_party`) is,
from the public graph's side, the same as one on the organization's own
machines: the hosting is the deployment's statement.

## What changes inside a deployment

The connection fits the workspace #1133 drew and adds no page of its
own. The mirror gets one ("The mirror", below).

- **Public graph → Overview** (`/admin/outside`). Its account card shows
  the connection: connected or not, the organization (with its domain
  once verified), the grants held, the allowance and what is left of it.
  Administrators get Connect, Replace the connection key and Disconnect
  there, each in a drawer, from a session. The card reads all of this
  from `GET /organizations/me` over the connection, in place of
  `GET /users/me` under a key.
- **The signing key's registration becomes readable.** #1133 left a gap:
  Overview cannot read whether the publishing key is registered, so it
  infers that from the act log. `GET /organizations/me` lists the
  deployment's live publisher registrations, and Overview shows those
  instead.
- **Health** (`/admin`). Today each row that needs attention names who
  fixes it: the operator (`OWNER_WORDS` in `web/lib/health.ts`) or an
  administrator. A third owner joins them: "Organization", meaning an
  admin of the organization on minerval.ai. A missing grant or a
  withdrawn deployment belongs to that owner, and the row says what to
  ask them for. The public-graph area's rows link to Overview.
- **Sidebar.** Overview's entry gets a signal (`public_graph` in
  `WorkSignal`). A dot shows when the deployment is not connected, has
  been withdrawn, or lacks a grant its settings need. Like the other
  counts, it is read after the page draws (`/api/work/counts`).
- **Inbox.** The Public graph group gains items for administrators: a
  connection waiting for approval, with its code and link; a grant
  withdrawn or the deployment retired; an allowance spent.
- **Budget** (`/admin/budget`). The usage-report section names the
  organization it is billed to, and shows the deployment's allowance
  beside the public owls.
- **Outbox** and the act list on Overview are unchanged. Connecting,
  replacing the key and disconnecting are outward acts, listed there with
  who did them.

Under the pages:

- One client, `src/services/public-graph-client.ts`, signs every request
  to the public graph. The mirror applier, the usage-report sender, the
  outbound sender and the outward acts all call it, in place of the
  `x-api-key` header each builds today.
- `MIRROR_FEED_URL`, `PUBLIC_GRAPH_API_URL` and `USAGE_REPORT_URL` all
  name the same server today. The connection keeps one address, set in
  the Connect drawer. The three settings stay as overrides for a
  deployment whose operator wants them fixed, and the preflight says when
  one differs from the connection's.
- The preflight's checks on the three keys become checks on the
  connection: connected or not, and whether each grant the deployment's
  settings need is held (for instance, `read_feed` where a feed is
  followed).
- Every place that tells an operator to "check PUBLIC_GRAPH_API_KEY"
  instead says what the public graph answered and who can fix it: an
  admin of the organization, on minerval.ai.

## The mirror

Following the public graph ([mirror.md](mirror.md)) is set up today with
three settings and run with `scripts/mirror.ts`. With a connection it is
set up and kept in the app. The settings stay as the operator's
overrides, and the page says when one is in force.

**A page: Public graph → Mirror** (`/admin/outside/mirror`), in the
sidebar's Public graph section with a signal of its own: a dot when the
mirror has stopped at a refusal, or a new feed key waits to be accepted.
Every member reads it (it is `GET /mirror/status` and the applied
batches). Administrators act on it, from a session.

**Setting up.** Before following starts, the page checks and shows:

1. The deployment is connected and holds `read_feed`.
2. The feed's key is confirmed (below).
3. The feed's vectors come from this deployment's embedding model, and
   the mirrored tables have the shape this release writes. Either
   mismatch would refuse every batch, so it is said before anything is
   pulled.

Then an administrator chooses how batches arrive (over the network, or
as files) and presses Start following. The page states what the first
snapshot costs, as [mirror.md](mirror.md) measures it, and what pulling
the whole feed shows minerval.ai: that the deployment exists and when it
pulls. While the snapshot applies, the page shows batches applied out of
the snapshot's, and that the mirror is partial (`complete: false`).

**The feed's key.** The deployment reads the key from
`GET /mirror/feed/key` when it connects. That is no weaker than today,
where an operator copies the same answer into `MIRROR_FEED_PUBLIC_KEYS`.
An administrator then confirms it once, against the key Minerval
publishes in its docs, outside the deployment. No batch applies until
the key is confirmed. The key a batch carries is still never trusted.

**When the feed's key changes.** `GET /mirror/feed/key` answers one key
today; it gains the list of keys the feed signs with, the current one
first, so that a publisher can add a key before it signs with it. When
a new one appears, the page offers it beside the one
accepted, and an administrator accepts it after the same comparison.
The old key stays accepted until it is removed, so nothing stops during
the change. Until the new key is accepted, a batch signed only with it
is refused (`unknown_key`), and the refusal points to the offer.

**Keeping it.** The page shows how far behind the public graph the
mirror is, the newest batch, the next check, and the batches with their
notes. The notes that touch the deployment's own work come first, in
words: a public claim retracted and kept here as deprecated because
local judgments hang off it, or a merge that left a local edge on the
absorbed claim. A refusal is shown with who fixes it, using Health's
owners: the operator for `schema_newer` (upgrade) and `row_refused`
(which row, read with `scripts/mirror.ts status`), an administrator for
`unknown_key`. A refusal that names a row of the deployment's own keeps
the guarded wording [mirror.md](mirror.md) gives it. Health and the
Inbox carry the same rows.

**Start, pause, check now.** `POST /mirror/follow`, `POST /mirror/pause`
and `POST /mirror/check`, for holders of `administer` from a session,
each on the activity log. They are not MCP tools: each is an
administrator's choice about what the deployment pulls, made as Connect
is. `get_mirror_status` stays a tool.

**From files.** A deployment the network does not join follows from
`MIRROR_FEED_DIR`. The page lists the files there and what became of
each, and the next batch it needs. A member of the organization
downloads batches on minerval.ai, from the deployment's row on the
Deployments tab: every batch after one the member names, never a
choice among nodes, so the download shows no more than a pull over the
network does. It is on the organization's log as a pull of that range.
The files are checked exactly as fetched ones are.

## Phases

Each phase is one pull request or a few, and leaves things working.

1. **Organizations** (built). `contributors.kind`, `organization_members`,
   `organization_log`, making an organization, invitations, admins, the
   last-admin rule and its operator route, the organization's page and its
   public contributor page, the organization's pages drawn with the
   workspace kit, buying owls as the organization, acting from
   minerval.ai, and converting a shared account. No deployment changes
   yet.
2. **Connected deployments.** `deployments`, `deployment_grants`,
   `deployment_requests`, `deployment_request_nonces`, the signed-request
   method in the auth plugin, `deployment-grants.ts` and its test, the
   connect flow on both sides, the connection on Overview with its Health
   rows, sidebar signal and Inbox items, the signing client, and the
   mirror applier, usage reports, outbound and outward acts moved onto
   it. The Mirror page, with the feed key confirmed in the app, and
   start, pause and check now. Bearer keys still work beside it: a deployment that has a
   connection uses it, and one that does not falls back to the keys in
   `.env`.
3. **Control.** Withdrawing grants and retiring deployments from
   minerval.ai, replacing the connection key, the owl allowance, connecting
   by hand, submitting carried-out page packages and uploading usage
   reports, feed files to download, accepting a new feed key, publishing
   through the connection
   (`publishers.deployment_id`), and the check on hosting words.
4. **Domains.** Verification, the daily check, and showing the domain.
5. **Billing on the organization.** The report identifier tied to the
   organization, reports refused when it does not match, the admins' read of reports received, and
   the organization's billing page.
6. **minerval.ai as an OpenID Connect provider** for organizations, which
   a hosted deployment needs and a self-hosted one may use. Naming the
   person who acted, as a gate setting.
7. **Bearer keys go.** `MIRROR_FEED_API_KEY`, `PUBLIC_GRAPH_API_KEY` and
   `USAGE_REPORT_API_KEY` are removed from `config.ts`, `config-file.ts`,
   `env.example`, the preflight and the docs. Old keys on converted
   organization accounts are revoked, after each organization's page has
   shown, from phase 1 on, which of them are still used.

Each phase also does what CLAUDE.md asks of a new route: its MCP side in
`src/mcp/route-tools.ts`, its label in `src/server/request-labels.ts`, a
classification in `src/llm/tools/assistant-tools.ts` for any tool that
writes, the page table in `plugin/skills/using-minerval/SKILL.md` for new
pages, and the caller skills where a tool's behaviour changes.

MCP: reading one's organizations, their deployments and grants are tools.
Approving a deployment, granting, withdrawing, adding members, making
admins and acting from minerval.ai are excluded, with this reason: each decides who speaks for an
organization, so it is a person's act in their own session, as
registering a publisher is today. The connect, rotate and disconnect
routes inside a deployment are excluded for the same reason. The routes
a deployment signs are not tools: an agent has no deployment key of its
own.

## Decisions

The review raised four questions, answered here.

- **Acting as the organization without a deployment: yes, for spending,
  by admins in a session.** An organization that funds public work and
  runs no deployment is a real case, and making it run one to spend its
  own owls would be absurd. What is allowed is narrow: the acts that
  spend money, from an admin's session, logged under the admin's name.
  Contributing and publishing stay with deployments, so there is still
  one way to do each kind of work ("Acting from minerval.ai").
- **The allowance has no period.** It is a sum the admin sets and adds
  to. A sum that only goes down when spent is one figure an agent can be
  told and can act on. A monthly reset is a second fact to state, and it
  lets a deployment nobody is watching spend again every month with
  nobody deciding to let it. It is also how budgets already work here:
  a mandate's escrow and a budget job are sums that someone funds
  ([allocation.md](allocation.md)).
- **No "confirmed by Minerval" on hosted deployments. The hosting words
  are checked instead.** The public graph refuses a false `minerval`, and
  a Minerval-provisioned deployment cannot claim another word. So every
  record says where a deployment runs, and none says it to Minerval's
  credit ("Hosted by Minerval").
- **The usage-report identifier stays the deployment's own, in format
  1.** A report's text is fixed when it is prepared, and a deployment
  prepares reports before it connects and sends them later, oldest first.
  A format that carried the public graph's id could not be prepared before
  connecting, and would change when a deployment reconnects. The
  deployment's own identifier is tied to the organization when it
  connects, and checked on every report ("Billing").
