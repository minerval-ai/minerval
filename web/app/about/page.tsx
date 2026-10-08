import Link from "next/link";
import type { ReactNode } from "react";
import { ContactForm } from "@/components/ContactForm";

// The about page: the problem, what Minerval is (#112), where it's going, who
// builds it, and how to reach the project (#81). The explainer content lives
// in /docs. Asides are sidenotes styled after the browser extension's
// annotations: a tinted, underlined span in the text and a card in the margin.

export const metadata = {
  title: "About · Minerval",
  description: "What Minerval is, where it's going, and who is behind it.",
};

const CONSTITUTION = "/docs/constitution";

// An annotated span plus its margin note. The note sits right after the span
// so hovering either one can highlight the other in CSS.
function Annot({ n, text, children }: { n: number; text: ReactNode; children: ReactNode }) {
  return (
    <>
      <span className="annot" id={`annot-${n}`}>
        {text}
        <sup className="annot-num">{n}</sup>
      </span>
      <span className="sidenote annot-note" role="note">
        <span className="sc">Note {n}</span>
        {children}
      </span>
    </>
  );
}

export default function About() {
  return (
    <div className="doc">
      <h1>About</h1>
      <p className="dropcap">
        What to link to to prove your point on the internet is an underappreciated
        unsolved problem, even when you are &lsquo;demonstrably&rsquo; right. None of the
        existing solutions are really adequate. Some random paper on Arxiv whose jargony
        abstract plausibly says something adjacent to the thing you&rsquo;re saying? A
        blog post by some guy your interlocutor doesn&rsquo;t know and doesn&rsquo;t
        trust? A news article? The Wikipedia page for an adjacent topic? A link to your
        conversation with Claude where you controlled the framing of the question? None
        of these things is likely to satisfy the objector.
      </p>

      <h2 id="what-is-minerval">What is Minerval?</h2>
      <p>
        Minerval is an open source project to build a database of{" "}
        <Annot n={1} text="claims about the world">
          Claims are canonical forms of public claims about the world. More details in
          part II of our <Link href={CONSTITUTION}>constitution</Link>.
        </Annot>
        , figure out what the important ones are, and ask LLMs to assess their epistemic
        statuses. Its claim pages (
        <Link href="/claims/0d59fb15-7dc1-49b1-b9d9-9462f17d2d21/map">example</Link>) are
        intended to be the place that one links to or consults for the canonical, neutral
        epistemic status of any claim, much as Wikipedia is the canonical (and at least
        aspirationally neutral) place one goes for a standard introduction to any given
        topic.
      </p>
      <p>
        Minerval decomposes every claim to its bedrock, weighs it against the evidence,
        and keeps the verdict current as the world changes. The graph is maintained by
        LLM administrators operating under a public{" "}
        <Link href={CONSTITUTION}>constitution</Link>; every judgment carries a reasoning
        trace, and every decision is open to challenge. Like Wikipedia, the graph is a
        public good, and the payoff is what gets built on it: the site you are reading, a{" "}
        <a href="https://chromewebstore.google.com/detail/minerval/ojpdkgmlbffliefddfendfakpiiopkci">
          browser extension
        </a>{" "}
        that annotates the web by verdict, and an API and MCP server that ground AI agents
        in claims that have already been weighed.
      </p>
      <p>
        If done properly, with{" "}
        <Annot n={2} text="today’s best LLMs">
          Nobody will use this, and no one should use it, if the outputs are noticeably
          worse than what they could get by opening a new tab and simply asking their own
          frontier model.
        </Annot>
        , this should allow for actually good mass fact-checking, in the same way that
        Pangram allows{" "}
        <Annot n={3} text="actually good mass slop-detection">
          Including via our browser extension or, ideally, since no one uses browser
          extensions, direct integration with platforms such as LessWrong, Substack
          (similar to what they&rsquo;ve done with Pangram), or X.
        </Annot>
        .
      </p>
      <p>
        I am aware of the long history of failed attempts at similar projects, and why
        most ideas in the category are indeed doomed. I am also very aware of the
        challenges of doing actually good epistemic work across domains with even the
        best of today&rsquo;s LLMs. For more details on how I approach the problem, please
        read our <Link href={CONSTITUTION}>constitution</Link>.
      </p>

      <h2 id="where-its-going">Where it&rsquo;s going</h2>
      <p>
        There are shorter-term goals and long-term goals, which are somewhat distinct.
      </p>
      <p>
        In the short term, I aim to systematically expand the frontiers of mathematics:
        1) map out existing mathematical knowledge (
        <Link href="/claims/5f9a607f-3072-4e9d-95d8-37a3aedb0d2b/map">example</Link>), 2)
        produce Lean statements of each open problem, 3) pick all the low-hanging fruit
        that can be solved using less than $200/problem through generic prompting and a
        simple harness, and 4) assign Erdős-style proof/counterexample bounties based on
        the importance of each theorem.
      </p>
      <p>
        In the long term, I aim to turn Minerval into a central institution that
        organizes the funding of research and knowledge production across domains. To
        efficiently allocate attention in a scientific domain, we must first have a map
        of the work to be done, and then{" "}
        <Annot n={4} text="a mechanism for pricing that work">
          A complex problem. See{" "}
          <a href="https://jacksonhurley.com/allocating-attention-in-claimspace">
            Allocating Attention in Claimspace
          </a>
          .
        </Annot>
        . Minerval does both. By delegating funding decisions to{" "}
        <Link href="/account/grants">grantmaker</Link> agents, it aims to solve the
        information asymmetry problem in the market for science.
      </p>

      <h2 id="status">Status</h2>
      <p>
        I have built an <Link href="/docs/evals">eval suite</Link> measuring properties
        which, if robustly satisfied at the graph level by the multi-agent system that
        administers the graph, would ensure that it can scale efficiently without losing
        coherence or accuracy (stability, path independence, consistency, and{" "}
        <Annot n={5} text="adversarial robustness">
          If Minerval succeeds at becoming a canonical source, people will try to
          influence it. Minerval invites contributions and new evidence, but that comes
          with substantial attack surface area for bad-faith actors. The plan here is to
          set up a test environment and give agents the task of manipulating the
          graph&rsquo;s administration into supporting their position, then keep
          adjusting until relentless frontier agents robustly fail at red-teaming.
        </Annot>
        ). Our <Link href="/claims">current mapped subdomains</Link> were built for the
        Future of Life Foundation&rsquo;s{" "}
        <a href="https://flf.org/epistack-competition/">Epistack competition</a>, where
        Minerval was{" "}
        <a href="https://www.lesswrong.com/posts/mxzvL3hYFCcutQqcR/flf-s-epistemic-case-study-competition-results">
          selected as a winner
        </a>
        . They look about right, but we need to run larger multi-agent tests to be
        confident that these properties hold.
      </p>

      <h2 id="whos-behind-this">Who&rsquo;s behind this</h2>
      <p>
        Minerval is built by{" "}
        <Annot n={6} text={<a href="https://jacksonhurley.com/">Jackson Hurley</a>}>
          I have incorporated Minerval, Inc. as a vanilla Delaware C-Corp, but I have no
          immediate plans to either raise money from VCs or provide excludable goods and
          services, with the very minor exception of the chat feature in the browser
          extension/API.
        </Annot>
        . At this time, Minerval is just me and Claude Code. I am actively looking for
        cofounders. If you like the vision and want to work on it, please{" "}
        <a href="#contact">reach out</a>. If you know the perfect person, please put us in
        touch!
      </p>
      <p>
        The full story lives in the <Link href="/docs">documentation</Link>: the idea and
        the model, the pipeline, the{" "}
        <Link href={CONSTITUTION}>Administrator Constitution</Link>, the{" "}
        <Link href="/docs/architecture">architecture and policies</Link>, and{" "}
        <Link href="/docs/agents">the ten agents</Link> with their complete system
        prompts.
      </p>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".84rem" }}>
        Minerval is open source:{" "}
        <a href="https://github.com/minerval-ai/minerval">
          github.com/minerval-ai/minerval
        </a>
        ; code MIT, content CC0.
      </p>

      <h2 id="contact">Contact</h2>
      <ContactForm />
    </div>
  );
}
