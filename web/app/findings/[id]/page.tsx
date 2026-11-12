import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  apiConfigured,
  fetchArgumentPage,
  fetchClaimCards,
  fetchFinding,
  fetchSourceFacts,
} from "../../../lib/api";
import { FindingRefs, FindingSightings, fmtDate } from "../../../components/Findings";
import { FindingAccount, type LinkedRecords } from "../../../components/findings/FindingAccount";
import { Standing } from "../../../components/findings/FindingParts";
import { StatusBadge } from "../../../components/Assessment";
import { PageHead } from "@/components/PageHead";
import { agentLabel, firstParagraph, numberAccount } from "@/lib/findings";
import type { ArgumentPage, SourceFacts } from "@/lib/types";

export const revalidate = 60;

// How many linked sources and arguments the margin reads, each a request of
// its own. An account is a few paragraphs, so this is far above what one
// links; past it a link still works and its card says only what kind it is.
const MARGIN_READS = 16;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const result = apiConfigured() ? await fetchFinding(id) : null;
  return {
    title: result ? `${result.finding.headline} · Minerval` : "Finding · Minerval",
    description: result ? firstParagraph(result.finding.account) : undefined,
  };
}

export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!apiConfigured()) {
    return (
      <div className="col">
        <PageHead back={{ href: "/findings", label: "findings" }} title="Finding" />
        <p>The frontend is not connected to a Minerval API, so this finding is unavailable.</p>
      </div>
    );
  }
  const result = await fetchFinding(id);
  if (!result) notFound();
  const { finding: f, sightings, cited_assessments: assessments } = result;

  const { paragraphs, targets } = numberAccount(f.account);
  const citedClaims = f.refs.filter((r) => r.kind === "claim" && r.id !== f.claim_id);
  const sourceIds = targets.filter((t) => t.kind === "source").map((t) => t.id).slice(0, MARGIN_READS);
  const argumentIds = targets.filter((t) => t.kind === "argument").map((t) => t.id).slice(0, MARGIN_READS);
  const [claims, sources, argumentPages] = await Promise.all([
    fetchClaimCards([
      f.claim_id,
      ...citedClaims.map((r) => r.id),
      ...targets.filter((t) => t.kind === "claim").map((t) => t.id),
    ]),
    Promise.all(sourceIds.map((sid) => fetchSourceFacts(sid))),
    Promise.all(argumentIds.map((aid) => fetchArgumentPage(aid).catch(() => null))),
  ]);
  const records: LinkedRecords = {
    claims,
    sources: new Map(
      sources.flatMap((s, i): Array<[string, SourceFacts]> => (s ? [[sourceIds[i]!, s]] : []))
    ),
    arguments: new Map(
      argumentPages.flatMap((a, i): Array<[string, ArgumentPage]> => (a ? [[argumentIds[i]!, a]] : []))
    ),
  };

  // What the account links to is already named in its margin; "Rests on"
  // lists the records cited, and names the ones the margin has not.
  const linkedClaims = new Set(targets.filter((t) => t.kind === "claim").map((t) => t.id));
  const unlinkedClaims = citedClaims.filter((r) => !linkedClaims.has(r.id));
  const describedIds = new Set(assessments.map((a) => a.id));
  const otherRefs = f.refs.filter(
    (r) => r.kind !== "claim" && !(r.kind === "assessment" && describedIds.has(r.id))
  );
  const linkedCited = citedClaims.length - unlinkedClaims.length;

  return (
    <div className="fnd fnd-one">
      <PageHead
        back={{ href: "/findings", label: "findings" }}
        kicker="Finding"
        title={f.headline}
        variant="statement"
        meta={
          <>
            noted by the {agentLabel(f.agent)} · {fmtDate(f.first_noted_at)} ·{" "}
            <span title="The importance of the finding, not of the claim.">
              importance {f.importance} of 10
            </span>
            {f.sighting_count > 1 && ` · met ${f.sighting_count} times`}
          </>
        }
      />

      {f.status === "withdrawn" && (
        <p className="finding-notice">
          <span className="sc">Withdrawn</span>
          {f.withdrawn_note ? ` · ${f.withdrawn_note}` : ""}
        </p>
      )}
      {f.stale && (
        <p className="finding-notice">
          <span className="sc">The graph has moved</span> · this note cites an assessment that is
          no longer the node&apos;s current one; read the node for the present verdict.
        </p>
      )}

      {f.claim_text && (
        <div className="fnd-claim">
          <div className="sc">On the claim</div>
          <p>
            <Link href={`/claims/${f.claim_id}`}>{f.claim_text}</Link>
            <Standing card={claims.get(f.claim_id)} />
          </p>
        </div>
      )}

      <FindingAccount paragraphs={paragraphs} targets={targets} records={records} />

      <div className="fnd-under">
        {f.refs.length > 0 && (
          <section>
            <div className="acct-head">
              <h2>Rests on</h2>
              <span className="acct-note">the records it cites, as they stand now</span>
            </div>
            {assessments.map((a) => (
              <div className="acct-line" key={a.id}>
                <div>
                  {a.claim_id === f.claim_id ? (
                    <Link href={`/claims/${a.claim_id}`}>The assessment of this claim</Link>
                  ) : (
                    <>
                      The assessment of <Link href={`/claims/${a.claim_id}`}>{a.claim_text}</Link>
                    </>
                  )}
                  <span className="acct-detail">
                    {a.current
                      ? "still the claim’s current one"
                      : "since superseded; the claim has been assessed again"}
                  </span>
                </div>
                <div className="fnd-standing">
                  <StatusBadge status={a.status} />
                  {typeof a.confidence === "number" && (
                    <span className="fnd-credence">{a.confidence.toFixed(2)}</span>
                  )}
                </div>
              </div>
            ))}
            {unlinkedClaims.map((r) => {
              const card = claims.get(r.id);
              return (
                <div className="acct-line" key={r.id}>
                  <div>
                    <Link href={`/claims/${r.id}`}>{card?.text ?? `claim ${r.id.slice(0, 8)}`}</Link>
                  </div>
                  <div>
                    <Standing card={card} />
                  </div>
                </div>
              );
            })}
            {linkedCited > 0 && (
              <div className="acct-line">
                <div>
                  {linkedCited === 1 ? "One claim" : `${linkedCited} claims`} linked in the account
                  above
                </div>
              </div>
            )}
            {otherRefs.length > 0 && (
              <p className="finding-footing">
                <span className="sc">Also cites</span>{" "}
                <FindingRefs refs={otherRefs} claimId={f.claim_id} />
              </p>
            )}
          </section>
        )}
        <FindingSightings sightings={sightings} />
      </div>
    </div>
  );
}
