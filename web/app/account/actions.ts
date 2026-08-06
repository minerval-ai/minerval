"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth, signOut } from "../../auth";
import {
  createApiKey,
  createOwlPackCheckout,
  revokeApiKey,
  topUpBudgetJob,
  cancelBudgetJob,
  approveGrant,
  topUpGrant,
  cancelGrant,
  AccountApiError,
} from "../../lib/account-api";

export interface CreateKeyState {
  plaintext?: string;
  name?: string;
  error?: string;
}

// The acting identity always comes from the server session — never from the
// form — so a forged request can only ever operate on its own account.
export async function createKeyAction(
  _prev: CreateKeyState,
  formData: FormData
): Promise<CreateKeyState> {
  const session = await auth();
  if (!session?.externalId) return { error: "Not signed in." };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Give the key a name." };
  try {
    const created = await createApiKey(session.externalId, name);
    revalidatePath("/account");
    return { plaintext: created.key, name: created.name };
  } catch (err) {
    const message =
      err instanceof AccountApiError ? err.message : "Key creation failed.";
    return { error: message };
  }
}

export async function revokeKeyAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.externalId) return;
  const keyId = String(formData.get("key_id") ?? "");
  if (!keyId) return;
  try {
    await revokeApiKey(session.externalId, keyId);
  } catch (err) {
    console.error("[account] revoke failed:", err);
  }
  revalidatePath("/account");
}

export interface BuyOwlsState {
  error?: string;
}

// Sends the buyer to Stripe-hosted Checkout; on success the webhook credits
// the owl ledger and Stripe redirects back to /account. The acting identity
// comes from the server session, so the only user-controlled input is the
// pack id — which the API validates against its configured pack list.
export async function buyOwlsAction(
  _prev: BuyOwlsState,
  formData: FormData
): Promise<BuyOwlsState> {
  const session = await auth();
  if (!session?.externalId) return { error: "Not signed in." };
  const packId = String(formData.get("pack_id") ?? "");
  if (!packId) return { error: "Pick a pack." };
  let checkoutUrl: string;
  try {
    checkoutUrl = await createOwlPackCheckout(session.externalId, packId);
  } catch (err) {
    const message =
      err instanceof AccountApiError
        ? err.message
        : "Could not start the purchase.";
    return { error: message };
  }
  redirect(checkoutUrl);
}

export interface JobActionState {
  error?: string;
  ok?: boolean;
}

// Top up a budget job (a paused job resumes). The acting identity comes from
// the server session; the API re-validates ownership and balance.
export async function topUpJobAction(
  _prev: JobActionState,
  formData: FormData
): Promise<JobActionState> {
  const session = await auth();
  if (!session?.externalId) return { error: "Not signed in." };
  const jobId = String(formData.get("job_id") ?? "");
  const owls = Number(formData.get("owls"));
  if (!jobId || !Number.isFinite(owls) || owls <= 0) {
    return { error: "Enter how many owls to add." };
  }
  try {
    await topUpBudgetJob(session.externalId, jobId, owls);
  } catch (err) {
    return {
      error:
        err instanceof AccountApiError ? err.message : "Top-up failed.",
    };
  }
  revalidatePath(`/account/jobs/${jobId}`);
  return { ok: true };
}

export async function cancelJobAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.externalId) return;
  const jobId = String(formData.get("job_id") ?? "");
  if (!jobId) return;
  try {
    await cancelBudgetJob(session.externalId, jobId);
  } catch (err) {
    console.error("[account] job cancel failed:", err);
  }
  revalidatePath(`/account/jobs/${jobId}`);
}

export async function approveGrantAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.externalId) return;
  const grantId = String(formData.get("grant_id") ?? "");
  if (!grantId) return;
  try {
    await approveGrant(session.externalId, grantId);
  } catch (err) {
    console.error("[account] grant approval failed:", err);
  }
  revalidatePath(`/account/grants/${grantId}`);
}

export async function topUpGrantAction(
  _prev: JobActionState,
  formData: FormData
): Promise<JobActionState> {
  const session = await auth();
  if (!session?.externalId) return { error: "Not signed in." };
  const grantId = String(formData.get("grant_id") ?? "");
  const owls = Number(formData.get("owls"));
  if (!grantId || !Number.isFinite(owls) || owls <= 0) {
    return { error: "Enter how many owls to add." };
  }
  try {
    await topUpGrant(session.externalId, grantId, owls);
  } catch (err) {
    return {
      error: err instanceof AccountApiError ? err.message : "Top-up failed.",
    };
  }
  revalidatePath(`/account/grants/${grantId}`);
  return { ok: true };
}

export async function cancelGrantAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.externalId) return;
  const grantId = String(formData.get("grant_id") ?? "");
  if (!grantId) return;
  try {
    await cancelGrant(session.externalId, grantId);
  } catch (err) {
    console.error("[account] grant cancel failed:", err);
  }
  revalidatePath(`/account/grants/${grantId}`);
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
