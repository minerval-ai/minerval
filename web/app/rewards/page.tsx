import Link from "next/link";
import { getDoc } from "@/lib/content";
import { Markdown } from "@/components/Markdown";
import { DocLayout } from "@/components/DocLayout";
import { extractToc } from "@/lib/toc";

// The Contributor Rewards Policy: the terms under which Minerval, Inc. pays
// contributors, from its own funds, for epistemic work it accepted. Vendored
// verbatim from docs/rewards-policy.md by scripts/sync-frontend-content.ts.
// Reachable by URL but not linked from the footer until the payout side
// exists and the policy has an effective date (same treatment as
// /contributors, #191).

export const metadata = {
  title: "Contributor Rewards Policy · Minerval",
  description:
    "The terms under which Minerval pays contributors for epistemic work it accepts: what a reward is, who pays, and when it is owed.",
};

export default function RewardsPolicyPage() {
  const text = getDoc("rewards-policy");
  const toc = extractToc(text, { minDepth: 2, maxDepth: 2 });
  return (
    <div>
      <p className="sc" style={{ marginBottom: "1rem" }}>
        <Link href="/docs">← docs</Link>
      </p>
      <DocLayout
        toc={toc}
        aside={
          <aside className="rail-note">
            <span className="sc">Not yet in force</span>
            Minerval does not currently offer rewards. This page publishes the
            policy that will govern them when it does, so the terms are on the
            record before the first offer is made.
          </aside>
        }
      >
        <Markdown>{text}</Markdown>
      </DocLayout>
    </div>
  );
}
