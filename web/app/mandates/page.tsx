import type { Metadata } from "next";
import Link from "next/link";
import {
  accountApiConfigured,
  listMandates,
  type MandateSummaryView,
} from "../../lib/account-api";
import { OwlMark } from "../../components/OwlMark";

export const metadata: Metadata = {
  title: "Mandates · Minerval",
  description:
    "Standing mandates directing the graph's attention, open for anyone to put owls behind.",
};
export const dynamic = "force-dynamic";

function owls(n: number): string {
  return Number(n.toFixed(2)).toString();
}

const ACTION_LABEL: Record<string, string> = {
  assess: "assessments",
  reassess: "reassessments",
  deepen: "deep dives",
  ingest: "sources ingested",
};

function mixLine(mix: Record<string, number>): string {
  const parts = Object.entries(mix)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${ACTION_LABEL[k] ?? k}`);
  return parts.length > 0 ? parts.join(" · ") : "standing coverage of its scope";
}

function MandateCard({
  m,
  featured,
}: {
  m: MandateSummaryView;
  featured: boolean;
}) {
  const pct =
    m.budget_owls > 0
      ? Math.min(100, Math.round((m.spent_owls / m.budget_owls) * 100))
      : 0;
  return (
    <Link
      href={`/mandates/${m.id}`}
      className={featured ? "mandate-tile mandate-tile-featured" : "mandate-tile"}
    >
      <p className="sc mandate-tile-manager">
        {m.is_platform ? "run by Minerval" : `managed by ${m.manager}`}
      </p>
      <h3>{m.title}</h3>
      {m.objective && <p className="mandate-tile-objective">{m.objective}</p>}
      <p className="mandate-tile-mix">{mixLine(m.action_mix)}</p>
      <div className="mandate-tile-budget">
        <span>
          <OwlMark size={14} className="owl-mark" />
          {owls(m.spent_owls)} of {owls(m.budget_owls)} owls spent
        </span>
        <span className="mandate-tile-contribs">
          {m.contributor_count} contributor{m.contributor_count === 1 ? "" : "s"}
        </span>
      </div>
      <div className="mandate-meter" aria-hidden>
        <div className="mandate-meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </Link>
  );
}

// Mandates are public things: managed by one person, funded by anyone.
// Pride of place goes to the largest mandates, and above all to the ones
// Minerval itself sets up and runs.
export default async function MandatesPage() {
  if (!accountApiConfigured()) {
    return (
      <div className="col">
        <h1>Mandates</h1>
        <p>The frontend is not connected to a Minerval API.</p>
      </div>
    );
  }
  let mandates: MandateSummaryView[] = [];
  try {
    mandates = await listMandates();
  } catch {
    // fall through to the empty state
  }

  const platform = mandates.filter((m) => m.is_platform);
  const community = mandates.filter((m) => !m.is_platform);

  return (
    <div className="col-wide account">
      <p className="claim-eyebrow">directing the graph&rsquo;s attention</p>
      <h1>Mandates</h1>
      <p style={{ maxWidth: "44rem" }}>
        A mandate is a funded program of work on the graph: claims to assess,
        subtrees to deepen, sources to bring in, areas to keep fresh. Each is
        managed by one person in conversation with the Grantmaker, and each
        is public: anyone can put owls behind a mandate they want to see go
        further. Unspent budgets return to their contributors, and funding
        buys scheduling only, never conclusions.
      </p>
      <p className="order-line">
        <Link href="/account/grants/new">start your own mandate →</Link>
      </p>

      {platform.length > 0 && (
        <section>
          <h2>Run by Minerval</h2>
          <div className="mandate-grid mandate-grid-featured">
            {platform.map((m) => (
              <MandateCard key={m.id} m={m} featured />
            ))}
          </div>
        </section>
      )}

      {community.length > 0 && (
        <section>
          <h2>Community mandates</h2>
          <div className="mandate-grid">
            {community.map((m) => (
              <MandateCard key={m.id} m={m} featured={false} />
            ))}
          </div>
        </section>
      )}

      {mandates.length === 0 && (
        <p className="account-empty">
          No mandates are live yet. Yours could be the first.
        </p>
      )}
    </div>
  );
}
