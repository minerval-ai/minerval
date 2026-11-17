# The usage report

The usage report is billing. Every private graph pays Minerval toward the public graph it reads. By default the price is metered on use: a deployment reports the owls its agents' runs spent, whoever hosts it and whoever runs its models, and pays Minerval in proportion. A flat price for the feed is the alternative, and a deployment on it reports nothing.

The report is one total for one day. It never says which claims, mandates or people the work was for, so the payment shows nothing about what the organization cares about.

**Who receives it and who can read it.** A report is sent privately to Minerval's server (`POST /usage-reports`, for instance at `api.minerval.ai`), under the organization's account with Minerval, and recorded against that account so that Minerval can bill the metered price. It is not published: no route reads a received report back, the mirror feed does not carry it, and no other account can see it (see [Receiving](#receiving)). The pages and messages a deployment shows name Minerval as the recipient, not "the public graph", which an administrator reads as "made public".

One codebase serves both sides. A members-only deployment (`READS=members`) on the metered price sends reports. Every deployment can receive them, which is of use on the public graph. The public graph itself reports to no one: with nothing set, no report is prepared, no worker starts and nothing is sent.

## What a report is

One JSON document, in canonical form (keys sorted, no spaces):

```json
{"deployment":"5b1f5c0e-6a57-4f0e-9d53-0f6c1f6f4c11","format":1,"kind":"minerval-usage-report","owls_spent":"12.500000","period":"2026-11-10","revision":0}
```

| Field | |
| --- | --- |
| `owls_spent` | The owls the deployment's runs spent in the period, to six decimal places. It is the period's metered cost: the sum of `llm_usage.cost_micro_usd`, which holds every metered call, model tokens and priced tools alike. One owl covers one dollar of metered cost |
| `period` | The UTC day the total is of. A report is made only of a day that has ended |
| `revision` | `0` for the day's first report. A correction takes the next number |
| `deployment` | An identifier made at random with the deployment's first report and repeated on every one, so that two deployments reporting under one account are told apart. It says nothing else about the deployment |
| `format`, `kind` | `1` and `minerval-usage-report` |

That is all of it. A report carries no claim, question, source, mandate or person, no count of runs, no model or provider, no code version and nothing an agent read or wrote. The receiving route refuses a body with any other field, so a report cannot carry more than this by accident.

Two things were considered and left out. The number of runs is not needed to bill and says something about how an organization works. The code version is not needed to bill either. If Minerval later needs either, it is a new format and a change an administrator sees on the page before anything is sent.

## Preparing

The worker (`src/workers/usage-reports.ts`, every `USAGE_REPORT_INTERVAL_SECONDS`, an hour by default) writes one row to `usage_reports` for each UTC day that has ended and has none.

- The first day reported is the first day anything was metered. `USAGE_REPORT_FROM` names a later one: a deployment that moves from the flat price to the metered one sets the day the metered price starts, so that days it paid for flat are not reported.
- From there every day gets a report, a day with no spend included, so the record has no gaps to be asked about.
- A report's text is fixed when it is written (`usage_reports.body`, with its SHA-256). Nothing rewrites it.
- **Every label is counted.** The meter's rows carry the label of the run each is for, and the database holds a worker or an administrator to what they read. The count is therefore taken under system clearance (`prepareUsageReports`, listed with its reason in `tests/unit/db/system-clearance.test.ts`), and what it writes is a day and a total, in a table that carries no label.
- **Idempotent by period.** Preparing again writes nothing. One row per day and revision, under a database lock, so every task may run the worker.
- **A correction is a new entry.** Each pass recounts the last seven closed days. If a day's count no longer matches its latest report, the correction is a new row with the next revision, and both are sent. The meter's rows carry the time they were written, so this happens only in unusual cases: a restored backup, a repair by hand. An administrator can ask for any range to be recounted.

## Sending

One of two ways, set by the deployment:

| Setting | |
| --- | --- |
| `USAGE_REPORT_URL` | The address of the receiving route on Minerval's server, for instance `https://api.minerval.ai/usage-reports` |
| `USAGE_REPORT_API_KEY` | An API key of the organization's account with Minerval (its account on the public graph). A secret |
| `USAGE_REPORT_DIR` | A directory. Each report is written there as `usage-report-<day>-r<revision>.json`, to be handed over, for a deployment whose network is restricted |
| `USAGE_REPORT_FROM` | The first UTC day reported, `YYYY-MM-DD`. Empty by default |
| `USAGE_REPORT_INTERVAL_SECONDS` | How often the worker runs. Default 3600 |
| `PUBLIC_GRAPH_PRICE` | `metered` (the starting value) or `flat`. On `flat` nothing is prepared and nothing is sent |

Setting both a URL and a directory is refused when the deployment starts, so that each report has one record of how it left.

Unsent reports are sent oldest first. A report that fails stops the pass; its row records the attempt and the error, and the next pass tries again. So a deployment that was offline, or that has no destination set yet, sends late and in order, and what it sends is the text that was prepared.

A file is the report and nothing else. Whoever hands it over posts it under the organization's key:

```
curl -X POST https://api.minerval.ai/usage-reports \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  --data-binary @usage-report-2026-11-10-r0.json
```

The account that reports is the organization's one account with Minerval, the same account it acts on the public graph under and its mirror of the public graph is fetched under. Reporting under it publishes nothing: the report is recorded privately against it.

## What the administrators read

`GET /usage-reports/outgoing` (`list_usage_reports` on MCP), for holders of `administer`: the price in force, what a report says and what it never says, where reports go, and every report exactly as it is sent, before it is sent and after, with when it was sent, how, and what Minerval's server answered. On the flat price the same page says that nothing is prepared and nothing is sent.

`POST /usage-reports/outgoing/send`, from a signed-in session, prepares and sends now instead of at the worker's next pass, and takes `recount_from` to recount from a given day.

The page is the Usage tab of Budget (`/admin/budget?tab=usage`) in a members-only build of the web app; `/admin/usage-report` redirects there.
The sentences it shows are in `src/services/usage-report-service.ts` (`WHAT_IS_SENT`, `WHAT_IS_NEVER_SENT`, `FLAT_PRICE_SENDS_NOTHING`, `HOW_A_REPORT_IS_CORRECTED`).

## Receiving

`POST /usage-reports`, on every deployment and of use on Minerval's. It takes a report from an authenticated account and records it against that account in `usage_reports_received`, as sent.

- **Private to the account and to Minerval.** The route answers only with the report's day, revision, hash and when it was received. No other route, page or MCP tool reads `usage_reports_received`, the table is not in the mirror feed (`src/services/mirror-manifest.ts`), and nothing publishes it. Minerval, which runs the server and its database, is the only one to read it, to bill from it once there is a price per owl.

- The same report again is recognized by its hash and changes nothing (`200`, `recorded: false`).
- A different report for a day and revision already recorded is refused (`409 REPORT_DIFFERS`). A recorded report is not changed; a correction is the next revision.
- Rows are kept per account. What one account reports never touches another account's rows, whatever deployment identifier it names.
- A day that has not ended, and a body with any field the format does not have, are refused (`400`).

**It bills nothing.** The price per owl is not decided, so a report is recorded and nothing else happens; the answer says `charged: false`. When a price exists, billing reads the latest revision of each day.

The route is not an MCP tool: it is sent by a deployment's worker, and an agent has no report of its own to send.
