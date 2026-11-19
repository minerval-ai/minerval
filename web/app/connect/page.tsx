import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { AccountApiError } from "../../lib/account-api";
import { readConnectRequest, type ConnectRequestView } from "../../lib/organizations-api";
import { ActionForm } from "../../components/admin/ActionForm";
import { MastheadHeight } from "@/components/MastheadHeight";
import { PageHead } from "@/components/PageHead";
import { approveConnectAction, createOrganizationForConnectAction, denyConnectAction } from "../account/organizations/actions";
import { DEPLOYMENT_GRANTS, PERMISSION_WORDS } from "../../lib/organization-permissions";

export const metadata: Metadata = { title: "Connect a deployment · Minerval", robots: { index: false } };
export const dynamic = "force-dynamic";

// The link a private deployment shows when it asks to be connected
// (docs/organizations.md, "Connecting"). The person opens it signed in as
// themselves and sees what is asking. An admin of an organization chooses
// what it may do there and approves it, and is sent back to the
// deployment's own Overview; someone who admins none can make an
// organization here and go on; a member who is not an admin is told who can
// approve it, with the link to send them.

/** A code lasts fifteen minutes, so what is left is said in minutes. */
function expiresIn(at: string): string {
  const minutes = Math.ceil((new Date(at).getTime() - Date.now()) / 60_000);
  return minutes <= 0 ? "expired" : minutes === 1 ? "expires within a minute" : `expires in ${minutes} minutes`;
}

const HOSTING_SAID: Record<string, string> = {
  own_machines: "On the organization's own machines",
  third_party: "On machines the organization hired",
  minerval: "Run by Minerval for the organization",
};

export default async function ConnectPage({ searchParams }: { searchParams: Promise<{ code?: string; organization?: string }> }) {
  const { code, organization } = await searchParams;
  const here = `/connect${code ? `?code=${encodeURIComponent(code)}` : ""}`;
  const session = await auth();
  if (!session?.externalId) redirect(`/signin?callbackUrl=${encodeURIComponent(here)}`);

  let request: ConnectRequestView | null = null;
  let problem: string | null = null;
  if (code) {
    try {
      request = await readConnectRequest(session.externalId, code);
    } catch (err) {
      problem =
        err instanceof AccountApiError
          ? err.message
          : "This code could not be read. Try again in a moment; if it keeps failing, press Connect on the deployment again for a new one.";
    }
  }

  // The link to send someone else, as this site's own address.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "minerval.ai";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const link = request ? `${proto}://${host}/connect?code=${request.code}` : null;

  return (
    <div className="account-home org-home">
      <MastheadHeight />
      <PageHead
        back={{ href: "/account/organizations", label: "Organizations" }}
        title="Connect a deployment"
        meta={request ? `Code ${request.code}` : undefined}
        lede="A private deployment asks to act for an organization here, with a key of its own. An admin of the organization chooses what it may do, and approves it."
      />

      {!code && (
        <section className="acct-section">
          <div className="acct-head">
            <h2>The code</h2>
            <span className="acct-note">Shown in the deployment&rsquo;s Connect drawer</span>
          </div>
          <form action="/connect" method="get" className="admin-form">
            <label>
              Code
              <input name="code" required placeholder="WDJB-MJHT" autoComplete="off" />
            </label>
            <div className="admin-form-foot">
              <button className="order-button" type="submit">
                Look it up
              </button>
            </div>
          </form>
        </section>
      )}

      {problem && (
        <p className="acct-prose acct-measure" role="alert">
          {problem}
        </p>
      )}

      {request && (
        <>
          <section className="acct-section">
            <div className="acct-head">
              <h2>What is asking</h2>
              <span className="acct-note">What the deployment says of itself</span>
            </div>
            <div className="acct-line">
              <div>
                <b>{request.suggested_name}</b>
                <span className="acct-detail">what it asks to be called; you can change it below</span>
              </div>
            </div>
            <div className="acct-line">
              <div>
                {request.address ? <a href={request.address}>{request.address.replace(/^https?:\/\//, "")}</a> : "No address given"}
                <span className="acct-detail">its own address, where its members sign in; you are sent back there after approving</span>
              </div>
            </div>
            <div className="acct-line">
              <div>
                {HOSTING_SAID[request.hosting] ?? request.hosting_words}
                <span className="acct-detail">
                  where it runs: its statement, shown on every page it publishes
                  {request.hosting === "minerval" ? ", and checked by Minerval" : ", not checked"}
                </span>
              </div>
            </div>
            <div className="acct-line">
              <div>
                <code>{request.key_id.slice(0, 8)}</code>
                <span className="acct-detail">its key&rsquo;s id, first eight characters: the deployment shows the same</span>
              </div>
              <span className="acct-status">{request.state === "waiting" ? expiresIn(request.expires_at) : request.state}</span>
            </div>
          </section>

          {request.state !== "waiting" ? (
            <p className="acct-prose acct-measure" role="status">
              {request.state === "approved"
                ? "This code has been approved already. The deployment shows it connected."
                : request.state === "denied"
                  ? "This code was denied. An administrator of the deployment can press Connect again for a new one."
                  : "This code expired before anyone approved it. An administrator of the deployment presses Connect again for a new one."}
            </p>
          ) : request.your_organizations.length > 0 ? (
            <Approve request={request} chosen={organization} link={link!} />
          ) : (
            <NotAnAdmin request={request} link={link!} />
          )}
        </>
      )}
    </div>
  );
}

function Approve({ request, chosen, link }: { request: ConnectRequestView; chosen?: string; link: string }) {
  const needs = request.needs ?? request.asked_grants.map((grant) => ({ grant, why: null }));
  const needed = new Map(needs.map((n) => [n.grant, n.why] as const));
  const orgs = request.your_organizations;
  const first = orgs.find((o) => o.id === chosen)?.id ?? orgs[0]!.id;
  return (
    <>
      <section className="acct-section">
        <div className="acct-head">
          <h2>Approve it</h2>
          <span className="acct-note">Recorded on the organization&rsquo;s log under your name</span>
        </div>
        <p className="acct-prose acct-measure">
          <b>Approve only if you, or someone you trust, pressed Connect on this deployment just now.</b> Anyone can make a code and send
          you its link. Check that the deployment shows the key id above.
        </p>
        <ActionForm action={approveConnectAction} submit={`Approve ${request.suggested_name}`}>
          <input type="hidden" name="code" value={request.code} />
          <label>
            For
            <select name="organization_id" defaultValue={first}>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <small>The organizations you are an admin of. It acts as the one you choose, under what you tick below.</small>
          </label>
          <label>
            What to call it
            <input name="name" defaultValue={request.suggested_name} maxLength={120} />
            <small>Shown to the organization&rsquo;s members, and on every page this deployment publishes.</small>
          </label>
          <fieldset className="admin-fieldset">
            <legend>What it may do as the organization</legend>
            {DEPLOYMENT_GRANTS.map((g) => (
              <label key={g} className="admin-check">
                <input type="checkbox" name="grant" value={g} defaultChecked={needed.has(g)} />
                <span>
                  <code>{g}</code> {PERMISSION_WORDS[g]}
                  {needed.has(g) && <small> Its settings need this{needed.get(g) ? `: ${needed.get(g)}` : "."}</small>}
                </span>
              </label>
            ))}
          </fieldset>
          <label>
            Allowance on spend, in owls
            <input name="allowance_owls" type="number" min={0} step="any" placeholder="none: the whole balance" />
            <small>With spend ticked: the most of the organization&rsquo;s owls it may spend, until an admin raises it. Empty for none.</small>
          </label>
          <small className="acct-note">
            {request.address
              ? `After approving you are sent back to ${request.address.replace(/^https?:\/\//, "")}, which shows it connected.`
              : "After approving you go to the organization's Deployments tab. The deployment learns it the next time it asks."}{" "}
            You can change all of this later there.
          </small>
        </ActionForm>
        <div style={{ marginTop: "0.8rem" }}>
          <ActionForm action={denyConnectAction} submit="Deny it" inline danger>
            <input type="hidden" name="code" value={request.code} />
          </ActionForm>
        </div>
      </section>
      <section className="acct-section">
        <details>
          <summary className="acct-note">For an organization you do not admin, or a new one</summary>
          <p className="acct-prose acct-measure">
            Send an admin of that organization this link: <code>{link}</code>. Or make a new organization, which you admin, and approve it
            for that.
          </p>
          <NewOrganization code={request.code} />
        </details>
      </section>
    </>
  );
}

function NotAnAdmin({ request, link }: { request: ConnectRequestView; link: string }) {
  const memberOf = request.member_organizations ?? [];
  return (
    <>
      {memberOf.length > 0 && (
        <section className="acct-section">
          <div className="acct-head">
            <h2>Ask an admin</h2>
            <span className="acct-note">You are a member, not an admin, of {memberOf.length === 1 ? "this organization" : "these"}</span>
          </div>
          {memberOf.map((o) => (
            <div key={o.id} className="acct-line">
              <div>
                <Link href={`/account/organizations/${o.id}`}>{o.name}</Link>
                <span className="acct-detail">
                  {o.admins.length ? `Its ${o.admins.length === 1 ? "admin" : "admins"}: ${o.admins.join(", ")}` : "It has no admin who can sign in now."}
                </span>
              </div>
            </div>
          ))}
          <p className="acct-prose acct-measure">
            Send them this link, which works for fifteen minutes from when the code was made: <code>{link}</code>
          </p>
        </section>
      )}
      <section className="acct-section">
        <div className="acct-head">
          <h2>{memberOf.length > 0 ? "Or make an organization" : "Make an organization for it"}</h2>
          <span className="acct-note">You are an admin of none, so you cannot approve it yet</span>
        </div>
        <p className="acct-prose acct-measure">
          A deployment acts for an organization. Make one and you become its admin, and approve the deployment for it on this page.
          Making one costs nothing and gives nothing: no owls, no standing.
        </p>
        <NewOrganization code={request.code} />
      </section>
    </>
  );
}

function NewOrganization({ code }: { code: string }) {
  return (
    <ActionForm action={createOrganizationForConnectAction} submit="Make it, and go on">
      <input type="hidden" name="code" value={code} />
      <label>
        The organization&rsquo;s name
        <input name="name" required maxLength={120} autoComplete="organization" />
        <small>Public, and proves nothing: two organizations can share a name. You become its first admin.</small>
      </label>
    </ActionForm>
  );
}
