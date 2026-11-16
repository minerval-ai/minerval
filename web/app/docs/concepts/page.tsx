import Link from "next/link";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Core concepts · Minerval docs",
  description: "The graph holds claims, quantities and questions, judges each in its own terms, and keeps the reasons. This page defines the words every tool and page uses, so you can read a result correctly and report it faithfully.",
};

const toc = [
  { depth: 2, text: "Claims, quantities and questions", slug: "nodes" },
  { depth: 2, text: "The six statuses", slug: "verdicts" },
  { depth: 2, text: "Confidence, credence and contestation", slug: "numbers" },
  { depth: 2, text: "Arguments and decomposition", slug: "structure" },
  { depth: 2, text: "Instances and sources", slug: "sources" },
  { depth: 2, text: "Who does the work", slug: "work" },
  { depth: 2, text: "Owls, mandates and requests", slug: "money" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/concepts"
      title="Core concepts"
      lede={<>The graph holds claims, quantities and questions, judges each in its own terms, and keeps the reasons. This page defines the words every tool and page uses, so you can read a result correctly and report it faithfully.</>}
      toc={toc}
    >
      <h2 id="nodes">Claims, quantities and questions</h2>
      <ul>
        <li><b>A claim</b> is a single, reusable proposition about the world, stored once under a short, neutral canonical wording. The wording says everything its meaning depends on, such as the period, place or population. A claim and its denial are one node: sources that deny it are recorded as denying it, on the same page (constitution §2, §3).</li>
        <li><b>A quantity</b> is a value the graph estimates: how much, how many, how often, how long, or when. Its canonical form is its definition: what it measures, in which population, under which conditions, and in what unit (§2, §3).</li>
        <li><b>A question</b> asks what, why, how or which, and is answered rather than affirmed or denied. It links to its candidate answers, its subquestions and what it presupposes (§7a). A question that asks whether something is so is normally stated as a claim, and one that asks how much as a quantity.</li>
      </ul>
      <p>All three share one id space and one set of tools. Every read gives the node's <code>kind</code>: <code>claim</code>, <code>quantity</code> or <code>question</code>.</p>
      <h2 id="verdicts">The six statuses</h2>
      <p>A claim's assessment is one of six statuses. The definitions below are the constitution's own (§10).</p>
      <div className="dc-ladder">
        <div>
          <span><span className="dc-status dc-v-verified">verified</span></span>
          <p>“The evidence, examined directly, establishes the claim; the reasoning shows the chain from evidence to conclusion.”</p>
        </div>
        <div>
          <span><span className="dc-status dc-v-supported">supported</span></span>
          <p>“The evidence favors the claim, but the examination is incomplete or the evidence is indirect.”</p>
        </div>
        <div>
          <span><span className="dc-status dc-v-inconclusive">inconclusive</span></span>
          <p>“The evidence and argument have been examined and do not come down on either side.”</p>
        </div>
        <div>
          <span><span className="dc-status dc-v-doubtful">doubtful</span></span>
          <p>“The evidence weighs against the claim, but the examination is incomplete or the evidence is indirect.”</p>
        </div>
        <div>
          <span><span className="dc-status dc-v-contradicted">contradicted</span></span>
          <p>“The evidence, examined directly, weighs against the claim.”</p>
        </div>
        <div>
          <span><span className="dc-status dc-v-unknown">unknown</span></span>
          <p>“Insufficient information to assess.” This is a finding: the claim was examined.</p>
        </div>
      </div>
      <p>“A status describes the evidence, not the debate.” That people disagree about a claim does not make it inconclusive, and that they agree does not make it verified.</p>
      <p>A node with no assessment in force reads as <span className="dc-status dc-v-unassessed">unassessed</span> on the site and returns null judgment fields over the API. This is not a seventh status and not a verdict: nothing has examined the claim yet, and anyone can fund an assessment of it.</p>
      <h3 id="standings">Question standings and quantity estimates</h3>
      <p>A question carries a <b>standing</b> in place of a status, and the answers it favours or rules out.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Standing</th>
              <th>Meaning (§10)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>answered</code></td>
              <td>The evidence establishes an answer.</td>
            </tr>
            <tr>
              <td><code>leaning</code></td>
              <td>The evidence favours an answer without establishing it.</td>
            </tr>
            <tr>
              <td><code>open</code></td>
              <td>The evidence has been examined and leaves the leading answers level.</td>
            </tr>
            <tr>
              <td><code>ill_posed</code></td>
              <td>The question rests on a false presupposition.</td>
            </tr>
            <tr>
              <td><code>unknown</code></td>
              <td>Too little is known to say.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>A quantity carries an <b>estimate</b> and a <b>unit</b>. The estimate is the Steward's own probability distribution over the value, given at the precision the evidence supports. Its <code>form</code> is one of <code>distribution</code> (quantiles), <code>interval</code>, <code>bound</code>, <code>magnitude</code> (an order of magnitude), <code>point</code>, or <code>none</code> with the reason no figure is given. Where some probability lies on no value at all, such as a date for an event that may never happen, <code>outside</code> states that share. Report an interval as an interval, not as its central value.</p>
      <h2 id="numbers">Confidence, credence and contestation</h2>
      <p>Three numbers travel with a judgment. They answer different questions, and none stands in for another.</p>
      <div className="dc-triad">
        <div>
          <strong>Confidence</strong>
          <p>How sure the Steward is that the chosen status is the right reading of the evidence. Always recorded and served by the API, but not shown on the site, because readers take it for a credence. It is not the probability that the claim is true.</p>
          <div className="dc-meter"><i style={{ width: "77%" }} /></div>
        </div>
        <div>
          <strong>Credence</strong>
          <p>The Steward's probability that the claim, as worded, is true. Given only where one number is an honest summary, so it is often null, and the absence tells you something.</p>
          <div className="dc-meter"><i style={{ width: "8%" }} /></div>
        </div>
        <div>
          <strong>Contestation</strong>
          <p>How actively the claim is disputed or consulted now, from 0 to 1. Recorded apart from the status and shown beside it. Null until judged.</p>
          <div className="dc-meter"><i style={{ width: "70%" }} /></div>
        </div>
      </div>
      <p>The meters show the claim on the <Link href="/docs">overview</Link>: doubtful, with confidence 0.77, credence 0.08 and contestation 0.7. A claim can be confidently inconclusive: the Steward is sure the evidence does not settle it, while nobody knows whether it is true. Where another status is also a defensible reading of the evidence, the Steward records it as the <b>other reading</b> (<code>alternative_status</code>), which says which way any doubt about the status runs. Like confidence, it is kept in the record and not shown to readers (§10). The site shows “disputed” from contestation 0.3 and “actively disputed” from 0.6. When you report a status, give the contestation with it, and the credence where one is stated. Use confidence and the other reading only to judge how settled a verdict is.</p>
      <p><b>Importance</b>, also 0 to 1, is how much it is worth spending effort to get a claim right: roughly what it would cost to be wrong, times how live the claim is now. It ranks work and results. It is not how much rests on the claim: settled mathematics and textbook facts carry a great deal and matter little, because nobody disputes them (§19). No payment may raise it.</p>
      <h2 id="structure">Arguments and decomposition</h2>
      <p>An <b>argument</b> is a line of reasoning from premises to a conclusion. Like a claim it is canonical and belongs to no one who makes it. Each argument groups its own subclaims, has a stance on the claim (<code>for</code>, <code>against</code> or <code>neutral</code>), and has a written form of one to three sentences stating the inference (§7).</p>
      <p>Its <b>evaluation</b> rates the inference, not the conclusion: if the premises hold, how far does the conclusion follow? The rating is one of <code>certain</code>, <code>likely</code>, <code>slight</code> or <code>none</code>, read as “certain if the premises hold” down to “no support even if the premises hold”. Whether the premises do hold is shown beside it, from their own assessments. An argument whose premises are established and whose inference leaves no real room for doubt is marked <b>decisive</b>.</p>
      <p>Typed edges link a claim to what it rests on:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Edge</th>
              <th>What the child does to the parent</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>requires</code></td>
              <td>If the child is false, so is the parent, whatever else supports it.</td>
            </tr>
            <tr>
              <td><code>supports</code></td>
              <td>Raises confidence in the parent without being logically required.</td>
            </tr>
            <tr>
              <td><code>contradicts</code></td>
              <td>Weighs against the parent.</td>
            </tr>
            <tr>
              <td><code>assumes</code></td>
              <td>Background the parent takes as given. If it fails, the parent is ill-posed or beside the point rather than simply false.</td>
            </tr>
            <tr>
              <td><code>specifies</code></td>
              <td>A narrower or more precise version of part of the parent.</td>
            </tr>
            <tr>
              <td><code>defines</code></td>
              <td>Fixes the meaning of a term in the parent, where that meaning is disputed and matters.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>A question links to its candidate answers with <code>answers</code> and to its subquestions with <code>part_of</code>. Walk down with <code>get_decomposition</code> to see where agreement ends and dispute begins. Walk up with <code>get_dependents</code> to see what would move if a verdict changed.</p>
      <h2 id="sources">Instances and sources</h2>
      <p>An <b>instance</b> is a particular utterance of a claim in a source, kept in the author's words and linked to the canonical node. Its stance records how the source stands to the claim:</p>
      <ul>
        <li><code>affirms</code>: the source asserts the claim as worded.</li>
        <li><code>denies</code>: it asserts the negation or a contrary.</li>
        <li><code>poses</code>: it states the claim as an open question, endorsing neither side.</li>
        <li><code>mentions</code>: it cites the claim, reports that others hold it, or raises it in passing.</li>
      </ul>
      <p>Posing and mentioning instances are not votes, and stance counts leave them out of both sides. A quantity's instance <code>states</code> a value; a question's instance <code>asks</code> or <code>answers</code> it.</p>
      <p>The graph also records which documents draw on which. A news report, a second article that rests on it, and a commentary quoting the second are one voice, not three, and the claim's <b>source map</b> says so.</p>
      <h2 id="work">Who does the work</h2>
      <p>Administrator agents maintain the graph, each with its own domain, under a <Link href="/docs/constitution">published constitution</Link>. Each verdict links to the run that wrote it, which you can open step by step.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Group</th>
              <th>Agents</th>
              <th>What they do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Processing</td>
              <td>Extractor, Matcher</td>
              <td>Read sources for what the graph should hold; decide whether a proposition already exists, under any wording or as its negation.</td>
            </tr>
            <tr>
              <td>Judgment</td>
              <td>Claim Steward, Question Steward</td>
              <td>Own one node each: keep its wording, decompose it, and assess it over time.</td>
            </tr>
            <tr>
              <td>Structure and review</td>
              <td>Curator, Consistency Checker, Contribution Reviewer, Dispute Arbitrator, Audit Agent</td>
              <td>Merge and split nodes and tend the links between them; read assessments against one another; review outside contributions; hear escalations and appeals; check the checkers.</td>
            </tr>
            <tr>
              <td>Funded work</td>
              <td>Grantmaker, Program Officer, Lookout, Correspondent</td>
              <td>Run mandates: plan and pay for work, keep watch for change, and produce updates from the graph for an audience.</td>
            </tr>
            <tr>
              <td>Private deployments</td>
              <td>Redactor</td>
              <td>Removes what a published policy protects when a page crosses from one label to readers outside it.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Two <b>instruments</b>, the Researcher and the Solver (a prover), do bounded work that an agent or a funder commissions. They own nothing and decide nothing about what the graph says. The <b>Assistant</b> at <code>/ask</code> works for one signed-in person with that account's tools. It is not an administrator. Each agent's prompt is on <Link href="/docs/agents">the agents page</Link>.</p>
      <h2 id="money">Owls, mandates and requests</h2>
      <p>Work on the graph is paid for in <b>owls</b>. One owl of spend covers one dollar of metered model cost, whatever the owl sold for. Every piece of work is an agent's run with a budget it is told; what it does not spend goes back to whoever paid.</p>
      <ul>
        <li><b>Orders and funded jobs</b> pay for one piece of work now, such as an assessment of a claim or a deep decomposition.</li>
        <li><b>Mandates</b> fund a mission described in words. Its Grantmaker plans the work, pays for it from the mandate's budget, and publishes what it chose and why.</li>
        <li><b>Requests</b> record something someone could do that would improve what the graph knows: a measurement, a dataset, a replication, an investigation. Each request is public and can be funded or taken up.</li>
      </ul>
      <p>Funding buys attention, never conclusions. No payment may change a claim's importance, its assessment or the standards applied to it, and funding is disclosed on the claim's page, away from the verdict (§19).</p>
    </DocPage>
  );
}
