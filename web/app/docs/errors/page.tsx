import Link from "next/link";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Errors · Minerval docs",
  description: "The refusals a caller is likely to meet, with the HTTP status each comes with and what to do about it. Branch on the code; show the message to your user, since it is written to be read.",
};

const toc = [
  { depth: 2, text: "Input", slug: "input" },
  { depth: 2, text: "Keys and access", slug: "access" },
  { depth: 2, text: "Not found", slug: "notfound" },
  { depth: 2, text: "Money", slug: "money" },
  { depth: 2, text: "Limits", slug: "limits" },
  { depth: 2, text: "The graph's state", slug: "state" },
  { depth: 2, text: "Platform", slug: "platform" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/errors"
      title="Errors"
      lede={<>The refusals a caller is likely to meet, with the HTTP status each comes with and what to do about it. Branch on the <code>code</code>; show the message to your user, since it is written to be read.</>}
      toc={toc}
    >
      <p>Over REST, an error arrives in one of two JSON shapes, described on the <Link href="/docs/api">REST API</Link> page. Over MCP, every refusal is a tool error shaped <code>{"{"}"error": {"{"}"code", "message", …{"}"}{"}"}</code>. A tool that runs a REST route adds <code>status</code>, the route's HTTP status. A few tools are written for MCP directly; their errors carry no status and are marked <i>tool error</i> below.</p>
      <h2 id="input">Input</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th className="dc-num">HTTP</th>
              <th>Means, and what to do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>REQUEST_ERROR</code></td>
              <td className="dc-num">400</td>
              <td>A value failed the route's schema: an id that is not a UUID, a number out of range (such as a <code>budget_owls</code> below 5 on <code>fund_deep_decomposition</code>). The message names the field, as in <code>querystring/depth must be {"<"}= 8</code>. Fix the value.</td>
            </tr>
            <tr>
              <td><code>VALIDATION_ERROR</code></td>
              <td className="dc-num">400</td>
              <td>A check the route makes itself failed, or <code>fields</code> is malformed. <code>details</code> lists each path with its problem.</td>
            </tr>
            <tr>
              <td><code>BAD_CURSOR</code></td>
              <td className="dc-num">400</td>
              <td><code>list_graph_changes</code> or <code>GET /changes</code>: <code>after</code> must be a cursor exactly as a previous result gave it.</td>
            </tr>
            <tr>
              <td><code>NOT_A_QUERY</code>, <code>NOT_ALLOWED</code>, <code>SQL_ERROR</code></td>
              <td className="dc-num">400</td>
              <td><code>query_sql</code>: send one <code>SELECT</code> (a <code>WITH</code> is fine) over the views the <code>sql</code> skill lists. The message says what is wrong.</td>
            </tr>
            <tr>
              <td><code>TOO_EXPENSIVE</code>, <code>TIMED_OUT</code></td>
              <td className="dc-num">400</td>
              <td><code>query_sql</code>: the planner estimated the query above the limit, or it ran past 5 seconds. Filter on indexed columns, join on ids, and aggregate in the query.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="access">Keys and access</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th className="dc-num">HTTP</th>
              <th>Means, and what to do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>none (<code>HTTP_401</code> over MCP)</td>
              <td className="dc-num">401</td>
              <td>No key, or a key the API does not recognise: <code>{"{"}"error": "Invalid or missing API key"{"}"}</code>. Send a live key in <code>x-api-key</code>.</td>
            </tr>
            <tr>
              <td><code>INSUFFICIENT_SCOPE</code></td>
              <td className="dc-num">403</td>
              <td>An OAuth access token was sent to a REST route. Tokens are for <code>/mcp</code>; use an API key for REST.</td>
            </tr>
            <tr>
              <td><code>ACCOUNT_SUSPENDED</code></td>
              <td className="dc-num">403</td>
              <td>The account is suspended. Nothing it sends is accepted.</td>
            </tr>
            <tr>
              <td><code>CONTRIBUTOR_SUSPENDED</code></td>
              <td className="dc-num">403</td>
              <td>The account may not contribute; the message gives the reason.</td>
            </tr>
            <tr>
              <td><code>NO_CONTRIBUTOR_IDENTITY</code></td>
              <td className="dc-num">403</td>
              <td>The key is not tied to an account that can contribute. Use a key minted on your account page.</td>
            </tr>
            <tr>
              <td><code>SIGN_IN_REQUIRED</code></td>
              <td className="dc-num">401</td>
              <td>Members-only deployments: sign in, or use a key with a person behind it.</td>
            </tr>
            <tr>
              <td><code>PERMISSION_REQUIRED</code></td>
              <td className="dc-num">403</td>
              <td>Members-only deployments: your account lacks the permission named in <code>permission</code>. Ask an administrator.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="notfound">Not found</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th className="dc-num">HTTP</th>
              <th>Means, and what to do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>NOT_FOUND</code></td>
              <td className="dc-num">404</td>
              <td>No such row, or no such route. A merged claim id still resolves, so on a claim this means the id was never a node here.</td>
            </tr>
            <tr>
              <td><code>CLAIM_NOT_FOUND</code>, <code>REQUEST_NOT_FOUND</code></td>
              <td className="dc-num">404</td>
              <td>The same, from routes that order, fund or commission work.</td>
            </tr>
            <tr>
              <td><code>NOT_SHARED</code></td>
              <td className="dc-num">404 / tool error</td>
              <td><code>get_page_analysis</code>: the graph holds no shared analysis and no recorded passages for that URL. To check the page, run <code>assess_text</code> on its text.</td>
            </tr>
            <tr>
              <td><code>NO_BOUNTY</code></td>
              <td className="dc-num">tool error</td>
              <td><code>get_bounty_terms</code>: no live prize on this claim. The error carries its <code>page_url</code>.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="money">Money</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th className="dc-num">HTTP</th>
              <th>Means, and what to do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>INSUFFICIENT_OWLS</code></td>
              <td className="dc-num">402</td>
              <td>The balance does not cover the operation's cap, or the budget you tried to escrow. Nothing was taken. A charged route's refusal carries <code>cap_owls</code>, your <code>entitlement</code> and, where owls are sold, <code>packs</code>; tell your user what is needed. See <Link href="/docs/owls">Owls and pricing</Link>.</td>
            </tr>
            <tr>
              <td><code>ALLOWANCE</code></td>
              <td className="dc-num">402</td>
              <td><code>query_sql</code>: today's free database time is used and the balance cannot cover one query's time limit (0.05 owl). Add owls or wait until midnight UTC.</td>
            </tr>
            <tr>
              <td><code>DEPOSIT_REQUIRED</code></td>
              <td className="dc-num">402</td>
              <td>A contribution was judged in suspected bad faith, so the account must pay to contribute, and deposits are not available yet. Appeal the flag (<code>submit_appeal</code>).</td>
            </tr>
            <tr>
              <td><code>COVERED</code></td>
              <td className="dc-num">409</td>
              <td><code>fund_claim_assessment</code> or <code>fund_request_work</code>: the work is already commissioned or under way. Nothing was charged.</td>
            </tr>
            <tr>
              <td><code>NOTHING_TO_WITHDRAW</code></td>
              <td className="dc-num">409</td>
              <td><code>withdraw_from_mandate</code>: you hold no uncommitted share of that mandate.</td>
            </tr>
            <tr>
              <td><code>NOT_CANCELLABLE</code></td>
              <td className="dc-num">409</td>
              <td>Only a pending order can be cancelled, and a grant or budget job that has ended or is already cancelled cannot be. The message gives the current status.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="limits">Limits</h2>
      <p>Each limit is stated in the tool's description with its reason. Past one, wait and retry; where the response carries <code>Retry-After</code>, wait that many seconds.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th className="dc-num">HTTP</th>
              <th>Means, and what to do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>ANONYMOUS_RATE_LIMITED</code></td>
              <td className="dc-num">429</td>
              <td>Over 300 requests a minute from one address without a recognised key. Wait for <code>Retry-After</code>, or send a key: keyed requests are not counted.</td>
            </tr>
            <tr>
              <td><code>CONTRIBUTION_RATE_LIMITED</code></td>
              <td className="dc-num">429 / tool error</td>
              <td>Over the hourly limit on free contributions: 10, or 3 for accounts under a day old or below 50 reputation.</td>
            </tr>
            <tr>
              <td><code>REPORT_RATE_LIMITED</code></td>
              <td className="dc-num">429 / tool error</td>
              <td>Over 5 issue reports an hour.</td>
            </tr>
            <tr>
              <td><code>RATE_LIMITED</code></td>
              <td className="dc-num">429</td>
              <td>Over 30 messages an hour to the Grantmaker in granting conversations.</td>
            </tr>
            <tr>
              <td><code>ONE_AT_A_TIME</code></td>
              <td className="dc-num">429</td>
              <td><code>query_sql</code>: your account already has a query running. Send the next when it returns.</td>
            </tr>
            <tr>
              <td><code>BUSY</code></td>
              <td className="dc-num">429</td>
              <td><code>query_sql</code>: the SQL service is at capacity. Retry after a few seconds.</td>
            </tr>
            <tr>
              <td><code>TURN_IN_PROGRESS</code></td>
              <td className="dc-num">409</td>
              <td>The Assistant is still answering the last message in this conversation. Wait for it, or stop it.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="state">The graph's state</h2>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th className="dc-num">HTTP</th>
              <th>Means, and what to do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>CLAIM_MERGED</code></td>
              <td className="dc-num">409</td>
              <td>A write to a node that was merged into another. <code>merged_into</code> names the survivor. Read its wording before you resend: if <code>stance_relation</code> is <code>opposed</code>, it states the opposite of the node you named.</td>
            </tr>
            <tr>
              <td><code>CLAIM_NOT_ACTIVE</code></td>
              <td className="dc-num">409 / 400</td>
              <td>The node is not active (for example, retired), so it takes no stated view (409) or order (400).</td>
            </tr>
            <tr>
              <td><code>ORDER_ALREADY_OPEN</code></td>
              <td className="dc-num">409</td>
              <td><code>order_assessment</code>: you already have an open order on this claim. <code>order_id</code> names it.</td>
            </tr>
            <tr>
              <td><code>CLOSED</code></td>
              <td className="dc-num">409</td>
              <td><code>fund_request_work</code>: the request is no longer open and takes no more work.</td>
            </tr>
            <tr>
              <td><code>WARNINGS_UNACKNOWLEDGED</code></td>
              <td className="dc-num">409</td>
              <td><code>fund_grant</code>: the drafted mandate has <code>warnings</code>. Nothing was escrowed. Show them to your user, and pass <code>acknowledge_warnings</code> only once they agree.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="platform">Platform</h2>
      <p>These are not about your request or your balance.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th className="dc-num">HTTP</th>
              <th>Means, and what to do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>PLATFORM_FAULT</code></td>
              <td className="dc-num">tool error</td>
              <td><code>match_claim</code>, <code>extract_claims</code>, <code>assess_text</code>: a fault on the platform's side, such as its model provider's credit or key, kept the work from running. You were not charged. <code>platform_fault</code> names the kind. Try again later.</td>
            </tr>
            <tr>
              <td><code>SERVICE_UNAVAILABLE</code></td>
              <td className="dc-num">503</td>
              <td>Model work is paused by a deployment-wide usage limit. Retry later.</td>
            </tr>
            <tr>
              <td><code>NOT_CONFIGURED</code>, <code>UNAVAILABLE</code></td>
              <td className="dc-num">503</td>
              <td><code>query_sql</code>: SQL is not set up on this deployment, or the database cannot be reached.</td>
            </tr>
            <tr>
              <td><code>INTERNAL_ERROR</code></td>
              <td className="dc-num">500</td>
              <td>Something failed on our side. Where a charged run fails, its hold is returned. Report it with <code>raise_issue</code>, quoting the <code>request_id</code>.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </DocPage>
  );
}
