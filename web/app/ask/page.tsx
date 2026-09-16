import Link from "next/link";
import { AskGraph } from "@/components/AskGraph";

// "Ask the graph" (#312): a question to the graph as a whole, starting from
// nothing in view. Reached from the search box on /claims, which carries the
// typed text along as ?q=. The panel is a client island; the page itself is
// static and the same for every reader.

export const metadata = {
  title: "Ask the graph · Minerval",
  description:
    "Put a question to the Minerval claim graph and get an answer grounded in its assessments, with the claims it rests on cited.",
};

const STARTERS = [
  "What does the graph say about whether lockdowns did more harm than good?",
  "Which claims about inflation in 2022 are contested?",
  "What is the strongest evidence that the minimum wage reduces employment?",
];

export default async function AskPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const question = q?.trim() || undefined;

  return (
    <div className="doc">
      <p className="sc" style={{ marginBottom: ".5rem" }}>
        <Link href="/claims">← claims</Link>
      </p>
      <h1>Ask the graph</h1>
      <p className="lede">
        A question, answered from what the graph has already weighed: its
        assessments, the disagreements it has mapped, and the reasoning behind
        each verdict, with the claims it rests on cited so you can read them.
      </p>
      <p>
        The graph does not know everything, and the answer says so where it
        is silent. For a claim already on the site, the same box sits on its
        page, anchored to that claim; to search instead of ask, use{" "}
        <Link href="/claims">the claims index</Link>.
      </p>

      <AskGraph
        context={{ kind: "graph" }}
        heading="Your question"
        starters={question ? [] : STARTERS}
        initialQuestion={question}
      />
    </div>
  );
}
