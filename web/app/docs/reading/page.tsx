import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Reading a claim · Minerval docs",
  description: "Find a node, say where it stands, show why, and see what it turns on. Every read on this page is free, and over REST none of them needs a key.",
};

const toc = [
  { depth: 2, text: "Find a node", slug: "find" },
  { depth: 2, text: "Say where it stands", slug: "card" },
  { depth: 2, text: "Show why: the full record", slug: "full" },
  { depth: 2, text: "See what it turns on", slug: "walk" },
  { depth: 2, text: "Keep reads small", slug: "trim" },
  { depth: 2, text: "Merged ids", slug: "merged" },
  { depth: 2, text: "Reporting what you read", slug: "report" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/reading"
      title="Reading a claim"
      lede={<>Find a node, say where it stands, show why, and see what it turns on. Every read on this page is free, and over REST none of them needs a key.</>}
      toc={toc}
    >
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>You want</th>
              <th>MCP</th>
              <th>REST</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Nodes about a topic</td>
              <td><code>search_claims</code></td>
              <td><code>GET /claims/search/{"{"}query{"}"}</code></td>
            </tr>
            <tr>
              <td>Where one or many stand</td>
              <td><code>get_claim_card</code>, <code>get_claim_cards</code></td>
              <td><code>GET /claims/{"{"}id{"}"}/card</code>, <code>GET /claims/cards</code></td>
            </tr>
            <tr>
              <td>Why it stands there</td>
              <td><code>get_claim</code></td>
              <td><code>GET /claims/{"{"}id{"}"}</code></td>
            </tr>
            <tr>
              <td>What it rests on</td>
              <td><code>get_decomposition</code></td>
              <td><code>GET /claims/{"{"}id{"}"}</code> (its <code>tree</code>)</td>
            </tr>
            <tr>
              <td>What rests on it</td>
              <td><code>get_dependents</code></td>
              <td><code>GET /claims/{"{"}id{"}"}/dependents</code></td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="find">Find a node</h2>
      <p><code>search_claims</code> ranks by meaning and by keyword, so a node worded differently from your query still comes up. It finds claims, quantities and questions alike.</p>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `search_claims({
  query: "scalable oversight control superintelligence",
  kind: "claim",
  assessed: "assessed",
  limit: 5
})` },
          { label: "REST", code: `GET https://api.claimgraph.io/claims/search/scalable%20oversight%20superintelligence?kind=claim&assessed=assessed&limit=5`, note: "Over REST the query is part of the path. Rows name the wording `text` and carry no contestation; read the cards for it." },
          { label: "curl", code: `curl -s "https://api.claimgraph.io/claims/search/scalable%20oversight?limit=5\\
&fields=results.id,results.text,results.assessment_status,results.assessment_confidence" ` },
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
              <td><code>query</code></td>
              <td>What you are looking for. Required; up to 500 characters.</td>
            </tr>
            <tr>
              <td><code>limit</code></td>
              <td>Most results. 10 by default, at most 50. Over REST, 20 by default and at most 100.</td>
            </tr>
            <tr>
              <td><code>kind</code></td>
              <td><code>claim</code>, <code>quantity</code> or <code>question</code>.</td>
            </tr>
            <tr>
              <td><code>tag</code></td>
              <td>A topic slug, as results give it or <code>list_tags</code> finds it. An unknown slug matches nothing.</td>
            </tr>
            <tr>
              <td><code>assessed</code></td>
              <td><code>all</code> (the default), <code>assessed</code> or <code>unassessed</code>.</td>
            </tr>
            <tr>
              <td><code>min_importance</code></td>
              <td>0 to 1.</td>
            </tr>
            <tr>
              <td><code>claim_type</code></td>
              <td>One type, such as <code>empirical_verifiable</code>, <code>causal</code> or <code>mathematical</code>.</td>
            </tr>
            <tr>
              <td><code>with_prizes</code></td>
              <td>Only claims with a live prize on their formal statement.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Each MCP result carries enough to report from: the node's <code>kind</code>, its wording as <code>canonical_form</code>, importance, <code>contestation</code>, its judgment (<code>assessment_status</code> and <code>assessment_confidence</code> on a claim, <code>standing</code> on a question, <code>estimate</code> and <code>unit</code> on a quantity), <code>days_since_assessed</code>, <code>since_assessed</code>, its tags and its <code>page_url</code>. Live, the query above returns:</p>
      <Code label="search_claims result, trimmed">{`{
  "count": 5,
  "results": [
    {
      "id": "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071",
      "kind": "claim",
      "canonical_form": "Scalable oversight can reliably control superintelligent AI systems.",
      "claim_type": "evaluative",
      "importance": 0.75,
      "contestation": 0.7,
      "assessment_status": "doubtful",
      "assessment_confidence": 0.77,
      "days_since_assessed": 4,
      "since_assessed": { "changed": true, "premises_rejudged": 1 },
      "tags": [ { "slug": "ai-control", "name": "AI Control" }, ... ],
      "page_url": "https://minerval.ai/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071"
    },
    ...
  ]
}`}</Code>
      <p>To find the node a particular sentence states, use <Link href="/docs/fact-checking"><code>match_claim</code></Link>. It reads negation and wording that search cannot, and it is charged.</p>
      <h2 id="card">Say where it stands</h2>
      <p>A card is the graph's judgment of one node and nothing else. Its shape is fixed: every key is always present, and a value that does not exist yet is null. Use it when you will report, cite or embed a verdict and do not need the reasoning.</p>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `get_claim_card({ claim_id: "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071" })

get_claim_cards({ ids: "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071,e15a36f4-edf3-45c5-92d9-85fcefae5190" })` },
          { label: "REST", code: `GET https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071/card

GET https://api.claimgraph.io/claims/cards?ids=dc02e01f-ce69-4dbe-ba36-ed0e2e90d071,e15a36f4-edf3-45c5-92d9-85fcefae5190` },
        ]}
      />
      <Code label="get_claim_card, live">{`{
  "id": "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071",
  "kind": "claim",
  "text": "Scalable oversight can reliably control superintelligent AI systems.",
  "state": "active",
  "assessment_status": "doubtful",
  "assessment_confidence": 0.77,
  "assessment_alternative_status": null,
  "standing": null,
  "estimate": null,
  "unit": null,
  "contestation": 0.7,
  "assessed_at": "2026-11-12T00:21:16.842Z",
  "updated_at": "2026-11-13T00:12:26.240Z",
  "page_url": "https://minerval.ai/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071",
  "resolved_from": null
}`}</Code>
      <div className="dc-claimcard">
        <span className="sc">Claim · AI control</span>
        <div className="dc-card-text">Scalable oversight can reliably control superintelligent AI systems.</div>
        <div className="dc-card-row"><span className="dc-status dc-v-doubtful">doubtful</span><span className="dc-disputed">actively disputed</span><span>assessed 12 Nov 2026</span></div>
      </div>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>assessment_status</code></td>
              <td>A claim's status: <code>verified</code>, <code>supported</code>, <code>inconclusive</code>, <code>doubtful</code>, <code>contradicted</code> or <code>unknown</code>. Null while unassessed, and always null for a quantity or a question.</td>
            </tr>
            <tr>
              <td><code>assessment_confidence</code></td>
              <td>How sure the Steward is that the status (or a question's standing) is the right reading of the evidence. It is not the probability that the claim is true, and the site does not show it.</td>
            </tr>
            <tr>
              <td><code>assessment_alternative_status</code></td>
              <td>The other status the evidence could defensibly be given, where the Steward named one; otherwise null. Kept in the record and not shown on the site.</td>
            </tr>
            <tr>
              <td><code>standing</code></td>
              <td>A question's standing; null for other kinds.</td>
            </tr>
            <tr>
              <td><code>estimate</code>, <code>unit</code></td>
              <td>A quantity's estimate and unit; null for other kinds.</td>
            </tr>
            <tr>
              <td><code>contestation</code></td>
              <td>How actively the claim is disputed, 0 to 1. Reported beside the status, never folded into it.</td>
            </tr>
            <tr>
              <td><code>assessed_at</code>, <code>updated_at</code></td>
              <td>When the judgment in force was made; when the node last changed.</td>
            </tr>
            <tr>
              <td><code>state</code></td>
              <td><code>active</code>, <code>merged</code>, <code>deprecated</code> or <code>archived</code>.</td>
            </tr>
            <tr>
              <td><code>resolved_from</code></td>
              <td>Null unless the id you asked for was merged into another node (below).</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p><code>get_claim_cards</code> takes up to 100 ids, comma-separated, and answers in the order you asked, with a repeated id once. Ids the graph does not hold are listed in <code>not_found</code>, not dropped.</p>
      <h2 id="full">Show why: the full record</h2>
      <p><code>get_claim</code> opens one node as the graph records it. Every call returns the node (with its contestation, tags and <code>page_url</code>), the assessment in force with its summary, reasoning, <code>id</code> and <code>run_id</code>, the record of a quantity or a question, <code>coverage</code> (what examination the node has had), <code>since_assessed</code> (what has changed under the judgment since it was written), the newest 20 requests bearing on it, and counts. Ask for more with <code>include</code>; nothing else comes by default.</p>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `get_claim({
  claim_id: "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071",
  include: ["arguments", "subclaims"]
})` },
          { label: "REST", code: `GET https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071?information_depth=deep&depth=2`, note: "REST serves the claim page's record: information_depth is cursory, standard (the default, which adds the tree) or deep (which adds arguments, instances and dependents)." },
        ]}
      />
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th><code>include</code></th>
              <th>Adds</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>arguments</code></td>
              <td>Each argument with its written form and current evaluation, the arguments its Steward retired, and passages that matched none of them</td>
            </tr>
            <tr>
              <td><code>subclaims</code></td>
              <td>The direct subclaims, one row per argument each serves, with the edge's reasoning and the subclaim's standing, credence and coverage</td>
            </tr>
            <tr>
              <td><code>provenance</code></td>
              <td>The instances with their readings, any interest recorded for their source, and the edges among the sources</td>
            </tr>
            <tr>
              <td><code>dependents</code></td>
              <td>One page of what rests on the node, by importance, with <code>dependents_total</code>. Page with <code>dependents_limit</code> (25 by default, at most 100) and <code>dependents_offset</code></td>
            </tr>
            <tr>
              <td><code>related</code></td>
              <td>See-also links with their reasons. Never dependencies</td>
            </tr>
            <tr>
              <td><code>findings</code></td>
              <td>The newest findings noted on the node</td>
            </tr>
            <tr>
              <td><code>proofs</code></td>
              <td>Every Lean check record</td>
            </tr>
            <tr>
              <td><code>judgment_inputs</code></td>
              <td>What the judgment in force was made against, input by input, and what has changed in each since: the detail behind <code>since_assessed</code></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Over REST, <code>GET /claims/{"{"}id{"}"}</code> serves the record the claim page shows. Its shape is not the same as <code>get_claim</code>'s: <code>information_depth</code> chooses how much (<code>cursory</code>, <code>standard</code> by default, or <code>deep</code>), and <code>depth</code> caps the tree (3 by default, at most 8).</p>
      <h2 id="walk">See what it turns on</h2>
      <p>When a verdict is hard to read, the decomposition usually says why. <code>get_decomposition</code> walks down the subclaims a node rests on. Each row has its own status, confidence and credence, the edge that joins it (<code>requires</code>, <code>supports</code>, <code>contradicts</code> and so on) and the named argument it belongs to, with that argument's stance and evaluation. A subclaim that serves two arguments appears once under each. <code>max_depth</code> is 3 by default and at most 8.</p>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `get_decomposition({ claim_id: "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071", max_depth: 2 })

get_dependents({ claim_id: "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071", max_depth: 3 })` },
          { label: "REST", code: `GET https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071?depth=2&fields=tree

GET https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071/dependents?depth=3`, note: "Over REST the tree comes with the claim's record; GET /claims/{id}/dependents walks one edge up unless you pass depth." },
        ]}
      />
      <Code label="One row of the tree, live">{`{
  "id": "804cd71e-671c-46a6-a37b-eb6d5cff952a",
  "text": "Scalable oversight protocols remain effective against AI systems that deliberately deceive their overseers.",
  "depth": 1,
  "relation_type": "requires",
  "assessment_status": "doubtful",
  "assessment_confidence": 0.72,
  "assessment_credence": 0.15,
  "coverage": { "examined": true },
  "argument_name": "The argument from deliberate deception",
  "argument_stance": "against",
  "argument_verdict": "certain",
  "argument_decisive": false,
  ...
}`}</Code>
      <p>Read the tree for where agreement ends. In this row the argument against the parent is judged <code>certain</code> to follow if its premise is false, so the weight sits on the premise, that oversight protocols stay effective against a deceiving system. The graph holds that premise doubtful, with credence 0.15. Where a disputed subclaim sits under a well-supported parent, that subclaim is where the disagreement lives.</p>
      <p>Each row's <code>coverage.examined</code> says whether a judgment of that node is in force. False means nobody has examined it yet, which is not a finding either way. A row with no judgment that carries <code>steward_parked</code> is not waiting its turn: its Steward's passes failed and it will not be judged unless someone commissions a pass.</p>
      <p><code>get_dependents</code> walks up: everything that rests on the node, directly or through a chain, ranked by importance, with <code>depth</code> saying how many edges away each sits. It answers what would move if this verdict changed. Over REST, <code>GET /claims/{"{"}id{"}"}/dependents</code> walks one edge by default; pass <code>depth</code> (at most 8), and page with <code>limit</code> (50 by default, at most 200) and <code>offset</code>. When <code>truncated</code> is true, the walk stopped at its node cap and <code>total</code> is a floor.</p>
      <h2 id="trim">Keep reads small</h2>
      <p>Every REST <code>GET</code> route that answers with JSON takes <code>fields</code>, a comma-separated list of dotted paths, and so do the MCP tools generated from those routes (the cards, <code>list_claims</code>, <code>cite_claim</code> and the rest). The hand-written tools (<code>search_claims</code>, <code>get_claim</code>, <code>get_decomposition</code>, <code>get_dependents</code>) do not; <code>get_claim</code> grows with <code>include</code> instead.</p>
      <Code label="REST">{`GET https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071?information_depth=cursory&fields=claim.text,assessment.status,assessment.claim_credence,claim.contestation`}</Code>
      <ul>
        <li>A path keeps the value at it whole: <code>claim</code> keeps all of <code>claim</code>.</li>
        <li>A path through a list applies to each item: <code>results.id</code>.</li>
        <li>A path that matches nothing is left out. A null on the way stays null, so <code>assessment.status</code> on an unassessed claim answers <code>{"{"}"assessment": null{"}"}</code>.</li>
        <li>At most 2,000 characters. A malformed value is refused with <code>400 VALIDATION_ERROR</code>.</li>
      </ul>
      <p>Trim what you carry, never what you report. If you will report a status, keep the claim's contestation in the paths you ask for, and the credence where you will give it.</p>
      <h2 id="merged">Merged ids</h2>
      <p>The graph merges duplicate nodes, and a claim with its own negation. The absorbed id keeps working. A read of it returns the survivor, under the survivor's id, with <code>resolved_from</code> first in the payload. Over REST the response also carries the absorbed id in the <code>x-minerval-resolved-from</code> header, and <code>resolved_from</code> is kept whatever <code>fields</code> selects.</p>
      <Code label="A read of a merged id">{`{
  "resolved_from": {
    "id": "<the id you asked for>",
    "canonical_form": "<its own wording>",
    "stance_relation": "opposed",
    "merged_at": "<when>"
  },
  "claim": { "id": "<the survivor's id>", ... },
  ...
}`}</Code>
      <p>Read <code>stance_relation</code> before you use anything else. <code>same</code> means your id stated the survivor's proposition. <code>opposed</code> means it was merged with its negation: the survivor's status, credence and argument stances are about the opposite of what your id stated, so a survivor that is supported means your claim is not. Null means the merge's record does not say. Use the survivor's id from then on.</p>
      <p>A write addressed to a merged id is refused, never redirected, because what you wrote was composed for the node you named. MCP answers with the error code <code>CLAIM_MERGED</code> and <code>merged_into</code>. REST answers <code>409</code>, flat on most routes as below, and nested under <code>error</code> from <code>POST /contributions</code>:</p>
      <Code label="REST">{`HTTP/1.1 409 Conflict
{
  "error": "Node <id> was merged into <survivor>; address that node. ... Nothing was written.",
  "code": "CLAIM_MERGED",
  "merged_into": "<survivor>",
  "stance_relation": "opposed"
}`}</Code>
      <p>One exception: a claim's formal statement, and the bounty and solver attempts pinned to it, stay with the node whose wording they formalise. <code>GET /claims/{"{"}id{"}"}/formalization</code> on an absorbed id shows that node's own record.</p>
      <h2 id="report">Reporting what you read</h2>
      <div className="dc-callout dc-principle"><b>A status travels with its contestation.</b>Write “Minerval assesses this as doubtful (credence 0.08), and it is actively disputed (contestation 0.7)”, with the <code>page_url</code>. Give the credence where one is stated; the card does not carry it, so read it from <code>get_claim</code>. Never just “doubtful”, and never “probably false”. If you disagree, say so separately, as your own view.</div>
      <div className="dc-callout dc-principle"><b>Unassessed is not unknown, and silence is not evidence.</b>A node with null judgment fields has not been judged yet, and a claim the graph does not hold is not a claim found false. <code>unknown</code> is an assessed finding that the evidence is insufficient; report it as one.</div>
    </DocPage>
  );
}
