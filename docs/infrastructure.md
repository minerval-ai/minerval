# Infrastructure: domains, hosting & traffic flow

How the production deployment is wired across Vercel, AWS, and Cloudflare.

## Domains

| Domain | Role | Hosting |
| --- | --- | --- |
| `minerval.ai` (+ `www`) | Public Next.js app | Vercel project `episteme` (team `Episteme`) |
| `api.claimgraph.io` | Backend API | AWS ALB → ECS Fargate (`infra/`) |
| `claimgraph.io` (+ `www`) | 301 redirect → `https://minerval.ai` | Cloudflare Redirect Rule (no origin) |

DNS for all three zones is hosted on **Cloudflare**. `minerval.ai` is registered with
Cloudflare Registrar; `claimgraph.io` is registered elsewhere with nameservers pointed at
Cloudflare. The Vercel project and team are still named `episteme` — pre-rebrand
identifiers that are not user-visible.

### Pending: the `episteme.wiki` → `minerval.ai` cutover

The codebase now points at `minerval.ai` everywhere. The hosting side has to follow, and
none of it is a code change:

1. Add the `minerval.ai` zone in Cloudflare and the `A @ / A www 76.76.21.21` records below.
2. Bind `minerval.ai` (+ `www`) as a domain on the Vercel project and let it issue TLS.
3. Rename the Vercel env vars to `MINERVAL_API_URL` / `MINERVAL_API_KEY` (the app reads the
   `EPISTEME_*` names as a fallback, so the order does not matter and nothing breaks
   mid-flight). Remove the old names once the new ones are live.
4. Keep `episteme.wiki` bound and add a Cloudflare Redirect Rule 301-ing it to
   `minerval.ai`, alongside the existing `claimgraph.io` rule, so old links survive.
5. ~~Drop the `PUBLIC_WEB_BASE_URL` pin in `infra/lib/api-stack.ts` and redeploy~~ — done
   (the pin was still leaking `episteme.wiki` into citations, MCP links, and OAuth after
   the domain went live; the API now rides its `https://minerval.ai` code default).
   Takes effect on the next API deploy.

### Persistent citation URLs (w3id.org)

"Cite this claim" (#290) mints citations whose URL is the claim page under
`minerval.ai`. The load-bearing identifier is the claim id + assessment
version, not the domain — but for institution-grade permanence (citations
outliving any future rebrand, the way `episteme.wiki`-era links now depend on
a redirect rule), the scholarly mechanism is a
[w3id.org](https://w3id.org) namespace: a community-guaranteed redirect
service configured via PR to
[perma-id/w3id.org](https://github.com/perma-id/w3id.org).

The namespace is **registered** (perma-id/w3id.org PR merged 2026-08-03,
submitted from Jackson's fork; the submitted files live in `infra/w3id/`):
`https://w3id.org/minerval/claim/<claim-id>` → `minerval.ai/claims/<claim-id>`,
and `https://w3id.org/minerval/vocab` → the `mv:` vocabulary docs.
`CITATION_URL_BASE=https://w3id.org/minerval/claim` is set in
`infra/lib/api-stack.ts` (#322), so citations and nanopub claim IRIs carry the
permanent form from the next API deploy. Verify after deploying:
`curl -sI https://w3id.org/minerval/claim/test` should 302 to the claim page,
and `GET /claims/:id/citation` should return `w3id.org` URLs.

The nanopublication export (#292, `GET /claims/:id/nanopub`) already mints
its `mv:` vocabulary IRIs under `https://w3id.org/minerval/vocab#` (see
`docs/vocab.md`), and its claim IRIs follow `CITATION_URL_BASE` like
citations do — both resolve fully once the namespace is registered.

### Email on `minerval.ai` (Google Workspace)

Email is independent of the web cutover above — MX/TXT records don't touch the `A` records
Vercel needs, so this can happen before, after, or during it. The zone already exists in
Cloudflare (Cloudflare Registrar requires it), so it's purely additive:

1. Sign up at workspace.google.com for **Business Starter** (one seat) with domain
   `minerval.ai`, admin `jackson@minerval.ai`. Verify ownership with the
   `google-site-verification` TXT record the wizard hands out.
2. DNS records in Cloudflare (MX/TXT are never proxied, so no grey/orange decisions):
   - `MX @ 1 smtp.google.com` (Google's current single-record setup)
   - `TXT @ "v=spf1 include:_spf.google.com ~all"`
   - `TXT google._domainkey <value>` — generate under Admin console → Gmail →
     Authenticate email, then hit "Start authentication"
   - `TXT _dmarc "v=DMARC1; p=none; rua=mailto:jackson@minerval.ai"` — tighten `p=` once
     DKIM/SPF have soaked
3. Chrome Web Store (issue #135): register the developer account ($5 one-time) **signed in
   as `jackson@minerval.ai`**, not a personal account — listings are effectively pinned to
   the registering account (transfers are a support-ticket process). Verify the contact
   email, then verify the `minerval.ai` domain property in Google Search Console (DNS TXT,
   instant from the same Cloudflare zone) so the listing shows a verified publisher site.

The store's privacy questionnaire will ask about data handling — the extension sends page
text to the API on user action, so answer accordingly and link the site's privacy policy.

## Request flow

```
Browser ──HTTPS──> minerval.ai (Vercel, Next.js)
                        │  server-side only (BFF)
                        └──HTTPS──> api.claimgraph.io (Cloudflare proxy)
                                        └──> AWS ALB :443 ──> ECS Fargate :3000
```

The browser **never** talks to the API directly. `web/lib/api.ts` is `server-only`; React
Server Components / route handlers call the API from Vercel's servers. Because it is
server-to-server there is no CORS configuration to maintain.

## Configuration that makes it work

- **Vercel → API binding**: project env var `MINERVAL_API_URL = https://api.claimgraph.io`
  (Production + Preview). This is the *only* place the API base URL lives — it is not
  hardcoded anywhere in the codebase (`web/lib/api.ts` reads `process.env.MINERVAL_API_URL`,
  falling back to the pre-rebrand `EPISTEME_API_URL` while both exist).
  Changing the backend endpoint is purely a Vercel env change + redeploy.
- **minerval.ai DNS** (Cloudflare, both records **DNS-only / grey cloud** so Vercel can
  issue TLS): `A @ 76.76.21.21`, `A www 76.76.21.21`.
- **claimgraph.io DNS** (Cloudflare): `CNAME api → <ALB DNS name>` (proxied),
  `AAAA @ 100::` + `CNAME www → claimgraph.io` (proxied, placeholders for the redirect rule).
- **Redirect rule** (Cloudflare → Rules → Redirect Rules): host `claimgraph.io`/`www` →
  301 `concat("https://minerval.ai", http.request.uri.path)`.
- **TLS to the origin**: the ALB has an HTTPS:443 listener with an ACM certificate for
  `api.claimgraph.io` (see `infra/lib/api-stack.ts`). Cloudflare SSL/TLS mode for the
  claimgraph.io zone should be **Full (Strict)** so the Cloudflare→ALB leg is encrypted and
  validated. (It runs on Flexible only as a temporary fallback if the origin cert is absent.)

## Known drift: the ALB :443 listener

The HTTPS:443 listener was first created via the AWS CLI to bring `api.claimgraph.io` online,
then codified in `infra/lib/api-stack.ts`. CloudFormation does not yet own that listener, so
the **next `cdk deploy` will fail** with "a listener already exists on port 443" until the
manual listener is deleted once:

```sh
ALB_ARN=$(aws elbv2 describe-load-balancers --region us-east-1 \
  --names Episte-ApiAl-uTjpMpVSb3vy --query 'LoadBalancers[0].LoadBalancerArn' --output text)
LISTENER_ARN=$(aws elbv2 describe-listeners --region us-east-1 --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`443\`].ListenerArn" --output text)
aws elbv2 delete-listener --listener-arn "$LISTENER_ARN"   # one-time, then cdk deploy
```

There is a brief HTTPS gap for `api.claimgraph.io` between the delete and the deploy; do it in
a low-traffic window (or flip Cloudflare SSL to Flexible during it).

## Reference values

- AWS account `702111526219`, region `us-east-1`.
- ALB DNS: `Episte-ApiAl-uTjpMpVSb3vy-704224970.us-east-1.elb.amazonaws.com`.
- ACM cert (api.claimgraph.io):
  `arn:aws:acm:us-east-1:702111526219:certificate/49ad38f0-d695-468b-9424-f69bd3c8769b`.
- Health check: `GET /health` → `{"status":"healthy",...}`.

## Optional hardening (not yet done)

Restrict the ALB security group (`sg-09f4949edb92c3bfe`) ingress on 80/443 to Cloudflare's
published IP ranges so the origin is only reachable through Cloudflare.
</content>

## The Lean checker

The checker (docs/architecture.md, "The Lean checker") is a separate CDK
stack, `EpistemeLeanChecker` (`infra/lib/lean-checker-stack.ts`): an ECR
repository whose lifecycle rule expires untagged layers only, so every pin
referenced by a statement or a bounty stays pullable; a Secrets Manager
entry for the bearer token; the warm-lane Fargate service (2 vCPU, 16 GB,
60 GB ephemeral) in the isolated subnets; the cold-lane task definition
(4 vCPU, 16 GB) that the API launches per check with `RunTask`; interface
endpoints for ECR API, ECR DKR, CloudWatch Logs, and Secrets Manager plus
a gateway endpoint for S3; and the checker security group, whose only
egress is to those endpoints. `infra/bin/app.ts` passes the service URL,
the secret, and the cold-lane launch parameters to the API stack, which
sets `LEAN_CHECKER_URL`, `LEAN_CHECKER_TOKEN`, and the
`LEAN_CHECKER_COLD_*` variables on the API task and grants it
`ecs:RunTask`. The `LEAN_CHECKER_COLD_*` variables and the `RunTask` grant
are reserved for a future path in which the API launches one cold-lane
task per prize check itself; nothing in `src/` reads them today, and prize
checks go to the checker service's `POST /v1/check` and are polled. The
API reaches the checker over private addressing; the checker reaches
nothing, and a synth-level test asserts the no-callback rule.

The endpoints, every one but the first behind the bearer token:

| Route | Lane | Purpose |
| --- | --- | --- |
| `GET /health` | both | pin, lane, queue depth, CPU spent today |
| `GET /v1/pins` | both | the live pin and its image digest |
| `POST /v1/elaborate` | warm | type-check a statement file; returns the elaborated form and hashes, or errors with positions |
| `POST /v1/scratch` | warm | semi-trusted iteration for the Steward and the solver; diagnostics only, never a verdict |
| `POST /v1/search` | warm | proxy to the pinned Loogle mirror (`LOOGLE_URL`) |
| `POST /v1/check` | cold for `prize` mode | static policy, then a queued job: `202 {check_id}` |
| `GET /v1/checks/:id` | both | the record: status, verdict, failed gate, per-gate checks, diagnostics, resource use, pin, hashes |

The warm lane refuses `mode: "prize"`; prize verdicts come only from a
cold-lane task, which exits on its own once its finished record has been
fetched. The service carries a daily CPU-hour cap and per-job limits of its
own. The image build, the first-deployment checklist, the golden fixture
that is the acceptance test for a pin, the first measurements nobody has
made yet (image size, cache-fetch duration, `import Mathlib` warm start,
peak memory, replay runtime, cold-lane start), and the single-instance v0
mode are in `lean-checker/README.md`; record the measurements there on the
first build. A weekly scheduled CI job pulls the pinned image and runs the
golden fixture and the checker's integration tests, since Lean and the
Mathlib cache are too large for the per-push jobs.

## The solver worker

The solver (docs/architecture.md, "The solver") runs as a second ECS
service in the API stack, `npm run worker:solver`, `desiredCount` 1, with
its own task definition carrying more memory than the API's 1 GiB, the same
secrets as the API, and `SOLVER_ENABLED` as an environment variable. It is
stopped in one of three ways: `SOLVER_ENABLED=false` and a deploy (the
worker exits its loop); a `solver_paused` row in `platform_flags`, which
every running attempt polls each turn, so no deploy is needed; or
`POST /admin/attempts/:id/cancel` for one attempt. Its daily spend is
bounded by `SOLVER_DAILY_CAP_OWLS` (`SOLVER_CALIBRATION_DAILY_CAP_OWLS`
during calibration) independently of any mandate. Solver attempts and
prize checks are DB-backed jobs with their own workers, never SQS messages:
the two queues' 120-second visibility timeout (`infra/lib/queue-stack.ts`)
is unsuitable for either.

## Attachments and the S3 path

Uploaded files live in Postgres (`attachments`, `bytea` bodies) at v1
volumes. Nothing exists for object storage today: no bucket in
`infra/lib/`, no S3 client in `package.json`. The migration path needs no
schema change, because the row already carries `storage` and
`storage_key`: a bucket, the S3 gateway endpoint the checker stack already
creates, presigned PUT and GET routes, and a backfill that moves bodies and
flips `storage` to `s3`. Its triggers are files over 10 MiB, attachment
storage past about 5 GB, or a second region.

## Secrets

- `episteme/lean-checker-token`: the checker's bearer token, generated by
  the checker stack and read by the API task and the checker tasks. It is
  the only secret the checker ever sees, and it is never in the web tier.
- `MINERVAL_OPERATOR_KEY`: the operator key (docs/accounts.md, "The
  operator key") for the eight operator routes: the fund deposit, the
  bounty confirmation, the prize-claim sign-off, the void, the sanctions
  screening, the owl grant, the release of a `check_error` hold, and the
  operator page. It is held outside the web deployment, in the operator's
  own password manager or a Secrets Manager entry the web task cannot
  read, and used only from the operator's own session. It is never set on
  the Vercel project.
- Nothing else is baked into the checker image or its environment, because
  the cold lane runs a claimant's code.
- A payout provider's key arrives only with cash payouts, in its own entry,
  never a widening of the Stripe Checkout key.

## Runbooks

**Pin advance and statement migration.** Follow "Advancing the pin" in
`lean-checker/README.md`: edit `pin.json`, `lean-toolchain`, and the
lakefile; resolve the revision; build; run the golden fixture; record the
measurements; push under the new tag; deploy the checker stack with the new
digest. Then run the migration job, which re-elaborates every open
statement under the new pin and carries forward without a new version only
a statement whose elaborated body and constant closure hash the same. A
statement with a live bounty never changes pin without a new version and
the 30-day amendment notice, whatever the hash says; a renamed or
deprecated Mathlib name means the Steward republishes (new version, same
claim, a migration note in the correspondence) and the old pin stays
accepted for a 30-day grace window; a statement that no longer elaborates
and cannot be migrated mechanically is the Steward's decision, never the
script's. At most three pins are live at once, and the cold-lane launcher
passes a statement's own pin as the image tag until every open statement is
on the new one.

**Pausing the solver.** Without a deploy: set the `solver_paused` row in
`platform_flags`; running attempts stop at their next turn, complete their
action with the metered amount, keep their notebook and transcript, and
record `cancelled`. With a deploy: set `SOLVER_ENABLED=false` on the solver
service. Clear the flag or the variable to resume; the cooldown and the
daily cap apply as usual.

**Cancelling an attempt.** `POST /admin/attempts/:id/cancel` (service key)
sets `proof_attempts.status = 'cancelling'`; the attempt polls it each turn
and closes as above. An attempt whose worker died is found by the reopen
sweep after three hours without a heartbeat and marked `orphaned`; its
spend to that point is already on the meter.

**Re-queuing a `check_error`.** A prize claim reaches `check_error` after
`PRIZE_CHECK_MAX_ATTEMPTS` checker errors, and it holds the statement's
queue: no later claim on that statement is checked until it is resolved, so
an infrastructure failure never costs a claimant their priority. From the
operator page, first fix the cause (a cold-lane task that cannot pull its
image, a daily CPU cap spent, a warm lane that lost its Mathlib), then
re-queue the claim (`POST /prize-claims/:id/retry-check`, operator key,
written to `audit_log` as `prize_route:retry_check`); it returns to
`queued` with its original `submitted_at`, and the worker's next
submission forces a fresh run rather than the checker's deduplicated error
record. A claim is never rejected from `check_error`.

**A prize claim stuck in review.** The prize-check worker re-invokes the
Steward on `prize_claim` for an `in_review` claim with no decision after 24
hours, at most once a day per claim, and again at once when the Audit
agent sends an acceptance back (the claim returns to `in_review` with its
window cleared). The operator page lists every claim in review for over 24
hours under `in_review_over_24h`, keyed on when it entered review, so a
claim the Steward keeps failing to decide stays visible until someone
looks at the run.

**Voiding and signing off a prize claim.** Both need the operator key and
are written to `audit_log` with the credential kind and the acting person,
as are the screening (`POST /prize-claims/:id/screening`), the owl grant
(`POST /prize-claims/:id/pay`), and the check retry. There is no deposit
route: a prize is owls held against the escrow of the mandate that posted
it, and a platform mandate's escrow is funded by the seed.
Sign-off (`POST /prize-claims/:id/sign-off {note}`) is required before
`payable` when the bounty is at or above `PRIZE_HUMAN_SIGNOFF_OWLS`, the
claim's importance is at or above `PRIZE_HUMAN_SIGNOFF_IMPORTANCE`, the
contribution is in `human_review`, an Arbitrator outcome on a challenge was
`human_review`, a second-opinion checker disagreed with the verdict, the
Steward's decision was served by a fallback model, or the screening
returned anything but clear; the operator page lists claims awaiting it
with the full record, and the checklist requires identity, tax form, and
screening to be recorded first. A void (`POST /prize-claims/:id/void
{ground, note}`) names one of the enumerated challenge grounds; its note is
public and it is appealable on the ordinary route like any rejection. A
void after payout is recorded on the payout row as `reversed` and clawed
back as a negative `prize_award`.

**Withdrawing a bounty with notice.** Withdrawal is prospective only. The
Grantmaker's `withdraw_bounty` (or the operator) sets
`withdraw_effective_at` to `BOUNTY_NOTICE_DAYS` (30) from now; the notice
appears on the claim page and the prize listing at once; submissions
received before the effective time are judged under the prior terms; the
timer is suspended while any prize claim on the bounty is non-terminal, so
a live claim never loses its reservation. At the effective time the bounty
becomes `withdrawn` and the reservation returns to the fund. A rebinding
after a statement defect may instead be answered with the same notice, in
which case the bounty does not rebind.

**A checker image rebuild.** For the same pin: rebuild, run the golden
fixture, confirm the digest changed only where intended, push under the
same tag, and deploy with the new digest; bump `checker_version` in
`pin.json` if `Minerval/Check.lean` or the server changed, since the
`lean_checks` dedupe key includes it. Never delete an old tag: retired
images stay in the registry so any historical verdict can be re-run.

**Reconciling the prize escrows.** Monthly, and before any bounty at or
above the sign-off threshold opens: for each mandate with a live or paid
bounty, confirm that its prize numbers (`GET /prizes`, and the mandate
page) agree with the rows they are derived from (each bounty in a holding
status is held at its amount; each `prize_payouts` row not `reversed`
matches one `prize_award` grant net of its `withholding_micro_usd`, and is
counted gross against the mandate; each prize-review reserve job names its
bounty in its checkpoint), that the mandate's headroom is never negative,
and that when every bounty of the mandate is terminal nothing is held.
When a cash rail exists the same job compares the provider's ledger. A
discrepancy is an `admin_adjust` entry with a note, never an edit of an
existing row.

## Monitoring

- Checker queue depth and per-check wall time, from `/health` and
  `lean_checks.resource`.
- The solver's daily spend against its cap, and attempts `running` past
  their heartbeat.
- Prize claims in `checking` past `PRIZE_CHECK_RECLAIM_MINUTES`, and any
  claim in `check_error`.
- Claims in `in_challenge_window` approaching `window_ends_at` without an
  audit outcome.
- Bounties in `house_result_pending` older than seven days without a
  Steward decision.
- Winners whose payee steps are incomplete past 60 days of the 90.
- Fund balance against open bounties: `available` must never be negative.
- The money triggers' latency: the Steward's `prize_claim` run should start
  within an hour of `in_review`.

## Retention

- Prize records (the submission and its hashes, the checker record,
  timestamps, screening, tax forms, the grant, the rules version) and the
  transcripts of attempts on bounty-bearing claims: at least seven years.
- Other solver transcripts: the operator's trace retention.
- Retired checker images: kept in the registry.
- Failed submissions' Lean sources: restricted until the bounty closes,
  then public with the record; an erasure request is answered by
  pseudonymizing the credit name, never by deleting the record.
