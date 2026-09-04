import Link from "next/link";
import { ContactForm } from "@/components/ContactForm";

// A short about page: what Minerval is (#112), who builds it, and how to
// reach the project (#81). The explainer content lives in /docs.

export const metadata = {
  title: "About · Minerval",
  description: "What Minerval is, and who is behind it.",
};

export default function About() {
  return (
    <div className="doc">
      <p className="sc" style={{ marginBottom: ".5rem" }}>About</p>
      <h1>What is Minerval?</h1>
      <p className="lede">
        An open repository of the world&rsquo;s claims: what is asserted, what each
        assertion rests on, and how much the evidence supports it.
      </p>

      <p className="dropcap">
        Minerval decomposes every claim to its bedrock, weighs it against the evidence,
        and keeps the verdict current as the world changes. The graph is maintained by
        LLM administrators operating under a public constitution; every judgment carries
        a reasoning trace, and every decision is open to challenge. Like Wikipedia, the
        graph is a public good, and the payoff is what gets built on it: the site you are
        reading, a browser extension that annotates the web by verdict, and an API and
        MCP server that ground AI agents in claims that have already been weighed.
      </p>

      <p>
        The full story lives in the <Link href="/docs">documentation</Link>: the idea and
        the model, the pipeline, the{" "}
        <Link href="/docs/constitution">Administrator Constitution</Link>, the{" "}
        <Link href="/docs/architecture">architecture and policies</Link>, and{" "}
        <Link href="/docs/agents">the eight agents</Link> with their complete system
        prompts. How we check that the administrators do their work well, and what we do not
        yet measure, is on <Link href="/docs/evals">the evals page</Link>.
      </p>

      <h2 id="whos-behind-this">Who&rsquo;s behind this</h2>
      <p>
        Minerval is built by <a href="https://jacksonhurley.com">Jackson Hurley</a>, a
        writer and technologist based in New York. Trained as a mathematician at Pomona
        College, with published research in matrix analysis, he writes on the economics
        of science; his essay series{" "}
        <a href="https://jacksonhurley.com">A Marketplace of Ideas</a> argues for funding
        research by measuring what it actually settles, and Minerval is the public record
        that kind of measurement requires. The project is independent and self-funded,
        with its governing texts published in full.
      </p>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".84rem" }}>
        Minerval is open source:{" "}
        <a href="https://github.com/minerval-ai/minerval">
          github.com/minerval-ai/minerval
        </a>{" "}
        · <a href="https://github.com/jacksonqueenking">@jacksonqueenking</a>
      </p>

      <h2 id="contact">Contact</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".84rem" }}>
        Questions, corrections, or a claim the graph gets wrong: write below and it lands
        in a real inbox.
      </p>
      <ContactForm />
    </div>
  );
}
