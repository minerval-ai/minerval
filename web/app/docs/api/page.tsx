import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "REST API · Minerval docs",
  description: "The graph over plain HTTP, at https://api.claimgraph.io. This page covers what every route has in common: reading without a key, caching, limits, trimming responses, writes, spending and errors.",
};

const toc = [
  { depth: 2, text: "Try it", slug: "try" },
  { depth: 2, text: "Keys", slug: "auth" },
  { depth: 2, text: "Open reads and caching", slug: "reads" },
  { depth: 2, text: "The anonymous rate limit", slug: "limits" },
  { depth: 2, text: "Partial responses", slug: "fields" },
  { depth: 2, text: "Merged ids", slug: "merged" },
  { depth: 2, text: "Writes are reviewed", slug: "writes" },
  { depth: 2, text: "Routes that spend", slug: "money" },
  { depth: 2, text: "Errors", slug: "errors" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/api"
      title="REST API"
      lede={<>The graph over plain HTTP, at <code>https://api.claimgraph.io</code>. This page covers what every route has in common: reading without a key, caching, limits, trimming responses, writes, spending and errors.</>}
      toc={toc}
    >
      <p>Every route an account can call is also an MCP tool, apart from a few left out for a stated reason (buying owls, for one, happens on the account page). The tool runs the route itself, with the same validation, charges and errors. The <Link href="/docs/tools">tool catalog</Link> is therefore a map of the API, and each entry names its route. A self-hosted deployment serves the same API at its own address.</p>
      <div className="dc-callout"><b>Schemas for every route.</b>The <a href="https://api.claimgraph.io/docs">OpenAPI explorer</a> lists each route with its parameters and response shapes, generated from the routes themselves. The OpenAPI document is at <code>https://api.claimgraph.io/docs/json</code>.</div>
      <h2 id="try">Try it</h2>
      <p>These reads need no key. The id is a real claim on the public graph.</p>
      <CodeTabs
        tabs={[
          { label: "Card", code: `curl https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071/card`, note: "The claim's judgment in one small shape. GET /claims/cards?ids=<id>,<id> reads up to 100 at once." },
          { label: "Claim", code: `curl "https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071?information_depth=standard&depth=3"`, note: "The full record. information_depth is cursory, standard (the default) or deep; depth caps the decomposition tree at 1 to 8 levels (default 3)." },
          { label: "What rests on it", code: `curl "https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071/dependents?depth=3"`, note: "Walks up. depth 1 (the default) returns direct dependents; above 1, each row says the depth it was found at." },
          { label: "Changes", code: `curl "https://api.claimgraph.io/changes?under=dc02e01f-ce69-4dbe-ba36-ed0e2e90d071"`, note: "Material changes to verdicts under this claim, oldest first. Pass next_cursor back as after to read on." },
          { label: "Trimmed", code: `curl "https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071?fields=claim.text,claim.contestation,assessment.status,assessment.claim_credence"

# {"claim":{"text":"Scalable oversight can reliably control superintelligent AI systems.",
#   "contestation":0.7},"assessment":{"status":"doubtful","claim_credence":0.08}}`, note: "Only the parts named in fields come back." },
        ]}
      />
      <h2 id="auth">Keys</h2>
      <p>Reads are open. Everything that writes, spends or reads your own account needs an API key in the <code>x-api-key</code> header. Mint one on your account page; see <Link href="/docs/auth">Authentication</Link>. An OAuth access token from an MCP client is scoped to <code>/mcp</code> and is refused on REST routes with <code>403 INSUFFICIENT_SCOPE</code>.</p>
      <h2 id="reads">Open reads and caching</h2>
      <p>A read on a route that needs no key, sent without credentials, is a public read. Any web page may call it from the browser: the answer carries <code>access-control-allow-origin: *</code>. A successful public read is cacheable for a minute:</p>
      <Code label="Headers on a public read">{`access-control-allow-origin: *
cache-control: public, max-age=60, stale-while-revalidate=300
etag: W/"ZWSRV1AfUoRyZjuGZplQoJhbOXA"
vary: Authorization, X-API-Key
ratelimit-policy: 300;w=60`}</Code>
      <ul>
        <li>Send the <code>ETag</code> back in <code>If-None-Match</code> and an unchanged response comes back as <code>304</code> with no body.</li>
        <li>Because of the cache, an anonymous read can be up to a minute behind the graph, and a stale copy may be served for up to five more minutes while a fresh one is fetched.</li>
        <li>A request that carries a key is never served from cache. Its answer is <code>cache-control: private, no-store</code>.</li>
      </ul>
      <p>These are the public graph's settings. A deployment can set its own cache times, or restrict CORS to a list of origins, in which case public reads are no longer stored in shared caches.</p>
      <h2 id="limits">The anonymous rate limit</h2>
      <p>Requests without a recognised credential are limited to 300 a minute per IP address. Every counted response carries <code>RateLimit-Policy: 300;w=60</code>. Past the limit the answer is <code>429</code> with <code>Retry-After</code> in seconds:</p>
      <Code label="429">{`{
  "error": {
    "code": "ANONYMOUS_RATE_LIMITED",
    "message": "Requests without credentials are limited to 300 requests per minute per IP address. …",
    "request_id": "…"
  }
}`}</Code>
      <p>The limit exists because an anonymous caller has no budget to bound its use, so a count per address stands in for one. Requests with a valid key are not counted; their bound is the account's balance. A made-up key is counted like no key. Each API instance counts separately, and reads answered from the edge cache are not counted at all, so treat 300 as the least you can rely on.</p>
      <h2 id="fields">Partial responses</h2>
      <p>Every <code>GET</code> that answers with a JSON object takes <code>fields</code>: a comma-separated list of dotted paths, at most 2,000 characters.</p>
      <ul>
        <li>A path keeps the value at it whole. <code>claim</code> keeps all of <code>claim</code>.</li>
        <li>A path through a list applies to each item: <code>results.id,results.text</code>.</li>
        <li>A path that matches nothing is left out. A null on the way stays null, so <code>assessment.status</code> on an unassessed claim answers <code>{"{"}"assessment": null{"}"}</code>.</li>
        <li>Malformed input, such as a stray comma, is a <code>400 VALIDATION_ERROR</code>.</li>
        <li>It does not apply to errors or to responses that are not JSON (BibTeX, Lean source, Atom feeds, exports). There it is checked and then ignored.</li>
      </ul>
      <p>When you trim a judgment, keep the claim's contestation, and its credence where one is stated. A status without the contestation beside it misreports the graph.</p>
      <h2 id="merged">Merged ids</h2>
      <p>When two nodes are merged, the absorbed id keeps working for reads. A <code>GET</code> on any <code>/claims/:claim_id/…</code> route answers for the surviving node and adds <code>resolved_from</code> to the JSON (kept even when <code>fields</code> trims everything else). Every such response, JSON or not, also carries the absorbed id in the <code>x-minerval-resolved-from</code> header.</p>
      <p>Check <code>resolved_from.stance_relation</code>. If it is <code>opposed</code>, the node was merged with its negation, and the survivor's verdict is about the opposite of what your id stated.</p>
      <p>A write to an absorbed id is refused with <code>409 CLAIM_MERGED</code>. The body names the survivor in <code>merged_into</code>. Read the survivor's wording before you resend, because after an opposed merge it says the opposite.</p>
      <p>The formal statement routes (<code>/formalization</code>, <code>/formalization.lean</code>, <code>/formalizations</code>) are the exception: they keep answering for the absorbed node's own statement.</p>
      <h2 id="writes">Writes are reviewed</h2>
      <p>Nothing you send changes the graph directly. A proposed claim, a submitted source, a stated view and a contribution each enter the review queue, and the Contribution Reviewer decides. The first three answer <code>202 Accepted</code>; a contribution answers <code>201</code> with <code>review_status: "pending"</code>.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th>Status</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>POST /claims/propose</code></td>
              <td className="dc-num">202</td>
              <td>Charged: capped at the <code>claim_proposal</code> cap, refunded in full if review rejects it</td>
            </tr>
            <tr>
              <td><code>POST /sources</code></td>
              <td className="dc-num">202</td>
              <td>Charged: capped at the <code>source_ingest</code> cap, refunded in full if review rejects it</td>
            </tr>
            <tr>
              <td><code>POST /claims/:claim_id/stated-views</code></td>
              <td className="dc-num">202</td>
              <td>Free; counts toward the hourly contribution limit</td>
            </tr>
            <tr>
              <td><code>POST /contributions</code></td>
              <td className="dc-num">201</td>
              <td>Free; counts toward the hourly contribution limit</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Code label="POST /claims/propose → 202">{`curl -X POST https://api.claimgraph.io/claims/propose \\
  -H "x-api-key: $MINERVAL_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"claim": "…", "kind": "claim"}'

{
  "contribution": {
    "id": "…",
    "contribution_type": "propose_claim",
    "review_status": "pending",
    "submitted_at": "…"
  },
  "message": "Proposal queued for review. …"
}`}</Code>
      <p>Follow any of them with <code>GET /contributions/:id</code> (<code>get_contribution_status</code>). Once a proposal is accepted it returns <code>became_claim_id</code> and <code>page_url</code>.</p>
      <p>A few other routes answer <code>202</code> because they start work and return before it finishes: a message to the Assistant or the Grantmaker, and a page analysis still running for the browser extension. Read the result from the resource the response names.</p>
      <h2 id="money">Routes that spend</h2>
      <p>Reads are free. A route that runs a model holds its operation's <b>cap</b> from your balance when the work starts, then returns whatever the run did not use once its metered cost is known. You never pay more than the cap. Routes that fund open-ended work escrow the budget you choose and return what is not spent. <Link href="/docs/owls">Owls and pricing</Link> has the figures.</p>
      <p>A charged route checks first that your balance covers the cap. If it does not, the answer is <code>402 INSUFFICIENT_OWLS</code>, with what you need to act on:</p>
      <Code label="402">{`{
  "error": "This operation (assessment) costs up to 2 owls (you pay the metered cost, never more than the cap) and your balance is 0.4. Buy owls from your account page …",
  "code": "INSUFFICIENT_OWLS",
  "cap_owls": 2,
  "entitlement": {
    "owl_balance": 0.4,
    "caps_owls": { "assessment": 2, "text_analysis": 0.1, … },
    "signup_grant_owls": 10,
    "monthly_grant_owls": 1,
    …
  },
  "packs": [{ "id": "owls_5", "owls": 5, "name": "Clutch", "price_cents": 2000, "discount_percent": 0 }, …]
}`}</Code>
      <p><code>packs</code> is present only where owls can be bought. The funding routes (escrow) answer a short balance with <code>402 INSUFFICIENT_OWLS</code> too, carrying the message and code only.</p>
      <h2 id="errors">Errors</h2>
      <p>Every refusal is JSON with a status code that means what HTTP says it means, a stable <code>code</code> to branch on, and a message written for the reader. Routes send that in one of two shapes, so read both:</p>
      <CodeTabs
        tabs={[
          { label: "Nested", code: `{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "fields has an empty path (a stray comma)",
    "details": [{ "path": "fields", "message": "fields has an empty path (a stray comma)" }],
    "request_id": "7916118c-…"
  }
}`, note: "Input that fails a route's schema, unknown routes, server faults, the anonymous rate limit, SQL refusals, and most refusals on claim, source and contribution routes. request_id is present on most of these; quote it when you report a problem." },
          { label: "Flat", code: `{
  "error": "Node 4b1e… was merged into 9c07…; address that node. …",
  "code": "CLAIM_MERGED",
  "merged_into": "9c07…",
  "stance_relation": "same"
}`, note: "Spending and funding refusals (402), mandates, grants, orders, budget jobs, requests, writes to a merged id, and permission refusals. Extra fields sit beside code at the top level." },
          { label: "Reading either", code: `const body = await res.json();
const err = typeof body.error === "string"
  ? { ...body, message: body.error }   // flat: extras at the top level
  : body.error;                       // nested: extras inside error
// err.code may be missing on a 401: see below`, note: "Branch on code and the HTTP status. Show the message to your user." },
        ]}
      />
      <p>Input errors come in two codes. A value the route's schema rejects (a malformed id, <code>depth=99</code>) is <code>400 REQUEST_ERROR</code>, with a message such as <code>querystring/depth must be {"<"}= 8</code>. A check a route makes itself, or a malformed <code>fields</code>, is <code>400 VALIDATION_ERROR</code> with <code>details</code> naming each path.</p>
      <p>A missing or unrecognised key is <code>401</code> with <code>{"{"}"error": "Invalid or missing API key"{"}"}</code> and no <code>code</code>.</p>
      <p>Over MCP, the same refusal is a tool error, always in one shape: <code>{"{"}"error": {"{"}"code", "message", "status", …{"}"}{"}"}</code>, where <code>status</code> is the HTTP status and the flat shape's extra fields are carried along. A refusal with no code arrives as <code>HTTP_401</code> and so on. <Link href="/docs/errors">All common codes →</Link></p>
    </DocPage>
  );
}
