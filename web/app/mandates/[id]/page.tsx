import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "../../../auth";
import {
  accountApiConfigured,
  fetchMandateView,
  type MandateDetailView,
  type MandatePipelineRow,
} from "../../../lib/account-api";
import { OwlMark } from "../../../components/OwlMark";
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
  queued: "queued",
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

      {mandate.contributors.length > 0 && (
        <p className="order-line">
          Backed by{" "}
          {mandate.contributors
            .map((c) => `${c.name} (${owls(c.owls)} owls)`)
            .join(", ")}
          .
        </p>
      )}

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
