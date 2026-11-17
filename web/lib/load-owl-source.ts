import "server-only";
import { cache } from "react";
import { fetchAccount } from "./account-api";
import { owlSourceOf, gettingOwlsSentence, CREATES_OWLS, type OwlSource } from "./owl-source";
import { holds, loadStanding } from "./standing";

// Where the signed-in person gets more owls here (lib/owl-source.ts), read
// once for each page render from what the API already says: the account's
// entitlement and packs, and whether the person holds the permission that
// creates owls. A read that fails says "none", which sends nobody to a
// section that may not be there.
export const loadOwlSource = cache(async (externalId: string): Promise<OwlSource> => {
  const [account, standing] = await Promise.all([
    fetchAccount(externalId).catch(() => null),
    loadStanding(),
  ]);
  if (!account) return { kind: "none" };
  return owlSourceOf(account.entitlement, account.packs, holds(standing, CREATES_OWLS));
});

/** How the person gets more owls here, as one sentence for a refusal's message. */
export async function gettingOwlsFor(externalId: string): Promise<string> {
  return gettingOwlsSentence(await loadOwlSource(externalId));
}
