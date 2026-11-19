import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { accountApiConfigured } from "../../../lib/account-api";
import { listConversionsForMe, listMyOrganizations, type ConversionView, type OrganizationView } from "../../../lib/organizations-api";
import { actingOrganization } from "../../../lib/acting-as";
import { dateish } from "../../../lib/account-format";
import { ActionForm } from "../../../components/admin/ActionForm";
import { MastheadHeight } from "@/components/MastheadHeight";
import { PageHead } from "@/components/PageHead";
import { switchActingAction } from "../acting-actions";
import { acceptConversionAction, createOrganizationAction } from "./actions";

export const metadata: Metadata = { title: "Organizations · Minerval" };
export const dynamic = "force-dynamic";

// The organizations a person belongs to (docs/organizations.md). An
// organization is an account of its own kind that nobody signs in as; its
// people act as it, as themselves, with the switch beside each one here.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default async function OrganizationsPage() {
  const session = await auth();
  if (!session?.externalId) redirect("/signin");
  const me = session.externalId;
  if (!accountApiConfigured()) {
    return (
      <div className="account-home">
        <PageHead title="Organizations" lede="The frontend is not connected to a Minerval API (MINERVAL_API_URL)." />
      </div>
    );
  }
  const [orgs, conversions, acting] = await Promise.all([
    listMyOrganizations(me).catch(() => [] as OrganizationView[]),
    listConversionsForMe(me).catch(() => [] as ConversionView[]),
    actingOrganization(),
  ]);

  return (
    <div className="account-home">
      <MastheadHeight />
      <PageHead
        back={{ href: "/account", label: "Account" }}
        title="Organizations"
        meta={orgs.length ? `You belong to ${plural(orgs.length, "organization")}` : "None yet"}
        lede="An organization is an account of its own, with its own owls, that nobody signs in as. Its members act as it, as themselves, with the pages they use as themselves, each with what its admins have given them."
      />

      {conversions.length > 0 && (
        <section className="acct-section">
          <div className="acct-head">
            <h2>Waiting for you</h2>
            <span className="acct-note">Accounts that named you as their first admin</span>
          </div>
          {conversions.map((c) => (
            <div key={c.id} className="acct-job">
              <p className="acct-prose">
                <b>{c.account.display_name}</b> asks to become the organization <b>{c.name}</b>. It keeps its record:{" "}
                {plural(c.keeps.published_pages, "published page")}, {plural(c.keeps.publishers, "publisher registration")} and{" "}
                {plural(c.keeps.live_api_keys, "live API key")}. The shared login stops reaching it, and you become its admin. Asked{" "}
                {dateish(c.asked_at)}.
              </p>
              <ActionForm action={acceptConversionAction} submit={`Accept and become admin of ${c.name}`}>
                <input type="hidden" name="conversion_id" value={c.id} />
              </ActionForm>
            </div>
          ))}
        </section>
      )}

      <section className="acct-section">
        <div className="acct-head">
          <h2>Yours</h2>
        </div>
        {orgs.length === 0 ? (
          <p className="acct-prose acct-quiet">You belong to no organization. Make one below, or open an invitation link someone gave you.</p>
        ) : (
          orgs.map((o) => {
            const permissions = o.permissions ?? [];
            const mayAct = o.role === "admin" || permissions.length > 0;
            const on = acting?.id === o.id;
            return (
              <div key={o.id} className="acct-line">
                <div>
                  <Link href={`/account/organizations/${o.id}`}>{o.name}</Link>
                  <span className="acct-detail">
                    {o.role === "admin" ? "admin, with every permission" : permissions.length ? `member: ${permissions.join(", ")}` : "member, with no permission to act as it"}
                  </span>
                </div>
                {mayAct && (
                  <form action={switchActingAction}>
                    <input type="hidden" name="organization_id" value={on ? "" : o.id} />
                    <input type="hidden" name="return_to" value="/account/organizations" />
                    <button type="submit" className="linklike">
                      {on ? "acting as it · act as yourself" : `act as ${o.name}`}
                    </button>
                  </form>
                )}
              </div>
            );
          })
        )}
      </section>

      <section className="acct-section">
        <div className="acct-head">
          <h2>Make an organization</h2>
          <span className="acct-note">Costs nothing and gives nothing: no owls, no standing</span>
        </div>
        <ActionForm action={createOrganizationAction} submit="Make organization">
          <label>
            Name
            <input name="name" required maxLength={120} autoComplete="organization" />
            <small>Public, and proves nothing: two organizations can share a name. You become its first admin.</small>
          </label>
        </ActionForm>
        <p className="acct-note">
          Have a login several people share for an organization? <Link href="/account/convert">Make that account an organization</Link>,
          keeping its record.
        </p>
      </section>
    </div>
  );
}
