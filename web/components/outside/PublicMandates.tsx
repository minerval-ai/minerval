import Link from "next/link";
import { OwlMark } from "@/components/OwlMark";
import { membersOnly } from "@/lib/members";
import { british, fetchPublicAccount } from "@/lib/outside-api";
import { holds, loadStanding } from "@/lib/standing";

// On a private deployment's mandates page: the organisation's mandates on
// the public graph, listed with its own and marked as public, with its
// balance of public owls and the way to a new public mandate
// (docs/outward-acts.md). A private mandate cannot pay for public work, so
// paying for public work is made easy from here. On the public site this
// renders nothing.
export async function PublicMandates() {
  if (!membersOnly()) return null;
  const standing = await loadStanding();
  if (standing.state !== "signed_in" || !standing.mine.member) return null;
  const account = await fetchPublicAccount(standing.externalId).catch(() => null);
  if (!account) return null;
  const mayAct = holds(standing, "direct");
  return (
    <section>
      <h2>On the public graph</h2>
      {!account.connected ? (
        <p className="account-empty">{british(account.in_words ?? "")}</p>
      ) : (
        <>
          <p className="order-line" style={{ maxWidth: "46rem" }}>
            The mandates above are this deployment&rsquo;s own, paid for in its own owls, and they pay for work here. Work on the
            public graph is paid for by a public mandate, in public owls. {account.account?.name ?? "The organisation"} has{" "}
            <OwlMark size={14} className="owl-mark" />
            <strong>{(account.public_owls ?? 0).toLocaleString("en-GB", { maximumFractionDigits: 2 })} public owls</strong>, which
            never convert to or from this deployment&rsquo;s.{" "}
            {mayAct ? <Link href="/admin/outside#mandates">New public mandate →</Link> : <Link href="/admin/outside">The public graph →</Link>}
          </p>
          {(account.public_mandates ?? []).length === 0 ? (
            <p className="account-empty">The organisation funds no mandate on the public graph yet.</p>
          ) : (
            <div className="mandate-grid">
              {(account.public_mandates ?? []).map((m) => (
                <Link key={m.id} href="/admin/outside#mandates" className="mandate-tile">
                  <p className="sc mandate-tile-manager">public · on the public graph</p>
                  <h3>{m.title ?? "A public mandate"}</h3>
                  <div className="mandate-tile-budget">
                    <span>
                      <OwlMark size={14} className="owl-mark" />
                      {m.spent_owls !== null && m.budget_owls !== null ? `${m.spent_owls} of ${m.budget_owls} public owls spent` : `${m.budget_owls ?? ""} public owls`}
                    </span>
                    <span className="mandate-tile-contribs">{m.status ?? ""}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
