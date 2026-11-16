import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Authentication · Minerval docs",
  description: "Read the graph with no credentials at all, connect a hosted MCP client through OAuth, or send an API key from anything where you set the headers. Every authenticated call is attributed to one account.",
};

const toc = [
  { depth: 2, text: "Reading without credentials", slug: "anonymous" },
  { depth: 2, text: "OAuth 2.1 for hosted MCP clients", slug: "oauth" },
  { depth: 2, text: "API keys", slug: "keys" },
  { depth: 2, text: "When a credential is refused", slug: "refused" },
  { depth: 2, text: "In a members-only deployment", slug: "labels" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/auth"
      title="Authentication"
      lede={<>Read the graph with no credentials at all, connect a hosted MCP client through OAuth, or send an API key from anything where you set the headers. Every authenticated call is attributed to one account.</>}
      toc={toc}
    >
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>You are using</th>
              <th>Credential</th>
              <th>Where it works</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A browser page or script that only reads</td>
              <td>None</td>
              <td>Public REST reads. Not <code>/mcp</code></td>
            </tr>
            <tr>
              <td>Claude.ai, Cowork, or Claude Code with no key set</td>
              <td>OAuth access token (<code>eoat_…</code>), obtained for you</td>
              <td><code>/mcp</code> only</td>
            </tr>
            <tr>
              <td>Claude Code with a key, a CLI, a server, the browser extension</td>
              <td>API key (<code>epk_…</code>)</td>
              <td><code>/mcp</code> and every REST route an account can call</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="anonymous">Reading without credentials</h2>
      <p>The public REST reads need no key. They answer with <code>access-control-allow-origin: *</code>, so a page on any site can call them from the browser. The headers a page may send are <code>Content-Type</code>, <code>Authorization</code> and <code>X-API-Key</code>, and a script can read <code>RateLimit-Policy</code> and <code>Retry-After</code> from the response.</p>
      <p>An anonymous read answered <code>200</code> is cacheable: <code>cache-control: public, max-age=60, stale-while-revalidate=300</code>, with a weak <code>ETag</code>. Send the tag back in <code>If-None-Match</code> and an unchanged answer comes back as <code>304</code> with no body. A request that carries any credential is answered <code>private, no-store</code>.</p>
      <Code label="A public read, as served">{`$ curl -sI "https://api.claimgraph.io/tags?limit=1"
HTTP/2 200
access-control-allow-origin: *
access-control-expose-headers: RateLimit-Policy, Retry-After
ratelimit-policy: 300;w=60
cache-control: public, max-age=60, stale-while-revalidate=300
vary: Authorization, X-API-Key
etag: W/"Wm70D5kbx9aL25OMz03IE46FlpA"`}</Code>
      <p>Requests without a recognised credential are limited to <b>300 a minute per IP address</b>. Every counted response states the limit in <code>RateLimit-Policy: 300;w=60</code>. Past it the answer is <code>429</code> with <code>Retry-After</code> (in seconds) and the code <code>ANONYMOUS_RATE_LIMITED</code>. An anonymous caller has no account or budget to bound its use, so a count per address stands in for one. A request with a recognised key or token is not counted. Each API instance keeps its own count, and reads the edge answers from its cache never reach one.</p>
      <p>The MCP endpoint always needs an account. An anonymous <code>POST /mcp</code> gets <code>401</code> with a challenge that points the client at the sign-in flow below:</p>
      <Code label="The challenge">{`HTTP/2 401
www-authenticate: Bearer resource_metadata="https://api.claimgraph.io/.well-known/oauth-protected-resource/mcp"

{"error":"Invalid or missing API key"}`}</Code>
      <h2 id="oauth">OAuth 2.1 for hosted MCP clients</h2>
      <p>The API is an OAuth 2.1 authorisation server for its own <code>/mcp</code> resource. A client that follows the MCP authorisation spec finds everything from the challenge above, so in Claude.ai or Cowork you add <code>https://api.claimgraph.io/mcp</code> as a custom connector and leave the client ID and secret empty. The client registers itself and opens the sign-in page.</p>
      <ol className="dc-steps">
        <li>
          <strong>Discovery</strong>
          <p><code>GET /.well-known/oauth-protected-resource</code> names the authorisation server; <code>GET /.well-known/oauth-authorization-server</code> describes it. Both are also served with <code>/mcp</code> appended, because clients derive the path both ways. Each is public and cached for an hour.</p>
        </li>
        <li>
          <strong>Registration</strong>
          <p><code>POST /oauth/register</code> (RFC 7591), with no credentials. <code>redirect_uris</code> (one to ten) must be <code>https</code>, or <code>http</code> on <code>localhost</code>, <code>127.0.0.1</code> or <code>[::1]</code>. <code>token_endpoint_auth_method</code> is <code>none</code> for a public client, or <code>client_secret_basic</code> (the default) or <code>client_secret_post</code>, in which case the answer carries a client secret (<code>eocs_…</code>) once.</p>
        </li>
        <li>
          <strong>Authorisation</strong>
          <p><code>GET /oauth/authorize</code> with <code>response_type=code</code> and PKCE: <code>code_challenge</code> is required and <code>code_challenge_method</code> must be <code>S256</code>. The only scope is <code>mcp</code>. The API checks the request and sends the browser to <code>minerval.ai/oauth/consent</code>.</p>
        </li>
        <li>
          <strong>Consent</strong>
          <p>The person signs in on minerval.ai if they are not already, sees the client's name and where it will send them back, and approves or denies. Approving needs a signed-in session. The page says what the client will be able to do: read the graph, propose claims and submit sources, contributions and appeals in the person's name, and spend owls from their balance. It cannot buy owls or manage API keys.</p>
        </li>
        <li>
          <strong>Tokens</strong>
          <p><code>POST /oauth/token</code> with <code>grant_type=authorization_code</code>, the code, the <code>redirect_uri</code> and the <code>code_verifier</code>. Later, <code>grant_type=refresh_token</code>.</p>
        </li>
      </ol>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Prefix</th>
              <th>Lasts</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Pending authorisation (authorize to consent)</td>
              <td />
              <td>10 minutes</td>
            </tr>
            <tr>
              <td>Authorisation code</td>
              <td><code>eoac_</code></td>
              <td>5 minutes, one use</td>
            </tr>
            <tr>
              <td>Access token</td>
              <td><code>eoat_</code></td>
              <td>1 hour (<code>expires_in: 3600</code>)</td>
            </tr>
            <tr>
              <td>Refresh token</td>
              <td><code>eort_</code></td>
              <td>30 days, replaced on every use</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Every refresh revokes the refresh token it was given and issues a new pair, so a client that refreshes at least once every 30 days stays connected. A refresh token that has already been used is treated as stolen: every token in that grant is revoked, the answer is <code>invalid_grant</code>, and the person has to approve the client again.</p>
      <div className="dc-callout"><b>Tokens work only on /mcp.</b>An access token is scoped <code>mcp</code> and bound to the MCP endpoint, which is what the person consented to. On a REST route it is refused with <code>403 INSUFFICIENT_SCOPE</code>. Every route an account can call is also an MCP tool, and the tool runs as the account that holds the token. Use an API key to call REST directly.</div>
      <h2 id="keys">API keys</h2>
      <p>Create a key on your account page, under <a href="https://minerval.ai/account#keys">API keys</a>. It starts <code>epk_</code> and is shown once, when it is made: copy it then. Make one for each place you use it, so each can be revoked on its own. The account page lists your keys by their first twelve characters with when each was last used and what its calls cost.</p>
      <CodeTabs
        tabs={[
          { label: "Claude Code", code: `claude mcp add --transport http minerval https://api.claimgraph.io/mcp \\
  --header "x-api-key: epk_…"` },
          { label: "MCP over HTTP", code: `curl https://api.claimgraph.io/mcp \\
  -H "Authorization: Bearer epk_…" \\
  -H "content-type: application/json" \\
  -H "accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`, note: "On /mcp a key may be sent as a Bearer token, for clients that can only set Authorization." },
          { label: "REST", code: `curl https://api.claimgraph.io/users/me \\
  -H "x-api-key: epk_…"`, note: "REST routes read the key from x-api-key only." },
        ]}
      />
      <p>Send the key in <code>x-api-key</code>. On <code>/mcp</code> it may instead go in <code>Authorization: Bearer {"<"}key{">"}</code>; REST routes read only <code>x-api-key</code>, and take a Bearer value only when it is an OAuth access token.</p>
      <p>Creating and revoking keys need a session signed in on the site, never a key. A key that leaked could otherwise mint more keys, or revoke yours. Buying owls is held the same way, so neither is an MCP tool. Listing your keys is (<code>list_api_keys</code>, <code>GET /api-keys</code>).</p>
      <h2 id="refused">When a credential is refused</h2>
      <p>A key the API does not recognise (mistyped, revoked, or made up) is not a credential. What happens depends on the route:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Case</th>
              <th>Answer</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>A public read that answers everyone the same, such as <code>GET /claims/:claim_id</code></td>
              <td>Answered as an anonymous read: counted against the address limit, and marked <code>private, no-store</code></td>
            </tr>
            <tr>
              <td>A route that needs an account, or a public read that looks at the caller when one is presented (such as <code>GET /contributions</code>, for <code>mine</code>)</td>
              <td><code>401</code> <code>{"{"}"error":"Invalid or missing API key"{"}"}</code></td>
            </tr>
            <tr>
              <td>An access token that is unknown, expired or revoked</td>
              <td><code>401</code> <code>Invalid or expired access token</code></td>
            </tr>
            <tr>
              <td>An access token on a REST route</td>
              <td><code>403 INSUFFICIENT_SCOPE</code></td>
            </tr>
            <tr>
              <td>A valid credential for a suspended account</td>
              <td><code>403 ACCOUNT_SUSPENDED</code></td>
            </tr>
            <tr>
              <td>Key creation, revocation or a purchase without a signed-in session</td>
              <td><code>403 SESSION_REQUIRED</code></td>
            </tr>
            <tr>
              <td>The token endpoint, with client authentication that fails</td>
              <td><code>401 invalid_client</code></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>On a route that exists, a <code>401</code> means the credential was not recognised: check the key, or sign the client in again. <Link href="/docs/errors">Errors →</Link></p>
      <h2 id="labels">In a members-only deployment</h2>
      <p>A members-only deployment serves nothing to a request without a credential: it answers <code>401 SIGN_IN_REQUIRED</code>, and <code>403 NOT_A_MEMBER</code> to an account that holds no permission there. The OAuth discovery, registration, authorise and token endpoints stay open, because a client has to reach them before it holds anything.</p>
      <p>Where such a deployment holds material at more than one label, each API key and each OAuth grant works at one label, named by the person when the key is made (<code>POST /api-keys</code> takes <code>label</code>) or when the client is approved (<code>POST /oauth/requests/:request_id/approve</code> takes <code>label</code>), and kept through every refresh. A request made with it reads what that label reads, within what the person may read, and files what it adds at that label and no other. An MCP client is told its connection's label in the server's instructions; <code>get_my_labels</code> says who reads it. A key made before the deployment had a second label works at <code>public</code>. <Link href="/docs/members-only">Members-only deployments →</Link></p>
    </DocPage>
  );
}
