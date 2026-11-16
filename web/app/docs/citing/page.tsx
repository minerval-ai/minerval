import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Citing and embedding · Minerval docs",
  description: "Carry a claim out of the graph with its judgment intact: cite it in a bibliography, export it to a formal format, or show it on another site with its status and dispute. Every route on this page is a free read and needs no account.",
};

const toc = [
  { depth: 2, text: "Cite a claim", slug: "cite" },
  { depth: 2, text: "Export it", slug: "export" },
  { depth: 2, text: "Embed a claim", slug: "embed" },
  { depth: 2, text: "Reporting what you cite", slug: "report" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/citing"
      title="Citing and embedding"
      lede={<>Carry a claim out of the graph with its judgment intact: cite it in a bibliography, export it to a formal format, or show it on another site with its status and dispute. Every route on this page is a free read and needs no account.</>}
      toc={toc}
    >
      <h2 id="cite">Cite a claim</h2>
      <p><code>cite_claim</code> (<code>GET /claims/:claim_id/citation</code>) returns a conventional citation and the evidence record behind it. The author is Minerval. The citation names the claim's id and the version of the assessment in force when you asked (the JSON form also carries that assessment's id), so a reader can find the exact judgment you cited in <code>get_assessment_history</code> after the graph has moved on.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th><code>format</code></th>
              <th>Returns</th>
              <th>Content type</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>json</code> (default)</td>
              <td><code>citation</code> (plain text, BibTeX and CSL renderings, with the assessment's id, version, status and date) and <code>evidence_record</code>: the assessment with its reasoning, each argument with its premises, each source passage with its quote and stance, and a tally of disagreement</td>
              <td><code>application/json</code></td>
            </tr>
            <tr>
              <td><code>bibtex</code></td>
              <td>The BibTeX entry alone, ready for a <code>.bib</code> file</td>
              <td><code>application/x-bibtex</code></td>
            </tr>
            <tr>
              <td><code>csl</code></td>
              <td>The CSL JSON item alone</td>
              <td><code>application/vnd.citationstyles.csl+json</code></td>
            </tr>
          </tbody>
        </table>
      </div>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `cite_claim({
  "claim_id": "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071",
  "format": "bibtex"
})` },
          { label: "REST", code: `curl "https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071/citation?format=bibtex"` },
          { label: "Result", code: `@misc{minerval_claim_dc02e01f,
  author       = {{Minerval}},
  title        = {Scalable oversight can reliably control superintelligent AI systems.},
  year         = {2026},
  howpublished = {Minerval},
  url          = {https://w3id.org/minerval/claim/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071},
  urldate      = {2026-11-16},
  note         = {Claim dc02e01f-ce69-4dbe-ba36-ed0e2e90d071; assessment v3 (doubtful), assessed 2026-11-12}
}`, note: "Output for the claim above, 16 November 2026: a citation names the assessment version it cites." },
        ]}
      />
      <p>The same citation is on every claim page under <b>Cite this claim</b>, with copy buttons for each rendering and the full evidence record as a JSON download. With <code>format=json</code> you can trim the response with <code>fields</code>, as on any JSON read.</p>
      <p>A claim that has not been assessed still cites: the citation says so and carries no version. Cite it as the graph's wording of the proposition, not as a finding.</p>
      <h2 id="export">Export it</h2>
      <p>Four exports render what the graph already holds. Each is a plain <code>GET</code> with an MCP twin, and none is metered. Graph content is dedicated to the public domain under CC0, and the exports say so.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Route</th>
              <th>Format</th>
              <th>Use it for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>export_claim_nanopub</code></td>
              <td><code>/claims/:claim_id/nanopub</code></td>
              <td>Nanopublication: TriG by default, <code>?format=jsonld</code> for JSON-LD</td>
              <td>Linked-data and scholarly tooling. Claim, assessment and source passages in PROV-O, CiTO and Dublin Core, with Minerval's own terms for the rest</td>
            </tr>
            <tr>
              <td><code>export_claim_scasp</code></td>
              <td><code>/claims/:claim_id/scasp</code></td>
              <td>s(CASP) logic program, <code>text/x-prolog</code></td>
              <td>Asking a solver whether the claim follows from the premises the graph records. <code>max_depth</code> is 1 to 8, default 3, the same bound as <code>get_decomposition</code></td>
            </tr>
            <tr>
              <td><code>export_claim_mira</code></td>
              <td><code>/claims/:claim_id/mira</code></td>
              <td>MIRA graph, JSON-LD</td>
              <td>Research-attribution tools. A claim or a question with its evidence, sources, neighbouring nodes and requests, each with its creator</td>
            </tr>
            <tr>
              <td><code>get_formalization_lean</code></td>
              <td><code>/claims/:claim_id/formalization.lean</code></td>
              <td>Lean 4 source, <code>text/plain</code></td>
              <td>Outside solvers. The published formal statement verbatim, with <code>x-minerval-pin</code> and <code>x-minerval-source-hash</code> headers; <code>404 NO_FORMALIZATION</code> where the claim has none. See <Link href="/docs/prizes">Proofs and prizes</Link></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>The nanopublication and MIRA exports read the same evidence record as the citation, so the three cannot disagree. They omit a credence wherever the graph does not state one, and they resolve the graph's internal claim links to the claims' text. The formats are documented in <a href="https://github.com/minerval-ai/minerval/blob/main/docs/vocab.md">docs/vocab.md</a>, <a href="https://github.com/minerval-ai/minerval/blob/main/docs/scasp.md">docs/scasp.md</a> and <a href="https://github.com/minerval-ai/minerval/blob/main/docs/mira.md">docs/mira.md</a>.</p>
      <h2 id="embed">Embed a claim</h2>
      <p>An embed shows the graph's judgment as it stands when the page is viewed, and links back to the claim. Each claim page has the snippets under <b>Embed this claim</b>; they are built from the claim's id.</p>
      <CodeTabs
        tabs={[
          { label: "Card", code: `<blockquote class="minerval-claim" data-claim-id="dc02e01f-ce69-4dbe-ba36-ed0e2e90d071"><a href="https://minerval.ai/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071">Scalable oversight can reliably control superintelligent AI systems.</a></blockquote>
<script async src="https://minerval.ai/embed.js"></script>`, note: "Fits its column and sizes itself. Without the script it stays a quotation with its link." },
          { label: "Iframe", code: `<iframe src="https://minerval.ai/embed/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071" title="Minerval: Scalable oversight can reliably control superintelligent AI systems." width="480" height="200" style="border:0;max-width:100%" loading="lazy"></iframe>`, note: "Where scripts are not allowed. A fixed height; add ?theme=light or ?theme=dark to fix its colours." },
          { label: "Badge", code: `[![Minerval's judgment of this claim](https://minerval.ai/embed/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071/badge.svg)](https://minerval.ai/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071)`, note: "An image for a README or a forum post, in Markdown." },
          { label: "oEmbed", code: `curl "https://minerval.ai/oembed?url=https://minerval.ai/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071&maxwidth=400"`, note: "Returns a rich embed whose html is the iframe." },
        ]}
      />
      <p>Every form is drawn from the claim's card, so it reports the judgment whole: the status, dispute beside it when contestation is 0.3 or more (“actively disputed” from 0.6), the date of the last assessment, and an “as of” date for when it was served. A question shows its standing and a quantity its estimate. A node with no judgment reads as unassessed, never as a verdict. Verdict confidence is not shown. For the claim above the badge reads <i>doubtful · actively disputed</i>.</p>
      <div className="dc-claimcard">
        <span className="sc">Claim · AI Control</span>
        <div className="dc-card-text">Scalable oversight can reliably control superintelligent AI systems.</div>
        <div className="dc-card-row"><span className="dc-status dc-v-doubtful">doubtful</span><span className="dc-disputed">actively disputed</span><span>assessed 12 Nov 2026</span></div>
      </div>
      <h3 id="forms">The four forms</h3>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Form</th>
              <th>Address</th>
              <th>Details</th>
              <th className="dc-num">Cached</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Card page</td>
              <td><code>/embed/claims/:id</code></td>
              <td>One self-contained document that may be framed from any site and is kept out of search. <code>?theme=light</code> or <code>dark</code> fixes its colours; otherwise it follows the reader's colour scheme. It posts its height to the parent page.</td>
              <td className="dc-num">5 min</td>
            </tr>
            <tr>
              <td>Script</td>
              <td><code>/embed.js</code></td>
              <td>Replaces each <code>blockquote.minerval-claim</code> with the card page in an iframe and keeps the frame as tall as its content. The id comes from <code>data-claim-id</code>, or from a link to <code>/claims/:id</code> inside the quote. <code>data-theme</code> works as the query does. Safe to include more than once; for quotes added later, call <code>MinervalEmbed.scan()</code>.</td>
              <td className="dc-num">–</td>
            </tr>
            <tr>
              <td>Badge</td>
              <td><code>/embed/claims/:id/badge.svg</code></td>
              <td>One line in the status colours. Its title carries the full sentence and the “as of” date.</td>
              <td className="dc-num">10 min</td>
            </tr>
            <tr>
              <td>oEmbed</td>
              <td><code>/oembed?url=…</code></td>
              <td>JSON only (<code>format=json</code>, the default; any other format answers <code>501</code>). <code>url</code> must be a claim page on minerval.ai. The frame is 480px wide unless <code>maxwidth</code> is narrower; <code>maxheight</code> caps the estimated height, and the frame scrolls if the card needs more. Answers <code>cache_age: 600</code>.</td>
              <td className="dc-num">10 min</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>A claim that does not exist answers <code>404</code> with a notice card or badge, cached for a minute. If the site cannot reach the graph it answers <code>503</code> and caches nothing. An embed never falls back to sample data.</p>
      <h3 id="height">Sizing your own iframe</h3>
      <p>If you frame the card page without <code>embed.js</code>, listen for its height message. It is sent on load and whenever the card's height changes:</p>
      <Code label="JavaScript">{`window.addEventListener("message", (event) => {
  if (event.origin !== "https://minerval.ai") return;
  const { type, id, height } = event.data || {};
  if (type !== "minerval:embed:height") return;
  // id is the claim the frame shows; height is in CSS pixels
  document.querySelector(\`iframe[data-claim="\${id}"]\`).style.height = \`\${Math.ceil(height)}px\`;
});`}</Code>
      <p>Check the origin as above: the card page sends the message to any parent, since it says only which claim and how tall.</p>
      <h2 id="report">Reporting what you cite</h2>
      <div className="dc-callout dc-principle"><b>Quote the judgment whole, and date it.</b>“Minerval rates this doubtful (credence 0.08) and actively disputed, as of 12 November 2026”, with the link. A citation pins one assessment; an embed shows the current one. Say which you are giving, and keep the graph's view apart from your own.</div>
    </DocPage>
  );
}
