"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth, signOut } from "../../auth";
import {
  createApiKey,
  createOwlPackCheckout,
  revokeApiKey,
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

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}
