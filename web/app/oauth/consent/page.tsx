import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import {
  accountApiConfigured,
  fetchOAuthRequest,
  type OAuthRequestView,
} from "../../../lib/account-api";
import { approveConsentAction, denyConsentAction } from "./actions";

export const metadata: Metadata = { title: "Authorize access — Minerval" };
export const dynamic = "force-dynamic";

// The consent half of the OAuth flow for remote MCP connectors (Claude.ai,
// Cowork, ...). The API validates the client and parks the authorization
// request; this page binds the approval to the signed-in account and sends
// the browser back to the client with the code.
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ request_id?: string; error?: string }>;
}) {
  const { request_id: requestId, error } = await searchParams;
  if (!requestId) redirect("/");
  if (!accountApiConfigured()) redirect("/");

  const session = await auth();
  if (!session?.externalId) {
    redirect(
      `/signin?callbackUrl=${encodeURIComponent(`/oauth/consent?request_id=${requestId}`)}`
    );
  }

  let request: OAuthRequestView;
  try {
    request = await fetchOAuthRequest(requestId);
  } catch {
    return (
      <Shell>
        <p>
          This authorization request doesn&apos;t exist. Start the connection
          again from your MCP client.
        </p>
      </Shell>
    );
  }

  if (request.status !== "pending" || request.expired) {
    return (
      <Shell>
        <p>
          This authorization request has expired or was already handled. Start
          the connection again from your MCP client.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <p>
        <strong>{request.client.name}</strong>
        {request.client.uri ? (
          <>
            {" "}
            (<a href={request.client.uri}>{request.client.uri}</a>)
          </>
        ) : null}{" "}
        is asking to connect to the Minerval claim graph as{" "}
        <strong>{session!.user?.name ?? session!.externalId}</strong>.
      </p>
      <p>
        It will be able to search and read claims, run fact-checks against
        your monthly allowance, and submit contributions in your name. You can
        revoke access at any time from your account page. After you approve,
        you&apos;ll be sent back to{" "}
        <code>{request.client.redirect_host}</code>.
      </p>
      {error === "gone" && (
        <p className="signin-note">
          That request had already expired; ask the client to reconnect.
        </p>
      )}
      {error === "failed" && (
        <p className="signin-note">Approval failed; try again.</p>
      )}
      <div className="signin-options">
        <form action={approveConsentAction}>
          <input type="hidden" name="request_id" value={requestId} />
          <button className="signin-button" type="submit">
            Approve
          </button>
        </form>
        <form action={denyConsentAction}>
          <input type="hidden" name="request_id" value={requestId} />
          <button className="signin-button" type="submit">
            Deny
          </button>
        </form>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="col">
      <p className="claim-eyebrow">authorize</p>
      <h1>Connect an application</h1>
      {children}
    </div>
  );
}
