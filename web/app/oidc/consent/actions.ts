"use server";

import { redirect } from "next/navigation";
import { auth } from "../../../auth";
import { AccountApiError, accountFetch } from "../../../lib/account-api";
import type { FormState } from "../../../components/admin/ActionForm";

// Signing in to an organization's deployment with a minerval.ai account
// (docs/organizations.md, "Signing in"). The person comes from the session;
// the API checks that they are a live member of the deployment's
// organization, and answers where to send them back.

async function answer(path: string): Promise<FormState> {
  const session = await auth();
  if (!session?.externalId) return { error: "Not signed in." };
  let to: string;
  try {
    to = (await accountFetch<{ redirect_to: string }>(path, { method: "POST", actingUser: session.externalId })).redirect_to;
  } catch (err) {
    return { error: err instanceof AccountApiError ? err.message : "That did not work. Start again from the deployment." };
  }
  redirect(to);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function approveSignInAction(_prev: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("request_id") ?? "");
  if (!UUID.test(id)) return { error: "No such sign-in." };
  return answer(`/oidc/requests/${id}/approve`);
}

export async function denySignInAction(_prev: FormState, form: FormData): Promise<FormState> {
  const id = String(form.get("request_id") ?? "");
  if (!UUID.test(id)) return { error: "No such sign-in." };
  return answer(`/oidc/requests/${id}/deny`);
}
