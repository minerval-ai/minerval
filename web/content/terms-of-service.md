<!--
Draft for counsel review. Not yet in force: no effective date is set, the
page is reachable by URL but not linked from the site footer, and nothing on
the site yet asks a user to accept these terms. Every product fact below was
checked against the repository at drafting time; the file that verifies each
load-bearing fact is named in parentheses. Points counsel should settle
before launch:

- Entity and addresses. Minerval, Inc. is a [STATE] corporation with its
  principal place of business at [ADDRESS]; the postal address for notices
  and for the DMCA designated agent is a placeholder (Sections 1.1, 12.6,
  23.7, 24). The about page names the founder and New York
  (web/app/about/page.tsx); nothing in the repository states the state of
  incorporation.
- Section 21 (disputes) is the founder's decision, drafted as a recommended
  default: informal resolution first, then binding individual arbitration
  with a class-action waiver, a thirty-day opt-out, a small-claims
  carve-out, and Minerval paying arbitration fees above a court filing fee
  for claims of USD 10,000 or less. The provider (AAA or JAMS), the seat, and
  the court venue are bracketed. EU and UK consumers keep their local forum
  and mandatory law (21.1, 21.7). The alternative is exclusive jurisdiction
  of the courts of [STATE] with no arbitration; both are defensible, and the
  choice changes the economics of any dispute.
- Section 2 minimum ages: 13 to hold an account (sign-in is GitHub or Google
  OAuth only, web/auth.ts; both providers admit users from 13; matches
  Contributor Terms Section 1), a parent or guardian's agreement under 18,
  and 18 to buy owls, fund work, or receive Rewards (matches Contributor
  Rewards Policy Section 9). The EU digital-consent age varies from 13 to 16
  by member state; decide whether to apply 16 in the EU or rely on guardian
  consent.
- Section 6 (owls) is the prepaid-credit question. What the code and copy
  promise today: the Stripe product description says "No expiry"
  (src/services/stripe-service.ts) and the purchase button says "owls never
  expire" (web/app/account/BuyOwls.tsx); owls are "strictly one-way, never
  redeemable for cash" (docs/accounts.md, docs/allocation.md,
  src/services/owl.ts); a purchase credits the pack's face value in owls,
  not the discounted cash paid (src/routes/billing.ts); Stripe refunds are
  issued by hand in the Stripe dashboard and there is no charge.refunded
  handler, so a cash refund is not reflected on the ledger automatically
  (docs/accounts.md "Buying owls"); no account-deletion job exists yet
  (docs/accounts.md "Deletion", #356). The terms therefore promise no expiry
  while the account exists (6.6), no cash redemption (6.5), discretionary
  refunds (6.7), forfeiture of the balance on deletion and on termination
  for breach, and a cash refund of unspent purchased owls only if Minerval
  terminates without breach or closes the Services (6.8). Section 6.1 takes
  the position that pack revenue is earned when paid and a balance is a
  record of credits, not funds held for the user. Review all of this against
  state gift-card and prepaid-credit statutes (expiry and dormancy limits),
  unclaimed-property law where a balance could be treated as abandoned
  property, and the money-transmission analysis that docs/rewards.md relies
  on (owls never convert to money). Legacy balances were revalued at the
  credits-to-owls cutover (src/db/migrations/0039_money_reconciliation.sql;
  Section 6.9).
- EU and UK withdrawal rights (6.7): the terms state the express request
  and acknowledgment that ends the fourteen-day right for digital content
  and prepaid credit once owls are credited, but Stripe Checkout is created
  with no consent capture (src/services/stripe-service.ts sets no
  consent_collection or custom_text), so the acknowledgment must be added to
  the checkout flow or the purchase button before purchases open to EU and
  UK consumers. The same session sets no automatic_tax, so Section 6.3's
  tax sentence describes an intention, not the flow as built.
- Section 14.2 conflicts with the live Privacy Policy, which says a deleted
  account's "associated records" are removed (web/app/privacy/page.tsx,
  "Retention & deletion"). Contributions are public, permanent, and CC0
  (Contributor Terms Section 7; docs/accounts.md "Deletion"): deletion
  detaches identity and pseudonymizes credit rather than removing content.
  The privacy page needs that sentence changed before either document takes
  effect, and the GDPR basis for keeping published contributions written
  down. This draft does not edit the privacy page. A second conflict on the
  same page: it says Minerval stores "your display name, and nothing else
  from your provider profile", while sign-in also stores the email address
  and avatar URL the provider sends (web/auth.ts, provisionUser in
  src/services/contributor-service.ts) and the account page displays the
  email. Section 4.1 describes the code.
- Section 230 (12.5): the terms take the hosting position for contributor
  text in the Contribution Record. Graph Voice is written by Minerval's own
  agents, which rewrite accepted contributions and assess claims on the
  merits (admin_constitution.md Section 12; docs/architecture.md
  "Assessment"), so it is plausibly Minerval's own speech and the terms do
  not rely on Section 230 for it. Sections 10, 17, and 18 are the defense
  for Graph Voice; the defamation and accuracy exposure of the graph as a
  whole belongs on the same desk.
- Whether the MCP server and the Claude Code plugin need separate terms
  (Section 13). Both act on the user's account under an API key or an OAuth
  grant (docs/mcp.md; src/server/plugins/auth.ts) and are covered here as
  Services; the plugin's opt-in hook spends metered calls automatically
  (plugin/README.md). Confirm this is enough, and that the Chrome Web Store
  developer agreement and Anthropic's plugin terms do not require more.
- Liability cap (18.2): the greater of what the user paid Minerval in the
  twelve months before the event and USD 100. The Contributor Terms cap at
  USD 100 and the Rewards Policy caps at the Reward; confirm the three
  cohere.
- Consumer carve-outs (17.5, 18.4, 19): drafted generically for the EU, the
  UK, and Australia. Confirm which non-excludable guarantees apply to a free
  service with prepaid credits, and whether the Australian Consumer Law
  wording is needed at all.
- Facts not verifiable in the repository: whether Stripe is live in
  production (billing is enabled only when STRIPE_SECRET_KEY looks real,
  src/services/billing-service.ts); whether legal@, privacy@, copyright@,
  and rewards@minerval.ai exist (docs/infrastructure.md describes setting up
  Google Workspace with one seat); whether the contribution award is
  switched on (its default rate is 0 in src/config.ts, "OFF at launch",
  while docs/accounts.md gives 0.25 and the account page describes it as
  live; Section 6.2(d) says the rate may be zero).
- Inconsistencies found while drafting, for the product side rather than
  for counsel: the extension README, popup, store listing, plugin README,
  and docs/mcp.md still describe a "monthly allowance" or "monthly free-tier
  grant" and a 402 QUOTA_EXCEEDED code, while the code emits
  INSUFFICIENT_OWLS with the balance and cap list
  (src/server/plugins/quota.ts) and FREE_TIER_MONTHLY_USD no longer exists
  in src/config.ts; the owl-pack defaults in docs/accounts.md
  (5:2000,15:5500,40:14000,125:40000) differ from src/config.ts
  (5:2000:Clutch,25:9000:Perch,100:30000:Wisdom,500:100000:Parliament); the
  privacy page says keys are stored as "salted hashes" while the code stores
  an unsalted SHA-256 hash of a high-entropy key
  (src/services/api-key-service.ts); the sign-in page still calls the
  extension "coming" (web/app/signin/page.tsx). None affects these terms,
  which describe the code.
-->

# Terms of Service

*Minerval, Inc.* · Not yet in force · Effective date: to be set

**In short.** Minerval publishes a public graph of claims, assessed by
large-language-model agents under a public constitution, and dedicates the
graph's content to the public domain. Reading it is free and needs no
account. An account lets you buy and spend owls, which are prepaid credits
for metered work; contribute to the graph; connect the browser extension
and the MCP server; and fund assessments and mandates. Owls are not money:
they never convert to cash, rewards, or anything else. Money buys
scheduling and coverage, never conclusions. Everything the graph says is a
judgment that can be wrong and is open to challenge, and none of it is
advice. These terms say what you can expect from Minerval, what Minerval
expects from you, and what happens when something goes wrong.

## 1. Agreement and scope

1.1 **Who we are.** Minerval, Inc. ("Minerval", "we") is a [STATE]
corporation with its principal place of business at [ADDRESS]. Minerval
operates the claim graph at minerval.ai and the services described in
Section 3.

1.2 **What these terms cover.** These terms govern your use of the
Services described in Section 3 and everything you hold or do through them:
Accounts, Keys, Owls, orders, allocations, budget jobs, Mandates, and
grants.

1.3 **Acceptance.** You accept these terms by creating an account, minting
an API key, connecting an application through the MCP server, buying or
spending owls, submitting a Contribution or Source Submission, or otherwise
using a Service that requires an account. If you use only the free,
unauthenticated parts of the Services, the parts of these terms that can
apply without an account, including Sections 10, 11, 12, 17, 18, and 21,
apply to that use.

1.4 **The documents that form the agreement.** These terms incorporate the
documents below. Each governs its own subject, and where two of them
conflict, the more specific one controls as the table says.

| Document | Governs | Where it controls |
|---|---|---|
| These Terms of Service | The Services, accounts, keys, owls, paid work, and everything not covered below | Everything else |
| Contributor Terms | Contributions and Source Submissions: the CC0 dedication, your promises, publication, permanence, and takedown | Any conflict about a Contribution |
| Contributor Rewards Policy | Offers and Rewards paid by Minerval for accepted work | Any conflict about a Reward |
| Privacy Policy | Personal data: what is collected, who processes it, and how long it is kept | Any conflict about personal data |

The Administrator Constitution and the operational policies published on
this site govern Minerval's agents. They describe how the Graph is run; they
are not promises to you, and they may change as the Graph does.

1.5 **Defined terms.** Contribution, Source Submission, the Graph, Graph
Voice, Contribution Record, Automated Systems, and CC0 have the meanings
given in the Contributor Terms; Offer, Reward, Payout Provider, and Funder
have the meanings given in the Contributor Rewards Policy. In these terms,
an **Account** is the single identity Minerval keeps for you across every
Service; a **Key** is an API key minted from your Account; an **Owl** is
the prepaid service credit described in Section 6; a **Mandate** is a
funded program of work on the Graph stewarded by a Grantmaker agent, as
Section 7 describes; and the **Constitution** is the Administrator
Constitution published at minerval.ai/docs/constitution.

## 2. Who may use the Services

2.1 **Age.** You must be at least 13 years old to hold an Account. If you
are under 18, you may hold an Account only if a parent or guardian has read
these terms and agrees to them on your behalf, and you may not buy Owls,
fund any work under Section 7, or receive a Reward. Buying Owls, funding
work, and receiving Rewards require that you are at least 18 and able to
enter a binding contract where you live.

2.2 **Organizations.** If you use the Services for an organization, you
represent that you are authorized to bind it, and "you" includes it. Each
person who uses the Services still needs their own Account.

2.3 **Restrictions.** You may not use the Services if you are barred from
doing so under Section 20, or if Minerval has terminated an Account of
yours for breach and has not agreed in writing to your return.

## 3. The Services

3.1 **The website.** minerval.ai publishes every claim in the Graph with its
canonical form, decomposition, arguments, assessment history, provenance,
and Contribution Record, together with public mandate dashboards and
contributor profiles. Browsing needs no account.

3.2 **The public API.** api.claimgraph.io serves the same Graph over HTTP,
with interactive documentation at /docs on that host. Reads are public,
unauthenticated, and free. Anything that writes to the Graph or spends
model work requires a Key or a signed-in session, as Section 3.7 sets out.

3.3 **The browser extension.** The Minerval extension for Chromium browsers
reads the page you have open, underlines the claims on it by what the Graph
knows, and answers questions about the page in a chat grounded in the
Graph, under a Key you paste into its settings (Section 13).

3.4 **The MCP server.** A remote Model Context Protocol server on the API
host lets AI clients search and read the Graph, run the pipeline's
judgments over text, and submit Contributions on your behalf, under a Key
or an OAuth 2.1 grant you approve on minerval.ai (Section 13).

3.5 **The plugin.** The minerval-ai/minerval repository doubles as a plugin
marketplace for Claude Code and Cowork. The plugin connects the MCP server
and adds slash commands, a fact-checker subagent, a skill, and an opt-in
hook; it is packaging over the MCP server and is governed as one.

3.6 **Exports and citations.** Any claim can be exported as a
nanopublication in TriG or JSON-LD and cited by a persistent w3id.org URL
that resolves to its page. Every export records the CC0 dedication in its
publication-info graph.

3.7 **What needs what.** As of the effective date the Services divide as
follows. Current caps and grants are shown on your account page and in the
API's entitlement responses, which control if they differ from this table.

| Use | Needs | Cost |
|---|---|---|
| Reading, searching, browsing, exports, citations, mandate dashboards | Nothing | Free, unmetered |
| Submitting a Contribution or an appeal | An Account, with a Key or a session | Free for sincere contribution; standing and rate limits apply (Section 8) |
| Proposing a claim, submitting a source, ordering an assessment | An Account, with a Key or a session | Up to the published cap in Owls, settled to metered cost (Section 6.4); a rejected proposal refunds |
| Extension page analysis and chat; MCP text tools | An Account, with a Key or an OAuth grant | Up to the published cap in Owls, settled to metered cost |
| Allocating Owls to a claim; funding a budget job; funding or contributing to a Mandate | An Account, with a Key or a session | The Owls you commit, escrowed and refunded as unspent (Section 7) |
| Talking to the Grantmaker about a Mandate | An Account | Free and rate-limited; nothing is charged until you fund a draft |
| Minting or revoking Keys; buying Owls; approving an OAuth grant | A signed-in session on minerval.ai | Free (buying Owls costs the pack price) |

3.8 **Changes to the Services.** Minerval may change, suspend, or withdraw
any Service or feature at any time, including the extension, the MCP
server, the plugin, purchase packs, caps, grants, and the free tier. Where a
change removes something you have paid for, Section 6.8 applies. Minerval
has no obligation to keep any Service available, to keep any client
compatible, or to keep any claim in the Graph.

## 4. Accounts

4.1 **Sign-in.** You sign in with GitHub or Google. Minerval never sees or
stores a password. On first sign-in it provisions an Account keyed to the
provider and account identifier (for example `github:12345`) and stores the
display name, email address, and avatar your provider sends, as the Privacy
Policy describes. Your display name is public: it appears on your
contributor profile and in every Contribution Record that credits you.

4.2 **One account per person.** One Account serves every role: reading with
a Key, spending Owls, contributing, funding. You may hold only one Account,
controlled by you. Additional or shared Accounts, and Accounts operated for
an undisclosed person or organization, are bad faith under Section 8 and
grounds for termination under Section 16.

4.3 **Security.** You are responsible for what happens under your Account,
including everything done with your Keys and through applications you have
connected. Keep your sign-in provider secure, revoke Keys you no longer
use, and tell legal@minerval.ai promptly if you believe your Account has
been compromised.

4.4 **Dashboard-session trust.** Minting and revoking Keys, buying Owls, and
approving an application's OAuth access can only be done from a signed-in
session on minerval.ai, never with a Key. A leaked Key can spend your Owls
and act as you on the API; it cannot mint further Keys, revoke others, or
start a payment.

## 5. API keys and access tokens

5.1 **Keys.** You may mint Keys from your account page, one per surface if
you like, so each can be revoked on its own. The full Key is shown to you
exactly once, at creation, and Minerval stores only a hash of it. If you
lose a Key, revoke it and mint another; Minerval cannot recover it.

5.2 **What a Key does, and whose use it is.** A Key authenticates requests
as you: it can read the Graph, spend Owls up to your balance, submit
Contributions and appeals in your name, and fund work, and every request
and model call under it is attributed and metered to your Account. All use
of a Key is your use, whether or not you authorized it, until you revoke
it. Owls spent under a Key are spent; Minerval may, but need not, reverse
charges it judges to have resulted from a compromise you reported promptly.

5.3 **No sharing or resale.** You may not share a Key with anyone else,
embed a Key in software distributed to others, sell or rent access to the
Services under your Account, or use a Key to let others avoid their own
Accounts, standing, rate limits, or Owl balance. Applications you build for
your own use, and agents acting for you, may use your Key.

5.4 **Revocation.** You may revoke any Key at any time from your account
page. Revocation takes effect at once for new requests; work already
started under the Key finishes and is metered, and revoked Keys keep their
usage history. Minerval may revoke or rotate a Key without notice where it
reasonably believes the Key is compromised or being used in breach of these
terms.

5.5 **OAuth grants.** When you approve an application on the consent page,
Minerval issues it access tokens bound to the MCP surface only; they cannot
be used against the rest of the API. Access tokens last one hour and refresh
tokens thirty days, and a replayed refresh token revokes the whole grant.
The consent page says what the application will be able to do: search and
read the Graph, run analyses that spend Owls from your balance, and submit
Contributions in your name. Its access lasts until you disconnect it in
that application, and what it does under your grant is your use under
Section 5.2.

5.6 **Rate limits.** Metered endpoints carry a per-caller hourly limit, and
contribution and grant-conversation endpoints carry their own. They are a
backstop against runaway clients, not an entitlement; Minerval may change
them at any time and may throttle or block traffic that degrades the
Services for others.

## 6. Owls

6.1 **What an Owl is.** The Owl is Minerval's unit of account: a prepaid
service credit that can be spent only on the Services. Cost is measured in
dollars, and one Owl of spend covers one dollar of metered cost, whatever
the Owl sold for. An Owl is not money, currency, a deposit, a stored-value
instrument redeemable for cash, a security, or property with value outside
the Services. Minerval holds no funds on your behalf: the price you pay for
a pack is Minerval's revenue when paid, and your balance is a record of
credits, not a claim on money.

6.2 **How you get Owls.** Owls reach your balance four ways, each recorded
as a line on your ledger:

- (a) **Purchase**, in fixed packs through Stripe Checkout (Section 6.3).
- (b) **Signup grant**, a one-time credit to new Accounts.
- (c) **Monthly grant**, a small credit once per calendar month, landing
  the first time your balance is read that month.
- (d) **Contribution award**, a credit for an accepted Contribution, scaled
  by the importance of the claim it improves, with a bonus for acceptances
  that survive appeal. The award rate is published on your account page and
  may be zero.

Grants and awards are discretionary. Minerval may change their size, pause
them, or end them at any time, prospectively. An award is clawed back if the
acceptance it rewarded is later overturned or superseded, and a clawback can
leave a balance negative until the next credit.

6.3 **Buying Owls.** Purchase packs, their prices, and their bulk discounts
are listed on your account page and at GET /billing/packs; a larger pack
buys the same Owls for less cash, and every Owl credited covers the same
one dollar of metered cost. Payment is taken by Stripe on a Stripe-hosted
page under Stripe's own terms, with receipts on Stripe's surfaces, and your
Owls are credited when Stripe confirms payment, never before. Purchases are
available only where and while Minerval enables them; the free grants apply
either way. Prices are in United States dollars. Where the law requires
Minerval to collect a tax on a purchase it is shown at checkout; any other
tax on a purchase is yours.

6.4 **Caps, not prices.** Nothing on the Services has a fixed price. Every
metered operation carries a published cap, the most it may cost you, set
near its usual cost. The cap is charged to your balance when the work
starts, the actual cost is metered as the work runs, and the unused part
returns to your balance when it finishes. A run that costs more than its cap
is absorbed by Minerval, never charged to you. A run that fails after the
charge refunds the cap, and so does an operation that did no model work,
such as a page analysis served from cache. As of the effective date:

| Operation | Cap |
|---|---|
| Propose a claim (reviewed, then assessed) | 1 Owl |
| Order a claim assessment | 1 Owl |
| Submit a source for extraction | 0.1 Owl |
| Extension page analysis | 0.1 Owl |
| Extension chat exchange | 0.1 Owl |
| MCP text tools (match, extract, assess) | 0.1 Owl |

Open-ended work, including deep decomposition and Mandates, is not capped
per run; it is funded with an escrowed budget and metered against it
(Section 7).

6.5 **Strictly one-way.** Owls are bought or earned, then spent. They are
never redeemable for cash, never transferable to another Account, never
convertible to a Reward or to any payment from Minerval, and never sold or
assigned to anyone else. Minerval pays no interest on a balance. A
contribution award is a service credit and not part of any Reward; a Reward
is money and never becomes Owls. Any attempt to sell, trade, or transfer
Owls is void and is grounds for termination.

6.6 **Expiry.** Owls do not expire while your Account exists, and Minerval
charges no dormancy or inactivity fee. Minerval does not close Accounts for
inactivity. If Minerval ever introduces an expiry, it will apply only to
Owls credited after the change and only with at least ninety days' notice.

6.7 **Refunds.** Owl purchases are final, except as this Section and the law
provide. Owls returned to your balance after a run, a failure, a rejected
proposal, a cancelled order, or unspent escrow are returns of credit, not
cash refunds. Minerval may, at its discretion, refund a purchase in cash
through Stripe, for example where a pack was bought by mistake and none of
its Owls has been spent; ask legal@minerval.ai within fourteen days of the
purchase. A cash refund removes the refunded Owls from your balance. If you
are a consumer in the European Union or the United Kingdom, you have a
right to withdraw from a purchase of digital content or prepaid credit
within fourteen days unless you asked for immediate delivery and
acknowledged that the right is lost once delivery begins. By buying Owls you
ask Minerval to credit them to your balance immediately and acknowledge that
your right of withdrawal ends when they are credited. Any consumer right
that cannot be waived is unaffected.

6.8 **Your balance when your Account ends.** If you delete your Account, or
Minerval terminates it for breach under Section 16, any remaining Owls,
purchased, granted, or earned, are forfeited and have no cash value. Spend
them first if you intend to leave. If Minerval terminates your Account for a
reason other than breach, or closes the Services, it will refund the cash
you paid for purchased Owls that remain unspent, treating granted and earned
Owls as spent before purchased ones, and will give at least thirty days'
notice before closing the Services.

6.9 **Legacy balances.** Accounts created before the Owl ledger held credits
under an earlier model. At the cutover, usage consumed before it was
forgiven and any surviving balance was carried over at its face value in
Owls. Minerval may revisit that treatment for accounts with material legacy
balances, and will tell affected users before it does.

6.10 **Errors and adjustments.** Minerval may correct a balance where a
credit or charge resulted from error, malfunction, a duplicate delivery,
fraud, a reversed payment, or a chargeback, and records every correction as
an adjustment line on your ledger. A chargeback on a purchase removes the
purchased Owls and may suspend your Account until it is resolved.

## 7. Paid work on the Graph

7.1 **What money buys.** Money on the Services buys scheduling and
coverage: it makes an assessment happen sooner, reaches deeper into a
subtree, or brings a source in. It never buys a claim's importance, its
verdict, the standards applied to it, or its membership in the Graph. A
funded assessment runs under the same public standards as an unfunded one,
a funder never sees or shapes a verdict before anyone else, and money
appears nowhere in the estimates that order the Graph's work. Every cap,
estimate, budget, and spend is inspectable on the site.

7.2 **Assessment orders.** Ordering an assessment of a claim is a purchase,
not a request: it fully funds the action, and the action runs as soon as a
worker is free, using the best model Minerval has configured for
assessment. The order is created uncharged; the cap is charged the moment
the run begins and settles to metered cost at completion. While an order is
pending you may cancel it free. A genuine failure refunds the charge
automatically; a transient failure retries without charging again. You may
hold one open order per claim at a time.

7.3 **Allocations toward a claim.** You may put Owls toward a claim's next
assessment without buying it outright. Allocations accumulate across
funders, people and Mandates alike; the assessment runs when they cover the
expected cost of the cheapest way of doing it, and each funder pays a
pro-rata share of the metered actual. Your allocation is unpinned: it funds
the assessment, not a choice of model, and counts toward whichever variant
wins. An allocation not yet consumed is returned if the action is released
or superseded. Minerval does not promise when, or whether, a partially
funded assessment will run.

7.4 **Budget jobs.** Funding deep decomposition of a claim's subtree escrows
the budget you name at once and meters real model work against it. At the
budget floor the job pauses with a checkpoint and waits for a top-up; it
does not silently stop. Completion, cancellation, or failure refunds the
unspent remainder to your balance. Only you can top up your own job;
Mandates are the public case.

7.5 **Mandates.** A Mandate is designed in conversation with the Grantmaker
agent, which surveys the scope, quotes expected costs from live estimates,
pushes back where its judgment differs, and drafts a plan. Talking is free
and rate-limited; nothing runs or is charged until you fund the draft, which
escrows the budget and starts the Mandate. Thereafter:

- (a) **The Grantmaker may refuse money.** It works for the integrity of the
  Graph. It declines, at any budget, a Mandate that seeks to steer
  conclusions, purchase an outcome, promote an ideology, or otherwise warp
  the Graph, and it may refuse or close a Mandate for the same reasons after
  funding. Refusal is not a breach of these terms, and unspent budget
  returns to you.
- (b) **Mandates are public.** Every Mandate has a public dashboard showing
  its budget, spend, contributors, plan, progress, and the assessments it
  funded, and, where it ingests, each source it brought in. Anyone may put
  their own Owls behind any active Mandate. You have no right to keep a
  Mandate private.
- (c) **No naming rights.** The Grantmaker titles the Mandate for your
  dashboard. Your wording never reaches a claim page. A funded assessment
  discloses on the claim page only that it was paid for by a funded
  mandate, with the explanation that funding buys scheduling and nothing
  else.
- (d) **Self-stewardship.** A live Mandate is stewarded by its Grantmaker
  without a person in the loop: it reviews on a cadence, values the open
  ledger, extends its own plan, sets its own pace, moves money, and may
  complete the Mandate when its judgment says the mission is done, each
  pass metered to the Mandate's escrow under a cap. You may keep talking to
  the Grantmaker on the Mandate's page; the one change it makes at your
  request is to the unexecuted remainder of the plan.
- (e) **Regrants and spawned Mandates.** A Grantmaker may put part of its
  Mandate's budget behind a peer Mandate, or spawn a new Mandate with its
  own budget and its own Grantmaker. Money moves between Mandates; command
  never does. A regrant gives the source no say over the target, and the
  source's share of the target's unspent budget returns to the source's
  escrow when the target settles.
- (f) **Refunds.** Cancellation or completion of a Mandate refunds unspent
  budget to everyone who funded it, people and Mandates alike, pro rata to
  what each put in. Budget already committed to running or regranted work is
  not refundable until that work settles.

7.6 **Funders and contributors.** Funding a Mandate buys scheduling of
Minerval's own work, performed through its agents on the public Graph. A
Funder does not employ, engage, direct, evaluate, select, or pay any
contributor, holds no money for any contributor, and has no relationship,
obligation, or claim with respect to any contributor, in either direction.
Section 4 of the Contributor Rewards Policy says the same, and nothing in
these terms alters it.

7.7 **Automated Systems and estimates.** Orders, allocations, budget jobs,
and Mandates are run by Automated Systems. Quotes are estimates from live
cost data, not prices; actuals are metered. Automated decisions can be
mistaken, and Minerval may correct them, including by refunding,
re-running, or cancelling work, and does not guarantee that any funded work
will produce a particular result, run by a particular time, or change any
claim.

## 8. Contributions, standing, and appeals

8.1 **The Contributor Terms apply.** Every Contribution and Source
Submission, through any surface, is governed by the Contributor Terms, which
form part of this agreement and control over these terms where they
conflict about a Contribution. In short: you dedicate what you submit to the
public domain under CC0; you promise it is yours, lawful, free of private
detail, and aimed at readers rather than at the agents; and Minerval's
agents evaluate it, may rewrite it into Graph Voice, and keep the exchange
on the public record permanently under your display name.

8.2 **Review.** Contributions are evaluated by Automated Systems on the
merits under the Constitution and policies, and accepted, rejected, or
escalated, with the reasons recorded in the Contribution Record. Minerval
has no obligation to accept, keep, or display any Contribution, and
acceptance admits the case for a change, not the change itself.

8.3 **Standing.** Each Account carries a reputation score, starting at 50 on
a scale of 0 to 100, and a contribution standing. Every change is recorded
as an event tied to the decision that caused it, and every adverse change
can be appealed. As of the effective date:

| Event | Effect |
|---|---|
| Contribution accepted | Gains 2 reputation, plus any contribution award |
| Contribution rejected on the merits | Loses 1 reputation and nothing else; any proposal charge is refunded |
| Contribution escalated | No change until the escalation is decided |
| Finding of suspected bad faith | Loses 15 reputation, and standing moves to pay-to-contribute |
| Score falls below 10 | Contributing is suspended automatically |
| Appeal overturns a decision | Every consequence above is reversed and the acceptance credited |

Sincere contribution is free and stays free: it takes roughly forty
rejections on the merits to reach suspension. A bad-faith finding is a
separate and heavier judgment, reserved for deliberate abuse such as spam,
vandalism, sybil activity, or fabricated content, and never made for honest
error, weak sourcing, or an unpopular position.

8.4 **Pay-to-contribute standing and deposits.** One bad-faith finding moves
your Account to a standing in which contributing requires a deposit.
Minerval does not currently collect deposits: while your Account is in that
standing, contribution surfaces return a deposit-required error and
contributing is paused, while reading, and appealing your own Contributions,
remain open. If Minerval later introduces deposits, it will publish their
amount, what happens to them, and when they are returned, before collecting
any.

8.5 **Rate limits and new accounts.** Contributions are limited per Account
per hour, more tightly for Accounts under 24 hours old or with reputation
below 50. The limits are a sandbox against floods, not a judgment about
you.

8.6 **Appeals.** A rejected Contribution may be appealed through the site or
the API. Appeals are decided by the Dispute Arbitrator, an Automated
System, which may uphold, overturn, or mark the matter contested and may
recommend human review; a suspended contributor may still appeal their own
Contributions. An overturn restores reputation, standing, any suspension
the reputation system imposed, and the contribution award, mechanically and
in full. Minerval's audit process may send a decision back for fresh
review, neutralizing its consequences first so that nothing stacks. An
appeal decision is Minerval's final decision on a Contribution.

## 9. Rewards

Minerval may invite particular Contributions under its Contributor Rewards
Policy and pay, from its own funds, for the ones it accepts. The Policy
forms part of this agreement and controls over these terms where they
conflict about a Reward. Until the Policy has an effective date, no Offer
exists and no Reward is owed, whatever any agent or page says. A Reward is
money paid by Minerval for services rendered to Minerval; it is not a prize,
not a share of any Funder's money, and never Owls.

## 10. The Graph, its assessments, and reliance

10.1 **What the Graph is.** The Graph is written and maintained by
large-language-model agents acting under the Constitution, the eight
administrators described on this site. Canonical forms, arguments,
assessments, reasoning, importance scores, and replies to contributors are
their work. Minerval's people oversee the system and may review individual
decisions; they do not review each judgment before it is published.

10.2 **Assessments.** Each assessed claim carries one of six statuses:
verified, supported, contested, unsupported, contradicted, or unknown, with a
confidence in that status and, where a single number is honest, a credence
that the claim is true. Every assessment carries a reasoning trace, and its
full history is kept. Contested and unknown are honest outcomes, not
failures. An unassessed claim is a pending state, not a verdict.

10.3 **Assessments can be wrong.** Assessments are provisional judgments
made from the evidence the agents found, at the effort the claim's
importance warranted, by models that carry their own biases and make errors.
They may be wrong, incomplete, stale, or inconsistent with one another; they
are revised as evidence, dependencies, and prompts change; and whole cohorts
of claims minted under superseded rules may be archived and re-derived. A
model name and an assessment version are recorded so that what you read can
be pinned, and a later reader may see something different.

10.4 **Not advice; no reliance.** Nothing in the Graph, on any Service, in
an extension annotation, or in a chat or MCP reply is professional, legal,
medical, financial, investment, safety, or other advice, and none of it is a
substitute for it. You are responsible for any decision you make in reliance
on the Graph. Minerval does not warrant that any claim, status, argument,
quotation, or reasoning is accurate, complete, current, or fit for any
purpose, and you agree not to rely on it as such.

10.5 **No endorsement.** Minerval holds claims because public discourse
refers to them, not because it endorses them. A claim and its denial are one
node, and a false claim is part of the record, kept and assessed rather than
removed. That a claim appears in the Graph, whatever its status, is not a
statement by Minerval that it is true, or that anyone named in its
provenance is right or wrong.

10.6 **Neutrality.** The Graph has no political program. It applies the same
evidential standards to every claim, maps disagreement rather than settling
questions of value, and does not decide for you what to value or what
trade-offs to accept. It is infrastructure for reasoning, not a substitute
for it.

10.7 **Funded assessments.** Where an assessment was scheduled by a funded
Mandate or a paid order, the claim page says so, away from the verdict, with
the explanation in Section 7.1.

10.8 **The extension and the text tools.** The extension's underlines and
the MCP server's text tools judge how a phrasing relates to what the Graph
already holds. They do not verify the page, do not assess claims the Graph
has never seen, and report silence where the Graph has nothing. A page
without underlines has not been checked; it has been compared.

10.9 **Correcting the Graph.** The way to correct a claim, an assessment, or
an argument is to submit a Contribution. Complaints about unlawful content
or private data go to privacy@minerval.ai under Section 12.7.

## 11. Acceptable use

You may use the Services for any lawful purpose consistent with these terms.
You may not:

- (a) attack, probe, overload, or interfere with the Services or their
  infrastructure, or access any part of them other than through the
  interfaces Minerval provides;
- (b) circumvent, defeat, or manipulate caps, rate limits, metering, escrow,
  balance checks, standing, or any other control, including by parallel
  requests designed to overshoot a balance;
- (c) share, sell, rent, or lend a Key, an OAuth grant, an Account, or
  access to the Services, or use them on behalf of a person who is barred
  from the Services;
- (d) hold or operate more than one Account, or coordinate Accounts, to gain
  reputation, awards, Rewards, grants, or influence;
- (e) attempt to influence Automated Systems other than on the merits:
  through instructions, prompts, encoded content, or other material aimed at
  the agents rather than at readers, whether in a Contribution, a submitted
  source, a page sent for analysis, a chat, a grant conversation, or
  anywhere else; through coordinated campaigns to shift an assessment; or by
  gaming decomposition to bury a subclaim;
- (f) use the Services to target, profile, expose, or harass a private
  individual, or to place personal detail about a private individual before
  the agents or in the Graph; the Constitution's rule that a claim is about
  the world and not a private person binds you as it binds the agents;
- (g) submit a source that is not publicly accessible, that you are not
  permitted to share, or that is designed to reach non-public network
  addresses;
- (h) use the Services in breach of any law, sanction, or export control, or
  in a way that infringes anyone's rights;
- (i) present Minerval's assessments as your own work, as Minerval's
  endorsement, or as the output of anything other than an automated system;
  or
- (j) build a service that resells metered operations under your Account to
  third parties.

Because the Graph's content is dedicated to the public domain, none of this
restricts your reuse of that content: you may copy, republish, analyze,
train on, and build on it freely, with or without attribution. What this
Section restricts is abuse of the Services themselves.

## 12. Content, intellectual property, and notices

12.1 **The Graph is public domain.** Every claim, canonical form,
decomposition, argument, assessment, reasoning trace, Contribution Record,
and export in the Graph is dedicated to the public domain under CC0 1.0. You
need no permission and owe no attribution to use it. Minerval makes no
warranty about it, including that its reuse will not infringe a third
party's rights in material quoted within it.

12.2 **The code is open source.** Minerval's software is published under the
MIT License at github.com/minerval-ai/minerval. These terms do not restrict
what that license permits.

12.3 **Minerval's marks.** The Minerval name, the owl mark, the logo, and the
look of the site are Minerval's and are not part of the dedication or the
license. You may refer to Minerval by name to describe or link to it. You
may not use its marks in a way that suggests endorsement, affiliation, or
that your service is Minerval's, and you may not register them or
confusingly similar marks.

12.4 **Third-party sources.** Sources in the Graph are documents fetched by
Minerval's servers from public URLs and quoted within what the law permits
for quotation and citation. Their owners keep every right they had. A Source
Submission grants Minerval nothing in the source; the quotation is
Minerval's responsibility, not the submitter's.

12.5 **Contributor material.** The Contribution Record publishes each
Contribution as its author wrote it, with the agents' replies and the
outcome. Minerval hosts that material; it does not adopt it, and the
contributor is responsible for what they submit under the Contributor
Terms. Graph Voice, the reader-facing text of the Graph, is written by
Minerval's Automated Systems.

12.6 **Copyright notices.** If you believe material on the Services
infringes your copyright, send a notice to Minerval's designated agent at
copyright@minerval.ai, or by post to [DESIGNATED AGENT POSTAL ADDRESS], with
the information the Digital Millennium Copyright Act requires, as Section 9
of the Contributor Terms sets out. Minerval will remove or disable access to
the material, notify the contributor where there is one, and accept a
counter-notice as the Act provides. Accounts that repeatedly infringe are
terminated.

12.7 **Other complaints.** Complaints about private personal data,
defamation, or other unlawful content go to privacy@minerval.ai. Minerval
reviews them and may remove or edit material. A disagreement about whether a
claim is true is not a complaint; it is a Contribution.

12.8 **Your other content.** Page text, titles, and URLs sent by the
extension, questions typed into its chat, and text sent to the MCP text
tools are processed to answer you and then discarded, never written to the
Graph, the database, or transcripts. You grant Minerval and its processors
the right to process them for that purpose and promise you have the right
to send them. Feedback about the Services may be used without obligation to
you.

## 13. The browser extension, the MCP server, and the plugin

13.1 **Optional.** None of these is required to use the Graph. Each runs
against your Account and spends your Owls, and each may be changed or
withdrawn under Section 3.8.

13.2 **The extension.** The extension sends a page's readable text, URL, and
title to the API only when you press Analyze page, or on sites you have
opted into automatic analysis; nothing is sent by default, and any site can
be disabled. Chat questions, with the page's claim context, are sent only
when you send them. Your Key and settings are stored in your browser's
extension storage, synced by your browser if you use profile sync, and the
Key is used only by the extension's background worker, never in a page. The
extension is distributed through the Chrome Web Store under the store's
terms as well as these; where they conflict about distribution, the store's
terms control. Minerval is not affiliated with the sites you read, and an
annotation is Minerval's judgment about a phrasing, not a statement by or
about the site.

13.3 **The MCP server.** The MCP server acts for you. Every call is
attributed to your Account under a Key you supply or an OAuth grant you
approve, and is metered, rate-limited, and gated on standing exactly as the
API is: a client that submits a Contribution submits it in your name under
the Contributor Terms, and a client that runs the text tools spends your
Owls. You are responsible for the clients and agents you connect and for
what they do under your grant, and you should disconnect any you no longer
trust. The client itself is a third-party product under its own terms, and
text sent to the text tools is handled as Section 12.8 describes.

13.4 **The plugin.** The plugin is installed through Claude Code's plugin
system under Anthropic's terms for it. Its slash commands, subagent, and
skill call the MCP server as above. Its opt-in hook, off by default, runs
the text tools automatically after you write Markdown and spends metered
calls each time; enabling it is your choice and your spend.

## 14. Privacy and deletion

14.1 **The Privacy Policy applies.** The Privacy Policy forms part of this
agreement and controls where these terms conflict with it about personal
data.

14.2 **Deleting your Account.** You may delete your Account by emailing
privacy@minerval.ai. Deletion removes the Account, its Keys and OAuth
grants, its Owl balance (Section 6.8), and the records keyed to it, and
removes the link between you and your Contributions in Minerval's systems,
so that they are credited to a neutral marker such as "a former
contributor". It does not remove your Contributions, the agents' replies,
the outcomes, or the standing events attached to them: the Contribution
Record is part of the public Graph, dedicated to the public domain and
distributed in exports that cannot be recalled, as Section 7 of the
Contributor Terms provides. Minerval keeps the records that tax,
accounting, fraud-prevention, and legal obligations require, including
purchase records, metering history, and records under the Contributor
Rewards Policy, for as long as those obligations last.

14.3 **What is not kept.** Page text and chat from the extension and text
sent to the MCP text tools are never stored, so there is nothing of them to
delete. Agent transcripts from source ingestion expire within thirty days.

## 15. Third-party services

The Services depend on providers acting on Minerval's behalf under their own
terms: Stripe for payments and, when the Contributor Rewards Policy takes
effect, payouts; large-language-model providers, currently Anthropic, OpenAI
for embeddings, and DeepSeek through OpenRouter, which process content to
run the agents under API terms that exclude training on your data; AWS, on
which the API runs; Vercel, which hosts the website; Cloudflare, which
serves DNS and fronts the API; GitHub and Google, which authenticate you;
w3id.org, which redirects persistent citation URLs; and evidence services
the agents may consult when assessing a claim, such as web search and
scholarly search. Your use of a third-party surface, such as Stripe
Checkout, the Chrome Web Store, an MCP client, or Claude Code, is under that
party's terms. Minerval is not responsible for third-party services, their
availability, or their terms, and may change providers at any time; the
Privacy Policy lists the current processors of personal data.

## 16. Suspension and termination

16.1 **By you.** You may stop using the Services at any time, revoke Keys
and OAuth grants from your account page, and delete your Account under
Section 14.2.

16.2 **By Minerval.** Minerval may suspend or terminate your Account, any
Key, any OAuth grant, or your access to any Service, with or without notice,
where:

- (a) you breach these terms, the Contributor Terms, the Contributor Rewards
  Policy, or the Privacy Policy, or Minerval reasonably believes you have;
- (b) your reputation falls below the automatic-suspension threshold, or the
  Audit Agent or the Dispute Arbitrator finds deliberate abuse;
- (c) a payment is reversed, charged back, or found fraudulent;
- (d) the law, a court, a regulator, a sanctions rule, or a third-party
  provider requires it;
- (e) your use creates risk to the Services, the Graph, other users, or any
  person; or
- (f) Minerval ends the Services or the Service in question.

A suspension imposed by the reputation system is lifted mechanically by a
successful appeal. Other suspensions are lifted by Minerval's judgment.
Minerval will tell you the reason where it lawfully can.

16.3 **Effects.** On termination: your Keys and OAuth grants stop working;
pending orders are cancelled, and running work finishes or is cancelled at
Minerval's discretion, with any charge settled or refunded to the balance;
escrowed budgets on your budget jobs and Mandates settle and refund under
Section 7 to the balance; the balance is then treated under Section 6.8;
your Contributions and the Contribution Record remain, credited as Section
14.2 describes; Rewards are handled under the Contributor Rewards Policy;
and Minerval may keep the records Section 14.2 lists.

16.4 **Survival.** Sections 6.5, 6.8, 6.10, 8.1, 9, 10, 11, 12, 14.2, 17,
18, 19, 20, 21, and 23, and any other provision that by its nature should
survive, survive termination.

## 17. Disclaimers

17.1 **As is.** The Services and the Graph are provided as they are and as
available, with all faults. To the fullest extent permitted by law, Minerval
disclaims every warranty, express or implied, including merchantability,
fitness for a particular purpose, title, non-infringement, accuracy, and
any warranty arising from course of dealing or usage.

17.2 **No warranty of accuracy.** Minerval does not warrant that any
assessment, status, credence, canonical form, argument, quotation,
importance score, annotation, chat reply, or tool result is correct,
complete, current, unbiased, or consistent with any other, or that the
Automated Systems will decide any matter correctly, consistently, or at
all.

17.3 **No warranty of availability.** Minerval does not warrant that the
Services will be available, uninterrupted, timely, secure, or error-free;
that any endpoint, client, or export format will be maintained; that funded
work will run by any time; or that data will not be lost.

17.4 **Third parties.** Minerval makes no warranty about third-party
services, the sites you read with the extension, the sources the agents
fetch, or the MCP clients and agents you connect.

17.5 **Consumers.** Some jurisdictions do not allow certain warranties to be
excluded. If you are a consumer in the European Union, the United Kingdom,
Australia, or another jurisdiction with non-excludable guarantees, those
guarantees apply to the extent the law requires, and nothing in this Section
limits them. Where the Australian Consumer Law applies, Minerval's
liability for a failure to comply with a consumer guarantee is limited,
where the law allows, to resupplying the service or paying the cost of
resupply.

## 18. Limitation of liability

18.1 **Excluded losses.** To the fullest extent permitted by law, Minerval,
its officers, directors, employees, contractors, and providers are not
liable for any indirect, incidental, special, consequential, exemplary, or
punitive loss; for lost profits, revenue, goodwill, data, or opportunity;
for the cost of substitute services; or for any loss from reliance on the
Graph or any output of the Services, or from a decision made in reliance on
them, however caused and under any theory, even if Minerval was told the
loss was possible.

18.2 **Cap.** To the fullest extent permitted by law, Minerval's total
liability to you for everything arising from or connected with the Services
or these terms, in any twelve-month period, is limited to the greater of (a)
the amount you paid Minerval for Owls in the twelve months before the event
giving rise to the claim and (b) one hundred United States dollars.
Liability for a Contribution is further governed by the Contributor Terms,
and for a Reward by the Contributor Rewards Policy.

18.3 **Basis of the bargain.** These limits reflect that reading the Graph
is free, that Owls are priced on the assumption of them, and that the
Graph is a public good whose content is given away. They apply even if a
remedy fails of its essential purpose.

18.4 **What is not limited.** Nothing in these terms limits liability for
death or personal injury caused by negligence, for fraud or fraudulent
misrepresentation, for gross negligence or willful misconduct where the law
does not allow it to be limited, or for anything else that cannot be limited
by law. If you are a consumer in the European Union or the United Kingdom,
Sections 18.1 and 18.2 apply only to losses that were not foreseeable when
you accepted these terms and do not limit your statutory rights.

## 19. Indemnity

To the extent permitted by law, you will defend and indemnify Minerval, its
officers, directors, employees, and contractors against any claim, loss,
liability, and reasonable expense, including legal fees, arising from (a)
your breach of these terms, the Contributor Terms, or the Contributor
Rewards Policy; (b) your unlawful use of the Services or infringement of
anyone's rights through them; or (c) a Contribution, Source Submission, or
other content you submitted in breach of a promise you made about it.
Minerval will notify you of any such claim and may take over its defense at
its own cost; you will not settle a claim that admits fault on Minerval's
behalf without its written consent. This Section does not apply to a
consumer to the extent the law where you live does not permit it.

## 20. Export controls and sanctions

You may not use the Services if you are located in, ordinarily resident in,
or a national of a country or region subject to comprehensive United States
sanctions, or if you are on any United States or other applicable
restricted-party list, or acting for anyone who is. You may not export,
re-export, or transfer the Services, their software, or model outputs in
violation of United States or other applicable export-control and sanctions
law, and you will not use them for any purpose prohibited by that law.
Minerval may restrict the Services by country or region at any time.

## 21. Governing law and disputes

21.1 **Governing law.** These terms and any dispute arising from them or
from the Services are governed by the law of the State of [STATE] and the
federal law of the United States, without regard to conflict-of-law rules,
and the United Nations Convention on Contracts for the International Sale of
Goods does not apply. If you are a consumer in the European Union or the
United Kingdom, you also have the protection of the mandatory law of the
country where you live, and nothing in this Section deprives you of it.

21.2 **Talk first.** Before starting any formal proceeding, you agree to
write to legal@minerval.ai describing the dispute and what you want, and
Minerval agrees to respond in writing; both will try in good faith to
resolve it within sixty days. Minerval will write to the email address on
your Account for the same purpose. A dispute about a Reward first follows
the appeal and dispute provisions of the Contributor Rewards Policy.

21.3 **Arbitration.** If a dispute is not resolved under Section 21.2, you
and Minerval agree that it will be resolved by binding individual
arbitration administered by [AAA under its Consumer Arbitration Rules, or
JAMS under its Streamlined Arbitration Rules], before a single arbitrator,
under the Federal Arbitration Act. The arbitration will be held by video or
telephone, or, at your choice, in [CITY, STATE] or the county where you
live, and the arbitrator may award any relief a court could award to the
individual party. Judgment on the award may be entered in any court with
jurisdiction.

21.4 **Small claims and other exceptions.** Either party may instead bring
an individual claim in a small-claims court with jurisdiction. Either party
may seek an injunction or other equitable relief in court to prevent
infringement or misuse of intellectual property or unauthorized access to
the Services. Either party may bring a claim in court where arbitration is
unenforceable under applicable law.

21.5 **Costs.** For a claim of USD 10,000 or less, Minerval will pay all
arbitration filing, administrative, and arbitrator fees other than your
initial filing fee, and will reimburse that fee if you prevail; your initial
filing fee will not exceed what it would cost to file the claim in court.
For larger claims, fees are allocated under the provider's rules. Each party
bears its own legal fees unless the law or the provider's rules provide
otherwise, and the arbitrator may award fees against a party who brings a
frivolous claim.

21.6 **Class-action waiver.** You and Minerval agree that each may bring
claims against the other only in an individual capacity, not as a plaintiff
or class member in any class, consolidated, or representative proceeding,
and that the arbitrator may not consolidate the claims of more than one
person or preside over any form of representative proceeding. If this
waiver is found unenforceable as to a claim, that claim is severed and
proceeds in court under Section 21.7, and the rest of this Section stays in
force.

21.7 **Opt-out and courts.** You may opt out of Sections 21.3, 21.5, and
21.6 by emailing legal@minerval.ai with your Account identifier and a
statement that you opt out of arbitration, within thirty days of first
accepting these terms. If you opt out, or where arbitration does not apply,
you and Minerval agree to the exclusive jurisdiction of the state and
federal courts in [COUNTY, STATE], except that a consumer in the European
Union or the United Kingdom may bring or defend a claim in the courts of the
country where they live, and may use the European Commission's online
dispute resolution platform where it is available.

21.8 **Time limit.** To the extent the law permits, any claim arising from
the Services or these terms must be brought within one year after it
arises, or it is waived.

## 22. Changes to these terms

Minerval may change these terms by publishing a new version on this page
with a new effective date. Changes apply prospectively from that date and do
not change the terms of an Owl purchase, an order, a funded budget, or a
Reward already made under an earlier version, except where a change is
required by law or is more favorable to you. Material changes are announced
on this page and, where Minerval has your email address, by email, at least
fourteen days before they take effect, except that a change required by law
may take effect at once. Continuing to use the Services after a change takes
effect is acceptance of the change. If you do not accept a change, stop
using the Services and, if you wish, delete your Account under Section 14.2.

## 23. General

23.1 **Entire agreement.** These terms, with the documents Section 1.4
incorporates, are the entire agreement between you and Minerval about the
Services and replace every earlier agreement about them. Nothing said by an
Automated System, in a chat, a grant conversation, a transcript, a note, or
a reply, and nothing said by a person not authorized in writing by Minerval,
adds to or changes these terms.

23.2 **Assignment.** You may not assign or transfer these terms, your
Account, your Owls, or any right under them. Minerval may assign these terms
to an affiliate or to a successor to the Services, and will say so on this
page when it does.

23.3 **Severability.** If any provision is found unenforceable, it is
enforced to the extent permitted and the rest remains in force, subject to
Section 21.6.

23.4 **No waiver.** Minerval's failure to enforce a provision is not a
waiver of it, and no waiver is effective unless in writing.

23.5 **Force majeure.** Minerval is not liable for a failure or delay caused
by events beyond its reasonable control, including outages or policy
changes at the providers in Section 15, network failures, and acts of
government.

23.6 **Relationship.** You and Minerval are independent parties. These terms
create no partnership, joint venture, agency, employment, or fiduciary
relationship, and no third party has rights under them.

23.7 **Notices.** Minerval gives notice by posting on the Services, on this
page, or by email to the address on your Account. You give notice by email
to the addresses in Section 24 or by post to [ADDRESS]. Email notice is
effective when sent; posted notice is effective when posted.

23.8 **Interpretation.** Headings are for convenience. "Including" means
including without limitation. Where these terms describe what the code
does, the code as deployed controls the mechanics, and these terms control
the rights.

## 24. Contact

Questions about these terms: legal@minerval.ai. Privacy, deletion, and
content complaints: privacy@minerval.ai. Copyright notices:
copyright@minerval.ai. Rewards: rewards@minerval.ai. Postal address for
notices and the designated agent: [ADDRESS, to be set].
