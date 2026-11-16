import Link from "next/link";
import type { JudgmentInputs } from "@/lib/types";
import { movedPremises } from "@/lib/since-assessed";
import { OrderAssessment } from "./OrderAssessment";

// What moved under the judgment since it was written (#566), said where the
// judgment is. The page shows it only when something a reader should hear
// of moved (lib/since-assessed.ts), so when it shows it is worth reading:
// the line opens onto the premises that moved, each with how, and beside
// them the way to have the node judged again.
export function SinceAssessed({
  claimId,
  line,
  inputs,
  judgment = "assessment",
}: {
  claimId: string;
  /** The line from sinceAssessedLine; the caller renders nothing when it is null. */
  line: string;
  inputs: JudgmentInputs | null | undefined;
  /** The page's word for the judgment: "assessment" for a claim, "estimate" for a quantity. */
  judgment?: "assessment" | "estimate";
}) {
  const moved = movedPremises(inputs);
  return (
    <details className="assess-changed-since">
      <summary>{line}</summary>
      <div className="assess-changed-since-body">
        {moved.length > 0 && (
          <ul>
            {moved.map((p) => (
              <li key={`${p.node_id}:${p.change}`}>
                <Link href={`/claims/${p.node_id}`}>{p.text ?? "a premise"}</Link>
                <span className="assess-changed-since-how">{p.change}</span>
              </li>
            ))}
          </ul>
        )}
        <p>
          The {judgment} above was made before these changes. Whether they
          change it is for a fresh {judgment} to say.
        </p>
        <OrderAssessment claimId={claimId} variant="reassess" />
      </div>
    </details>
  );
}
