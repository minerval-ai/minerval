import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { fetchAccount } from "../../../lib/account-api";
import { getOpenConversion, type ConversionView } from "../../../lib/organizations-api";
import { Banner, Card, Kv, Section, WorkHead, WorkPage, plural, shortDay } from "../../../components/work/ui";
import { WorkForm } from "../../../components/work/WorkForm";
import { askConversionAction, cancelConversionAction } from "../organizations/actions";

export const metadata: Metadata = { title: "Make this account an organization · Minerval" };
export const dynamic = "force-dynamic";

// A login several people share, made into an organization in place
// (docs/organizations.md, "Converting an existing shared account"). The
// account keeps its id, and so its record, pages, owls and keys. Nothing
// changes until the person it names as first admin accepts from their own
// session.

export default async function ConvertPage() {
  const session = await auth();
  if (!session?.externalId) redirect(`/signin?callbackUrl=${encodeURIComponent("/account/convert")}`);
  const me = session.externalId;
  const [account, open] = await Promise.all([
    fetchAccount(me).catch(() => null),
    getOpenConversion(me).catch(() => null as ConversionView | null),
  ]);

  return (
    <WorkPage>
      <WorkHead
        title="Make this account an organization"
        sub={account ? `Signed in as ${account.user.display_name}` : undefined}
        crumbs={[
          { href: "/account", label: "Account" },
          { href: "/account/organizations", label: "Organizations" },
        ]}
      />
      <Banner>
        For a login several people share. The account keeps everything it did, and the shared login stops reaching it. If this is your own
        account, <Link href="/account/organizations">make a new organization</Link> instead.
      </Banner>

      {open ? (
        <Section title="Asked" aside={`On ${shortDay(open.asked_at)}`}>
          <Card>
            <Kv
              rows={[
                ["Organization", open.name],
                ["First admin", `${open.first_admin.display_name}, who must accept from their own session`],
                [
                  "It keeps",
                  `${plural(open.keeps.published_pages, "published page")}, ${plural(open.keeps.publishers, "publisher registration")}, and its owls and record`,
                ],
                [
                  "It stops",
                  `${plural(open.keeps.live_api_keys, "live API key")}: a deployment connects to the organization with a key of its own, and a member acts as it signed in as themselves`,
                ],
              ]}
            />
            <div style={{ marginTop: 14 }}>
              <WorkForm action={cancelConversionAction} submit="Withdraw the request" />
            </div>
          </Card>
        </Section>
      ) : (
        <Section title="Ask">
          <Card>
            <WorkForm action={askConversionAction} submit="Ask them" primary>
              <div className="w-field">
                <label htmlFor="conv-name">Organization name</label>
                <input id="conv-name" className="w-input" name="name" required maxLength={120} defaultValue={account?.user.display_name ?? ""} />
              </div>
              <div className="w-field">
                <label htmlFor="conv-admin">First admin</label>
                <input id="conv-admin" className="w-input" name="first_admin" required placeholder="Their contributor page's address" />
                <span className="w-help">A person&apos;s own account, not this one. They see the request on their Organizations page.</span>
              </div>
            </WorkForm>
          </Card>
        </Section>
      )}

      <Section title="When they accept">
        <ul className="w-muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>The account becomes the organization, with them as its admin.</li>
          <li>Signing in with this login afterwards makes a new, empty person account. It no longer reaches the organization.</li>
          <li>Its API keys keep working until an admin revokes them. The organization&apos;s page lists them as old keys still live.</li>
          <li>Its OAuth tokens are revoked, and its email and avatar, which were the login&apos;s, are cleared.</li>
        </ul>
      </Section>
    </WorkPage>
  );
}
