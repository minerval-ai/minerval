import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { accountApiConfigured, AccountApiError, makeGuest } from "./account-api";

// Guests on /ask (docs/accounts.md, "Guests"): a visitor with no account may
// talk to the Assistant on owls Minerval gives them. The API makes the guest
// account (POST /users/guest) and holds every bound; this keeps which guest
// a browser is, in an httpOnly cookie signed with the sign-in secret, so a
// visitor cannot name another guest. Only the Assistant's routes read it
// (lib/assistant-proxy.ts), and the API lets a guest reach nothing else.
//
// Signing in carries the guest's conversations to the new account (auth.ts
// reads the cookie when it provisions the account, then it is cleared).

export const GUEST_COOKIE = "minerval_guest";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function secret(): string | null {
  return (
    process.env.AUTH_SECRET ??
    (process.env.NODE_ENV === "production" ? null : "minerval-dev-secret-not-for-production")
  );
}

function sign(externalId: string, key: string): string {
  return createHmac("sha256", key).update(`guest:${externalId}`).digest("base64url");
}

/** The guest a cookie value names, if it is one this web tier signed. */
export function verifyGuestCookie(value: string | undefined | null): string | null {
  const key = secret();
  if (!value || !key) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const externalId = value.slice(0, dot);
  if (!externalId.startsWith("guest:")) return null;
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(externalId, key));
  return given.length === expected.length && timingSafeEqual(given, expected) ? externalId : null;
}

/** The guest this browser is, if any. */
export async function currentGuest(): Promise<string | null> {
  try {
    return verifyGuestCookie((await cookies()).get(GUEST_COOKIE)?.value);
  } catch {
    // Outside a request: nobody.
    return null;
  }
}

export async function forgetGuest(): Promise<void> {
  try {
    (await cookies()).delete(GUEST_COOKIE);
  } catch {
    // Outside a route handler or action the cookie cannot be changed; it
    // names a guest whose conversations have moved, which reads as empty.
  }
}

// The visitor's address, as Cloudflare saw it (it sets cf-connecting-ip
// itself, and a client cannot forge it through Cloudflare); without it, the
// first hop the load balancer recorded.
async function visitorAddress(): Promise<string> {
  const h = await headers();
  return (
    h.get("cf-connecting-ip")?.trim() ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export type GuestOutcome =
  | { ok: true; externalId: string }
  | { ok: false; status: number; error: string; code: string };

/**
 * The guest this browser is, made now if it is none yet. Called only from
 * a route handler, where the cookie can be set.
 */
export async function guestOrMake(): Promise<GuestOutcome> {
  const existing = await currentGuest();
  if (existing) return { ok: true, externalId: existing };
  const key = secret();
  if (!key || !accountApiConfigured()) {
    return { ok: false, status: 503, error: "The Assistant is not available to guests here.", code: "GUESTS_OFF" };
  }
  try {
    const guest = await makeGuest(await visitorAddress());
    (await cookies()).set(GUEST_COOKIE, `${guest.external_id}.${sign(guest.external_id, key)}`, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: MAX_AGE_SECONDS,
    });
    return { ok: true, externalId: guest.external_id };
  } catch (err) {
    if (err instanceof AccountApiError) {
      return { ok: false, status: err.status, error: err.message, code: err.code ?? "GUEST_REFUSED" };
    }
    throw err;
  }
}
