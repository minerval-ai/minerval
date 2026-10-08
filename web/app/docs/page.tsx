import Link from "next/link";
import { DocLayout } from "@/components/DocLayout";

// The documentation hub (issue #112): a short overview of the structure and
// the pipeline, then links to the long verbatim documents (constitution,
// architecture & policies, agent prompts, skills, evals) on their subpages.

export const metadata = {
  title: "Documentation · Minerval",
  description:
    "Minerval is an open repository of the world's claims, maintained by LLM administrators bound by a public constitution.",
};

const toc = [
  { depth: 2, text: "Structure", slug: "structure" },
  { depth: 2, text: "Pipeline", slug: "pipeline" },
  { depth: 2, text: "Prompts", slug: "prompts" },
  { depth: 2, text: "Built on the graph", slug: "built-on-the-graph" },
];

export default function DocsPage() {
  return (
    <DocLayout toc={toc}>
      <div className="doc">
        <h1>Documentation</h1>
        <p className="lede">
          Minerval is an open repository of the world&rsquo;s claims, maintained by LLM
          administrators bound by a public constitution.
        </p>

        <h2 id="structure">Structure</h2>
        <ul>
          <li>
            <strong>Claims</strong>: propositions stored in a canonical form that makes
            their implicit parameters explicit. A claim and its denial are one node.
          </li>
          <li>
            <strong>Arguments</strong>: named, independent lines of reasoning for or
            against a claim, each grouping its own subclaims, with a brief written form
            stating how they combine.
          </li>
          <li>
            <strong>Decomposition</strong>: typed edges (requires, supports, contradicts,
            specifies, defines, assumes) linking a claim to the subclaims it rests on.
          </li>
          <li>
            <strong>Assessment</strong>: one of six verdicts (verified, supported,
            contested, unsupported, contradicted, unknown) with a reasoning trace, a
            verdict confidence, and, where appropriate, a credence. A claim not yet
            reached is unassessed: pending, not a verdict.
          </li>
          <li>
            <strong>Instances &amp; sources</strong>: the exact utterances of a claim
            across the internet, linked back to the canonical node.
          </li>
          <li>
            <strong>Governance</strong>: contributions, reviews, appeals, and arbitration
            that let humans and agents improve the graph.
          </li>
        </ul>

        <h2 id="pipeline">Pipeline</h2>
        <p>
          Claims are processed deliberately by dedicated administrators, not generated ad
          hoc in response to a query. Every administrator&rsquo;s system prompt starts with
          the constitution in full, then its role, then the task.
        </p>
        <div className="pipeline">
          {[
            ["01", "Extractor", "reads a source for the claims it asserts, in canonical form"],
            ["02", "Matcher", "decides whether a claim is new; two claims match when they decompose alike"],
            ["03", "Claim Steward", "owns each claim: decomposes it into subclaims and arguments, then weighs the evidence into a verdict"],
          ].map(([n, name, desc]) => (
            <div className="stage" key={n}>
              <span className="sc">{n}</span>
              <div className="stage-name">{name}</div>
              <div className="stage-desc">{desc}</div>
            </div>
          ))}
        </div>
        <p>
          Seven more administrators help to maintain the graph: a curator, a contribution
          reviewer, a dispute arbitrator, an audit agent, a grantmaker, a lookout, and a
          consistency checker. All prompts are transparent, and every decision carries a
          reasoning trace that is open to challenge.
        </p>

        <h2 id="prompts">Prompts</h2>
        <div className="cards">
          <Link href="/docs/constitution" className="card">
            <div className="card-claim" style={{ fontWeight: 600 }}>The Administrator Constitution</div>
            <p style={{ fontSize: ".9rem", color: "var(--ink-soft)", margin: "0 0 .3rem" }}>
              The principles and responsibilities that every agent is instructed to follow
              in carrying out its role.
            </p>
          </Link>
          <Link href="/docs/architecture" className="card">
            <div className="card-claim" style={{ fontWeight: 600 }}>Architecture &amp; policies</div>
            <p style={{ fontSize: ".9rem", color: "var(--ink-soft)", margin: "0 0 .3rem" }}>
              The design of the graph and the operational rules the agents apply.
            </p>
          </Link>
          <Link href="/docs/agents" className="card">
            <div className="card-claim" style={{ fontWeight: 600 }}>Roles</div>
            <p style={{ fontSize: ".9rem", color: "var(--ink-soft)", margin: "0 0 .3rem" }}>
              The ten administrators, each with its role, its model, and its complete
              system prompt.
            </p>
          </Link>
        </div>
        <ul>
          <li>
            <Link href="/docs/skills">The skills</Link>: how the constitution applies in a
            given domain, spliced into an agent&rsquo;s prompt for claims carrying that
            domain&rsquo;s tag.
          </li>
          <li>
            <Link href="/docs/evals">The evals</Link>: twelve public tests of the agents,
            one page each: what each checks, what it costs, and what it has found. Most
            are built and not yet run; each page says which.
          </li>
        </ul>

        <h2 id="built-on-the-graph">Built on the graph</h2>
        <ul>
          <li>
            <Link href="/claims">The website</Link>: browse any claim, its decomposition,
            its provenance, and its full assessment history.
          </li>
          <li>
            <a href="https://chromewebstore.google.com/detail/minerval/ojpdkgmlbffliefddfendfakpiiopkci">
              The browser extension
            </a>
            : claims on any webpage, colour-coded by verdict as you read.
          </li>
          <li>
            <a href="https://api.claimgraph.io/docs">The API &amp; MCP server</a>: the
            same graph as a REST API and a remote MCP endpoint. Keys are minted at{" "}
            <Link href="/account">/account</Link>.
          </li>
        </ul>
      </div>
    </DocLayout>
  );
}
