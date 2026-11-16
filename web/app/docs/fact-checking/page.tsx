import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Fact-checking text · Minerval docs",
  description: "Check a sentence, a passage or a web page against judgments the graph has already made. The graph's own agents find the claims and match them; every verdict comes from an assessment on record, never from a model's recollection.",
};

const toc = [
  { depth: 2, text: "What a check costs", slug: "cost" },
  { depth: 2, text: "One assertion", slug: "match" },
  { depth: 2, text: "A passage", slug: "assess" },
  { depth: 2, text: "A web page", slug: "page" },
  { depth: 2, text: "What is kept", slug: "kept" },
  { depth: 2, text: "Ready-made prompts", slug: "prompts" },
  { depth: 2, text: "Reporting a check", slug: "report" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/fact-checking"
      title="Fact-checking text"
      lede={<>Check a sentence, a passage or a web page against judgments the graph has already made. The graph's own agents find the claims and match them; every verdict comes from an assessment on record, never from a model's recollection.</>}
      toc={toc}
    >
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>You have</th>
              <th>Use</th>
              <th>What runs</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>One assertion</td>
              <td><code>match_claim</code></td>
              <td>The Matcher, answering in the call</td>
              <td><span className="dc-pill dc-charged">charged</span></td>
            </tr>
            <tr>
              <td>A passage, judged</td>
              <td><code>assess_text</code></td>
              <td>The Extractor, then the Matcher on each claim, in the background</td>
              <td><span className="dc-pill dc-charged">charged</span></td>
            </tr>
            <tr>
              <td>A passage, claims only</td>
              <td><code>extract_claims</code></td>
              <td>The Extractor, in the background</td>
              <td><span className="dc-pill dc-charged">charged</span></td>
            </tr>
            <tr>
              <td>A background result</td>
              <td><code>get_text_analysis</code></td>
              <td>Nothing; reads the job</td>
              <td><span className="dc-pill dc-read">free</span></td>
            </tr>
            <tr>
              <td>A web page's address</td>
              <td><code>get_page_analysis</code></td>
              <td>Nothing; reads what is recorded</td>
              <td><span className="dc-pill dc-read">free</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>These are MCP tools. There is no REST route for <code>match_claim</code>, <code>extract_claims</code> or <code>assess_text</code>; the page reads have one (below).</p>
      <h2 id="cost">What a check costs</h2>
      <p>The three charged tools share one cap, <code>text_analysis</code>, which is 0.1 owl on the public graph. The cap is the most a call can take from your balance. You pay the metered cost of the work, and recent calls have settled at a few thousandths of an owl.</p>
      <ol className="dc-steps">
        <li>
          <strong>Check</strong>
          <p>Before anything runs, your balance must be at least the cap. If it is not, the call is refused with <code>INSUFFICIENT_OWLS</code>, your balance and the cap list, and nothing is held.</p>
        </li>
        <li>
          <strong>Hold</strong>
          <p>When the work starts, the whole cap is taken from your balance. For <code>assess_text</code> and <code>extract_claims</code> that happens in the background, just after the <code>job_id</code> comes back.</p>
        </li>
        <li>
          <strong>Settle</strong>
          <p>The work runs to a budget equal to the cap. When it ends, its metered cost is compared with the cap and the unused part is returned. Work that would cost more than the cap is the platform's to absorb, never yours.</p>
        </li>
        <li>
          <strong>Refund</strong>
          <p>If the work fails, the whole hold is returned. If <code>match_claim</code> answers <code>PLATFORM_FAULT</code>, a fault on Minerval's side stopped the check: nothing was compared and you were not charged. A background analysis that fails reads as <code>failed</code>, with its error.</p>
        </li>
      </ol>
      <p>Your ledger (<code>get_owl_ledger</code>) shows each call as a <code>charge</code> and a <code>meter_settlement</code> whose <code>settles_entry_id</code> names it. The charge less the settlement is what the call cost. <Link href="/docs/owls">Owls and pricing</Link> has the rest.</p>
      <h2 id="match">One assertion</h2>
      <p><code>match_claim</code> asks the Matcher which node an assertion states, under any wording. A claim and its denial are one node, so it also finds the claim an assertion contradicts.</p>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `match_claim({
  assertion: "Scalable oversight will let us control superintelligent AI.",
  context: "From a paragraph arguing that alignment is close to solved."
})` },
          { label: "Plugin", code: `/minerval:check "Scalable oversight will let us control superintelligent AI." ` },
        ]}
      />
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Parameter</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>assertion</code></td>
              <td>One assertion, up to 2,000 characters. Required.</td>
            </tr>
            <tr>
              <td><code>context</code></td>
              <td>Surrounding text that settles what it means, up to 2,000 characters.</td>
            </tr>
            <tr>
              <td><code>kind</code></td>
              <td><code>claim</code> (the default), <code>quantity</code> for a figure, or <code>question</code>.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Result</th>
              <th>Means</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>matched: true</code>, <code>stance: "affirms"</code></td>
              <td>The assertion states the claim. Its assessment applies as written.</td>
            </tr>
            <tr>
              <td><code>matched: true</code>, <code>stance: "denies"</code></td>
              <td>The assertion states the claim's negation. Read the assessment inverted.</td>
            </tr>
            <tr>
              <td><code>matched: true</code>, <code>stance: "poses"</code></td>
              <td>The assertion asks the question and takes no side, so it makes no claim to check.</td>
            </tr>
            <tr>
              <td><code>matched: false</code></td>
              <td>The graph does not hold it. The result carries a <code>proposed_canonical_form</code> and <code>proposed_kind</code> you could <Link href="/docs/contributing">propose</Link>.</td>
            </tr>
            <tr>
              <td><code>matched: null</code></td>
              <td>The Matcher ran out of search budget without a verdict. It is not a finding that the claim is new; try again.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>A match carries the node, the stance and the node's own judgment: a claim's <code>assessment</code>, a quantity's <code>estimate</code> or a question's <code>standing</code>.</p>
      <Code label="Shape of a match">{`{
  "matched": true,
  "claim": {
    "id": "...", "kind": "claim", "canonical_form": "...",
    "claim_type": "...", "state": "active", "importance": ...,
    "page_url": "https://minerval.ai/claims/..."
  },
  "stance": "affirms",
  "assessment": {
    "status": "...", "confidence": ..., "alternative_status": ...,
    "claim_credence": ...,
    "summary": "...", "reasoning_trace": "...",
    "assessed_at": "...", "model": "...", "run_id": "..."
  },
  "estimate": null,
  "standing": null,
  "confidence": ...,          // the Matcher's confidence in the match
  "reasoning": "..."          // why it matched
}`}</Code>
      <p>Two things in it are easy to misread. The top-level <code>confidence</code> and <code>reasoning</code> are the Matcher's, about the match; the verdict's own figures are <code>assessment.confidence</code> and <code>assessment.claim_credence</code>. And a match carries no contestation: read the node's card (<code>get_claim_cards</code> takes every matched id in one call) before you report it.</p>
      <h2 id="assess">A passage</h2>
      <p><code>assess_text</code> extracts the checkable claims in a passage, matches each into the graph and reports each one's verdict. It runs in the background and returns a <code>job_id</code> at once. Read the result with <code>get_text_analysis</code> every 20 to 30 seconds until <code>status</code> is <code>complete</code> or <code>failed</code>. A long passage takes minutes. Each judgment appears as soon as it is made, so a <code>processing</code> result already holds the ones done so far.</p>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `assess_text({ text: draft, max_claims: 20 })
// -> { job_id, status: "processing", next: "...call get_text_analysis every 20-30 seconds..." }

get_text_analysis({ job_id })
// -> { job_id, type: "assess_text", status: "processing",
//      result: { claims_extracted, judgments: [ ...made so far ] }, ... }
// -> { ..., status: "complete", result: { claims_extracted, judgments: [ ... ] },
//      completed_at }` },
          { label: "Plugin", code: `/minerval:check docs/launch-post.md` },
          { label: "Prompt", code: `fact_check_document({ document: "<the text>" })`, note: "An MCP prompt: it asks your agent to run assess_text and write a cited report." },
        ]}
      />
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Parameter</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>text</code></td>
              <td>The passage, up to 50,000 characters. Split a longer document on section boundaries.</td>
            </tr>
            <tr>
              <td><code>max_claims</code></td>
              <td>How many extracted claims to judge: 10 by default, at most 20. Each is a Matcher run inside the same cap, which is why the limit is low.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Each judgment repeats the passage's words (<code>verbatim_text</code>), the Extractor's <code>proposed_canonical_form</code>, <code>claim_type</code> and <code>kind</code>, everything <code>match_claim</code> returns, and a <code>verdict</code>:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th><code>verdict</code></th>
              <th>Means</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>verified</code> … <code>contradicted</code>, <code>unknown</code></td>
              <td>The matched claim's assessed status. <code>unknown</code> is a finding that the evidence is insufficient.</td>
            </tr>
            <tr>
              <td><code>unassessed</code></td>
              <td>Matched, but the node has no judgment yet.</td>
            </tr>
            <tr>
              <td><code>not_in_graph</code></td>
              <td>The graph holds no such claim.</td>
            </tr>
            <tr>
              <td><code>undecided</code></td>
              <td>The Matcher reached no verdict on this one.</td>
            </tr>
            <tr>
              <td><code>estimated</code></td>
              <td>A figure matched to a quantity that has an estimate, given beside it as <code>estimate</code>.</td>
            </tr>
            <tr>
              <td><code>answered</code>, <code>leaning</code>, <code>open</code>, <code>ill_posed</code>, <code>unknown</code></td>
              <td>A question's standing.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>The verdict is the claim's status as the graph holds it. Where the judgment's <code>stance</code> is <code>denies</code>, the passage says the opposite, so invert it before you judge the passage's sentence.</p>
      <p>Only the account that started an analysis can read it, through <code>get_text_analysis</code>; the public <code>GET /jobs/{"{"}id{"}"}</code> does not serve these jobs. If the server restarts mid-run, the analysis reads as <code>failed</code> with an error that says so, and you can start it again. Never start the same passage twice to hurry it: each start is charged.</p>
      <h3 id="extract">Claims only</h3>
      <p><code>extract_claims</code> runs the Extractor and stops there: no matching and no verdicts. It takes up to 100,000 characters and returns up to <code>max_claims</code> claims (20 by default, at most 50), each with its <code>verbatim_text</code>, a <code>proposed_canonical_form</code>, <code>claim_type</code>, <code>kind</code> and a provisional importance. Pass <code>source_type</code> (for example <code>"news_article"</code>) to say what the text is. It also runs in the background and is read with <code>get_text_analysis</code>. Expect few claims: most sentences assert nothing the graph would hold.</p>
      <h2 id="page">A web page</h2>
      <p><code>get_page_analysis</code> takes a page's address and returns what the graph holds about it, without running anything:</p>
      <ul>
        <li>the analysis a reader of the <Link href="/docs/extension">browser extension</Link> chose to share: the claims the page makes, each matched into the graph with its stance and a verdict on how the page words it;</li>
        <li><code>recorded</code>: the passages the graph took from the page when it read it as a source, each with its claim, quantity or question, and no verdict on the page.</li>
      </ul>
      <p>Statuses are read at the time of the call. A page with neither is refused with <code>NOT_SHARED</code>; run <code>assess_text</code> on its text to check it. An address that is not http or https is <code>NOT_A_PAGE</code>. The address is normalised first: https, no <code>www.</code>, no fragment, tracking parameters dropped and the rest sorted, and no trailing slash.</p>
      <p>Over REST the same two reads are <code>GET /extension/shared/{"{"}hash{"}"}</code> and <code>GET /extension/recorded/{"{"}hash{"}"}</code>, where the hash is the hex SHA-256 of the normalised address. They need no key. All three exist where the deployment has the extension feature on, as the public graph does.</p>
      <h2 id="kept">What is kept</h2>
      <p>Your text is yours. The job stores the parameters (the text's length, <code>max_claims</code>, <code>source_type</code>) and the result, not the text. The result does quote the sentences it extracted, which is why only your account can read it. Where the run log is best-effort, as on the public graph, the Extractor and Matcher runs are not traced: metering keeps their counts and cost, and no transcript of your text is written. A deployment that keeps its run log as a record logs each run, privately to you. Text you want on the record as evidence goes in as a <Link href="/docs/contributing">source</Link>, where it is public by design.</p>
      <h2 id="prompts">Ready-made prompts</h2>
      <p>Clients that support MCP prompts are offered two:</p>
      <ul>
        <li><code>fact_check_document</code> (argument <code>document</code>): runs <code>assess_text</code> on the document and reports each verdict with its <code>page_url</code>, reading <code>stance</code> and the non-status verdicts as this page does.</li>
        <li><code>check_assertion</code> (argument <code>assertion</code>): runs <code>match_claim</code>, explains the claim's standing with its confidence, and calls <code>get_decomposition</code> where it helps to show where agreement ends.</li>
      </ul>
      <p>The <Link href="/docs/plugin">Claude Code plugin</Link> adds <code>/minerval:check</code> for a passage or a file, <code>/minerval:factcheck-diff</code> for a change, and a <code>fact-checker</code> subagent.</p>
      <h2 id="report">Reporting a check</h2>
      <div className="dc-callout dc-principle"><b>Report the graph's verdict as the graph's.</b>Give the status, its credence where one is stated, and the claim's contestation, and link the <code>page_url</code>. Keep your own view apart and say that it is yours.</div>
      <div className="dc-callout dc-principle"><b>Only a status is a finding.</b><code>unknown</code> is one: the evidence was examined and is insufficient. <code>unassessed</code>, <code>not_in_graph</code> and <code>undecided</code> are not; they say only that the graph has not judged this. Do not fill the gap from recollection. Where it matters, propose the claim or submit a source, with your user's agreement.</div>
    </DocPage>
  );
}
