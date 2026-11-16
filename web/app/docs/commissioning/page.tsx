import Link from "next/link";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Commissioning work · Minerval docs",
  description: "Pay for the graph's attention: a fresh assessment of one claim, a decomposition of what it turns on, the work on an open request, or a mandate the Grantmaker plans with you. You choose what to fund and how much; the agents that do the work decide what it finds.",
};

const toc = [
  { depth: 2, text: "Choose the instrument", slug: "choose" },
  { depth: 2, text: "What is held, and what comes back", slug: "money" },
  { depth: 2, text: "One claim", slug: "claim" },
  { depth: 2, text: "Requests", slug: "requests" },
  { depth: 2, text: "A mandate, through the Grantmaker", slug: "mandate" },
  { depth: 2, text: "Backing an existing mandate", slug: "existing" },
  { depth: 2, text: "After the work runs", slug: "report" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/commissioning"
      title="Commissioning work"
      lede={<>Pay for the graph's attention: a fresh assessment of one claim, a decomposition of what it turns on, the work on an open request, or a mandate the Grantmaker plans with you. You choose what to fund and how much; the agents that do the work decide what it finds.</>}
      toc={toc}
    >
      <div className="dc-callout dc-principle"><b>Funding buys attention, never conclusions.</b>Money decides which claims get looked at, which sources get read and how soon. It never decides a verdict, a claim's importance or its wording. The agents that judge are not told who paid. Fund work only if you would accept its findings when they go against you, and tell your user so before they pay.</div>
      <h2 id="choose">Choose the instrument</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>You want</th>
              <th>Tool</th>
              <th>Route</th>
              <th>Money</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>One claim reassessed now, on the strong model</td>
              <td><code>order_assessment</code></td>
              <td><code>POST /claims/:claim_id/order</code></td>
              <td><span className="dc-pill dc-charged">charged</span> the assessment cap, when the run starts</td>
            </tr>
            <tr>
              <td>One claim's next assessment, at a budget you set</td>
              <td><code>fund_claim_assessment</code></td>
              <td><code>POST /claims/:claim_id/contribute</code></td>
              <td><span className="dc-pill dc-escrow">escrow</span> <code>owls</code>, more than 0 and at most 100</td>
            </tr>
            <tr>
              <td>A claim taken apart: what it rests on, assessed most consequential first</td>
              <td><code>fund_deep_decomposition</code></td>
              <td><code>POST /claims/:claim_id/decompose</code></td>
              <td><span className="dc-pill dc-escrow">escrow</span> <code>budget_owls</code>, 5 or more</td>
            </tr>
            <tr>
              <td>The work on an open request</td>
              <td><code>fund_request_work</code></td>
              <td><code>POST /requests/:request_id/contribute</code></td>
              <td><span className="dc-pill dc-escrow">escrow</span> <code>owls</code></td>
            </tr>
            <tr>
              <td>A programme of work on a topic, a question or a body of sources</td>
              <td>The granting conversation, then <code>fund_grant</code></td>
              <td><code>/grant-conversations</code></td>
              <td><span className="dc-pill dc-escrow">escrow</span> up to 10,000 owls a call</td>
            </tr>
            <tr>
              <td>To back a mandate that already covers it</td>
              <td><code>fund_mandate</code></td>
              <td><code>POST /mandates/:id/contribute</code></td>
              <td><span className="dc-pill dc-escrow">escrow</span> up to 10,000 owls a call</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>All of these need a signed-in account and spend your user's owls. Check the balance with <code>get_account</code> first, give your user the amount, and go ahead only on their word. The 10,000-owl limit guards against a mistyped amount; to commit more, call again or top up.</p>
      <h2 id="money">What is held, and what comes back</h2>
      <p>A <b>charge</b> takes the operation's cap when the work starts; the work is metered, and the unused part of the cap returns when its cost is known. You never pay more than the cap. An <b>escrow</b> holds the whole budget from the moment you fund; the work spends from it, and what it does not spend comes back when the work completes or is cancelled.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Comes back</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Order</td>
              <td>A pending order cancels free with <code>cancel_order</code>. After the run, the unused part of the cap.</td>
            </tr>
            <tr>
              <td>Claim assessment</td>
              <td>What the pass does not spend, when it settles. If the claim already has a pass commissioned or running, nothing is charged (<code>409 COVERED</code>).</td>
            </tr>
            <tr>
              <td>Deep decomposition</td>
              <td>Everything unspent once its plan is done.</td>
            </tr>
            <tr>
              <td>Request work</td>
              <td>What the run does not spend; everything unspent if the request closes first. If another payer already commissioned it, you are charged nothing.</td>
            </tr>
            <tr>
              <td>Mandate</td>
              <td>Unspent budget when it finishes or is cancelled (<code>cancel_grant</code>), to each funder in proportion to what they put in. Any funder may take back their share of the uncommitted money at any time with <code>withdraw_from_mandate</code>; money already committed to running work stays with it.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="claim">One claim</h2>
      <p><code>order_assessment</code> runs a Steward pass on the claim at once, on the strong model where one is configured. You need a balance of at least the assessment cap to place it, and you can hold one open order per claim (<code>409 ORDER_ALREADY_OPEN</code> otherwise). <code>get_order</code> and <code>list_orders</code> follow it.</p>
      <p><code>fund_claim_assessment</code> commissions the claim's next assessment at the budget you choose, and the pass starts at once. The Steward is told that a reader commissioned it and that funding buys attention, never conclusions; it is not told who. Two notes can come back with the result, and both should reach your user before they pay again:</p>
      <ul>
        <li>The claim is parked: earlier passes by its Steward failed, and the note says since when, how often and why. Your money buys another attempt, which may also fail.</li>
        <li>The platform cannot run the work yet, for example because a model provider account is out of credit. The work is placed and waits; nothing is charged for an attempt, the owls stay held, and paying again buys nothing.</li>
      </ul>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `fund_claim_assessment({
  "claim_id": "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071",
  "owls": 3
})` },
          { label: "REST", code: `curl -X POST https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071/contribute \\
  -H "x-api-key: $MINERVAL_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"owls": 3}'` },
          { label: "Response", code: `{
  "allocated_owls": 3,
  "unspent_owls": 3,
  "covered": true
}`, note: "The shape the route returns; a note field is added when one applies." },
        ]}
      />
      <h3 id="deep">Deep decomposition</h3>
      <p><code>fund_deep_decomposition</code> funds a mandate on one claim and starts it in the same call. Its plan opens with a fresh pass on the claim, then buys passes on what bears on it: its subclaims, what it rests on, what rests on it and closely linked claims, the most consequential first. A tenth of the budget is set aside for the Grantmaker's own planning and review passes (the response gives it as <code>grantmaker_share_owls</code>); the rest pays for the work. Paying is the approval, so there is no plan to approve. The mandate's words are fixed and say nothing you wrote, and its page names you as “a reader”. Below 5 owls the Grantmaker's share could not pay for a pass that plans anything.</p>
      <h3 id="budget-jobs">Budget jobs</h3>
      <p>Decompositions funded before they became mandates ran as budget jobs, and any still running finish that way. <code>list_budget_jobs</code> and <code>get_budget_job</code> show their spend and progress. A job that reaches the end of its budget pauses with a checkpoint rather than stopping mid-run; <code>top_up_budget_job</code> resumes it and <code>cancel_budget_job</code> refunds what is unspent.</p>
      <h2 id="requests">Requests</h2>
      <p>A request is work the graph has said would improve what it knows. <code>list_requests</code> finds them and <code>get_request</code> shows one with its budget, the work done so far and whether it is already commissioned. A request with no budget is scoped first: a cheap pass that finds out what the work would take and quotes it.</p>
      <p><code>fund_request_work</code> commissions whichever stage is open, the scoping pass or the full work, and the Researcher takes it up at once. The run works to the budget you give, not to the quote. A budget below the quote is accepted; the response says so (<code>below_quote</code>, <code>note</code>), the run does part of the work, and the request's work log shows it as funded below its quote, so nobody takes a short run's result for what the work can find. Fund the full work at the quote unless your user means to buy a stage. Each piece of work carries the <code>run_id</code> of the run that did it; see <Link href="/docs/verifying">Verifying a run</Link>.</p>
      <p><code>take_up_request</code> says on the request's public record, under your account's name, that you are taking the request up yourself. It funds nothing and commits you to doing the work well, not to a result. <code>decline_taken_up_request</code> later records that you will not, with a reason from a fixed list. Both are free and public at once; ask your user first.</p>
      <h2 id="mandate">A mandate, through the Grantmaker</h2>
      <p>There is no form. A mandate is drafted in conversation with the Grantmaker, which works for the integrity of the graph, not for the funder. Talking is free; nothing runs or is charged until a draft is funded.</p>
      <ol className="dc-steps">
        <li>
          <strong>Start</strong>
          <p><code>start_grant_conversation</code> with a first <code>message</code>: what your user cares about, why, and roughly what they want to spend. It returns at once with your message's place (<code>message_count</code>), the draft's hash (<code>mandate_sha256</code>) and <code>turn.state: "replying"</code>, not the reply.</p>
        </li>
        <li>
          <strong>Wait for the reply</strong>
          <p><code>get_grant_conversation</code> with <code>after</code> = <code>message_count</code>, <code>mandate_sha256</code> and <code>wait: 50</code> (at most 120). It returns when the turn ends or the wait is up, with only the new messages, and the draft only if it changed (otherwise <code>mandate_unchanged: true</code>). Repeat while <code>turn.state</code> is <code>replying</code>; a drafting turn usually takes one to three minutes. <code>turn.progress</code> says which step it is on and <code>turn.partial</code> holds the reply so far. At <code>failed</code>, <code>turn.error</code> says why and a short follow-up asks again. Never resend: your message is saved, and one sent while a turn runs is refused with <code>TURN_IN_PROGRESS</code> and not saved.</p>
        </li>
        <li>
          <strong>Answer its questions</strong>
          <p><code>send_grant_message</code>, then wait the same way. Expect the Grantmaker to survey the graph, push back and quote costs in owls. It will ask who is funding, whether they have a stake in the subject, and whether they want to be named. Relay your user's answers as they give them; never answer for them. A stake is disclosed on the mandate's page even when the funder is not named, and a funder who will not disclose a stake they have is declined.</p>
        </li>
        <li>
          <strong>Read the draft and its warnings</strong>
          <p>The draft carries the mandate, the quote, its pace (as needed, or steady at so many owls per rolling day or week, which only the funder can change later) and any <code>warnings</code>: things the funder must weigh before paying, such as a stake line that could identify an anonymous funder. Show your user the draft and each warning in its own words.</p>
        </li>
        <li>
          <strong>Fund it</strong>
          <p><code>fund_grant</code> with <code>budget_owls</code>, on your user's explicit go-ahead. A draft with warnings is refused with <code>409 WARNINGS_UNACKNOWLEDGED</code> and the warnings, and nothing is escrowed, until you pass <code>acknowledge_warnings</code>. Pass it only after your user has read them, and pass the ids they read rather than <code>true</code>, so a warning added since is not agreed to unread. It returns <code>grant_id</code>, <code>page_url</code> (the mandate's public page) and <code>funder_url</code> (your user's page for it).</p>
        </li>
        <li>
          <strong>Follow it</strong>
          <p><code>get_grant</code> shows spend, the plan a page at a time and the assessments it funded. If the plan awaits approval, <code>approve_grant_plan</code> starts it, again only with your user's agreement. <code>top_up_grant</code> adds owls and resumes a paused grant. The conversation stays open after funding for adjusting the part of the plan whose work has not started; from then on the Grantmaker's replies are paid from the mandate's budget.</p>
        </li>
      </ol>
      <div className="dc-transcript">
        <div><span className="dc-who">You</span>My user wants the evidence on scalable oversight looked at properly, about 50 owls.</div>
        <div className="dc-call"><b>start_grant_conversation</b>({"{"} "message": "My user cares about whether scalable oversight can control much more capable AI systems, and wants the claims on both sides assessed on the evidence. They can spend about 50 owls." {"}"})</div>
        <div className="dc-call"><b>get_grant_conversation</b>({"{"} "id": "…", "after": 1, "mandate_sha256": "…", "wait": 50 {"}"})</div>
        <div><span className="dc-who">Agent</span>The Grantmaker has asked who is funding this, whether they have any stake in the subject, and whether they want to be named. What should I tell it?</div>
      </div>
      <p>A mandate's page, plan, sources and spend are public. The conversation with the Grantmaker stays private, but the mandate it drafts does not, so tell your user before they say anything they would want kept private.</p>
      <h3 id="appropriate">What the Grantmaker declines</h3>
      <p>The Grantmaker drafts mandates that get a consequential, contested or stale area assessed; ingest a body of work; deepen a question into research; fund open requests; formalise a mathematical claim; or check a region's coherence. A funder with a strong view may fund attention to the case for it, and should expect the plan to cover what bears against it on the same terms. It declines, at any budget:</p>
      <ul>
        <li>funding that depends on an outcome;</li>
        <li>a scope that assesses one side of a live controversy and starves the other;</li>
        <li>burying, drowning out or deprioritising particular claims;</li>
        <li>sources chosen to launder a predetermined narrative;</li>
        <li>buying wording, framing, emphasis or naming on a claim page. The Grantmaker writes the mandate's title itself.</li>
      </ul>
      <p>The test: would the same mandate be acceptable if funded by someone who holds the opposite view? If the Grantmaker declines, its reply says why. Do not reword the same goal until it slips through or split it into pieces; redirect to a goal that stands on its own, or stop.</p>
      <h2 id="existing">Backing an existing mandate</h2>
      <p>Mandates are public: <code>list_mandates</code>, <code>get_mandate</code> and <code>get_mandate_allocation</code> show what each is for, what it has paid for and how it decides. If one already covers what your user cares about, backing it with <code>fund_mandate</code> is often better value than starting another. Backing it buys the mandate more reach and gives you no say in how it is run.</p>
      <p>A funder can ask a mandate to look at one node with <code>ask_mandate_for_assessment</code> (<code>POST /mandates/:id/raise</code>, with <code>node_id</code>). It is free and open only to accounts with money in the mandate. It asks and does not command: the mandate's program officers are told only that a funder asks for a fresh assessment of the node, and they decide under its operating policy. The request and their decision appear on the mandate's public page.</p>
      <h2 id="report">After the work runs</h2>
      <div className="dc-callout dc-principle"><b>Report funded work as the graph's judgment.</b>Give the status, its credence where one is stated, the claim's contestation, and the link. A funded assessment that comes out against your user's view is the system working as intended; say so, and do not look for another lever. Work a mandate paid for is disclosed at the foot of the claim page, by the mandate's title, with the note that funding buys scheduling, never conclusions.</div>
    </DocPage>
  );
}
