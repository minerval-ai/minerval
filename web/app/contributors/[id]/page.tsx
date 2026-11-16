import type { Metadata } from "next";
import Link from "next/link";
import { fetchPublisher } from "@/lib/api";
import { PublisherRecordSection } from "@/components/claim/PublisherRecord";
import { notFound } from "next/navigation";
import { apiConfigured, fetchContributorProfile } from "../../../lib/api";
import { loadFeatures } from "../../../lib/data";
import { featureOn } from "../../../lib/features";
import { OwlMark } from "../../../components/OwlMark";
import { PageHead } from "@/components/PageHead";

export const revalidate = 60;

const TYPE_LABELS: Record<string, string> = {
  challenge: "challenge",
  support: "supporting evidence",
  propose_merge: "merge proposal",
  propose_split: "split proposal",
  propose_edit: "edit proposal",
  add_instance: "source instance",
  propose_argument: "argument",
  propose_claim: "proposed claim",
  propose_source: "proposed source",
  state_view: "stated view",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const profile = apiConfigured() ? await fetchContributorProfile(id) : null;
  return {
    title: profile
      ? `${profile.contributor.display_name} · Minerval`
      : "Contributor · Minerval",
  };
}

export default async function ContributorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!apiConfigured()) {
    return (
      <div className="col">
        <PageHead title="Contributor" />
        <p>
          The frontend is not connected to a Minerval API (set{" "}
          <code>MINERVAL_API_URL</code>), so contributor data is unavailable.
        </p>
      </div>
    );
  }

  const profile = await fetchContributorProfile(id);
  if (!profile) notFound();
  // An account that publishes pages from a deployment of its own
  // (docs/published-pages.md): its registration is a public record.
  const publisher = await fetchPublisher(id);

  const c = profile.contributor;
  // The prize owls figure is shown only where this deployment has prizes.
  const prizesOn = featureOn(await loadFeatures(), "prizes");

  return (
    <div className="col">
      <PageHead
        back={{ href: "/contributors", label: "contributors" }}
        kicker="Contributor"
        title={c.display_name}
        meta={
          <>
            member since {c.member_since.slice(0, 10)} · {c.trust_level}
            {c.is_suspended ? " · suspended" : ""}
          </>
        }
      />

      <section>
        <h2>Standing</h2>
        <div className="usage-chips">
          <span className="summary-chip">
            <OwlMark size={14} className="owl-mark" />
            {c.owls_earned} owls earned
          </span>
          {prizesOn && typeof c.owls_prized === "number" && c.owls_prized > 0 && (
            <span className="summary-chip">
              {c.owls_prized} owls in prizes
            </span>
          )}
          <span className="summary-chip">
            reputation {c.reputation_score.toFixed(0)}
          </span>
          <span className="summary-chip">
            {c.contributions_accepted} accepted
          </span>
          <span className="summary-chip">
            {c.contributions_rejected} rejected
          </span>
          {c.acceptance_rate !== null && (
            <span className="summary-chip">
              {c.acceptance_rate}% acceptance
            </span>
          )}
        </div>
      </section>

      {/* Views this account has stated to the graph directly (§4), each
          beside the assessment of what it was stated on. */}
      <section>
        <h2>Stated views</h2>
        <p style={{ fontFamily: "var(--sans)", fontSize: ".86rem" }}>
          <Link href={`/stated-views?speaker=${encodeURIComponent(id)}`}>
            Where this account&rsquo;s stated views and the graph&rsquo;s assessments differ →
          </Link>
        </p>
      </section>

      {profile.recent_contributions.length > 0 && (
        <section>
          <h2>Recent contributions</h2>
          <table className="account-table">
            <thead>
              <tr>
                <th>type</th>
                <th>claim</th>
                <th>status</th>
                <th>submitted</th>
              </tr>
            </thead>
            <tbody>
              {profile.recent_contributions.map((r) => (
                <tr key={r.id}>
                  <td>
                    {/* the record page carries the review's reasoning (#174) */}
                    <Link href={`/contributions/${r.id}`}>
                      {TYPE_LABELS[r.contribution_type] ?? r.contribution_type}
                    </Link>
                  </td>
                  <td>
                    {r.claim_id ? (
                      <Link href={`/claims/${r.claim_id}`}>view claim</Link>
                    ) : (
                      <span style={{ color: "var(--faint)" }}>proposed</span>
                    )}
                  </td>
                  <td>{r.review_status.replace(/_/g, " ")}</td>
                  <td>{r.submitted_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {profile.recent_awards.length > 0 && (
        <section>
          <h2>Recent owl awards</h2>
          <table className="account-table">
            <thead>
              <tr>
                <th>owls</th>
                <th>for</th>
                <th>date</th>
              </tr>
            </thead>
            <tbody>
              {profile.recent_awards.map((a) => (
                <tr key={a.id}>
                  <td>
                    <OwlMark size={14} className="owl-mark" />
                    +{a.owls}
                  </td>
                  <td>
                    {a.contribution_id ? (
                      <Link href={`/contributions/${a.contribution_id}`}>
                        accepted contribution
                      </Link>
                    ) : (
                      "accepted contribution"
                    )}
                  </td>
                  <td>{a.created_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {publisher && <PublisherRecordSection record={publisher} />}
    </div>
  );
}
