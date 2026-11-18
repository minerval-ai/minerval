import Link from "next/link";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Members-only deployments · Minerval docs",
  description: "A members-only deployment is the public graph's code run for one organisation: private material held at labels, people who act under permissions an administrator grants, and the organisation's own systems and files in front of its agents. This page is for the administrator deciding whether to…",
};

const toc = [
  { depth: 2, text: "Who is served", slug: "access" },
  { depth: 2, text: "Labels", slug: "labels" },
  { depth: 2, text: "Permissions", slug: "permissions" },
  { depth: 2, text: "The label a request works at", slug: "request-label" },
  { depth: 2, text: "Opening raw sources", slug: "raw" },
  { depth: 2, text: "Connections", slug: "connections" },
  { depth: 2, text: "File sets", slug: "file-sets" },
  { depth: 2, text: "Owls a deployment creates for itself", slug: "owls" },
  { depth: 2, text: "Between the deployment and the public graph", slug: "outside" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/members-only"
      title="Members-only deployments"
      lede={<>A members-only deployment is the public graph's code run for one organisation: private material held at labels, people who act under permissions an administrator grants, and the organisation's own systems and files in front of its agents. This page is for the administrator deciding whether to run one, or running one.</>}
      toc={toc}
    >
      <p>One setting makes a deployment members-only: <code>READS=members</code>, which the <Link href="/docs/self-hosting">self-hosting package</Link> sets for you. Left at <code>open</code>, its starting value, nothing on this page applies and none of its code runs.</p>
      <h2 id="access">Who is served</h2>
      <p>Nothing is served to anyone who is not signed in. One hook authenticates every request before its route runs, so a route added in a later release is closed without anyone remembering to close it. People sign in through the organisation's identity provider (OpenID Connect). There is no anonymous read, and no keyless development identity in any environment.</p>
      <ul>
        <li>A <b>member</b> is an account with at least one live permission. What a member may do is the sum of their permissions.</li>
        <li>An account that has signed in and holds nothing is shown only who it is and what it holds, so it can be told it has no access yet and see the identity an administrator will know it by.</li>
        <li>A request with no credential, or with a key that acts for no person, answers <code>401 SIGN_IN_REQUIRED</code>. A signed-in account with no permission answers <code>403 NOT_A_MEMBER</code>. That holds for an address that does not exist, too.</li>
        <li>Reachable without being a member: the health check, the endpoints an MCP client signs in through (it needs them before it holds a credential), the routes that check their own credential (the operator key, Stripe's webhook), and the web app's call that creates an account when a person signs in.</li>
      </ul>
      <h2 id="labels">Labels</h2>
      <p>Every row of the graph carries a <b>label</b> saying who may read it: a node, a judgment, a source and every passage taken from it, an agent run and each step of its log, a mandate, a conversation with the Assistant. <code>public</code> always exists. An administrator defines more on <code>/admin/labels</code>, and says which labels each one reads: a reader cleared for <code>restricted</code> that reads <code>internal</code> also reads everything <code>internal</code> reads. Labels have no order; the reads are the only relation between them.</p>
      <p>A person's <b>clearance</b> is <code>public</code>, each label a <code>read</code> permission names, and every label those read. Where a deployment holds more than one label, the database itself holds each request's queries to its clearance, so a bug in a route cannot widen what is read. Defining the first label takes about ten seconds while the database turns this on.</p>
      <p>Labels also govern what leaves the machine. A model provider or outside service is sent text at <code>public</code> only, until it is cleared for another label: by a holder of <code>clear_providers</code> on <code>/admin/labels</code>, or, where the deployment fixes it in its settings, by <code>PROVIDER_LABELS</code>. A run whose model's provider is not cleared for its label is refused before anything is sent. A node can carry a judgment at each label: an internal assessment of a public claim sits beside the public one and is read only by those cleared for it.</p>
      <h2 id="permissions">Permissions</h2>
      <p>Six permissions, each granted on its own, to an account or to a group the identity provider names. One person may hold several, and nothing in the code decides who should hold which.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Permission</th>
              <th>Held</th>
              <th>Lets its holder</th>
              <th>Never lets anyone</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>direct</code></td>
              <td />
              <td>Open a mandate and shape it with its Grantmaker, approve its plan, ask a mandate's Correspondent for an update, add sources (among them sets of files they upload), state the organisation's own view on a node, release a node's page to readers who do not read its label, end a standing release, hold a page that has not been released, send the pages a release outside has released to the public graph, and write the words a node is proposed there in. Adopt a request from the public graph. Unless the deployment names another permission for it (<code>PUBLIC_ACTS_BY</code>), act on the public graph in the organisation's name</td>
              <td>Edit an assessment or a run's log</td>
            </tr>
            <tr>
              <td><code>consent</code> (stored as <code>release</code>)</td>
              <td>for one party</td>
              <td>Act at a gate on what rests on that party's material: consent, approve, remove a passage from, hold or delay each part of a page or other item going to readers who do not read its label; set the gate for that party's material; consent to the words a node is proposed to the public graph in. For the organisation's own material, send an agent's report, as redacted, to Minerval's maintainers</td>
              <td>Edit what the agents wrote, or consent for another party</td>
            </tr>
            <tr>
              <td><code>fund</code></td>
              <td />
              <td>Put owls behind work: fund a drafted mandate, add to a mandate or a funded job, back a mandate, and order or fund work on a node or a request</td>
              <td>Decide what the work concludes. A Grantmaker can decline a mandate</td>
            </tr>
            <tr>
              <td><code>read</code></td>
              <td>at one label</td>
              <td>Read what the agents wrote at that label and at the labels it reads</td>
              <td>Change anything the agents wrote</td>
            </tr>
            <tr>
              <td><code>read_sources</code></td>
              <td>at one label</td>
              <td>Open the sources themselves at that label, not only what the agents wrote from them</td>
              <td>Change a source. A later edit is a new source</td>
            </tr>
            <tr>
              <td><code>administer</code></td>
              <td />
              <td>Grant and remove permissions, define labels and which reads which, add parties, say whose material a source is, save the redaction policy of a boundary, sign the statement that registers the deployment's key on the public graph, connect the deployment to the organisation's systems and pick which of their tools agents are offered, register a directory on the deployment's disk as a file set, set up the General mandate, create owls where the deployment creates its own, read and send the usage reports</td>
              <td>Act under a permission they have not also been granted, or change who may do what without a log entry</td>
            </tr>
            <tr>
              <td><code>clear_providers</code></td>
              <td />
              <td>Choose, for each label besides <code>public</code>, which model providers and outside services may be sent the text of work at it, on <code>/admin/labels</code>, where the deployment&rsquo;s settings do not fix that</td>
              <td>Read at a label they have not been granted, or clear a provider where the settings fix the clearance</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Every administrative write needs a signed-in session as well as the permission, so a leaked key, an access token, or an agent acting on text it read can never widen what anyone may read or consent to. For the same reason those writes are not MCP tools; the matching reads are (<code>list_permission_grants</code>, <code>list_parties</code>, <code>list_labels</code>). An MCP client or the Assistant is not offered a tool whose route needs a permission its account lacks, and is told which. Taking money back (withdrawing from a mandate, cancelling a grant, job or order) needs no permission, and neither do proposing, contributing or appealing.</p>
      <p>A grant to a group reaches every account whose latest sign-in carried that group. A sign-in vouches for its groups for <code>SIGN_IN_VALID_HOURS</code> (12 by default), after which the person signs in again. Grants are never deleted: removing one marks it with who removed it and when, and the log of every grant, removal and administrative act is open to every member on the Activity log (<code>/admin/activity</code>). The last live grant of <code>administer</code> cannot be removed.</p>
      <p><b>The first administrator.</b> Set <code>FIRST_ADMINISTRATOR</code> to your sign-in identity (<code>oidc:{"<"}subject{">"}</code>). Your first sign-in, while the deployment has never had an administrator, grants you every permission, at every label and for every party that exists. It works once. If a deployment loses all its administrators, <code>POST /operator/administrators</code> with the operator key grants <code>administer</code> again, and nothing else.</p>
      <h2 id="request-label">The label a request works at</h2>
      <p>Reading is held to a clearance. Writing needs one label, and the database lets a request add a row only at the label it works at. Where a deployment has only <code>public</code>, nothing here is asked. Where it has more, every request that writes gets its label in one of two ways, and a missing label is never read as <code>public</code>:</p>
      <ul>
        <li><b>From the row it is about.</b> A contribution, an appeal, an order, funding, a message in an existing conversation: each writes at the label of the row it concerns. A person who may not read that row is told it does not exist.</li>
        <li><b>From the person, when they start something new.</b> A source, a proposed node, a granting conversation, a conversation with the Assistant, an API key: the request names <code>label</code>, among the labels the person may read. There is no default. <code>GET /labels/mine</code> lists the choices with who reads each.</li>
      </ul>
      <p>Work on a node that already exists (<code>POST /claims/:claim_id/order</code>, <code>/contribute</code>, <code>/decompose</code>, and stating a view) takes an optional <code>label</code>: name one you hold that reads the node's label, and the work and its result are at that label, beside the node's own judgment.</p>
      <p><b>Keys, tokens and the Assistant work at one fixed label</b>, because an agent holds them. An API key's label is named when it is made, an OAuth client's when it is approved, and an Assistant conversation's when it starts. A request made with one reads what that label reads (within the person's clearance), files what it starts at that label with no parameter, and may change a row only at that same label. So an agent cannot choose where something is filed, or read at one label and write at another, whatever text it has read. A key made before the deployment had a second label works at <code>public</code>. A signed-in session has no label of its own, so <code>/mcp</code> takes a key or a token, never a session.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th className="dc-num">Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>LABEL_REQUIRED</code></td>
              <td className="dc-num">400</td>
              <td>Something new, and no label named. The answer lists the labels you may name</td>
            </tr>
            <tr>
              <td><code>LABEL_NOT_READABLE</code></td>
              <td className="dc-num">403</td>
              <td>A label you may not read, in the same words whether or not it exists</td>
            </tr>
            <tr>
              <td><code>LABEL_DOES_NOT_READ</code></td>
              <td className="dc-num">400</td>
              <td>Work on a node at a label that does not read the node's label</td>
            </tr>
            <tr>
              <td><code>LABEL_FIXED</code></td>
              <td className="dc-num">400</td>
              <td>A key or token named a label other than its own</td>
            </tr>
            <tr>
              <td><code>LABEL_MISMATCH</code></td>
              <td className="dc-num">409</td>
              <td>A key or token tried to change a row at another label</td>
            </tr>
            <tr>
              <td><code>CREDENTIAL_LABEL_NOT_READABLE</code></td>
              <td className="dc-num">403</td>
              <td>A key or token whose label its owner may no longer read</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="raw">Opening raw sources</h2>
      <p><code>read</code> at a label covers what the agents wrote there: nodes, assessments, each recorded passage, an examination's findings. <code>read_sources</code> opens the sources themselves, and is granted label by label: a grant at one label does not open the sources of a label it reads. <code>public</code> sources are open to every member. Where a person lacks it, the text is withheld and a notice names the permission and the label:</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Where</th>
              <th>Without <code>read_sources</code></th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>GET /sources/:source_id/document</code> (<code>get_source_document</code>)</td>
              <td>Each segment without its text or heading (<code>text_withheld</code>). Structure, length and the passages the agents recorded are served</td>
            </tr>
            <tr>
              <td><code>GET /sources/:source_id/examinations</code> (<code>get_source_examinations</code>)</td>
              <td>Each finding without the heading of its segment (<code>headings_withheld</code>). The finding itself is served</td>
            </tr>
            <tr>
              <td><code>GET /runs/:run_id/steps</code> and one step</td>
              <td>The parts of a step that hold a source's text are replaced by the notice; the rest of the step and its hash are served</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Read-only SQL returns no source text at all. What the permission does not protect: a passage an agent quoted from a source is readable by anyone who reads its label, and an agent's own run reads what its label reads, sources included.</p>
      <h2 id="connections">Connections</h2>
      <p>A <b>connection</b> points the deployment at an MCP server over one of the organisation's systems (a warehouse, a wiki, a ticket system), so the agents that weigh evidence can read it where it lives. An administrator adds it at a label they read, names whose system it is and what that party stands to gain or lose, and picks which of the server's tools agents are offered.</p>
      <div className="dc-callout"><b>A connection is for reading.</b>The deployment cannot prove that a tool only reads. Three things stand between an agent and a write, strongest first: a read-only credential granted at the system itself, which is the organisation's to do; the administrator's pick, tool by tool, of what is offered; and the server's markings, which forbid picking a tool the server says writes. A picked tool whose name, description, schema or markings change at the server is withdrawn until an administrator looks again.</div>
      <ul>
        <li><b>The credential</b> is never stored or shown. The connection names an environment variable starting <code>CONNECTION_</code>, read at the moment of each call.</li>
        <li><b>Who gets it.</b> The Claim Steward, the Question Steward, and the Researcher when a Steward launched it or it takes up a request, in runs whose label reads the connection's. A mandate's Lookouts may read through it but keep nothing.</li>
        <li><b>What a call becomes.</b> Each result is stored whole with its hash and time. A result is not a source until the agent keeps it (<code>keep_reading</code>), which gives it an address to cite. A call is never retried, and is not charged to the run's budget.</li>
        <li><b>Limits the administrator sets:</b> a timeout per call (120 seconds unless set, 5 to 900) and an optional rate across all runs.</li>
      </ul>
      <p>Administrators add and manage connections at <code>/admin/connections</code>, under Material in the sidebar. <a href="https://github.com/minerval-ai/minerval/blob/main/docs/connections.md">docs/connections.md</a> has the rest.</p>
      <h2 id="file-sets">File sets</h2>
      <p>A <b>file set</b> brings in files too large or too raw to be a document: a data export, logs, evaluation transcripts, a repository. Every file is hashed when it is added, a set is closed once filled and never changes, and agents explore it in a sandbox with no network, listing, searching and running their own analysis. The scripts and outputs an assessment rests on are kept with it.</p>
      <ul>
        <li><b>Upload</b> a set (up to <code>FILE_SET_UPLOAD_MAX_BYTES</code>, 10 GiB unless set) with <code>direct</code>.</li>
        <li><b>Register a directory</b> already on the deployment's disk with <code>administer</code>, because whoever registers it decides what label those files get. Nothing is copied.</li>
        <li>Either way the set is added at a label the person may read, and is offered to the same three roles as a connection, in runs whose label reads the set's. They get <code>run_command</code>, <code>open_output</code>, <code>keep_analysis</code> and <code>keep_file</code>.</li>
        <li>Sandbox time is charged to the run's budget at <code>SANDBOX_HOUR_COST_MICRO_USD</code> (50,000, that is $0.05 an hour, unless set), and the run is told the rate.</li>
      </ul>
      <p><a href="https://github.com/minerval-ai/minerval/blob/main/docs/file-sets.md">docs/file-sets.md</a> has the sandbox, its limits, and what a kept analysis records.</p>
      <h2 id="owls">Owls a deployment creates for itself</h2>
      <p>On the public graph owls are bought. A deployment that pays its own model providers sets <code>OWLS=created</code>: its owls are the organisation's own unit for budgeting its agents' work, one owl for one dollar of metered cost at the prices it is configured with. They are not bought, and never convert to or from owls on the public graph.</p>
      <ul>
        <li>It needs <code>READS=members</code>, refuses to start beside a Stripe key, and removes the purchase routes.</li>
        <li>An administrator creates owls from a signed-in session (<code>POST /owls/created</code>, or Budget at <code>/admin/budget</code>) into an account's balance or straight into a mandate's budget. Each act is logged with the amount, the recipient and a note.</li>
        <li>There is no cap: a ceiling here would be a number nobody chose. In its place, <code>get_created_owls</code> (<code>GET /owls/created</code>) shows every member how much has been created, by whom, into what, and what the deployment's runs have spent.</li>
        <li>No signup or monthly grant is given in any members-only deployment unless it sets one, and with <code>OWLS=created</code> neither can be set.</li>
        <li>A model the price catalog does not price needs a price in <code>MODEL_PRICES</code>; with <code>OWLS=created</code> a call to an unpriced model is refused before anything is sent.</li>
      </ul>
      <p>No agent work runs except by allocation, so each label whose upkeep and audits are to be paid for needs its own <b>General mandate</b>, set up by an administrator from a signed-in session (Budget, <code>/admin/budget</code>; <code>list_standing_mandates</code> reads it). The administrator sets its pace, the most owls it may commit in a rolling day; where owls are created, its budget is created with it, and where they are sold it is funded from a balance like any mandate.</p>
      <h2 id="outside">Between the deployment and the public graph</h2>
      <p>A members-only deployment can keep a read-only <Link href="/docs/self-hosting">mirror of the public graph</Link>, publish redacted pages back to it under a registered signing key, and act there in the organisation's name through the organisation's own account. On the metered price (<code>PUBLIC_GRAPH_PRICE=metered</code>, the starting value) it sends Minerval one figure a day for billing, the owls its runs spent, and never what the work was for. The figure goes privately under the organisation's account and is not published; on the flat price nothing is reported; the Usage tab of Budget (<code>/admin/budget?tab=usage</code>) shows what has been and will be sent. <a href="https://github.com/minerval-ai/minerval/blob/main/docs/accounts.md#members-only-deployments">docs/accounts.md, "Members-only deployments"</a> has every route and page.</p>
    </DocPage>
  );
}
