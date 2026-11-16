import Link from "next/link";
import { DocPage } from "@/components/docs/DocPage";

export const metadata = {
  title: "Resources, prompts and skills · Minerval docs",
  description: "Besides its tools, the MCP server offers resources a client can attach as context, two prompt templates, and the caller skills: written advice for agents on using the graph well. This page lists each.",
};

const toc = [
  { depth: 2, text: "Resources", slug: "resources" },
  { depth: 2, text: "Prompts", slug: "prompts" },
  { depth: 2, text: "Caller skills", slug: "skills" },
];

export default function Page() {
  return (
    <DocPage
      href="/docs/resources"
      title="Resources, prompts and skills"
      lede={<>Besides its tools, the MCP server offers resources a client can attach as context, two prompt templates, and the caller skills: written advice for agents on using the graph well. This page lists each.</>}
      toc={toc}
    >
      <h2 id="resources">Resources</h2>
      <p>A client that supports resources lists them with <code>resources/list</code> and reads one with <code>resources/read</code>. Reading a resource is free.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>URI</th>
              <th>Type</th>
              <th>What it holds</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>claims://recent</code></td>
              <td>JSON</td>
              <td>The 30 most recently updated claims, each with its <code>page_url</code>: where the graph is changing now.</td>
            </tr>
            <tr>
              <td><code>minerval://constitution</code></td>
              <td>Markdown</td>
              <td>The constitution every administrator works under, verbatim: what a claim is, how claims are assessed, what each status means, how contributions are judged, and what funding can and cannot buy.</td>
            </tr>
            <tr>
              <td><code>minerval://skills/<i>name</i></code></td>
              <td>Markdown</td>
              <td>One caller skill, as its <code>SKILL.md</code> with frontmatter. All seven are listed, below.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h3 id="templates">Templates</h3>
      <p>Two resources are addressed by a parameter.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Template</th>
              <th>Type</th>
              <th>What it holds</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>claim://{"{"}claim_id{"}"}</code></td>
              <td>JSON</td>
              <td>One claim with its current assessment and its decomposition tree, to attach as context. A merged id resolves to the surviving node and says so in <code>resolved_from</code>.</td>
            </tr>
            <tr>
              <td><code>minerval://skills/{"{"}name{"}"}</code></td>
              <td>Markdown</td>
              <td>A caller skill by name.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>Read the constitution before you contribute or fund anything, and whenever a verdict surprises you.</p>
      <h2 id="prompts">Prompts</h2>
      <p>A prompt is a ready-written instruction a client can offer its user, often as a slash command. Each of these runs a charged tool, so using one spends owls (<Link href="/docs/owls">Owls and pricing</Link>).</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Prompt</th>
              <th>What it asks the agent to do</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>fact_check_document(document)</code></td>
              <td>Run <code>assess_text</code> on the document and report the graph's verdict on each claim, cited by <code>page_url</code>. It tells the agent how to read <code>not_in_graph</code>, <code>unknown</code>, <code>undecided</code> and <code>unassessed</code>, to invert the assessment when the stance is <code>denies</code>, and to split a document longer than 50,000 characters.</td>
            </tr>
            <tr>
              <td><code>check_assertion(assertion)</code></td>
              <td>Run <code>match_claim</code> on one assertion and explain its standing: the claim it maps to, if any, and the current assessment, using <code>get_decomposition</code> where the dispute needs showing.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2 id="skills">Caller skills</h2>
      <p>The caller skills carry the graph's principles to agents that use it from outside. They are advice the agent is free to follow, not rules the graph enforces. One set of files reaches callers three ways:</p>
      <ul>
        <li>as Agent Skills, in the <Link href="/docs/plugin">Claude Code plugin</Link>;</li>
        <li>as MCP resources, at <code>minerval://skills/<i>name</i></code>, for clients that load resources but not skills;</li>
        <li>in their shortest form, as the server's initialize instructions, which every MCP client is shown.</li>
      </ul>
      <p>Each description below is the skill's own, from its frontmatter. An agent reads it to decide when to load the skill.</p>
      <div className="dc-tablewrap">
        <table>
          <thead>
            <tr>
              <th>Skill</th>
              <th>Use it when</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>claim-checking</code></td>
              <td>Checking factual assertions against the graph instead of recollection, and reporting what it finds the way the graph reasons: its judgment kept apart from your own, uncertainty kept honest, gaps turned into contributions. For prose that asserts checkable facts, or when someone asks whether a claim is true, disputed or supported.</td>
            </tr>
            <tr>
              <td><code>commissioning-research</code></td>
              <td>Funding work on the graph in good faith: a mandate through the Grantmaker, an assessment, backing an existing mandate, bringing sources and views without trying to steer conclusions. Covers which mandates are appropriate and which the Grantmaker will refuse.</td>
            </tr>
            <tr>
              <td><code>sql</code></td>
              <td>Querying the graph and its action ledger with <code>query_sql</code>: what each view holds, how they join, what is fast, and queries for common questions. For a filter, join or count the other tools do not offer.</td>
            </tr>
            <tr>
              <td><code>using-minerval</code></td>
              <td>Helping someone use the product: the surfaces (site, Assistant, browser extension, MCP, API, Claude plugin), what each page of the site shows, how to connect an agent, and how owls are bought and spent.</td>
            </tr>
            <tr>
              <td><code>writing-from-the-graph</code></td>
              <td>Making a document from what the graph holds (a brief, a ranked list, a table, evidence requests): which reads help, what importance means, how citations stay pinned, and what a request looks like.</td>
            </tr>
            <tr>
              <td><code>minerval-constitution</code></td>
              <td>The constitution in full, with a guide to reading it from outside. For why the graph judged a claim as it did, what status, confidence, credence, contestation or an estimate means, and what funding can and cannot buy. Not needed for a routine lookup.</td>
            </tr>
            <tr>
              <td><code>administrator-skills</code></td>
              <td>The skills and role prompts the graph's own administrators work under, verbatim. For how a particular agent will treat what you send it, why the graph did something, or how its agents do work you are doing yourself (a literature search, a provenance trace, a proof).</td>
            </tr>
          </tbody>
        </table>
      </div>
      <h3 id="instructions">The initialize instructions</h3>
      <p>Every MCP client receives these when it connects, whether or not it loads skills. In brief:</p>
      <ul>
        <li>Report the graph's judgment as the graph's: its status, its credence where stated, and the claim's <code>page_url</code>. Keep your own view separate and labelled as yours.</li>
        <li>Do not round. A status describes the evidence, not the debate; contestation is reported separately. <code>inconclusive</code> and <code>doubtful</code> are findings, not failures.</li>
        <li>The graph's silence is not evidence. An assessed <code>unknown</code> is a finding that the evidence is insufficient; an unassessed claim has no verdict yet.</li>
        <li>Reads are free. Check the balance and confirm amounts with your user before anything that spends or escrows owls.</li>
      </ul>
    </DocPage>
  );
}
