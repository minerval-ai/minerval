import { Code } from "@/components/docs/Code";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Owls and pricing · Minerval docs",
  description: "What is free, what spends owls and how a charge is worked out, so you can tell your user what something will cost before it runs.",
};

const toc = [
  { depth: 2, text: "The owl", slug: "owl" },
  { depth: 2, text: "What is free", slug: "free" },
  { depth: 2, text: "The free grants", slug: "grants" },
  { depth: 2, text: "Buying owls", slug: "packs" },
  { depth: 2, text: "Charged operations", slug: "caps" },
  { depth: 2, text: "Funded work", slug: "escrow" },
  { depth: 2, text: "SQL time", slug: "sql" },
  { depth: 2, text: "Limits that are not money", slug: "limits" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/owls"
      title="Owls and pricing"
      lede={<>What is free, what spends owls and how a charge is worked out, so you can tell your user what something will cost before it runs.</>}
      toc={toc}
    >
      <h2 id="owl">The owl</h2>
      <p>The owl is Minerval's unit of account. One owl of spend covers one dollar of metered model cost, one for one. An owl sells for $4, and that difference is the platform's whole margin: it sits in the purchase price, openly, never in the meter. Owls are bought or granted and then spent. They are never paid out as money.</p>
      <p><code>get_account</code> (<code>GET /users/me</code>) returns your balance and the figures on this page as the deployment has them set. Your history is in <code>get_owl_ledger</code> (<code>GET /billing/ledger</code>).</p>
      <h2 id="free">What is free</h2>
      <ul>
        <li>Every read of the graph, over MCP or REST, signed in or not.</li>
        <li>Contributions, stated views and issue reports. Each is reviewed or recorded, and each has an hourly limit (below).</li>
        <li>Ten owls when you sign up, and one owl in each calendar month you use the graph, starting with the first.</li>
        <li>A daily allowance of database time for <code>query_sql</code>.</li>
      </ul>
      <h2 id="grants">The free grants</h2>
      <p>On the public graph the signup grant is 10 owls, given once. The monthly owl lands the first time your balance is read in each calendar month (UTC): opening your account page, calling <code>get_account</code>, or starting anything that spends. Both land on that first read, so a new account starts with 11 owls. A month in which you do not show up adds nothing; the owls do not accrue. A deployment sets both grants, and <code>get_account</code> gives its figures (<code>entitlement.signup_grant_owls</code>, <code>entitlement.monthly_grant_owls</code>).</p>
      <h2 id="packs">Buying owls</h2>
      <p>Owls are bought in packs from your account page. Larger packs cost less per owl. <code>list_owl_packs</code> (<code>GET /billing/packs</code>) is a free read of the packs on offer:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Pack</th>
              <th className="dc-num">Owls</th>
              <th className="dc-num">Price</th>
              <th className="dc-num">Per owl</th>
              <th className="dc-num">Discount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Clutch</td>
              <td className="dc-num">5</td>
              <td className="dc-num">$20</td>
              <td className="dc-num">$4.00</td>
              <td className="dc-num">none</td>
            </tr>
            <tr>
              <td>Perch</td>
              <td className="dc-num">25</td>
              <td className="dc-num">$90</td>
              <td className="dc-num">$3.60</td>
              <td className="dc-num">10%</td>
            </tr>
            <tr>
              <td>Wisdom</td>
              <td className="dc-num">100</td>
              <td className="dc-num">$300</td>
              <td className="dc-num">$3.00</td>
              <td className="dc-num">25%</td>
            </tr>
            <tr>
              <td>Parliament</td>
              <td className="dc-num">500</td>
              <td className="dc-num">$1,000</td>
              <td className="dc-num">$2.00</td>
              <td className="dc-num">50%</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Purchases are on only where the deployment has payments set up; the entitlement's <code>credits_enabled</code> says whether they are. A self-hosted deployment may create its own owls instead of selling them. There, an administrator adds to your balance, and those owls never convert to or from owls on the public graph.</p>
      <h2 id="caps">Charged operations</h2>
      <p>Nothing has a fixed price. Each operation that runs a model has a <b>cap</b>: the most one run may cost you, set near its average. A charge goes in three steps.</p>
      <ol className="dc-steps">
        <li>
          <strong>Check</strong>
          <p>Before any work, your balance must cover the cap. If it does not, the call is refused with <code>INSUFFICIENT_OWLS</code> and nothing is held. The refusal carries your entitlement, the cap list and, where owls can be bought, the packs.</p>
        </li>
        <li>
          <strong>Hold</strong>
          <p>When the work starts, the whole cap is taken from your balance. A request that fails validation never gets this far, and costs nothing.</p>
        </li>
        <li>
          <strong>Settle</strong>
          <p>When the run ends, its metered cost is compared with the cap and the unused part is returned to your balance. If the run fails, the whole cap is returned. If it costs more than the cap, the platform absorbs the difference.</p>
        </li>
      </ol>
      <p>So a cap is a ceiling, never a price. A call to <code>assess_text</code> holds 0.1 owl and returns most of it: recent calls on the public graph have settled at a few thousandths of an owl. In your owl history the hold and its return are two entries, linked by <code>settles_entry_id</code>; the cost of the work is the hold less the return.</p>
      <h3 id="caplist">The cap list</h3>
      <p>The entitlement returns every cap in force, in owls, under <code>caps_owls</code>. On the public graph:</p>
      <Code label="get_account → entitlement.caps_owls">{`{
  "claim_proposal": 2,
  "assessment": 2,
  "source_ingest": 10,
  "extension_analysis": 1,
  "text_analysis": 0.1,
  "lookout_run": 0.05,
  "correspondent_run": 0.25,
  "consistency_sweep": 2,
  "sql_query": 0.05
}`}</Code>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Operation</th>
              <th>What it is</th>
              <th className="dc-num">Cap</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>text_analysis</code></td>
              <td>One call to <code>match_claim</code>, <code>extract_claims</code> or <code>assess_text</code></td>
              <td className="dc-num">0.1</td>
            </tr>
            <tr>
              <td><code>assessment</code></td>
              <td><code>order_assessment</code>: a fresh assessment of one claim. The hold is taken when the Claim Steward's run starts, so a pending order cancels free.</td>
              <td className="dc-num">2</td>
            </tr>
            <tr>
              <td><code>claim_proposal</code></td>
              <td><code>propose_claim</code>. Held when you submit. If review rejects the proposal, the whole cap is returned. If it is accepted, the hold pays for the new claim's first assessment and settles after that run.</td>
              <td className="dc-num">2</td>
            </tr>
            <tr>
              <td><code>source_ingest</code></td>
              <td><code>submit_source</code>. Held when you submit, returned in full if review rejects it, and settled to the cost of extraction if it is accepted.</td>
              <td className="dc-num">10</td>
            </tr>
            <tr>
              <td><code>extension_analysis</code></td>
              <td>The browser extension's analysis of one page</td>
              <td className="dc-num">1</td>
            </tr>
            <tr>
              <td><code>sql_query</code></td>
              <td>Not a hold. The balance a <code>query_sql</code> call needs past the day's free allowance: the 5-second time limit at 0.01 owl a second (below)</td>
              <td className="dc-num">0.05</td>
            </tr>
            <tr>
              <td><code>lookout_run</code></td>
              <td>One run of a mandate's lookout. Paid from the mandate's budget, not your balance.</td>
              <td className="dc-num">0.05</td>
            </tr>
            <tr>
              <td><code>correspondent_run</code></td>
              <td>One run of a Correspondent, writing one update. Paid from its mandate's budget.</td>
              <td className="dc-num">0.25</td>
            </tr>
            <tr>
              <td><code>consistency_sweep</code></td>
              <td>One run of the Consistency Checker over a part of the graph, priced by that part's size up to the cap (a strong sweep has its own ceiling, 10 by default). Run on the platform's own schedule, or bought by a mandate from its budget; never charged to a caller's balance.</td>
              <td className="dc-num">2</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Caps are deployment settings. Read them from the entitlement rather than from this page.</p>
      <h2 id="escrow">Funded work</h2>
      <p>Open-ended work has no cap. You choose a budget; it is <b>escrowed</b> from your balance at once and the work is metered against it. What the work does not spend comes back when it completes or is cancelled.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>What the budget buys</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>fund_claim_assessment</code></td>
              <td>One claim's next assessment, which runs at once</td>
            </tr>
            <tr>
              <td><code>fund_deep_decomposition</code></td>
              <td>A mandate on one claim: a fresh pass, then decomposing and assessing what bears on it. At least 5 owls. The Grantmaker's own planning passes may spend at most a tenth of it.</td>
            </tr>
            <tr>
              <td><code>fund_grant</code></td>
              <td>A mandate drafted with the Grantmaker</td>
            </tr>
            <tr>
              <td><code>fund_mandate</code></td>
              <td>A share of an existing public mandate. Unspent money returns to its funders in proportion to what each put in.</td>
            </tr>
            <tr>
              <td><code>fund_request_work</code></td>
              <td>The work on an open request, which runs at once</td>
            </tr>
            <tr>
              <td><code>top_up_grant</code>, <code>top_up_budget_job</code></td>
              <td>More budget for a grant or job; a paused one resumes</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>To get money back early: <code>cancel_grant</code> and <code>cancel_budget_job</code> return the unspent budget, and <code>withdraw_from_mandate</code> returns your share of what a mandate has not yet committed to running work. Everything funded is public.</p>
      <h2 id="sql">SQL time</h2>
      <p><code>query_sql</code> is metered by database time, not by a cap.</p>
      <ul>
        <li>Each account has a free daily allowance: 60 seconds of database time, or 600 seconds while its owl balance is above zero. It resets at midnight UTC.</li>
        <li>Past the allowance, a query costs 0.01 owl per second of database time, billed after it runs. The result says what it cost in <code>cost_owls</code> and how much allowance is left in <code>allowance_left_seconds</code>.</li>
        <li>A query past the allowance starts only if your balance could pay for its whole time limit, 0.05 owl. Otherwise it is refused with <code>ALLOWANCE</code>.</li>
        <li>The same query sent again within 30 seconds is answered from cache, free.</li>
      </ul>
      <h2 id="limits">Limits that are not money</h2>
      <p>Where money can bound something, it does. These limits cover what it cannot, and each is stated to callers with its reason.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Limit</th>
              <th>Why money cannot serve</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>10 free contributions an hour (contributions, stated views, prize-claim filings); 3 for accounts under a day old or below 50 reputation. Past it: <code>CONTRIBUTION_RATE_LIMITED</code>.</td>
              <td>Each one commands a review nobody pays for. Claim proposals and sources are charged and do not count.</td>
            </tr>
            <tr>
              <td>5 issue reports an hour (<code>raise_issue</code>). Past it: <code>REPORT_RATE_LIMITED</code>.</td>
              <td>Each takes maintainer attention that nothing prices.</td>
            </tr>
            <tr>
              <td>30 messages an hour to the Grantmaker in a granting conversation</td>
              <td>Each turn runs the Grantmaker and is free until a mandate is funded, so the turn has no cost ceiling of its own.</td>
            </tr>
            <tr>
              <td>300 requests a minute per IP address without a recognised key</td>
              <td>An anonymous caller has no budget to bound.</td>
            </tr>
            <tr>
              <td>One <code>query_sql</code> query at a time per account; 5 seconds and 500 rows per query</td>
              <td>Callers' queries share one read replica.</td>
            </tr>
            <tr>
              <td>10,000 owls per funding call (<code>fund_grant</code>, <code>fund_mandate</code>)</td>
              <td>A guard against a mistyped amount. Call again to commit more.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Text tools also bound the size of one call so that it stays within its cap: <code>assess_text</code> takes up to 50,000 characters and judges up to 20 claims; <code>extract_claims</code> takes up to 100,000 characters and returns up to 50 claims. Split longer text.</p>
    </DocPage>
  );
}
