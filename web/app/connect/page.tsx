import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { AccountApiError } from "../../lib/account-api";
import { readConnectRequest, type ConnectRequestView, type DeploymentGrant } from "../../lib/organizations-api";
import { Banner, Card, Kv, Section, WorkHead, WorkPage, shortWhen } from "../../components/work/ui";
import { WorkForm } from "../../components/work/WorkForm";
import { approveConnectAction, denyConnectAction } from "../account/organizations/actions";

export const metadata: Metadata = { title: "Connect a deployment · Minerval", robots: { index: false } };
export const dynamic = "force-dynamic";

// The link a private deployment shows when it asks to be connected
// (docs/organizations.md, "Connecting"). An admin of an organization opens
// it signed in as themselves, compares the code and key id with what the
// deployment shows, and approves it with the grants they choose, or denies
// it.

const GRANT_WORDS: Record<DeploymentGrant, string> = {
  read_feed: "Pull the whole mirror feed. It shows only that the deployment exists and when it pulls.",
  report_usage: "Send its daily usage total, privately to Minerval. Billed to the organization.",
  publish: "Register its signing key, and send pages and mandates under the organization's name.",
  act: "Take up requests, open and fund mandates, and spend the organization's public owls.",
};

export default async function ConnectPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const here = `/connect${code ? `?code=${encodeURIComponent(code)}` : ""}`;
  const session = await auth();
  if (!session?.externalId) redirect(`/signin?callbackUrl=${encodeURIComponent(here)}`);

  let request: ConnectRequestView | null = null;
  let problem: string | null = null;
  if (code) {
    try {
      request = await readConnectRequest(session.externalId, code);
    } catch (err) {
      problem = err instanceof AccountApiError ? err.message : "This code could not be read.";
    }
  }

  return (
    <WorkPage>
      <WorkHead title="Connect a deployment" sub="A private deployment asks to act for an organization" />

      {!code && (
        <Card>
          <form action="/connect" method="get" className="w-form">
            <div className="w-field">
              <label htmlFor="connect-code">The code the deployment shows</label>
              <input id="connect-code" className="w-input" name="code" required placeholder="WDJB-MJHT" autoComplete="off" />
            </div>
            <div className="w-form-foot">
              <button className="w-btn w-pri" type="submit">
                Look it up
              </button>
            </div>
          </form>
        </Card>
      )}

      {problem && <Banner tone="bad">{problem}</Banner>}

      {request && (
        <>
          <Banner tone="warn">
            Approve only if a deployment of yours shows this code and this key id right now. Anyone can make a code and send you its link.
          </Banner>
          <Section title="What is asking">
            <Card>
              <Kv
                rows={[
                  ["Code", <span key="c" className="w-mono">{request.code}</span>],
                  ["Key id, first eight", <span key="k" className="w-mono">{request.key_id.slice(0, 8)}</span>],
                  ["Suggested name", request.suggested_name],
                  ["Hosting", `${request.hosting_words} (the deployment's own statement)`],
                  ["Expires", shortWhen(request.expires_at)],
                ]}
              />
            </Card>
          </Section>

          {request.state !== "waiting" ? (
            <Banner tone="warn">
              {request.state === "approved"
                ? "This code has already been approved."
                : request.state === "denied"
                  ? "This code was denied."
                  : "This code has expired. Ask for a new one on the deployment."}
            </Banner>
          ) : request.your_organizations.length === 0 ? (
            <Banner>
              You are not an admin of any organization, so you cannot approve this. <Link href="/account/organizations">Make an organization</Link>, or
              send the link to an admin of yours.
            </Banner>
          ) : (
            <Section title="Approve it for">
              <Card>
                <WorkForm action={approveConnectAction} submit={`Approve ${request.suggested_name}`} primary lock="Recorded on the organization's log">
                  <input type="hidden" name="code" value={request.code} />
                  <div className="w-field">
                    <label htmlFor="connect-org">Organization</label>
                    <select id="connect-org" className="w-select" name="organization_id" defaultValue={request.your_organizations[0]!.id}>
                      {request.your_organizations.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="w-field">
                    <label htmlFor="connect-name">Name it</label>
                    <input id="connect-name" className="w-input" name="name" defaultValue={request.suggested_name} maxLength={120} />
                  </div>
                  <div className="w-field">
                    <span className="w-label">It may</span>
                    <div className="w-options">
                      {request.asked_grants.map((g) => (
                        <label key={g} className="w-option">
                          <input type="checkbox" name="grant" value={g} defaultChecked />
                          <div>
                            <b className="w-mono">{g}</b>
                            <span>{GRANT_WORDS[g]}</span>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>
                </WorkForm>
                <div style={{ marginTop: 10 }}>
                  <WorkForm action={denyConnectAction} submit="Deny" danger>
                    <input type="hidden" name="code" value={request.code} />
                  </WorkForm>
                </div>
              </Card>
            </Section>
          )}
        </>
      )}
    </WorkPage>
  );
}
