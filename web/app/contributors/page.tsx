import type { Metadata } from "next";
import Link from "next/link";
import { apiConfigured, fetchLeaderboard } from "../../lib/api";
import { OwlMark } from "../../components/OwlMark";

export const metadata: Metadata = {
  title: "Contributors — Minerval",
  description:
    "The contributors whose accepted challenges, evidence, and proposals have most improved the graph.",
};

export const revalidate = 60;

export default async function ContributorsPage() {
  if (!apiConfigured()) {
    return (
      <div className="col">
        <h1>Contributors</h1>
        <p>
          The frontend is not connected to a Minerval API (set{" "}
          <code>MINERVAL_API_URL</code>), so contributor data is unavailable.
        </p>
      </div>
    );
  }

  const contributors = await fetchLeaderboard(50);

  return (
    <div className="col">
      <p className="claim-eyebrow">contributors</p>
      <h1>Leaderboard</h1>
      <p>
        Accepted challenges, evidence, and proposals earn{" "}
        <strong>owls</strong> — the same spendable unit that buys assessments
        — in proportion to how load-bearing the affected claim is, with a
        bonus for contributions that survive appeal scrutiny. The leaderboard
        ranks lifetime owls <em>earned</em>: buying owls never moves it, and
        spending them never lowers it. It is distinct from{" "}
        <strong>reputation</strong>, which tracks standing — good-faith
        contribution is always free, whether or not it is accepted.
      </p>

      {contributors.length === 0 ? (
        <p className="account-empty">
          No owls have been earned yet. Earned owls appear when contributions
          are accepted.
        </p>
      ) : (
        <table className="account-table">
          <thead>
            <tr>
              <th>#</th>
              <th>contributor</th>
              <th>owls earned</th>
              <th>accepted</th>
              <th>standing</th>
            </tr>
          </thead>
          <tbody>
            {contributors.map((c, i) => (
              <tr key={c.id}>
                <td>{i + 1}</td>
                <td>
                  <Link href={`/contributors/${c.id}`}>{c.display_name}</Link>
                </td>
                <td>
                  <OwlMark size={14} className="owl-mark" />
                  {c.owls_earned}
                </td>
                <td>{c.contributions_accepted}</td>
                <td>{c.trust_level}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
