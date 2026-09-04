import type { Metadata } from "next";
import Link from "next/link";
import { loadClaim } from "@/lib/data";
import { formatOwls, fmtDateLong } from "@/lib/format";
import { resolutionPhrase } from "@/lib/prizes";
import { PrizeClaimForm } from "@/components/claim/PrizeClaimForm";

// The claim-prize flow (docs/mathematics.md §8.4): the form for one claim's
// open prize, opened on the current published statement. The page refuses
// politely when no prize is open, since the route would refuse anyway; the
// form itself is the component, one for every domain.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { detail } = await loadClaim(id);
  if (!detail) return { title: "Claim a prize · Minerval" };
  const text = detail.claim.text;
  return {
    title: `Claim the prize · ${text.length > 60 ? `${text.slice(0, 57)}…` : text} · Minerval`,
  };
}

export default async function PrizeClaimPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { detail, source } = await loadClaim(id);

  if (!detail) {
    return (
      <div className="col">
        <p className="sc"><Link href="/prizes">← prizes</Link></p>
        <h1 className="claim-hero">Claim not found.</h1>
        <p style={{ color: "var(--muted)" }}>
          There is no claim at this address. The link may be mistyped or out of date.
        </p>
      </div>
    );
  }

  const bounty = detail.bounty ?? null;
  const formalization = detail.formalization ?? null;
  const open = !!bounty && bounty.status === "open" && !!formalization
    && formalization.status === "published";

  return (
    <div className="col">
      <p className="sc" style={{ marginBottom: "1.2rem", display: "flex", gap: ".7rem", alignItems: "center" }}>
        <Link href={`/claims/${detail.claim.id}#prize`}>← claim page</Link>
        {source === "fixture" && (
          <span className="tag" title="The API is not connected; showing a design fixture.">
            fixture data
          </span>
        )}
      </p>
      <div className="claim-eyebrow">
        <span className="sc">Prize claim</span>
        {bounty && <span className="tag prize">{formatOwls(bounty.amount_micro_usd)}</span>}
      </div>
      <h1 className="claim-hero" style={{ fontSize: "1.5rem" }}>
        <Link href={`/claims/${detail.claim.id}`} className="plain">{detail.claim.text}</Link>
      </h1>

      {!open ? (
        <>
          <p style={{ color: "var(--muted)" }}>
            {!bounty
              ? "No prize is offered on this claim."
              : bounty.status === "claim_pending"
                ? "A submission on this statement has passed the checker and is under review; no further submissions are accepted unless it is rejected."
                : bounty.status === "house_result_pending"
                  ? "Minerval's own solver produced a checked result on this statement, and the steward's decision is pending; no submissions are accepted meanwhile."
                  : bounty.status === "rebinding"
                    ? "The formal statement was revised after this prize was posted, and the prize is held until the revised statement is confirmed."
                    : "This prize is not open."}
          </p>
          <p><Link href={`/claims/${detail.claim.id}#prize`}>→ the prize section on the claim page</Link></p>
        </>
      ) : (
        <>
          <p style={{ fontFamily: "var(--sans)", fontSize: ".86rem", color: "var(--ink-soft)", maxWidth: "36rem" }}>
            {formatOwls(bounty!.amount_micro_usd)} is offered for a Lean 4{" "}
            {resolutionPhrase(bounty!.resolution)} of statement {formalization!.version},
            published {fmtDateLong(formalization!.published_at)} and pinned to{" "}
            <span className="mono">{formalization!.pin_id}</span>. Entry is free. The
            checker runs first, in order of receipt; the Contribution Reviewer
            then judges form and good faith, never the proof; and the
            claim&rsquo;s steward judges only whether the statement proved is the
            statement posted. Every outcome is on the public record.
          </p>
          <details className="reasoning-detail" style={{ marginTop: 0 }}>
            <summary>The formal statement, verbatim</summary>
            <pre className="formal-src" style={{ marginTop: ".6rem" }}><code>{formalization!.statement_source}</code></pre>
          </details>
          <PrizeClaimForm claimId={detail.claim.id} bounty={bounty!} formalization={formalization!} />
        </>
      )}
    </div>
  );
}
