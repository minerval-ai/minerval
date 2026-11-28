import Link from "next/link";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Contributing · Minerval docs",
  description: "Challenge a verdict, bring evidence, propose a claim or a change to the graph's structure, or state your own view beside the graph's. Every contribution is reviewed on its merits, and the contribution, the review and the outcome are public.",
};

const toc = [
  { depth: 2, text: "How a contribution goes", slug: "how" },
  { depth: 2, text: "The contribution types", slug: "types" },
  { depth: 2, text: "Proposing a claim or a source", slug: "new" },
  { depth: 2, text: "Stating your own view", slug: "views" },
  { depth: 2, text: "Appealing a rejection", slug: "appeals" },
  { depth: 2, text: "Limits, reputation and standing", slug: "limits" },
  { depth: 2, text: "Good faith", slug: "faith" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/contributing"
      title="Contributing"
      lede={<>Challenge a verdict, bring evidence, propose a claim or a change to the graph's structure, or state your own view beside the graph's. Every contribution is reviewed on its merits, and the contribution, the review and the outcome are public.</>}
      toc={toc}
    >
      <h2 id="how">How a contribution goes</h2>
      <ol className="dc-steps">
        <li>
          <strong>Submit it</strong>
          <p><code>submit_contribution</code> (<code>POST /contributions</code>) with a <code>contribution_type</code>, the node it is about (<code>claim_id</code>) and <code>content</code>: your case, in words a reviewer can follow. Add <code>evidence_urls</code> for anything it rests on. It is attributed to your account, so you need to be signed in (see <Link href="/docs/auth">Authentication</Link>).</p>
        </li>
        <li>
          <strong>The Contribution Reviewer decides</strong>
          <p>It opens the evidence you cite, reads the claim's record and the other contributions on it, and decides <code>accept</code>, <code>reject</code> or <code>escalate</code>, with its reasoning and the constitution sections it relies on. Your reputation bears only on questions of bad faith, never on whether your case succeeds.</p>
        </li>
        <li>
          <strong>An accepted contribution goes to the node's Steward</strong>
          <p>Acceptance admits your case, not a change. The Steward receives the contribution as filed, with your evidence and the Reviewer's reasoning, and decides what it changes. A merge or split goes on to the Curator, who adjudicates it.</p>
        </li>
        <li>
          <strong>Follow it</strong>
          <p><code>get_contribution_status</code> returns <code>pending</code> until it is reviewed, then the decision and reasoning. <code>list_contributions</code> with <code>mine: true</code> finds yours if you lose the id. The exchange is also on the claim's page.</p>
        </li>
      </ol>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `submit_contribution({
  "claim_id": "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071",
  "contribution_type": "support",
  "content": "<what the evidence shows, and why it bears on this claim>",
  "evidence_urls": ["https://…"]
})` },
          { label: "REST", code: `curl -X POST https://api.claimgraph.io/contributions \\
  -H "x-api-key: $MINERVAL_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"claim_id":"dc02e01f-ce69-4dbe-ba36-ed0e2e90d071",
       "contribution_type":"support",
       "content":"<what the evidence shows, and why it bears on this claim>",
       "evidence_urls":["https://…"]}'` },
          { label: "Status", code: `get_contribution_status({ "contribution_id": "b8b57e76-897a-4cef-aea8-021e177befe0" })

{
  "contribution": { "contribution_type": "propose_merge", "review_status": "accepted", … },
  "review": {
    "decision": "accept",
    "reasoning": "… This admits the case for a merge only. The Curator adjudicates the merge and chooses the surviving wording.",
    "confidence": 0.8,
    "policy_citations": ["§2", "§5", "Part VIII"]
  }
}`, note: "A real review, abridged." },
        ]}
      />
      <h2 id="types">The contribution types</h2>
      <p>There are eleven. Each is about one existing node, except <code>propose_request</code>, which may bear on several nodes, on sources, or on something the graph does not hold yet: leave out <code>claim_id</code> and say in <code>content</code> what it bears on.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Use it to</th>
              <th>What the Reviewer looks for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>challenge</code></td>
              <td>Dispute the claim or its assessment</td>
              <td>A specific flaw, or counter-evidence it can follow to its source</td>
            </tr>
            <tr>
              <td><code>support</code></td>
              <td>Bring evidence or reasoning for it</td>
              <td>Something that bears on this claim and is new to its page</td>
            </tr>
            <tr>
              <td><code>add_instance</code></td>
              <td>Record a source where the claim appears. With <code>argument_id</code>, a source that makes, attacks or mentions one of its arguments</td>
              <td>An accurate quote, fairly put in context</td>
            </tr>
            <tr>
              <td><code>propose_argument</code></td>
              <td>Add a named argument for or against</td>
              <td>A coherent line of reasoning with relevant, connected premises</td>
            </tr>
            <tr>
              <td><code>propose_edit</code></td>
              <td>Reword the claim, usually with <code>proposed_canonical_form</code></td>
              <td>The same proposition, stated closer to the canonical form</td>
            </tr>
            <tr>
              <td><code>propose_merge</code></td>
              <td>Say two nodes are one: <code>merge_target_claim_id</code>. Or two arguments on the node: <code>argument_id</code> and <code>merge_target_argument_id</code></td>
              <td>That both turn on the same considerations</td>
            </tr>
            <tr>
              <td><code>propose_split</code></td>
              <td>Say a node, or an argument (<code>argument_id</code>), runs together more than one thing</td>
              <td>Propositions that turn on different considerations</td>
            </tr>
            <tr>
              <td><code>add_estimate</code></td>
              <td>Give a source's figure for a quantity</td>
              <td>The figure as the source states it, with the source</td>
            </tr>
            <tr>
              <td><code>propose_answer</code></td>
              <td>Offer a candidate answer to a question</td>
              <td>An answer to the question as worded</td>
            </tr>
            <tr>
              <td><code>propose_request</code></td>
              <td>Ask for work that would improve what the graph knows</td>
              <td>What to do, why it matters, and what would satisfy it. A request for a particular result is restated to ask for what would decide the matter either way</td>
            </tr>
            <tr>
              <td><code>answer_request</code></td>
              <td>Offer material for an open request: <code>request_id</code>, which must bear on <code>claim_id</code></td>
              <td>Material that meets the request</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>A contribution can also be made through a page another graph has published on the node: pass <code>about_published_page_id</code>. It is reviewed like any other.</p>
      <h2 id="new">Proposing a claim or a source</h2>
      <p>Two kinds of contribution put something new into the graph. Each holds owls when you submit it, and neither counts toward the hourly limit below: your balance is the bound.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Route</th>
              <th>What happens</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>propose_claim</code></td>
              <td><code>POST /claims/propose</code></td>
              <td>Proposes a claim, question or quantity by its wording alone (<code>claim</code>, at most 2,000 characters; <code>kind</code> is a guess the Matcher settles). If the Reviewer accepts it, the Matcher finds whether the graph already holds it under other words, and the node gets its first assessment, paid for by your charge.</td>
            </tr>
            <tr>
              <td><code>submit_source</code></td>
              <td><code>POST /sources</code></td>
              <td>Submits a <code>url</code> (with an optional <code>title</code> and <code>content</code>). Nothing is extracted until the Reviewer accepts it.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Both take the operation's cap when you submit: <code>claim_proposal</code> for a proposal and <code>source_ingest</code> for a source (<code>get_account</code> shows the caps in force; you need a balance of at least the cap). If the submission is rejected, the charge is refunded. If it is accepted, the work it pays for is metered and the unused part of the cap comes back. Arguments and evidence go on the node once it exists, as ordinary contributions. See <Link href="/docs/owls">Owls and pricing</Link>.</p>
      <h2 id="views">Stating your own view</h2>
      <p><code>state_view</code> (<code>POST /claims/:claim_id/stated-views</code>) puts your own view, or your organisation's, on record beside the graph's (constitution §4). It does not change the assessment, and its placement gives it no weight. The Reviewer admits it on form and good faith, never on whether it is right; once admitted it is recorded as a source on the node and its reasons go to the node's Steward, whose answer <code>get_contribution_status</code> shows.</p>
      <ul>
        <li><code>statement</code> (up to 2,000 characters) and <code>stance</code>. On a claim: <code>affirms</code>, <code>denies</code>, <code>qualifies</code>, <code>gives_probability</code> or <code>open</code>. On a quantity: <code>states</code> (with <code>figure</code>) or <code>open</code>. On a question: <code>answers</code> or <code>open</code>.</li>
        <li><code>probability</code> on a claim, required with <code>gives_probability</code>; <code>reasons</code> (up to 8,000 characters) and <code>evidence_urls</code> if you give them.</li>
        <li><code>stake</code>, a sentence on what you stand to gain or lose by the answer, or <code>no_stake: true</code>. One of the two is required.</li>
      </ul>
      <p>A stated view is published under your account's name in the words you pass, and is not edited or withdrawn afterwards. An agent should state a view only when its user asks. <code>list_stated_views</code> reads them back, each beside the judgment in force: <code>differs</code>, <code>agrees</code>, <code>not_assessed</code> or <code>not_comparable</code>. With <code>speaker_id</code> it shows how one account's views have held up against the graph's assessments.</p>
      <div className="dc-callout dc-principle"><b>A stated view is its speaker's; the judgment is the graph's.</b>Report each as whose it is. <code>not_assessed</code> means nobody has examined the node, which is not agreement.</div>
      <h2 id="appeals">Appealing a rejection</h2>
      <p><code>submit_appeal</code> (<code>POST /appeals</code>) with the <code>contribution_id</code> and your <code>appeal_reasoning</code> sends a rejected contribution to the Dispute Arbitrator, which reads the whole case record and rules. Only a rejected contribution can be appealed (<code>400 INVALID_STATE</code> otherwise), and any signed-in account may appeal one. A suspended account may still appeal its own. <code>get_appeal</code> follows it. The Reviewer also escalates close calls to the Arbitrator on its own. An overturned rejection is accepted with everything that follows from acceptance, and any penalty it carried is reversed.</p>
      <h2 id="limits">Limits, reputation and standing</h2>
      <p>A challenge, support, <code>propose_edit</code>, <code>add_instance</code>, <code>propose_argument</code>, <code>add_estimate</code> or <code>propose_answer</code> asks for a fresh pass on its node. By default that pass is paid for when you submit, up to the assessment cap, if your balance covers it: if the contribution is accepted the node is reassessed at once, and a rejection refunds the charge. <code>assess: false</code> charges nothing, and an accepted contribution&apos;s pass then goes to the General mandate&apos;s officers, who decide when it runs; <code>assess: true</code> refuses with <code>402 INSUFFICIENT_OWLS</code> when the balance does not cover it.</p>
      <p>Free contributions command a review that nobody pays for. That is why the free kinds carry an hourly limit, which counts free <code>submit_contribution</code>s, <code>state_view</code>, prize claims and challenges to them:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th className="dc-num">Per hour</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Reputation 50 or more, and at least a day old</td>
              <td className="dc-num">10</td>
            </tr>
            <tr>
              <td>Reputation below 50, or under 24 hours old</td>
              <td className="dc-num">3</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Past it the call answers <code>429 CONTRIBUTION_RATE_LIMITED</code>; wait and send it again.</p>
      <p><b>Reputation</b> runs from 0 to 100 and starts at 50. An accepted contribution adds 2 and a sincere rejection takes 1; an escalation changes nothing. A rejection the Reviewer or Arbitrator finds to be in bad faith (spam, vandalism, sybil activity or misinformation) takes a further 15. Below 10 an account is suspended. The bar for bad faith is high: honest error is a plain rejection, and doubt about intent is escalated.</p>
      <p><b>Standing.</b> One bad-faith finding moves an account to pay-to-contribute standing. Every contribution route then answers <code>402 DEPOSIT_REQUIRED</code>. Deposits do not exist yet, so the way back is an appeal, which stays open, as does reading the graph. An overturned finding restores the reputation and the standing.</p>
      <p><b>Owls for accepted contributions.</b> The award machinery exists (1 to 5 points by the claim's importance, times a per-point rate) but the rate is set per deployment and is off unless a deployment turns it on.</p>
      <h2 id="faith">Good faith</h2>
      <div className="dc-callout dc-principle"><b>Contribute what the evidence supports, whichever way it cuts.</b>Contributions and their reviews are public, and the graph presumes good faith of everyone who contributes. Do not resubmit a rejected case in new words, split it to slip past review, or flood a claim with sources that repeat one another; provenance work counts ten reports of one study as one voice. Before an agent files anything under its user's name, it should say what will be published and get the user's agreement.</div>
    </DocPage>
  );
}
