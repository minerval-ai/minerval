import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { accountApiConfigured } from "../../../lib/account-api";
import { listConversionsForMe, listMyOrganizations, type ConversionView, type OrganizationView } from "../../../lib/organizations-api";
import { Card, Empty, Pill, Section, Table, WorkHead, WorkPage, plural, shortDay } from "../../../components/work/ui";
import { WorkForm } from "../../../components/work/WorkForm";
import { acceptConversionAction, createOrganizationAction } from "./actions";

export const metadata: Metadata = { title: "Organizations · Minerval" };
export const dynamic = "force-dynamic";

// The organizations a person belongs to (docs/organizations.md). An
// organization is an account of its own kind that nobody signs in as; its
// people act for it as themselves.

export default async function OrganizationsPage() {
  const session = await auth();
  if (!session?.externalId) redirect("/signin");
  const me = session.externalId;
  if (!accountApiConfigured()) {
    return (
      <WorkPage>
        <WorkHead title="Organizations" />
        <Empty>The frontend is not connected to a Minerval API (MINERVAL_API_URL).</Empty>
      </WorkPage>
    );
  }
  const [orgs, conversions] = await Promise.all([
    listMyOrganizations(me).catch(() => [] as OrganizationView[]),
    listConversionsForMe(me).catch(() => [] as ConversionView[]),
  ]);

  return (
    <WorkPage>
      <WorkHead
        title="Organizations"
        sub={orgs.length ? plural(orgs.length, "organization") : "None yet"}
        crumbs={[{ href: "/account", label: "Account" }]}
      />

      {conversions.length > 0 && (
        <Section title="Waiting for you" aside="Accounts that named you as their first admin">
          {conversions.map((c) => (
            <Card key={c.id} title={<>{c.account.display_name} asks to become <b>{c.name}</b></>}>
              <p className="w-muted" style={{ margin: "0 0 10px" }}>
                It keeps its record: {plural(c.keeps.published_pages, "published page")}, {plural(c.keeps.publishers, "publisher registration")}{" "}
                and {plural(c.keeps.live_api_keys, "live API key")}. The shared login stops reaching it, and you become its admin.
                Asked {shortDay(c.asked_at)}.
              </p>
              <WorkForm action={acceptConversionAction} submit={`Accept and become admin of ${c.name}`} primary lock="The account becomes an organization">
                <input type="hidden" name="conversion_id" value={c.id} />
              </WorkForm>
            </Card>
          ))}
        </Section>
      )}

      <Section title="Yours">
        {orgs.length === 0 ? (
          <Empty>You belong to no organization. Make one below, or open an invitation link someone gave you.</Empty>
        ) : (
          <Table label="Your organizations">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Your role</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/account/organizations/${o.id}`}>{o.name}</Link>
                  </td>
                  <td>
                    <Pill tone={o.role === "admin" ? "info" : "neu"}>{o.role === "admin" ? "Admin" : "Member"}</Pill>
                  </td>
                  <td>{shortDay(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Section title="Make an organization" aside="Costs nothing and gives nothing: no owls, no standing">
        <Card>
          <WorkForm action={createOrganizationAction} submit="Make organization" primary>
            <div className="w-field">
              <label htmlFor="org-name">Name</label>
              <input id="org-name" className="w-input" name="name" required maxLength={120} autoComplete="organization" />
              <span className="w-help">Public, and proves nothing: two organizations can share a name.</span>
            </div>
          </WorkForm>
        </Card>
        <p className="w-muted">
          Have a login several people share for an organization? <Link href="/account/convert">Make that account an organization</Link>, keeping its record.
        </p>
      </Section>
    </WorkPage>
  );
}
