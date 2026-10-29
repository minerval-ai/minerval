import Link from "next/link";
import type { ClaimDetail } from "@/lib/types";
import type { DataSource } from "@/lib/data";
import { ClaimView } from "@/components/ClaimView";
import { DecompositionCompass } from "./DecompositionCompass";
import { MapCard } from "./MapCard";
import { DependentsRail } from "./DependentsRail";
import { RelatedRail } from "./RelatedRail";
import { QuestionView, QuestionRail } from "@/components/question/QuestionView";
import { RequestsRail } from "@/components/request/Requests";
import styles from "./margins.module.css";

// The claim page in its full three-column form (issue #42): the decomposition
// compass in the left margin, the dependents in the right, and ClaimView's
// reading column in the centre. On narrow screens the rails fold inline above
// and below the reading column. Assessment history lives at the bottom of the
// reading column (#196), not in a rail.
export function ClaimMargins({ detail, source }: { detail: ClaimDetail; source: DataSource }) {
  // A question is a node of its own kind (constitution §7a), with a page of
  // its own shape in the same frame.
  const isQuestion = detail.claim.kind === "question" && !!detail.question;
  return (
    <div className={styles.bleed}>
      <div className={styles.grid}>
        {/* LEFT — decomposition compass, with the map view as its structural
            counterpart: the same decomposition seen as a navigable figure */}
        <div className={styles.leftRail}>
          {isQuestion ? <QuestionRail detail={detail} /> : detail.tree && <DecompositionCompass tree={detail.tree} />}
          <MapCard claimId={detail.claim.id} tree={detail.tree} />
          <p style={{ marginTop: "0.55rem" }}>
            <Link className={styles.railLink} href={`/claims/${detail.claim.id}/history`}>
              view history →
            </Link>
          </p>
        </div>

        {/* CENTRE — the reading column */}
        <div className={styles.center}>
          <p className="sc" style={{ marginBottom: "1.2rem", display: "flex", gap: ".7rem", alignItems: "center" }}>
            <Link href="/claims">← claims</Link>
            {source === "fixture" && (
              <span className="tag" title="The API is not connected; showing a design fixture.">
                fixture data
              </span>
            )}
          </p>
          {isQuestion ? <QuestionView detail={detail} /> : <ClaimView detail={detail} />}
        </div>

        {/* RIGHT — what depends on this claim */}
        <div className={styles.rightRail}>
          <DependentsRail dependents={detail.dependents ?? []} />
          {/* Requests appear where the API serves them (or offline); a page
              with none says so only once requests exist at all. */}
          {detail.requests && <RequestsRail requests={detail.requests} />}
          <RelatedRail related={detail.related ?? []} />
        </div>
      </div>
    </div>
  );
}
