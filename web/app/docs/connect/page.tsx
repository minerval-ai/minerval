import Link from "next/link";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Connect an agent · Minerval docs",
  description: "Minerval is a remote MCP server at https://api.claimgraph.io/mcp. Add it to your client, sign in once, and your agent can read the graph, check text against it and add to it.",
};

const toc = [
  { depth: 2, text: "How the connection works", slug: "connection" },
  { depth: 2, text: "Where to go next", slug: "next" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/connect"
      title="Connect an agent"
      lede={<>Minerval is a remote MCP server at <code>https://api.claimgraph.io/mcp</code>. Add it to your client, sign in once, and your agent can read the graph, check text against it and add to it.</>}
      toc={toc}
    >
      <ol className="dc-steps">
        <li>
          <strong>Add the server</strong>
          <p>Pick your client. Each tab gives the whole setup.</p>
          <CodeTabs
            tabs={[
              { label: "Claude Code", code: `claude mcp add --transport http minerval https://api.claimgraph.io/mcp`, note: "Then run /mcp inside Claude Code and authenticate the minerval server. Your browser opens the Minerval sign-in page." },
              { label: "Claude.ai / Cowork", code: `Settings → Connectors → Add custom connector
  Name  Minerval
  URL   https://api.claimgraph.io/mcp`, note: "Leave the OAuth client ID and secret empty. The connector registers itself and opens the Minerval sign-in page." },
              { label: "Plugin", code: `/plugin marketplace add minerval-ai/minerval
/plugin install minerval@minerval`, note: "For Claude Code and Cowork. It adds the same server, plus slash commands, a fact-checker subagent and the caller skills. With no API key set, it signs you in through the browser; run /mcp to sign in again." },
              { label: "Cursor", code: `// ~/.cursor/mcp.json
{
  "mcpServers": {
    "minerval": {
      "url": "https://api.claimgraph.io/mcp",
      "headers": { "x-api-key": "<your key>" }
    }
  }
}`, note: "Uses an API key from your account page." },
              { label: "API key", code: `claude mcp add --transport http minerval https://api.claimgraph.io/mcp \\
  --header "x-api-key: $MINERVAL_API_KEY"

# The plugin reads the same variable:
export MINERVAL_API_KEY=<your key>`, note: "For any client that lets you set a header. The server also accepts the key as Authorization: Bearer <key>." },
              { label: "Other clients", code: `Endpoint   POST https://api.claimgraph.io/mcp
Transport  streamable HTTP, stateless, JSON responses
Auth       OAuth 2.1, discovered from the 401 challenge
           or an API key in x-api-key`, note: "GET and DELETE return 405: there is no event stream and no session." },
            ]}
          />
        </li>
        <li>
          <strong>Sign in</strong>
          <p>The first call without a credential gets a 401 that points your client to Minerval's sign-in. The client registers itself, opens the consent page on minerval.ai, and you sign in and approve. From then on it holds a token that it renews on its own.</p>
          <p>If your client can set a header, you can use an API key instead. Create one under API keys on your <a href="https://minerval.ai/account">account page</a>. <Link href="/docs/auth">Authentication →</Link></p>
        </li>
        <li>
          <strong>Ask something the graph holds</strong>
          <p>Choose a question in an area the graph has mapped. A good agent searches, reads the card, then walks the decomposition to find what the verdict turns on.</p>
          <div className="dc-transcript" aria-label="Example session">
            <div><span className="dc-who">You</span>Can scalable oversight keep superintelligent AI under control? Check Minerval.</div>
            <div className="dc-call"><b>search_claims</b>({"{"} query: "scalable oversight control superintelligence", limit: 5 {"}"})</div>
            <div className="dc-call"><b>get_claim_card</b>({"{"} claim_id: "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071" {"}"})</div>
            <div className="dc-call"><b>get_decomposition</b>({"{"} claim_id: "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071", max_depth: 1 {"}"})</div>
            <div><span className="dc-who">Agent</span>Minerval rates the claim that scalable oversight can reliably control superintelligent AI systems as <b>doubtful</b>, with credence 0.08, and records it as actively disputed (contestation 0.7). The claim requires that oversight protocols remain effective against AI systems that deliberately deceive their overseers, and the graph rates that premise <b>doubtful</b> (credence 0.15). The main line in favour, that AI debate lets less capable judges supervise more capable debaters, is <b>inconclusive</b> (credence 0.35). Against it, that oversight success declines as the capability gap grows is <b>supported</b> (credence 0.77). One premise beneath the claim has been judged again since this assessment was written. <a href="https://minerval.ai/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071">minerval.ai/claims/dc02e01f…</a></div>
          </div>
          <p>The answer gives each status with its credence, keeps contestation apart from the status, names the premise the verdict turns on, and links the claim's page. The agent's own view, if you ask for it, comes after this and is labelled as its own.</p>
        </li>
        <li>
          <strong>Know what costs owls</strong>
          <p>Reading the graph is free. Tools that run a model on your text, such as <code>match_claim</code> and <code>assess_text</code>, hold a capped charge from your balance when they start and return what the metered cost did not use. Work you commission is escrowed, and what it does not spend comes back. On the public graph, new accounts start with 11 owls (10 for signing up and 1 for the month), and another lands in each later month the account is used. <Link href="/docs/owls">Owls and pricing →</Link></p>
        </li>
      </ol>
      <h2 id="connection">How the connection works</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Part</th>
              <th>What happens</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Endpoint</td>
              <td><code>POST /mcp</code>, stateless JSON-RPC over streamable HTTP. Each call stands alone, so there is no session to resume.</td>
            </tr>
            <tr>
              <td>Discovery</td>
              <td>A call with no credential gets <code>401</code> with <code>WWW-Authenticate: Bearer resource_metadata="https://api.claimgraph.io/.well-known/oauth-protected-resource/mcp"</code>.</td>
            </tr>
            <tr>
              <td>Registration</td>
              <td>Clients register themselves at <code>POST /oauth/register</code>. Redirect URIs must be https, or http on localhost.</td>
            </tr>
            <tr>
              <td>Sign-in</td>
              <td>Authorization code with PKCE (S256 only). The consent page is on minerval.ai.</td>
            </tr>
            <tr>
              <td>Tokens</td>
              <td>Access tokens last 1 hour. Refresh tokens last 30 days and are replaced on each use; presenting a used one revokes the whole grant.</td>
            </tr>
            <tr>
              <td>Scope</td>
              <td>A token works on <code>/mcp</code> only. The REST API refuses it with <code>403 INSUFFICIENT_SCOPE</code>; use an API key there.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Through MCP an account can do everything it can do through the REST API, unless a stated reason excludes a route. Each tool's description says what it costs. In a <Link href="/docs/members-only">members-only deployment</Link>, a key or token also works at the one label chosen when it was created.</p>
      <h2 id="next">Where to go next</h2>
      <ul>
        <li><Link href="/docs/concepts">Core concepts</Link>: the vocabulary every tool uses.</li>
        <li><Link href="/docs/reading">Reading a claim</Link>: cards, the full record, and walking the tree.</li>
        <li><Link href="/docs/fact-checking">Fact-checking text</Link>: one assertion, a passage, or a web page.</li>
        <li><Link href="/docs/plugin">Claude Code plugin</Link>: the slash commands, the subagent and the opt-in hook.</li>
        <li><Link href="/docs/tools">MCP tools</Link>: every tool, with its REST route and what it costs.</li>
      </ul>
    </DocPage>
  );
}
