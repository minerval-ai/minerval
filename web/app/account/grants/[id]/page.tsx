import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "../../../../auth";
import {
  accountApiConfigured,
  getGrant,
  type GrantView,
} from "../../../../lib/account-api";
import { approveGrantAction, cancelGrantAction } from "../../actions";
import { TopUpGrant } from "./TopUpGrant";
import { OwlMark } from "../../../../components/OwlMark";

export const metadata: Metadata = { title: "Grant · Minerval" };
export const dynamic = "force-dynamic";

function owls(n: number): string {
  return Number(n.toFixed(3)).toString();
}

const STATUS_LINES: Record<string, string> = {
  planning:
    "The Grantmaker is surveying your scope and drafting an allocation plan. Nothing beyond the planning run is spent until you approve it.",
  pending_approval:
    "The Grantmaker has proposed a plan; review it below. Nothing more is spent until you approve.",
  active:
    "Active. The mandate's work runs through the action ledger, and its " +
    "Grantmaker stewards it with periodic review passes.",
  completed:
    "Completed. The mandate is fulfilled, and any unspent budget has returned to your balance.",
  cancelled: "Cancelled. The unspent budget has returned to your balance.",
};

export default async function GrantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await auth();
  if (!session?.externalId) redirect("/signin");
  if (!accountApiConfigured()) notFound();

  let grant: GrantView;
  try {
    grant = await getGrant(session.externalId, id);
  } catch {
    notFound();
  }

  const spentShare =
    grant.budget_owls > 0
      ? Math.min(1, grant.spent_owls / grant.budget_owls)
      : 1;
  const open =
    grant.status === "planning" ||
    grant.status === "pending_approval" ||
    grant.status === "active";
  const paused = grant.budget_status === "paused_budget";
  const planItems = grant.plan?.items ?? [];

  return (
    <div className="col account">
      <p className="claim-eyebrow">
        <Link href="/account/grants">← grants</Link>
      </p>
      <h1>{grant.name}</h1>
      <p className="order-line">
        <Link href={`/mandates/${grant.id}`}>
          public mandate page: live dashboard, contributors, and your line to
          the Grantmaker →
        </Link>
      </p>
      <p className="account-meta">
        {grant.policy} ·{" "}
        {grant.scope_claim_id && (
          <>
            scope: <Link href={`/claims/${grant.scope_claim_id}`}>this claim</Link>
            &rsquo;s subtree
          </>
        )}
        {" · funded "}
        {grant.created_at.slice(0, 10)}
      </p>

      <section>
        <h2>Status</h2>
        <p>
          {STATUS_LINES[grant.status] ?? grant.status}
          {paused &&
            " The budget is spent; top up below and the work continues where it left off."}
        </p>
        <div className="meter" aria-hidden>
          <div className="meter-fill" style={{ width: `${spentShare * 100}%` }} />
        </div>
        <p className="meter-caption">
          <OwlMark size={13} className="owl-mark" />
          {owls(grant.spent_owls)} of {owls(grant.budget_owls)} owls spent
        </p>
      </section>

      {grant.plan && (
        <section>
          <h2>
            {grant.status === "pending_approval"
              ? "The proposed plan"
              : "The plan"}
          </h2>
          {grant.plan.strategy && <p>{grant.plan.strategy}</p>}
          <table className="account-table">
            <thead>
              <tr>
                <th>#</th>
                <th>claim</th>
                <th>action</th>
                <th>why</th>
              </tr>
            </thead>
            <tbody>
              {planItems.map((item, i) => (
                <tr
                  key={`${item.claim_id}-${i}`}
                  style={
                    grant.status === "active" && i < grant.plan_cursor
                      ? { color: "var(--faint)" }
                      : undefined
                  }
                >
                  <td>{i + 1}</td>
                  <td>
                    <Link href={`/claims/${item.claim_id}`}>view claim</Link>
                  </td>
                  <td>{item.action}</td>
                  <td>{item.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {grant.status === "pending_approval" && (
            <form action={approveGrantAction}>
              <input type="hidden" name="grant_id" value={grant.id} />
              <button type="submit" className="order-button">
                Approve the plan and start the work
              </button>
            </form>
          )}
        </section>
      )}

      <section>
        <h2>What your funding bought</h2>
        {grant.funded_assessments.length > 0 ? (
          <table className="account-table">
            <thead>
              <tr>
                <th>claim</th>
                <th>verdict</th>
                <th>assessed</th>
              </tr>
            </thead>
            <tbody>
              {grant.funded_assessments.map((f, i) => (
                <tr key={`${f.claim_id}-${i}`}>
                  <td>
                    <Link href={`/claims/${f.claim_id}`}>{f.text}</Link>
                  </td>
                  <td>{f.status.replace(/_/g, " ")}</td>
                  <td>{f.assessed_at?.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="account-empty">
            No funded assessments yet; they appear here as each one lands. On
            its claim page, a funded assessment discloses only that a funded
            mandate scheduled it; the mandate&rsquo;s name stays on this
            dashboard.
          </p>
        )}
      </section>

      {open && (
        <section>
          <h2>Manage</h2>
          <TopUpGrant grantId={grant.id} paused={paused} />
          <form action={cancelGrantAction} style={{ marginTop: "0.8rem" }}>
            <input type="hidden" name="grant_id" value={grant.id} />
            <button className="linklike danger" type="submit">
              cancel grant and refund unspent budget
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
