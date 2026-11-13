import Link from "next/link";
import type { ClaimDetail } from "@/lib/types";
import type { DataSource } from "@/lib/data";
import { ALL_FEATURES_ON, type Features } from "@/lib/features";
import { ClaimView } from "@/components/ClaimView";
import { DecompositionCompass } from "./DecompositionCompass";
import { MapCard } from "./MapCard";
import { DependentsRail } from "./DependentsRail";
import { RelatedRail } from "./RelatedRail";
import { QuestionView, QuestionRail } from "@/components/question/QuestionView";
import { RequestsRail } from "@/components/request/Requests";
import { WaitingMessagesRail } from "./WaitingMessages";
import type { PublishedPageSummary, PublishedPageView } from "@/lib/published";
import { ClaimTabs, publishedDetail } from "./PublishedPage";
import { detailAt, detailWithoutJudgment, type InsideNode } from "@/lib/inside-node";
import { AskToShow, SeveralInForce, VersionNote, VersionTabs, VersionsInFull } from "./InsideVersions";
import styles from "./margins.module.css";

// The claim page in its full three-column form (issue #42): the decomposition
// compass in the left margin, the dependents in the right, and ClaimView's
// reading column in the centre. On narrow screens the rails fold inline above
// and below the reading column. Assessment history lives at the bottom of the
// reading column (#196), not in a rail.
//
// `features` says which optional parts this deployment has on. The claim's
// own data already arrives without what is off (lib/data.ts, loadClaim); the
// reading column takes the list for the links that lead to a feature's pages.
export function ClaimMargins({
  detail, source, features = ALL_FEATURES_ON, publishedPages = [], published = null, inside = null,
}: {
  /**
   * Only inside a private deployment that holds material at more than one
   * label: the assessments of this node the reader may read, the pages of it
   * shown to a label they read, and which the page is open on
   * (lib/inside-node.ts). Null on the public graph, where nothing below that
   * names it runs.
   */
  inside?: InsideNode | null;
  detail: ClaimDetail;
  source: DataSource;
  features?: Features;
  /** Pages other graphs publish of this node, and the one the second tab shows (docs/published-pages.md). */
  publishedPages?: PublishedPageSummary[];
  published?: PublishedPageView | null;
}) {
  // The second tab is the same reading column fed the published page. The
  // rails are about the public node's own structure, so they stay with the
  // first tab.
  if (inside?.open.kind === "shown") {
    const view = inside.open.view;
    return (
      <div className={styles.bleed}>
        <div className={styles.grid}>
          <div className={styles.leftRail} />
          <div className={styles.center}>
            <VersionTabs claimId={detail.claim.id} inside={inside} />
            <ClaimView detail={publishedDetail(detail, view)} features={features} published={view} />
          </div>
          <div className={styles.rightRail} />
        </div>
      </div>
    );
  }
  // The assessment the page is open on, where the node carries one at more
  // than one label: the ordinary page, reading that assessment.
  const open = inside?.open;
  const shownDetail =
    open?.kind === "version" ? detailAt(detail, open.version) : open?.kind === "several" ? detailWithoutJudgment(detail) : detail;
  const above = inside && (
    <>
      <VersionTabs claimId={detail.claim.id} inside={inside} />
      {open?.kind === "version" && <VersionNote claimId={detail.claim.id} detail={detail} inside={inside} version={open.version} />}
      {open?.kind === "version" && inside.mayAsk && <AskToShow claimId={detail.claim.id} version={open.version} />}
    </>
  );
  if (published) {
    return (
      <div className={styles.bleed}>
        <div className={styles.grid}>
          <div className={styles.leftRail} />
          <div className={styles.center}>
            <ClaimTabs claimId={detail.claim.id} published={publishedPages} current={published.published_page_id} />
            <ClaimView detail={publishedDetail(detail, published)} features={features} published={published} />
          </div>
          <div className={styles.rightRail} />
        </div>
      </div>
    );
  }
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
          <ClaimTabs claimId={detail.claim.id} published={publishedPages} current={null} />
          {above}
          {isQuestion ? (
            <>
              {/* A question's page reads its answer from the question's own
                  fields, so each assessment the reader may read is set out in
                  full above it. */}
              {inside && open && open.kind !== "none" && inside.versions.length > 1 && (
                <VersionsInFull
                  claimId={detail.claim.id}
                  detail={detail}
                  versions={open.kind === "version" ? [open.version] : open.kind === "several" ? open.versions : []}
                />
              )}
              <QuestionView detail={detail} fixture={source === "fixture"} />
            </>
          ) : (
            <ClaimView
              detail={shownDetail}
              fixture={source === "fixture"}
              features={features}
              publishedPages={publishedPages}
              judgedAbove={open?.kind === "several"}
              versionsAbove={
                open?.kind === "several" ? <SeveralInForce claimId={detail.claim.id} detail={detail} versions={open.versions} /> : undefined
              }
            />
          )}
        </div>

        {/* RIGHT — what depends on this claim */}
        <div className={styles.rightRail}>
          <WaitingMessagesRail messages={detail.waiting_messages ?? []} />
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
