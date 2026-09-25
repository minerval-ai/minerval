import Link from "next/link";
import type { ClaimDetail } from "@/lib/types";
import type { DataSource } from "@/lib/data";
import { ClaimView } from "@/components/ClaimView";
import { DecompositionCompass } from "./DecompositionCompass";
import { MapCard } from "./MapCard";
import { DependentsRail } from "./DependentsRail";
import { RelatedRail } from "./RelatedRail";
import styles from "./margins.module.css";

// The claim page in its full three-column form (issue #42): the decomposition
// compass in the left margin, the dependents in the right, and ClaimView's
// reading column in the centre. On narrow screens the rails fold inline above
// and below the reading column. Assessment history lives at the bottom of the
// reading column (#196), not in a rail.
export function ClaimMargins({ detail, source }: { detail: ClaimDetail; source: DataSource }) {
  return (
    <div className={styles.bleed}>
      <div className={styles.grid}>
        {/* LEFT — decomposition compass, with the map view as its structural
            counterpart: the same decomposition seen as a navigable figure */}
        <div className={styles.leftRail}>
          {detail.tree && <DecompositionCompass tree={detail.tree} />}
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
          <ClaimView detail={detail} />
        </div>

        {/* RIGHT — what depends on this claim */}
        <div className={styles.rightRail}>
          <DependentsRail dependents={detail.dependents ?? []} />
          <RelatedRail related={detail.related ?? []} />
        </div>
      </div>
    </div>
  );
}
