/**
 * Move every credential given on a connection's page onto the current key
 * (src/services/connection-credential.ts; docs/connections.md, "A
 * credential given here").
 *
 * Replacing the key credentials are sealed with goes:
 *
 *   1. Put the old key in CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS and a new one
 *      (openssl rand -base64 32) in CREDENTIAL_ENCRYPTION_KEY, and restart.
 *      Every credential still opens, under the previous key.
 *   2. Run this, with the same environment as the API. In the packaged
 *      deployment (deploy/compose.yml):
 *
 *        docker compose exec api npm run reseal:connection-credentials
 *
 *   3. When it says none is left on a previous key, remove the old key from
 *      CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS and restart.
 *
 * A credential that does not open (its key is not among those set) is left
 * as it is and named: give it again on the connection's page. Running this
 * twice changes nothing the second time.
 *
 * The keys someone outside issued that an administrator gave on the
 * settings page (docs/settings.md, "Keys issued by someone else") are sealed
 * under the same key, and are moved onto the current one here too.
 */
import { closeDb } from "../src/db/client.js";
import { resealStoredCredentials } from "../src/services/connection-service.js";
import { resealStoredSettings } from "../src/services/settings-service.js";

async function main(): Promise<number> {
  const result = await resealStoredCredentials();
  if (!result.ok) {
    console.error(result.message);
    return 1;
  }
  console.log(
    `Sealed again under the current key: ${result.resealed}. Already under it: ${result.already_current}.`
  );
  for (const c of result.not_opened) {
    console.log(`Did not open, so left as it is: "${c.name}" (${c.id}). Give its credential again on its page.`);
  }
  const settings = await resealStoredSettings();
  if (!settings.ok) {
    console.error(settings.message);
    return 1;
  }
  console.log(
    `Keys given on the settings page, sealed again under the current key: ${settings.resealed}. Already under it: ${settings.already_current}.`
  );
  for (const key of settings.not_opened) {
    console.log(`Did not open, so left as it is: ${key}. Give it again on the settings page.`);
  }
  const left = result.not_opened.length + settings.not_opened.length;
  if (left === 0) {
    console.log("Nothing is left on a previous key: the previous keys can be removed.");
  }
  return left === 0 ? 0 : 2;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
