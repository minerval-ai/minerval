# Infrastructure: domains, hosting & traffic flow

How the production deployment is wired across Vercel, AWS, and Cloudflare.

## Domains

| Domain | Role | Hosting |
| --- | --- | --- |
| `episteme.wiki` (+ `www`) | Public Next.js app | Vercel project `episteme` (team `Episteme`) |
| `api.claimgraph.io` | Backend API | AWS ALB → ECS Fargate (`infra/`) |
| `claimgraph.io` (+ `www`) | 301 redirect → `https://episteme.wiki` | Cloudflare Redirect Rule (no origin) |
| `minerval.ai` (+ `www`) | 301 redirect → `https://episteme.wiki` | Cloudflare Redirect Rule (no origin) |

DNS for all four zones is hosted on **Cloudflare**. `episteme.wiki` and `minerval.ai` are
registered with Cloudflare Registrar; `claimgraph.io` is registered elsewhere with
nameservers pointed at Cloudflare.

## Request flow

```
Browser ──HTTPS──> episteme.wiki (Vercel, Next.js)
                        │  server-side only (BFF)
                        └──HTTPS──> api.claimgraph.io (Cloudflare proxy)
                                        └──> AWS ALB :443 ──> ECS Fargate :3000
```

The browser **never** talks to the API directly. `web/lib/api.ts` is `server-only`; React
Server Components / route handlers call the API from Vercel's servers. Because it is
server-to-server there is no CORS configuration to maintain.

## Configuration that makes it work

- **Vercel → API binding**: project env var `EPISTEME_API_URL = https://api.claimgraph.io`
  (Production + Preview). This is the *only* place the API base URL lives — it is not
  hardcoded anywhere in the codebase (`web/lib/api.ts` reads `process.env.EPISTEME_API_URL`).
  Changing the backend endpoint is purely a Vercel env change + redeploy.
- **episteme.wiki DNS** (Cloudflare, both records **DNS-only / grey cloud** so Vercel can
  issue TLS): `A @ 76.76.21.21`, `A www 76.76.21.21`.
- **claimgraph.io DNS** (Cloudflare): `CNAME api → <ALB DNS name>` (proxied),
  `AAAA @ 100::` + `CNAME www → claimgraph.io` (proxied, placeholders for the redirect rule).
- **Redirect rule** (Cloudflare → Rules → Redirect Rules): host `claimgraph.io`/`www` →
  301 `concat("https://episteme.wiki", http.request.uri.path)`.
- **minerval.ai DNS** (Cloudflare): `AAAA @ 100::` + `CNAME www → minerval.ai` (both
  proxied, placeholders for the redirect rule — there is no origin).
- **minerval.ai redirect rule** (Cloudflare → Rules → Redirect Rules): filter
  `(http.host eq "minerval.ai") or (http.host eq "www.minerval.ai")` → dynamic 301
  `concat("https://episteme.wiki", http.request.uri)`. Note `http.request.uri` (not
  `.uri.path`): it carries the query string through as well, so
  `minerval.ai/claims/x?tab=y` lands on `episteme.wiki/claims/x?tab=y`. Universal SSL
  covers apex + `www` at the edge; no origin cert exists or is needed.
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
