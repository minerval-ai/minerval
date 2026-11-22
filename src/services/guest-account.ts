/**
 * Who a guest is (docs/accounts.md, "Guests"): an account the web tier
 * makes for a visitor with no account, so they can talk to the Assistant on
 * owls the platform gives. Its external id is `guest:<uuid>`, which no
 * sign-in provider makes. Kept apart from guest-service.ts so the auth
 * plugin and the ledger can ask without loading the service.
 */
export const GUEST_EXTERNAL_ID_PREFIX = "guest:";

export function isGuestExternalId(externalId: string | null | undefined): boolean {
  return typeof externalId === "string" && externalId.startsWith(GUEST_EXTERNAL_ID_PREFIX);
}
