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
