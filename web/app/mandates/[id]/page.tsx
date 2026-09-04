import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "../../../auth";
import {
  accountApiConfigured,
  fetchMandateView,
  type MandateDetailView,
  type MandatePipelineRow,
  type MandatePrizesView,
} from "../../../lib/account-api";
import type { AttemptSummary } from "../../../lib/types";
import { formatOwls } from "../../../lib/format";
import { ATTEMPT_VARIANT_LABEL, BOUNTY_STATUS_LABEL, attemptOutcomeLabel } from "../../../lib/prizes";
import { OwlMark } from "../../../components/OwlMark";
import { MandateRecord } from "../../../components/MandateRecord";
import { AllocationSection } from "./AllocationView";
import { ContributeBox } from "./ContributeBox";
import { MandateChat } from "./MandateChat";

export const metadata: Metadata = { title: "Mandate · Minerval" };
export const dynamic = "force-dynamic";

function owls(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function dateish(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "·";
}

const ACTION_LABEL: Record<string, string> = {
  assess: "assess",
  reassess: "reassess",
  deepen: "deepen",
  ingest: "ingest",
};

const STATE_LABEL: Record<string, string> = {
  done: "done",
  current: "in progress",
  queued: "planned",
};

// The importance histogram as inline CSS bars: four buckets, peripheral to
// central. Small enough to read at a glance, honest enough to dig into.
function Histogram({ buckets }: { buckets: number[] }) {
  const max = Math.max(1, ...buckets);
  const labels = ["0–.25", ".25–.5", ".5–.75", ".75–1"];
  return (
    <span
      className="pipeline-hist"
      title={buckets
        .map((n, i) => `importance ${labels[i]}: ${n} claim${n === 1 ? "" : "s"}`)
        .join(", ")}
    >
      {buckets.map((n, i) => (
        <span
          key={i}
          className="pipeline-hist-bar"
          style={{ height: `${4 + Math.round((n / max) * 14)}px` }}
          data-empty={n === 0 ? "" : undefined}
        />
      ))}
    </span>
  );
}

function PipelineSection({ pipeline }: { pipeline: MandatePipelineRow[] }) {
  return (
    <section>
      <h2>Ingestion pipeline</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem", maxWidth: "44rem" }}>
        The sources this mandate has brought into the graph, and what became
        of their claims: how many were linked or minted, how many have
        assessments, and how their importance runs (the bars span peripheral
        to central).
      </p>
      <table className="account-table pipeline-table">
        <thead>
          <tr>
            <th>source</th>
            <th>ingested</th>
            <th>status</th>
            <th>claims</th>
            <th>assessed</th>
            <th>importance</th>
            <th>avg</th>
            <th>contested</th>
          </tr>
        </thead>
        <tbody>
          {pipeline.map((s) => (
            <tr key={s.source_id}>
              <td className="pipeline-source">
                <a href={s.url} rel="noreferrer">
                  {s.title ?? s.url}
                </a>
              </td>
              <td>{dateish(s.ingested_at)}</td>
              <td>{s.extraction_status?.replace(/_/g, " ") ?? "·"}</td>
              <td>{s.claims_linked}</td>
              <td>{s.claims_assessed}</td>
              <td>
                <Histogram buckets={s.importance_histogram} />
              </td>
              <td>{s.avg_importance ?? "·"}</td>
              <td>{s.contested_claims > 0 ? s.contested_claims : "·"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

// The prizes section (docs/mathematics.md §8.1, §8.3): the mandate's prize
// numbers (a bounty is owls held against this mandate's own escrow from the
// day it opens until it resolves, and the payout consumes the hold), the
// house solver's attempts, and the claims with a bounty. Every amount is in
// owls; the sentence under the heading says where the money comes from.
function PrizesSection({
  prizes, attempts,
}: {
  prizes: MandatePrizesView;
  attempts: AttemptSummary[];
}) {
  const sorted = [...attempts].sort((a, b) =>
    (b.finished_at ?? b.started_at).localeCompare(a.finished_at ?? a.started_at),
  );
  return (
    <section>
      <h2>Prizes</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem", maxWidth: "44rem" }}>
        A prize is owls held against this mandate&rsquo;s own escrow from the
        day it opens until it resolves, in the same committed money as its
        attempts and formalizations; the payout consumes the hold. Prizes
        reward proofs and disproofs of formal statements the steward has
        published, and they buy no influence over any assessment.
      </p>
      <div className="alloc-tiles">
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">escrow</span>
          <span className="alloc-tile-big">{formatOwls(prizes.escrow_micro_usd)}</span>
          <span className="alloc-tile-sub">the mandate&rsquo;s budget, every prize&rsquo;s only source</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">held</span>
          <span className="alloc-tile-big">{formatOwls(prizes.held_micro_usd)}</span>
          <span className="alloc-tile-sub">in open prizes</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">paid</span>
          <span className="alloc-tile-big">{formatOwls(prizes.paid_micro_usd)}</span>
          <span className="alloc-tile-sub">in prizes, gross of withholding</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">review reserve</span>
          <span className="alloc-tile-big">{formatOwls(prizes.review_reserve_micro_usd)}</span>
          <span className="alloc-tile-sub">set aside for the review of submissions</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">headroom</span>
          <span className="alloc-tile-big">{formatOwls(prizes.headroom_micro_usd)}</span>
          <span className="alloc-tile-sub">what remains after every hold</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">prizes posted</span>
          <span className="alloc-tile-big">{prizes.bounties_posted.toLocaleString("en-US")}</span>
          <span className="alloc-tile-sub">{formatOwls(prizes.bounties_total_micro_usd)} in all</span>
        </div>
        <div className="alloc-tile">
          <span className="alloc-tile-kind sc">prizes paid</span>
          <span className="alloc-tile-big">{prizes.prizes_paid.toLocaleString("en-US")}</span>
          <span className="alloc-tile-sub">
            <OwlMark size={12} className="owl-mark" />
            {owls(prizes.owls_paid)} owls granted, net of withholding
          </span>
        </div>
      </div>

      {sorted.length > 0 && (
        <>
          <h3>Attempts</h3>
          <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.2rem", maxWidth: "44rem" }}>
            The house solver&rsquo;s runs against published statements, each
            public with its cost and its report.
          </p>
          <table className="account-table">
            <thead>
              <tr>
                <th>claim</th>
                <th>finished</th>
                <th>variant</th>
                <th>cost</th>
                <th>outcome</th>
                <th aria-label="report" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link href={`/claims/${a.claim_id}`}>view claim</Link>
                    {a.is_calibration && <> <span className="tag">calibration</span></>}
                  </td>
                  <td>{dateish(a.finished_at ?? a.started_at)}</td>
                  <td>{ATTEMPT_VARIANT_LABEL[a.variant] ?? a.variant}</td>
                  <td>{formatOwls(a.spent_micro_usd)}</td>
                  <td>{attemptOutcomeLabel(a)}</td>
                  <td>
                    {a.published_at ? (
                      <Link href={`/claims/${a.claim_id}/attempts/${a.id}`}>report</Link>
                    ) : (
                      <span style={{ color: "var(--faint)" }}>not yet published</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {prizes.bounties.length > 0 && (
        <>
          <h3>Claims with a prize</h3>
          <table className="account-table">
            <thead>
              <tr>
                <th>claim</th>
                <th>amount</th>
                <th>status</th>
                <th>open since</th>
                <th>submissions</th>
                <th>outcome</th>
              </tr>
            </thead>
            <tbody>
              {prizes.bounties.map((b) => (
                <tr key={`${b.claim_id}-${b.opened_at ?? ""}`}>
                  <td className="alloc-label">
                    <Link href={`/claims/${b.claim_id}`}>{b.text}</Link>
                  </td>
                  <td>{formatOwls(b.amount_micro_usd)}</td>
                  <td>{BOUNTY_STATUS_LABEL[b.status] ?? String(b.status).replace(/_/g, " ")}</td>
                  <td>{dateish(b.opened_at)}</td>
                  <td>{b.submissions}</td>
                  <td>{b.outcome ? b.outcome.replace(/_/g, " ") : "·"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

export default async function MandatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!accountApiConfigured()) {
    return (
      <div className="col">
        <h1>Mandate</h1>
        <p>The frontend is not connected to a Minerval API.</p>
      </div>
    );
  }
  const session = await auth();
  let mandate: MandateDetailView;
  try {
    mandate = await fetchMandateView(id, session?.externalId ?? null);
  } catch {
    notFound();
  }

  const pct =
    mandate.budget_owls > 0
      ? Math.min(
          100,
          Math.round((mandate.spent_owls / mandate.budget_owls) * 100)
        )
      : 0;
  const hasPlan = mandate.plan_items.length > 0;
  const hasPipeline = mandate.pipeline.length > 0;
  const open = mandate.status === "active";
  const prizes = mandate.prizes ?? null;

  return (
    <div className="col-wide account">
      <p className="claim-eyebrow">
        <Link href="/mandates">← mandates</Link>
      </p>
      <p className="sc mandate-tile-manager">
        {mandate.is_platform
          ? "run by Minerval"
          : `managed by ${mandate.manager}`}
        {mandate.status !== "active" && ` · ${mandate.status}`}
      </p>
      <h1>{mandate.title}</h1>
      {mandate.objective && (
        <p style={{ maxWidth: "44rem" }}>{mandate.objective}</p>
      )}
      {mandate.strategy && (
        <p style={{ maxWidth: "44rem", color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".84rem" }}>
          {mandate.strategy}
        </p>
      )}

      <div className="usage-chips">
        <span className="summary-chip">
          <OwlMark size={14} className="owl-mark" />
          {owls(mandate.spent_owls)} of {owls(mandate.budget_owls)} owls spent
        </span>
        <span className="summary-chip">
          {mandate.contributor_count} contributor
          {mandate.contributor_count === 1 ? "" : "s"}
        </span>
        {mandate.budget_status === "paused_budget" && (
          <span className="summary-chip">paused: budget spent</span>
        )}
        {mandate.funded_assessments.length > 0 && (
          <span className="summary-chip">
            {mandate.funded_assessments.length} assessments funded
          </span>
        )}
        {hasPipeline && (
          <span className="summary-chip">
            {mandate.pipeline.length} source
            {mandate.pipeline.length === 1 ? "" : "s"} ingested
          </span>
        )}
        {prizes && prizes.bounties_posted > 0 && (
          <span className="summary-chip">
            {prizes.bounties_posted} prize{prizes.bounties_posted === 1 ? "" : "s"} posted
          </span>
        )}
      </div>
      <div className="mandate-meter mandate-meter-page" aria-hidden>
        <div className="mandate-meter-fill" style={{ width: `${pct}%` }} />
      </div>

      {open && (
        <ContributeBox
          mandateId={mandate.id}
          signedIn={!!session?.externalId}
        />
      )}

      {(mandate.contributors.length > 0 ||
        mandate.funded_by_mandates.length > 0) && (
        <p className="order-line">
          Backed by{" "}
          {[
            ...mandate.contributors.map(
              (c) => `${c.name} (${owls(c.owls)} owls)`
            ),
            ...mandate.funded_by_mandates.map(
              (m) => `the ${m.title} mandate (${owls(m.owls)} owls)`
            ),
          ].join(", ")}
          .
        </p>
      )}

      {mandate.regrants_out.length > 0 && (
        <p className="order-line">
          This mandate funds{" "}
          {mandate.regrants_out.map((m, i) => (
            <span key={m.grant_id}>
              {i > 0 && ", "}
              <Link href={`/mandates/${m.grant_id}`}>{m.title}</Link> (
              {owls(m.owls)} owls)
            </span>
          ))}
          {" — "}mandates are peers: money moves between them, judgment
          never does.
        </p>
      )}

      {mandate.last_review && (
        <section>
          <h2>The Grantmaker&rsquo;s latest review</h2>
          <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem", maxWidth: "44rem" }}>
            This mandate stewards itself: its Grantmaker takes autonomous
            review passes — surveying its territory, revising its
            valuations, growing its plan — and leaves a note each time.
            Last pass: {dateish(mandate.last_review.at)}.
          </p>
          <blockquote className="mandate-review-note">
            {mandate.last_review.note}
          </blockquote>
        </section>
      )}

      {open && <AllocationSection mandateId={mandate.id} />}

      {hasPipeline && <PipelineSection pipeline={mandate.pipeline} />}

      {hasPlan && (
        <section>
          <h2>The plan</h2>
          <ul className="mandate-items">
            {mandate.plan_items.map((item, i) => (
              <li key={i} data-state={item.state}>
                <span className="tag">{ACTION_LABEL[item.action] ?? item.action}</span>{" "}
                {item.action === "ingest" ? (
                  <span className="mandate-target">{item.url}</span>
                ) : (
                  <Link className="mandate-target" href={`/claims/${item.claim_id}`}>
                    view claim
                  </Link>
                )}
                <span className="mandate-rationale"> {item.rationale}</span>
                <span className="mandate-state sc"> {STATE_LABEL[item.state]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {mandate.funded_assessments.length > 0 && (
        <section>
          <h2>Assessments this mandate funded</h2>
          <table className="account-table">
            <thead>
              <tr>
                <th>claim</th>
                <th>verdict</th>
                <th>assessed</th>
              </tr>
            </thead>
            <tbody>
              {mandate.funded_assessments.map((f) => (
                <tr key={`${f.claim_id}-${f.assessed_at}`}>
                  <td>
                    <Link href={`/claims/${f.claim_id}`}>{f.text}</Link>
                  </td>
                  <td>{f.status.replace(/_/g, " ")}</td>
                  <td>{dateish(f.assessed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {prizes && <PrizesSection prizes={prizes} attempts={mandate.attempts ?? []} />}
      {mandate.skills?.includes("mathematics") && <MandateRecord grantId={mandate.id} />}

      {mandate.is_manager && mandate.conversation_id && (
        <section>
          <h2>Talk to the Grantmaker</h2>
          <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".8rem", marginTop: "-.3rem", maxWidth: "44rem" }}>
            Your mandate, your Grantmaker: ask how the work is going, dig
            into the numbers, or redirect what remains of the budget. It can
            see everything on this page and more, and it can amend the
            unexecuted part of the plan.
          </p>
          <MandateChat conversationId={mandate.conversation_id} />
        </section>
      )}
    </div>
  );
}
