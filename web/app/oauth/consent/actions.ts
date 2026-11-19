"use server";

import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import {
  approveOAuthRequest,
  denyOAuthRequest,
  AccountApiError,
} from "../../../lib/account-api";

// The consenting identity always comes from the server session, never the
// form — same rule as API-key minting. The redirect target comes back from
// the API, which only ever builds it from the client's registered
// redirect_uri.

export async function approveConsentAction(formData: FormData): Promise<void> {
  const session = await auth();
  const requestId = String(formData.get("request_id") ?? "");
  if (!session?.externalId || !requestId) redirect("/signin");
  let redirectTo: string;
  try {
    const actingFor = String(formData.get("acting_for") ?? "").trim() || undefined;
    redirectTo = await approveOAuthRequest(session.externalId, requestId, actingFor);
  } catch (err) {
    const gone = err instanceof AccountApiError && err.status === 410;
    redirect(
      `/oauth/consent?request_id=${encodeURIComponent(requestId)}&error=${gone ? "gone" : "failed"}`
    );
  }
  redirect(redirectTo);
}

export async function denyConsentAction(formData: FormData): Promise<void> {
  const requestId = String(formData.get("request_id") ?? "");
  if (!requestId) redirect("/");
  let redirectTo: string;
  try {
    redirectTo = await denyOAuthRequest(requestId);
  } catch {
    redirect("/");
  }
  redirect(redirectTo);
}
