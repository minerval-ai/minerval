import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { AccountApiError, accountApiConfigured, accountFetch } from "../../../lib/account-api";
import { ActionForm } from "../../../components/admin/ActionForm";
import { MastheadHeight } from "@/components/MastheadHeight";
import { PageHead } from "@/components/PageHead";
import { approveSignInAction, denySignInAction } from "./actions";

export const metadata: Metadata = { title: "Sign in to a deployment · Minerval", robots: { index: false } };
export const dynamic = "force-dynamic";

// Where an organization's private deployment sends a person to sign in with
// their minerval.ai account (docs/organizations.md, "Signing in"). They see
// which deployment asks and for which organization, and sign in as
// themselves; only its live members can. The deployment learns who they are,
// that organization, and their role in it. A role here grants nothing in the
// deployment: its administrators grant what each person may do there.

interface SignInRequest {
  request_id: string;
  client: { name: string; redirect_origin: string };
  organization: { id: string; name: string };
  scopes: string[];
  your_role: "admin" | "member" | null;
  state: "waiting" | "approved" | "denied" | "expired";
}

export default async function OidcConsentPage({ searchParams }: { searchParams: Promise<{ request_id?: string }> }) {
  const { request_id: requestId } = await searchParams;
  if (!requestId || !accountApiConfigured()) redirect("/");
  const here = `/oidc/consent?request_id=${encodeURIComponent(requestId)}`;
  const session = await auth();
  if (!session?.externalId) redirect(`/signin?callbackUrl=${encodeURIComponent(here)}`);

  let request: SignInRequest | null = null;
  let problem: string | null = null;
  try {
    request = await accountFetch<SignInRequest>(`/oidc/requests/${encodeURIComponent(requestId)}`, { actingUser: session.externalId });
  } catch (err) {
    problem = err instanceof AccountApiError ? err.message : "This sign-in could not be read. Start again from the deployment.";
  }

  return (
    <div className="account-home">
      <MastheadHeight />
      <PageHead
        title="Sign in to a deployment"
        lede="A private deployment of an organization signs its members in with their minerval.ai accounts."
      />
      {problem && <p className="acct-prose acct-measure" role="alert">{problem}</p>}
      {request && (
        <section className="acct-section">
          <div className="acct-head">
            <h2>{request.client.name}</h2>
            <span className="acct-note">
              {request.organization.name}&rsquo;s deployment at {request.client.redirect_origin.replace(/^https?:\/\//, "")}
            </span>
          </div>
          {request.state !== "waiting" ? (
            <p className="acct-prose acct-measure">
              {request.state === "expired"
                ? "This sign-in has expired. Start again from the deployment."
                : "This sign-in has been answered already. Start again from the deployment if you need to."}
            </p>
          ) : request.your_role === null ? (
            <p className="acct-prose acct-measure">
              Only members of {request.organization.name} sign in to its deployment this way, and you are not one. An admin of{" "}
              {request.organization.name} invites you, on its Members tab here.{" "}
              <Link href="/account/organizations">Your organizations</Link>.
            </p>
          ) : (
            <>
              <p className="acct-prose acct-measure">
                Signing in tells the deployment who you are on minerval.ai ({request.scopes.includes("email") ? "your name and email" : "your name"}),
                that you are {request.your_role === "admin" ? "an admin" : "a member"} of {request.organization.name}, and nothing else. What you
                may do there is for its administrators to say.
              </p>
              <ActionForm action={approveSignInAction} submit={`Sign in to ${request.client.name}`}>
                <input type="hidden" name="request_id" value={request.request_id} />
              </ActionForm>
              <div style={{ marginTop: "0.6rem" }}>
                <ActionForm action={denySignInAction} submit="Not now" inline>
                  <input type="hidden" name="request_id" value={request.request_id} />
                </ActionForm>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
