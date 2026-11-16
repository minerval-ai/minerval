import Link from "next/link";
import { apiConfigured, fetchClaimCard } from "@/lib/api";
import { disputeMeta } from "@/lib/ontology";
import type { ClaimCard } from "@/lib/types";
import { Code } from "./Code";

// The overview's example: one real card, as GET /claims/:id/card and
// get_claim_card return it, drawn the way the embed draws it. It is fetched
// when the page renders, so the JSON beside it is never out of date. Without
// an API (a local build with no backend) it shows a sample and says so.

// The claim the home page's map opens on (app/page.tsx).
const CLAIM_ID = process.env.FLAGSHIP_CLAIM_ID ?? "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071";

const SAMPLE: ClaimCard = {
  id: CLAIM_ID,
  kind: "claim",
  text: "Scalable oversight can reliably control superintelligent AI systems.",
  state: "active",
  assessment_status: "doubtful",
  assessment_confidence: 0.77,
  assessment_alternative_status: null,
  standing: null,
  estimate: null,
  unit: null,
  contestation: 0.7,
  assessed_at: "2026-11-12T00:21:16.842Z",
  updated_at: "2026-11-13T00:12:26.240Z",
  page_url: `https://minerval.ai/claims/${CLAIM_ID}`,
  resolved_from: null,
};

async function load(): Promise<{ card: ClaimCard; live: boolean }> {
  if (!apiConfigured()) return { card: SAMPLE, live: false };
  try {
    const card = await fetchClaimCard(CLAIM_ID);
    return card ? { card, live: true } : { card: SAMPLE, live: false };
  } catch {
    return { card: SAMPLE, live: false };
  }
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export async function LiveCard() {
  const { card, live } = await load();
  const dispute = disputeMeta(card.contestation);
  const kind = card.kind.charAt(0).toUpperCase() + card.kind.slice(1);
  const judgment = card.assessment_status ?? card.standing;
  return (
    <>
      <div className="dc-claimcard">
        <span className="sc">{live ? kind : `${kind} · sample`}</span>
        <div className="dc-card-text">{card.text}</div>
        <div className="dc-card-row">
          {judgment ? (
            <span className={`dc-status dc-v-${card.assessment_status ?? "unknown"}`}>{judgment}</span>
          ) : (
            <span className="dc-status dc-v-unassessed">unassessed</span>
          )}
          {dispute && <span className="dc-disputed">{dispute.label}</span>}
          {card.assessed_at && <span>assessed {day(card.assessed_at)}</span>}
          <Link href={`/claims/${card.id}`}>Open the claim →</Link>
        </div>
      </div>
      <Code label={`GET https://api.claimgraph.io/claims/${card.id}/card`}>{JSON.stringify(card, null, 2)}</Code>
    </>
  );
}
