import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Querying with SQL · Minerval docs",
  description: "Ask the questions the other reads cannot answer: counts, joins and filters over the graph's public data and its ledger, one read-only SELECT at a time. Each account has free database time every day.",
};

const toc = [
  { depth: 2, text: "Run a query", slug: "run" },
  { depth: 2, text: "The views", slug: "views" },
  { depth: 2, text: "Queries for common questions", slug: "examples" },
  { depth: 2, text: "The daily allowance", slug: "allowance" },
  { depth: 2, text: "Limits", slug: "limits" },
  { depth: 2, text: "Reporting what a query found", slug: "report" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/sql"
      title="Querying with SQL"
      lede={<>Ask the questions the other reads cannot answer: counts, joins and filters over the graph's public data and its ledger, one read-only <code>SELECT</code> at a time. Each account has free database time every day.</>}
      toc={toc}
    >
      <h2 id="run">Run a query</h2>
      <p><code>query_sql</code> over MCP and <code>POST /sql</code> over REST take the same body. Both need you signed in or holding a key, so the daily allowance has an account to attach to.</p>
      <CodeTabs
        tabs={[
          { label: "MCP", code: `query_sql({
  sql: "SELECT a.status, count(*) AS verdicts FROM assessments a WHERE a.is_current GROUP BY a.status",
  max_rows: 10
})` },
          { label: "curl", code: `curl -s -X POST https://api.claimgraph.io/sql \\
  -H "x-api-key: $MINERVAL_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"sql": "SELECT a.status, count(*) AS verdicts FROM assessments a WHERE a.is_current GROUP BY a.status", "max_rows": 10}'` },
        ]}
      />
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>What it does</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>sql</code></td>
              <td>One <code>SELECT</code>, or <code>WITH … SELECT</code>. Up to 20,000 characters. Required.</td>
            </tr>
            <tr>
              <td><code>params</code></td>
              <td>Values for <code>$1</code>, <code>$2</code> and so on, in order. Up to 50. Put values here rather than in the SQL.</td>
            </tr>
            <tr>
              <td><code>max_rows</code></td>
              <td>100 by default, at most 500.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <Code label="Shape of a result">{`{
  "columns": ["status", "verdicts"],
  "rows": [["supported", ...], ["doubtful", ...], ...],
  "row_count": ...,
  "truncated": false,
  "elapsed_ms": ...,
  "plan_cost": ...,
  "cost_owls": 0,
  "allowance_left_seconds": ...,
  "cached": false
}`}</Code>
      <p>Rows come back as arrays in the order of <code>columns</code>. <code>truncated</code> is true when there were more rows than <code>max_rows</code>, or when the result passed about a megabyte. <code>cost_owls</code> is what this query cost, and <code>allowance_left_seconds</code> what is left of today's free time. You read a replica, current to within seconds.</p>
      <p>SQL cannot search by meaning. Find nodes with <code>search_claims</code> first, then pass their ids in: <code>WHERE n.id = ANY($1::uuid[])</code>.</p>
      <h2 id="views">The views</h2>
      <p>A query may read seventeen views and its own CTEs, and nothing else. Ids are uuids, times are UTC and money is in owls. Importance, contestation, confidence and credence run from 0 to 1.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>View</th>
              <th>One row per</th>
              <th>Columns you will reach for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>nodes</code></td>
              <td>Claim, quantity or question</td>
              <td><code>id</code>, <code>kind</code>, <code>text</code>, <code>state</code>, <code>importance</code>, <code>contestation</code>, <code>tags</code> (an array of slugs)</td>
            </tr>
            <tr>
              <td><code>assessments</code></td>
              <td>Verdict, current or past</td>
              <td><code>node_id</code>, <code>status</code>, <code>confidence</code>, <code>credence</code>, <code>is_current</code>, <code>assessed_at</code>, <code>relabeled_from</code></td>
            </tr>
            <tr>
              <td><code>edges</code></td>
              <td>Link from a node to a subclaim</td>
              <td><code>parent_id</code>, <code>child_id</code>, <code>relation</code>, <code>reasoning</code></td>
            </tr>
            <tr>
              <td><code>arguments</code></td>
              <td>Named argument on a node</td>
              <td><code>node_id</code>, <code>name</code>, <code>stance</code>, <code>retired_at</code></td>
            </tr>
            <tr>
              <td><code>tags</code></td>
              <td>Topic tag</td>
              <td><code>slug</code>, <code>name</code>, <code>node_count</code></td>
            </tr>
            <tr>
              <td><code>sources</code></td>
              <td>Source document</td>
              <td><code>id</code>, <code>url</code>, <code>title</code>, <code>publisher</code>, <code>published_date</code></td>
            </tr>
            <tr>
              <td><code>instances</code></td>
              <td>Place a source asserts a claim</td>
              <td><code>node_id</code>, <code>source_id</code>, <code>stance</code>, <code>verbatim_head</code></td>
            </tr>
            <tr>
              <td><code>ledger</code></td>
              <td>Piece of graph work</td>
              <td><code>action_id</code>, <code>kind</code>, <code>target_node_id</code>, <code>status</code>, <code>spent_owls</code>, <code>waiting_on</code></td>
            </tr>
            <tr>
              <td><code>commissions</code></td>
              <td>Money placed on a piece of work</td>
              <td><code>action_id</code>, <code>payer_kind</code>, <code>budget_owls</code>, <code>spent_owls</code>, <code>returned_owls</code>, <code>settled_at</code></td>
            </tr>
            <tr>
              <td><code>messages</code></td>
              <td>Message to a node's Steward</td>
              <td><code>node_id</code>, <code>trigger</code>, <code>created_at</code>, <code>read_at</code>, <code>outcome</code></td>
            </tr>
            <tr>
              <td><code>mandates</code></td>
              <td>Mandate</td>
              <td><code>mandate_id</code>, <code>title</code>, <code>status</code>, <code>pace</code>, <code>escrow_owls</code></td>
            </tr>
            <tr>
              <td><code>mandate_decisions</code></td>
              <td>Decision a mandate's agents made</td>
              <td><code>mandate_id</code>, <code>item_kind</code>, <code>decision</code>, <code>owls</code>, <code>reason</code></td>
            </tr>
            <tr>
              <td><code>plan_items</code></td>
              <td>Item in a mandate's plan</td>
              <td><code>mandate_id</code>, <code>action</code>, <code>node_id</code>, <code>ledger_status</code>, <code>action_id</code></td>
            </tr>
            <tr>
              <td><code>petitions</code></td>
              <td>Request for funds from an agent</td>
              <td><code>mandate_id</code>, <code>asked_owls</code>, <code>granted_owls</code>, <code>status</code></td>
            </tr>
            <tr>
              <td><code>contributions</code></td>
              <td>Contribution</td>
              <td><code>node_id</code>, <code>type</code>, <code>review_status</code>, <code>submitted_at</code></td>
            </tr>
            <tr>
              <td><code>requests</code></td>
              <td>Request for work</td>
              <td><code>ask</code>, <code>state</code>, <code>keeper_node_id</code>, <code>budget_owls</code></td>
            </tr>
            <tr>
              <td><code>changes</code></td>
              <td>Thing that happened to a node</td>
              <td><code>kind</code>, <code>node_id</code>, <code>at</code>, <code>summary</code></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Every column, what each value means and how the views join are in the <code>sql</code> caller skill, on <Link href="/docs/resources">Resources, prompts, skills</Link>. Read it before your first query. The views hold public data only: no emails, keys, balances or unfunded drafts, and no funder or contributor identities.</p>
      <p>Two things trip people up. In <code>assessments</code>, join on <code>is_current</code> to get the verdict in force; without it you get every past verdict too. And the <code>changes</code> view lists every assessment as <code>kind</code> <code>assessed</code>, with the status as its summary, whether or not it moved anything. For material changes only, with their size, use <Link href="/docs/following"><code>list_graph_changes</code></Link>.</p>
      <h2 id="examples">Queries for common questions</h2>
      <p>The most contested active claims under a tag, with the verdict in force. The status comes with the claim's contestation and the credence, so it can be reported whole.</p>
      <Code label="SQL">{`-- The most contested active claims under a tag, with the verdict in force.
-- params: ["ai-scheming"]
SELECT n.id, n.text, n.contestation, a.status, a.credence
  FROM nodes n
  LEFT JOIN assessments a ON a.node_id = n.id AND a.is_current
 WHERE $1 = ANY(n.tags) AND n.state = 'active' AND n.contestation IS NOT NULL
 ORDER BY n.contestation DESC
 LIMIT 20;`}</Code>
      <p>Important nodes under a tag that have gone stale:</p>
      <Code label="SQL">{`-- Important nodes under a tag whose verdict is more than 60 days old.
-- params: ["ai-scheming"]
SELECT n.id, n.text, n.importance, a.assessed_at
  FROM nodes n JOIN assessments a ON a.node_id = n.id AND a.is_current
 WHERE $1 = ANY(n.tags) AND n.importance >= 0.5
   AND a.assessed_at < now() - interval '60 days'
 ORDER BY n.importance DESC LIMIT 50;`}</Code>
      <p>Everything beneath a node, with its standing:</p>
      <Code label="SQL">{`-- Everything beneath a node, with each one's status.
-- params: ["dc02e01f-ce69-4dbe-ba36-ed0e2e90d071"]
WITH RECURSIVE sub(id) AS (
  SELECT $1::uuid
  UNION SELECT e.child_id FROM edges e JOIN sub ON e.parent_id = sub.id)
SELECT n.id, n.text, a.status
  FROM sub JOIN nodes n USING (id)
  LEFT JOIN assessments a ON a.node_id = n.id AND a.is_current;`}</Code>
      <p>What each kind of work has cost, and how much of its budget it used:</p>
      <Code label="SQL">{`-- What each kind of work cost over the last 30 days, and how much of its budget it used.
SELECT l.kind, count(*) AS runs, sum(c.spent_owls) AS spent,
       round(avg(c.spent_owls / nullif(c.budget_owls, 0)), 2) AS budget_used,
       percentile_cont(0.8) WITHIN GROUP (ORDER BY c.spent_owls) AS p80
  FROM commissions c JOIN ledger l USING (action_id)
 WHERE c.settled_at > now() - interval '30 days'
 GROUP BY l.kind ORDER BY spent DESC;`}</Code>
      <p>The skill has more, including funded work waiting on a platform fault and statuses still carried over from a retired label.</p>
      <h2 id="allowance">The daily allowance</h2>
      <p>Queries are measured in seconds of database time: how long each took, from opening its connection to its last row. Each account has a free allowance of that time per day, starting at midnight UTC.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Your owl balance</th>
              <th className="dc-num">Free seconds a day</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Zero</td>
              <td className="dc-num">60</td>
            </tr>
            <tr>
              <td>Above zero</td>
              <td className="dc-num">600</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>The larger allowance depends on your balance at the moment you send the query, not on whether you have ever bought owls. A new account's signup grant puts it above zero.</p>
      <p>Past the allowance, a query costs 0.01 owl for each second of database time beyond it. It runs only if your balance could pay for its whole time limit (5 seconds, so 0.05 owl, the <code>sql_query</code> figure in your account's cap list); otherwise it is refused with <code>ALLOWANCE</code>, which says when the allowance comes back. The charge is taken after the query, for the time it used, rounded to a ten-thousandth of an owl. A query that crosses the line pays only for the part past it. A query that fails counts its time against the allowance and is never charged.</p>
      <p>An identical query (the same SQL, <code>params</code> and <code>max_rows</code>) sent again within 30 seconds may be answered from cache: free, with <code>cached: true</code>.</p>
      <h2 id="limits">Limits</h2>
      <p>Read-only SQL runs on a replica the graph's own writes and agents do not share. These limits keep one caller's query from slowing everyone else's.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Limit</th>
              <th>What happens</th>
              <th>Code</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>One statement, a <code>SELECT</code></td>
              <td>Anything else is refused before it runs.</td>
              <td><code>NOT_A_QUERY</code> 400</td>
            </tr>
            <tr>
              <td>Only the views, your CTEs and allowed functions</td>
              <td>Aggregates, window functions, arithmetic, text, dates, arrays and JSON reads are allowed. Writes, row locks, <code>SELECT INTO</code> and functions that reach outside a read are refused.</td>
              <td><code>NOT_ALLOWED</code> 400</td>
            </tr>
            <tr>
              <td>The planner's estimate</td>
              <td>A query estimated above 500,000 is refused before it runs, with the estimate.</td>
              <td><code>TOO_EXPENSIVE</code> 400</td>
            </tr>
            <tr>
              <td>5 seconds</td>
              <td>The query is stopped.</td>
              <td><code>TIMED_OUT</code> 400</td>
            </tr>
            <tr>
              <td>One query at a time per account</td>
              <td>Send the next when the last returns.</td>
              <td><code>ONE_AT_A_TIME</code> 429</td>
            </tr>
            <tr>
              <td>Connections shared by all callers</td>
              <td>When they are all in use the query is refused at once, never queued. Retry after the <code>retry-after</code> header.</td>
              <td><code>BUSY</code> 429</td>
            </tr>
            <tr>
              <td>The daily allowance</td>
              <td>Above.</td>
              <td><code>ALLOWANCE</code> 402</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>A query that is valid but wrong (a misspelt column, a type mismatch) is <code>SQL_ERROR</code> with the database's message. <code>UNAVAILABLE</code> (503) is a fault on Minerval's side. On a deployment that has not set SQL up, the route answers <code>NOT_CONFIGURED</code> (503).</p>
      <p>To stay inside the estimate, filter first on what is indexed (ids, <code>node_id</code> and <code>target_node_id</code>, <code>tags</code> with <code>= ANY</code> or <code>&&</code>, <code>importance</code>, <code>assessed_at</code>, <code>created_at</code>), join on ids, and count in the query instead of fetching rows to count.</p>
      <h2 id="report">Reporting what a query found</h2>
      <div className="dc-callout dc-principle"><b>A query does not change the reporting rules.</b>A status read from <code>assessments</code> still travels with the node's <code>contestation</code>, and with its <code>credence</code> where one is stated. A row with <code>relabeled_from</code> set carries a status a migration brought over and nobody has re-judged; say so if you report it. A node with no current assessment has not been judged, which is not a finding.</div>
      <p>On a deployment that holds private material, the views show only the rows you may read, and the result carries a <code>note</code> saying which labels those were. A count there is over what you can read, not over everything the graph holds.</p>
    </DocPage>
  );
}
