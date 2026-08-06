import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import {
  accountApiConfigured,
  listGrants,
  type GrantView,
} from "../../../lib/account-api";
import { OwlMark } from "../../../components/OwlMark";

export const metadata: Metadata = { title: "Grants · Minerval" };
export const dynamic = "force-dynamic";

function owls(n: number): string {
  return Number(n.toFixed(3)).toString();
}

const STATUS_LABELS: Record<string, string> = {
  planning: "plan being drafted",
  pending_approval: "plan awaiting your approval",
  active: "active",
  completed: "completed",
  cancelled: "cancelled",
};

export default async function GrantsPage() {
  const session = await auth();
  if (!session?.externalId) redirect("/signin");

  let grants: GrantView[] = [];
  if (accountApiConfigured()) {
    try {
      grants = await listGrants(session.externalId);
    } catch {
      // list failure renders the empty state below
    }
  }

  return (
    <div className="col account">
      <p className="claim-eyebrow">
        <Link href="/account">← account</Link>
      </p>
      <h1>Grants</h1>
      <p>
        A grant funds sustained attention on the part of the graph you care
        about, from a handful of claims to a whole literature. You describe
        the work in conversation with the Grantmaker, it drafts a mandate and
        quotes the cost in owls, and funding the mandate escrows the budget
        and starts the work. Money buys scheduling, never conclusions: funded
        assessments meet the same standards as every other, and whatever a
        mandate does not spend returns to your balance.
      </p>
      <p>
        <Link href="/account/grants/new">→ create a grant</Link>
      </p>

      {grants.length > 0 && (
        <table className="account-table">
          <thead>
            <tr>
              <th>mandate</th>
              <th>policy</th>
              <th>status</th>
              <th>budget</th>
              <th>created</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id}>
                <td>
                  <Link href={`/account/grants/${g.id}`}>{g.name}</Link>
                </td>
                <td>{g.policy}</td>
                <td>
                  {g.status === "pending_approval" ? (
                    <strong>{STATUS_LABELS[g.status]}</strong>
                  ) : (
                    (STATUS_LABELS[g.status] ?? g.status) +
                    (g.budget_status === "paused_budget" ? " · needs top-up" : "")
                  )}
                </td>
                <td>
                  <OwlMark size={14} className="owl-mark" />
                  {owls(g.spent_owls)} / {owls(g.budget_owls)} owls
                </td>
                <td>{g.created_at.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {grants.length === 0 && (
        <p className="account-empty">No grants yet.</p>
      )}
    </div>
  );
}
