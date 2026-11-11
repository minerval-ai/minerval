import Link from "next/link";
import type { Metadata } from "next";
import { loadClaim, loadClaimEvents } from "@/lib/data";
import { buildClaimTextMap } from "@/lib/claim-links";
import { ClaimTimeline, summarizeEvents } from "@/components/claim/ClaimTimeline";
import styles from "@/components/claim/timeline.module.css";
import { PageHead } from "@/components/PageHead";

// The claim history (issue #175): /claims/:id/history is a sibling VIEW of
// /claims/:id, like /map — the same address seen as a record of how the
// current assessment came to be. The claim page stays about the assessment
// itself; contested processes (challenges, reviews, appeals, arbitration) are
// legible here without crowding the reading column.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { detail } = await loadClaim(id);
  if (!detail) return { title: "Claim history · Minerval" };
  const text = detail.claim.text;
  return {
    title: `${text.length > 80 ? `${text.slice(0, 77)}…` : text} · history · Minerval`,
    description: `How this claim's assessment came to be: ${text}`,
  };
}

export default async function ClaimHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [{ detail, source }, { events }] = await Promise.all([
    loadClaim(id),
    loadClaimEvents(id),
  ]);

  if (!detail) {
    return (
      <div className="col">
        <PageHead back={{ href: "/claims", label: "claims" }} title="Claim not in the local fixture set." />
        <p style={{ color: "var(--muted)" }}>
          The history opens on any claim once the API is connected.
        </p>
        <p><Link href="/claims/inflation-2022/history">→ open the worked example&apos;s history</Link></p>
      </div>
    );
  }

  return (
    <div className="col">
      <PageHead
        back={{ href: `/claims/${detail.claim.id}`, label: "claim page" }}
        kicker="History"
        tags={
          source === "fixture" && (
            <span className="tag" title="The API is not connected; showing a design fixture.">
              fixture data
            </span>
          )
        }
        variant="statement"
        title={<Link href={`/claims/${detail.claim.id}`}>{detail.claim.text}</Link>}
        meta={events && events.events.length > 0 && summarizeEvents(events)}
      />

      {events === null ? (
        <p style={{ color: "var(--muted)" }}>
          The history record for this claim could not be loaded.
        </p>
      ) : events.events.length <= 1 ? (
        <>
          <ClaimTimeline page={events} texts={buildClaimTextMap(detail.tree)} />
          <p style={{ color: "var(--muted)" }}>
            Nothing has happened to this claim yet beyond its creation: no
            assessments, contributions, or decisions are on record.
          </p>
        </>
      ) : (
        <ClaimTimeline page={events} texts={buildClaimTextMap(detail.tree)} />
      )}
    </div>
  );
}
