import Link from "next/link";
import { Code } from "@/components/docs/Code";
import { CodeTabs } from "@/components/docs/CodeTabs";
import { DocPage } from "@/components/docs/DocPage";
import { LiveCard } from "@/components/docs/LiveCard";

export const metadata = {
  title: "Documentation · Minerval docs",
  description: "Minerval is a shared, public map of what is known, how well it is known, and where real disagreement lies. These pages show you how to read it, check text against it, add to it and fund work on it, from an agent, from code or from the site.",
};

const toc = [
  { depth: 2, text: "Start in one line", slug: "start" },
  { depth: 2, text: "What you can do", slug: "what" },
  { depth: 2, text: "One claim, as the graph returns it", slug: "example" },
  { depth: 2, text: "Reporting what the graph says", slug: "report" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs"
      title="Documentation"
      lede={<>Minerval is a shared, public map of what is known, how well it is known, and where real disagreement lies. These pages show you how to read it, check text against it, add to it and fund work on it, from an agent, from code or from the site.</>}
      toc={toc}
    >
      <div className="dc-doors"><Link href="/docs/connect" className="dc-door">
  <span className="sc">Connect an agent</span><strong>Use the graph from Claude or any MCP client</strong>
  <p>Add one server URL. Your client signs you in the first time it calls.</p>
  <span className="dc-go">Connect an agent →</span>
</Link> <Link href="/docs/api" className="dc-door">
  <span className="sc">Build on the API</span><strong>The same graph over REST</strong>
  <p>Reads need no key and can be called from any web page. Writes take an API key. Cards for embedding, exports for citing.</p>
  <span className="dc-go">REST API →</span>
</Link> <Link href="/docs/constitution" className="dc-door">
  <span className="sc">Understand the judgments</span><strong>How the graph is governed</strong>
  <p>The constitution the administrators work under, each agent's prompt, the evals, and the run behind every verdict.</p>
  <span className="dc-go">Read the constitution →</span>
</Link></div>
      <h2 id="start">Start in one line</h2>
      <CodeTabs
        tabs={[
          { label: "Claude Code", code: `claude mcp add --transport http minerval https://api.claimgraph.io/mcp`, note: "Then run /mcp in Claude Code to sign in through the browser." },
          { label: "Claude.ai / Cowork", code: `Settings → Connectors → Add custom connector
  Name  Minerval
  URL   https://api.claimgraph.io/mcp`, note: "Leave the OAuth client ID and secret empty. The connector registers itself and opens the sign-in page." },
          { label: "Plugin", code: `/plugin marketplace add minerval-ai/minerval
/plugin install minerval@minerval`, note: "For Claude Code and Cowork: the same connection, with slash commands and a fact-checker subagent." },
          { label: "API key", code: `claude mcp add --transport http minerval https://api.claimgraph.io/mcp \\
  --header "x-api-key: $MINERVAL_API_KEY"`, note: "For any client that lets you set a header. Create a key on your account page." },
          { label: "REST", code: `curl https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071/card`, note: "Reads need no key." },
        ]}
      />
      <p className="dc-small">Reading the graph is free. On the public graph, new accounts start with 11 owls for the tools that run models: 10 for signing up and 1 for the month. Another owl lands in each later month the account is used. <Link href="/docs/connect">Full setup →</Link></p>
      <h2 id="what">What you can do</h2>
      <div className="dc-caps">
        <div className="dc-cap">
          <div className="dc-cap-head"><Link href="/docs/reading">Read the graph</Link><span className="dc-pill dc-read">free</span></div>
          <p>Find a claim, see where it stands, and walk what it rests on and what rests on it.</p>
          <span className="dc-cap-tools">search_claims · get_claim_card · get_decomposition · get_dependents</span>
        </div>
        <div className="dc-cap">
          <div className="dc-cap-head"><Link href="/docs/fact-checking">Check text</Link><span className="dc-pill dc-charged">metered, at most 0.1 owl</span></div>
          <p>Match one assertion to the claim it states, or check a whole passage against the graph.</p>
          <span className="dc-cap-tools">match_claim · assess_text · get_page_analysis</span>
        </div>
        <div className="dc-cap">
          <div className="dc-cap-head"><Link href="/docs/following">Follow what changes</Link><span className="dc-pill dc-read">free</span></div>
          <p>Read every material change to a judgment since a cursor you keep, under a claim or a topic.</p>
          <span className="dc-cap-tools">list_graph_changes · list_correspondent_updates</span>
        </div>
        <div className="dc-cap">
          <div className="dc-cap-head"><Link href="/docs/contributing">Contribute</Link><span className="dc-pill dc-write">reviewed</span></div>
          <p>Challenge a verdict, add evidence or state your own view, free of charge. Proposing a new claim or a source spends owls.</p>
          <span className="dc-cap-tools">submit_contribution · state_view · propose_claim</span>
        </div>
        <div className="dc-cap">
          <div className="dc-cap-head"><Link href="/docs/commissioning">Commission work</Link><span className="dc-pill dc-escrow">escrowed</span></div>
          <p>Fund an assessment, a deep decomposition, or a mandate you agree with a Grantmaker. What the work does not spend comes back.</p>
          <span className="dc-cap-tools">fund_claim_assessment · fund_deep_decomposition · start_grant_conversation</span>
        </div>
        <div className="dc-cap">
          <div className="dc-cap-head"><Link href="/docs/verifying">Verify a judgment</Link><span className="dc-pill dc-read">free</span></div>
          <p>Open the run that wrote an assessment, step by step, and check its log against its seal.</p>
          <span className="dc-cap-tools">get_run · list_run_steps · verify_run_log</span>
        </div>
      </div>
      <p className="dc-small">A call that runs a model holds its cap from your balance when it starts and returns what the metered cost did not use. You never pay more than the cap. <Link href="/docs/owls">Owls and pricing →</Link></p>
      <h2 id="example">One claim, as the graph returns it</h2>
      <p>This is the live card for one claim. <code>get_claim_card</code> and <code>GET /claims/:claim_id/card</code> return this shape, and the embed renders it.</p>
      <LiveCard />
      <p>Every key is always present. A claim's judgment is <code>assessment_status</code>, a question's is <code>standing</code>, and a quantity's is <code>estimate</code> with its <code>unit</code>. A node nobody has assessed yet returns nulls in those fields, which is not an error and not a verdict. <code>assessment_confidence</code> and <code>assessment_alternative_status</code> are kept for callers and are not shown on the site; <Link href="/docs/concepts">Core concepts</Link> says what they mean.</p>
      <h2 id="report">Reporting what the graph says</h2>
      <div className="dc-callout dc-principle"><b>Report the graph's judgment as the graph's.</b>Give its status, its credence where one is stated, its contestation beside them, and the claim's page link. Keep your own view separate and label it as yours.</div>
      <div className="dc-callout dc-principle"><b>Don't round.</b>A status describes the evidence, not the debate, and contestation is reported separately. “Inconclusive” and “doubtful” are findings, not failures. A verified claim is reported plainly.</div>
      <div className="dc-callout dc-principle"><b>The graph's silence is not evidence.</b>A claim the graph does not hold, or holds and has not assessed, is no licence to answer from memory. An assessed “unknown” is a finding that the evidence is insufficient. Where the graph is silent on something that matters, propose the claim or submit a source, with your user's agreement.</div>
      <p className="dc-small">Every MCP client is shown these principles when it connects. The <Link href="/docs/resources">caller skills</Link> give the full version.</p>
    </DocPage>
  );
}
