import Link from "next/link";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Browser extension · Minerval docs",
  description: "Read any page with the graph switched on: the claims on it underlined by what the graph knows, the canonical claim and its status on hover, and the Assistant beside the article to ask about it.",
};

const toc = [
  { depth: 2, text: "What the underlines mean", slug: "marks" },
  { depth: 2, text: "What it costs", slug: "costs" },
  { depth: 2, text: "Chat", slug: "chat" },
  { depth: 2, text: "Shared analyses", slug: "shared" },
  { depth: 2, text: "Pages the graph has read", slug: "recorded" },
  { depth: 2, text: "Privacy", slug: "privacy" },
  { depth: 2, text: "The same data over MCP and REST", slug: "api" },
  { depth: 2, text: "On other deployments", slug: "deployments" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/extension"
      feature="extension"
      title="Browser extension"
      lede={<>Read any page with the graph switched on: the claims on it underlined by what the graph knows, the canonical claim and its status on hover, and the Assistant beside the article to ask about it.</>}
      toc={toc}
    >
      <p><a href="https://chromewebstore.google.com/detail/minerval/ojpdkgmlbffliefddfendfakpiiopkci">Install from the Chrome Web Store</a>. It runs in Chrome and other Chromium browsers (Edge, Brave, Arc) and updates itself.</p>
      <ol className="dc-steps">
        <li>
          <strong>Make a key</strong>
          <p>Sign in at minerval.ai and create an API key under <a href="https://minerval.ai/account#keys">Account, API keys</a>. Name it after the extension, so you can revoke it on its own.</p>
        </li>
        <li>
          <strong>Paste it in</strong>
          <p>Click the extension's icon, open <b>Settings</b>, and paste the key. It is kept in the browser's synced extension storage, so it follows your Chrome profile to other machines.</p>
        </li>
        <li>
          <strong>Analyse a page</strong>
          <p>Open an article and press <b>Analyze page</b> in the popup. A long page can take a few minutes the first time. Nothing is sent until you press it, unless you turn on automatic analysis for a site or for every site.</p>
        </li>
      </ol>
      <p>Some things work before you add a key: underlines on pages someone else already shared, and on pages the graph has read as sources (both below).</p>
      <h2 id="marks">What the underlines mean</h2>
      <p>An analysis extracts the claims a page makes, matches each to the graph, and an agent judges how the page words each one against what the graph knows. You choose how much of that is drawn:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Markup level</th>
              <th>Underlined</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Conservative (default)</td>
              <td>Only claims judged egregiously misleading or wrong as written, in red</td>
            </tr>
            <tr>
              <td>Moderate</td>
              <td>Also unsettled claims stated as settled, dotted</td>
            </tr>
            <tr>
              <td>Aggressive</td>
              <td>Also oversimplified and noteworthy claims</td>
            </tr>
            <tr>
              <td>Off</td>
              <td>Nothing</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Hover a mark for the canonical claim, its status in the graph and a one-line reason. Click it for the decomposition, the evidence and arguments on each side, and a link to the claim's page. Claims the analysis found that the graph does not hold get a faint grey dashed underline (switch it off in settings): nothing has judged them. On a page the graph has read as a source, the passages it took from the page get a thin blue underline that carries no verdict (<Link href="/docs/extension#recorded">below</Link>). Marks are drawn over the page and never change its text.</p>
      <p>The popup's <b>Page</b> tab says where the page stands: not analysed (and nothing sent), analysing, or what was found, for example "14 claims found · 3 in the graph · 11 new". From there you can tick new claims and press <b>Propose</b>, or use <b>Propose this claim</b> in a mark's panel. A proposal goes through the same review as one made on minerval.ai.</p>
      <h2 id="costs">What it costs</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Action</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Analysing a page</td>
              <td><span className="dc-pill dc-charged">charged</span> Needs a balance of at least 1 owl. 1 owl is held when the work starts; the unused part comes back once the metered cost is known. You never pay more than 1 owl. When the server still holds a result for the same address and text (it keeps one for up to an hour), no new model work is done and the whole owl comes back.</td>
            </tr>
            <tr>
              <td>Reading a shared analysis, or the passages the graph recorded from a page</td>
              <td><span className="dc-pill dc-read">free</span> no key needed</td>
            </tr>
            <tr>
              <td>Hovering and opening a claim</td>
              <td><span className="dc-pill dc-read">free</span></td>
            </tr>
            <tr>
              <td>Chat</td>
              <td><span className="dc-pill dc-charged">charged</span> at metered cost as each reply runs, with no cap. The cost is shown under each reply</td>
            </tr>
            <tr>
              <td>Proposing a claim</td>
              <td><span className="dc-pill dc-charged">charged</span> The claim-proposal cap is held when you propose (the popup shows it with your balance). It returns in full if review declines the claim. If the claim is accepted it pays for its first assessment, and the unused part returns.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>With too few owls the analysis is refused with <code>402 INSUFFICIENT_OWLS</code>, and the answer states the cap and your balance. <Link href="/docs/owls">Owls and pricing →</Link></p>
      <h2 id="chat">Chat</h2>
      <p>The <b>Chat</b> tab is the Minerval Assistant, the same agent as <a href="https://minerval.ai/ask">minerval.ai/ask</a>, opened from the page you are on. It is told the page's address and title and what the extension found there, reads the graph, and answers with citations to claims. The marks on a page are its own: when a page is analysed, the Assistant gives each matched claim its verdict in a single call, so in the chat it can say why a passage was marked and look further than that call did. <b>Stop</b> ends a reply that is running, and the reply is also stopped when your balance reaches zero.</p>
      <p>If the Assistant prepares something that would spend owls on the graph or publish under your name (proposing a claim, funding work), nothing happens from the extension: the reply says an action is waiting and links to minerval.ai, where you run or decline it. An API key cannot release such an action. The exception is a kind of action you have allowed, on minerval.ai, to run without asking in every conversation: it runs at once.</p>
      <p>Each browser tab keeps its own conversation for the page it is on, and <b>New</b> starts another. Every conversation is saved in your account and listed on minerval.ai/ask, where you can continue or delete it. Press <b>⇥</b> in the popup's header to move the chat to the browser's side panel, which stays open while you read (Chrome 114 or later, Edge or Brave).</p>
      <h2 id="shared">Shared analyses</h2>
      <p>When one reader analyses a public page, the next reader of that page sees the result at once, with no click and no charge. The popup says "Checked by another reader on" and the date, and <b>Re-analyze</b> runs a fresh check.</p>
      <ul>
        <li><b>Which pages.</b> After an analysis you agreed to share, the server fetches the page itself, signed out, and keeps the result only if at least 80% of the claims' phrases are on that copy. An inbox, a logged-in view or a paywalled article fails that test, so it is never shared. The extension never offers a page whose text is mostly in an editor or text box. Sharing is on by default; switch it off for one page in the Page tab, or for all pages in settings.</li>
        <li><b>What is kept.</b> The normalised address, and for each claim the short phrase it was found in, the verdict with its one-line reason and the Assistant's confidence in it, the stance, and the matched claim's id (or, for a claim the graph does not hold, its proposed neutral wording). Not the page's text or title, and not who analysed it. Claim statuses are not stored: they are read from the graph each time the analysis is served, so they are current.</li>
        <li><b>How a page is looked up.</b> On each page the extension sends only the first four hex characters of a hash of the address, with no key and no cookies, and gets back every stored hash in that bucket. It asks for a result only when the page's full hash is in the answer. Turn lookups off with <b>Show what's already known about a page</b>.</li>
      </ul>
      <h2 id="recorded">Pages the graph has read</h2>
      <p>Many pages are already in the graph as sources: someone submitted them, a mandate's research read them, or a Steward cited them. On such a page the extension underlines each passage the graph took from it, attached to the claim, quantity or question the passage states, with no click, no charge and no key. A hover shows how the page stands toward the node (states it, argues against it, asks it, only refers to it) and the graph's current status. These marks judge nothing about how the page words it, so they never count toward the toolbar badge. They arrive through the same four-character lookup, and everything they show is already public on the source's page. A document read at another address, such as a paper's PDF when you are on its abstract page, is not recognised.</p>
      <h2 id="privacy">Privacy</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>What leaves the browser</th>
              <th>What is kept</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Opening any page, with lookups on</td>
              <td>Four hex characters of a hash of its address, without your key</td>
              <td>Nothing</td>
            </tr>
            <tr>
              <td>Analysing a page</td>
              <td>Its address, title and readable text (up to 200,000 characters), with your key</td>
              <td>The result, in the server's memory for an hour; a metering row per model call (agent, model, tokens, cost). The text is not written to the database</td>
            </tr>
            <tr>
              <td>Opening a mark's panel</td>
              <td>The claim's id, without your key</td>
              <td>Nothing</td>
            </tr>
            <tr>
              <td>Sharing, after an analysis of a public page</td>
              <td>Nothing more</td>
              <td>What "Shared analyses" lists above</td>
            </tr>
            <tr>
              <td>Chat</td>
              <td>Your question, and with the first one the page's address, title and the passages the extension marked</td>
              <td>The conversation, in your account, until you delete it. Never the page's text</td>
            </tr>
            <tr>
              <td>Proposing a claim</td>
              <td>The claim in its neutral wording, and your note if you write one</td>
              <td>The proposal, as any proposal. Not the page's address, title or text</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>On the public graph the analysis runs off the run log: no agent run, no transcript, no source and no claim instance is written from a page. A deployment that keeps its run log as a record (<code>RUN_LOG_MODE=record</code>) logs those runs, private to the reader, and still writes no source from them. The site's <a href="https://minerval.ai/privacy">privacy policy</a> states this in full.</p>
      <h2 id="api">The same data over MCP and REST</h2>
      <p><code>get_page_analysis</code> takes a page's URL and returns what the graph holds about it: a shared analysis, the passages it recorded, or both. It is free. A page with neither answers <code>NOT_SHARED</code>; <code>assess_text</code> on the page's text is the way to check it. <code>get_page_claims</code> takes the ids of nodes that passages were matched to and returns what the graph holds on each now, in the shape a verdict on a page's wording is judged from; it is free too. The extension's own routes:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>POST /extension/analyze</code></td>
              <td>Start or join an analysis (<code>url</code>, <code>title</code>, <code>content</code>, <code>share</code>). <code>200</code> with the result if it finishes within 20 seconds or was cached; otherwise <code>202</code> with <code>content_hash</code>. Key required, charged</td>
            </tr>
            <tr>
              <td><code>GET /extension/analysis/:content_hash</code></td>
              <td>Poll a started analysis. Key required, free</td>
            </tr>
            <tr>
              <td><code>GET /extension/shared?prefix=abcd</code></td>
              <td>The hashes in a four-character bucket: <code>hashes</code> (shared analyses) and <code>recorded</code> (pages read as sources). No key</td>
            </tr>
            <tr>
              <td><code>GET /extension/shared/:url_hash</code>, <code>GET /extension/recorded/:url_hash</code></td>
              <td>One page's shared analysis, or its recorded passages, by the SHA-256 of its normalised address. No key</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="deployments">On other deployments</h2>
      <p>The extension's API is a feature a deployment can switch off (<code>extension</code> in <code>FEATURES_OFF</code>). Where it is off, the <code>/extension</code> routes and <code>get_page_analysis</code> do not exist. <code>list_features</code> (<code>GET /setup/features</code>) says whether it is on; it is on for the public graph. The extension talks to <code>https://api.claimgraph.io</code> unless a developer sets another address under <b>Settings → Developer</b>. <Link href="/docs/self-hosting">Self-hosting →</Link></p>
    </DocPage>
  );
}
