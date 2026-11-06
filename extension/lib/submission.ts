import type { Submission } from "./types";

/**
 * A proposal's progress, worded the same in the popup and on the page. A
 * proposal stays worth asking after until it is declined, or accepted with
 * its claim assessed: an accepted claim's first assessment is still to come,
 * and the reader proposed it to see that.
 */

export function submissionSettled(sub: Submission): boolean {
  if (sub.review_status === "rejected") return true;
  return (
    sub.review_status === "accepted" && !!sub.claim && sub.claim.status !== "unassessed"
  );
}

export function submissionLabel(sub: Submission): string {
  switch (sub.review_status) {
    case "accepted":
      if (!sub.claim) return "Accepted · being added to the graph";
      return sub.claim.status === "unassessed"
        ? "Accepted · in the graph, awaiting its first assessment"
        : `Accepted · in the graph: ${sub.claim.status}`;
    case "rejected":
      return "Declined by review · the charge was refunded";
    case "escalated":
    case "human_review":
      return "Proposed · under further review";
    default:
      return "Proposed · pending review";
  }
}
