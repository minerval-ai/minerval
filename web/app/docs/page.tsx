import Link from "next/link";
import { DocLayout } from "@/components/DocLayout";

// The documentation hub (issue #112): one narrative from the idea to the full
// governing texts. The overview, the model, and the pipeline live here inline;
// the long verbatim documents (constitution, architecture & policies, agent
// prompts) are subpages, linked from "The full texts".

export const metadata = {
  title: "How Minerval works · Minerval",
  description:
    "What the claim graph is, how claims move through it, and the full texts that govern the administrators.",
};

const toc = [
  { depth: 2, text: "The idea", slug: "the-idea" },
  { depth: 2, text: "The model", slug: "the-model" },
  { depth: 2, text: "The pipeline", slug: "the-pipeline" },
  { depth: 2, text: "The full texts", slug: "the-full-texts" },
  { depth: 2, text: "How we check the work", slug: "how-we-check-the-work" },
  { depth: 2, text: "Built on the graph", slug: "built-on-the-graph" },
];

export default function DocsPage() {
  return (
    <DocLayout toc={toc}>
      <div className="doc">
        <p className="sc" style={{ marginBottom: ".5rem" }}>Documentation</p>
        <h1>How Minerval works</h1>
        <p className="lede">
          What the claim graph is, how a claim moves through it, and the full texts that
          govern the administrators: the constitution, the architecture and policies, and
          every agent&rsquo;s system prompt.
        </p>

        <h2 id="the-idea">The idea</h2>
        <p className="dropcap">
          Across the internet the same claims get investigated over and over, and the
          reasoning is thrown out the moment a session ends. Minerval keeps that work,
          and builds on it. It is an open repository of the world&rsquo;s claims, maintained by LLM
          administrators bound by a public constitution. Picture Wikipedia, if its pages
          were not topics but individual claims, each one weighed against the evidence and
          kept current as the world changes.
        </p>
        <p>
          The atomic unit is the claim, a proposition that can be true or false. A
          normative claim like &ldquo;we should raise the minimum wage&rdquo; counts no
          less than an empirical one. Claims decompose into subclaims, and two
          formulations are the same claim exactly when they decompose the same way; a
          claim and its denial are one node. Follow a claim down to its bedrock and you
          reach one of three kinds of ground: a verified fact, a contested empirical
          question, or a value premise. That is where a disagreement actually lives, and
          most public disagreement is confused about which kind it is: people believe they
          are arguing about facts when they are using different definitions, or believe
          they differ on values when they actually differ about empirical consequences.
        </p>
        <p>
          Minerval weighs evidence and reaches verdicts, but it will not write down a
          prior for every question and call that the answer. Neutral, not nihilist: the
          job is to make the structure of a disagreement visible, and to keep genuinely
          open questions legible as open. The work of decomposing a claim is done once,
          and applies everywhere the claim appears.
        </p>

        <h2 id="the-model">The model</h2>
        <ul>
          <li>
            <strong>Claims</strong>: propositions stored in a canonical form that makes
            their implicit parameters explicit.
          </li>
          <li>
            <strong>Arguments</strong>: named, independent lines of reasoning bearing on a
            claim, each grouping its own subclaims. Each carries a brief written form
            stating how those subclaims combine, with the subclaims linked inline. A
            claim can carry arguments for and against side by side.
          </li>
          <li>
            <strong>Decomposition</strong>: typed edges (requires, supports, contradicts,
            specifies, defines, assumes) linking a claim to the subclaims it rests on.
          </li>
          <li>
            <strong>Assessment</strong>: one of six verdicts (verified, supported,
            contested, unsupported, contradicted, unknown) and a reasoning trace,
            revised as the world changes. Two numbers can accompany the verdict: a
            verdict confidence (how sure the steward is that the status is right) and,
            where a single probability is honest, a credence that the claim is true.
            A claim the steward has not reached yet is unassessed: a pending state,
            not a verdict.
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

        <h2 id="the-pipeline">The pipeline</h2>
        <p>
          Claims are processed deliberately by dedicated administrators, not generated ad
          hoc in response to a query.
        </p>
        <div className="pipeline">
          {[
            ["01", "Extractor", "reads a source for the claims it asserts, in canonical form"],
            ["02", "Matcher", "same claim, or new? two claims match when they decompose alike, and a claim and its negation count as one"],
            ["03", "Claim Steward", "owns each claim: decomposes it into subclaims and arguments, then weighs the evidence into one of six verdicts"],
          ].map(([n, name, desc]) => (
            <div className="stage" key={n}>
              <span className="sc">{n}</span>
              <div className="stage-name">{name}</div>
              <div className="stage-desc">{desc}</div>
            </div>
          ))}
        </div>
        <p>
          Around them, five more administrators keep the graph honest: a curator tends the
          structure between claims, a contribution reviewer weighs public submissions, a
          dispute arbitrator handles escalations, an audit agent checks the work, and a
          grantmaker designs and stewards funded mandates.
          Eight agents in all; every decision carries a reasoning trace that is open to
          challenge.
        </p>

        <h2 id="the-full-texts">The full texts</h2>
        <p>
          Transparency is the point: the documents below are the actual texts the system
          runs on, published verbatim.
        </p>
        <div className="cards">
          <Link href="/docs/constitution" className="card">
            <div className="card-claim" style={{ fontWeight: 600 }}>The Administrator Constitution</div>
            <p style={{ fontSize: ".9rem", color: "var(--ink-soft)", margin: "0 0 .3rem" }}>
              The 25 principles that govern every agent, given in full as the first layer
              of each system prompt.
            </p>
          </Link>
          <Link href="/docs/architecture" className="card">
            <div className="card-claim" style={{ fontWeight: 600 }}>Architecture &amp; policies</div>
            <p style={{ fontSize: ".9rem", color: "var(--ink-soft)", margin: "0 0 .3rem" }}>
              The design of the graph and the operational rules the agents apply.
            </p>
          </Link>
          <Link href="/docs/agents" className="card">
            <div className="card-claim" style={{ fontWeight: 600 }}>The agents</div>
            <p style={{ fontSize: ".9rem", color: "var(--ink-soft)", margin: "0 0 .3rem" }}>
              The eight administrators, each with its role, its model, and its complete
              system prompt.
            </p>
          </Link>
        </div>

        <h2 id="how-we-check-the-work">How we check the work</h2>
        <p>
          The same transparency applies to our own quality claims. Every eval we run on the
          administrators is described in full, with its cost and its limits, and the results
          are published as they exist, single samples marked as such.
        </p>
        <div className="cards">
          <Link href="/docs/evals" className="card">
            <div className="card-claim" style={{ fontWeight: 600 }}>The evals</div>
            <p style={{ fontSize: ".9rem", color: "var(--ink-soft)", margin: "0 0 .3rem" }}>
              What we measure, how each measurement works, what it costs, what the numbers say
              so far, and what we do not measure yet. Enough to reproduce any of it.
            </p>
          </Link>
        </div>

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
            same graph as a REST API and a remote MCP endpoint that grounds AI agents in
            claims that have already been weighed. Keys are minted at{" "}
            <Link href="/account">/account</Link>.
          </li>
        </ul>
      </div>
    </DocLayout>
  );
}
