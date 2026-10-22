/**
 * The platform account: Minerval as a funder (#529).
 *
 * `platform:minerval` is the account the platform's own mandates are funded
 * from. Nobody signs in to it. Its agency runs through exactly two
 * credentials, never through the web tier's service key acting as it:
 *
 *  - a platform-grantmaking key (scope PLATFORM_GRANTMAKING_SCOPE), minted
 *    with the operator key, which holds the platform's granting
 *    conversations with the Grantmaker and can do nothing else: no other
 *    route, no funding, no acting for anyone;
 *  - the operator key, which funds a drafted mandate once a reviewed,
 *    public approval pins it (routes/platform-mandates.ts).
 *
 * So the platform is a funder like any other in the conversation, where the
 * Grantmaker designs, quotes, and can decline its mandates, and the only
 * thing that differs is where its money comes from.
 */
import { getOrCreateContributor } from "./contributor-service.js";

export const PLATFORM_EXTERNAL_ID = "platform:minerval";
export const PLATFORM_DISPLAY_NAME = "Minerval";

/**
 * The API-key scope that holds the platform's granting conversations. A key
 * of this scope resolves to the platform account and is accepted only on
 * the conversation routes, never on `/fund` (server/plugins/auth.ts).
 */
export const PLATFORM_GRANTMAKING_SCOPE = "platform_grantmaking";

/** The platform account (the seed's `platform:minerval`), created on first use. */
export async function getPlatformAccountId(): Promise<string> {
  const row = await getOrCreateContributor({
    externalId: PLATFORM_EXTERNAL_ID,
    displayName: PLATFORM_DISPLAY_NAME,
  });
  return row.id;
}
