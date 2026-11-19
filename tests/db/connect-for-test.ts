/**
 * Connect the deployment a test runs as to a public graph the test started,
 * as an administrator and an organization's admin would (docs/organizations.md,
 * "Connecting"), without the round trip: the organization's account made an
 * organization there, a deployment with its own key and the grants given, and
 * this deployment's connection row holding that key. Every request this
 * deployment then makes to the public graph is signed with the key
 * (services/public-graph-client.ts), as in production; no bearer key is used.
 */
import { withSystemClearance } from "../../src/db/clearance.js";
import { rawQuery } from "../../src/db/client.js";
import { generateSigningKey } from "../../src/services/mirror-batch.js";
import { forgetConnection } from "../../src/services/public-graph-client.js";

type PublicRows = <T>(text: string, params?: unknown[]) => Promise<T[]>;

export const ALL_DEPLOYMENT_GRANTS = ["read_feed", "report_usage", "publish", "spend", "speak", "propose", "take_up"] as const;

export async function connectForTest(input: {
  /** A query on the public graph's database. */
  pub: PublicRows;
  /** The organization's account there. */
  organizationId: string;
  /** The public graph's API address, as this deployment reaches it. */
  apiUrl: string;
  grants?: readonly string[];
  hosting?: "own_machines" | "third_party" | "minerval";
}): Promise<{ deploymentId: string; keyId: string }> {
  const key = generateSigningKey();
  const grants = input.grants ?? ALL_DEPLOYMENT_GRANTS;
  const hosting = input.hosting ?? "own_machines";
  await input.pub(`UPDATE contributors SET kind = 'organization' WHERE id = $1`, [input.organizationId]);
  const [org] = await input.pub<{ display_name: string }>(`SELECT display_name FROM contributors WHERE id = $1`, [input.organizationId]);
  const [dep] = await input.pub<{ id: string }>(
    `INSERT INTO deployments (organization_id, name, hosting, public_key, key_id) VALUES ($1, 'Test deployment', $2, $3, $4) RETURNING id`,
    [input.organizationId, hosting, key.publicKey, key.keyId]
  );
  for (const g of grants) {
    await input.pub(`INSERT INTO organization_grants (organization_id, deployment_id, permission) VALUES ($1, $2, $3)`, [input.organizationId, dep!.id, g]);
  }
  await withSystemClearance("A test connects its deployment to a public graph it started.", () =>
    rawQuery(
      `INSERT INTO public_graph_connection (id, api_url, private_key_pem, public_key, key_id, state, deployment_id, deployment_name,
         organization_id, organization_name, grants, connected_at, hosting)
       VALUES ('this', $1, $2, $3, $4, 'connected', $5, 'Test deployment', $6, $7, $8, now(), $9)
       ON CONFLICT (id) DO UPDATE SET api_url = EXCLUDED.api_url, private_key_pem = EXCLUDED.private_key_pem, public_key = EXCLUDED.public_key,
         key_id = EXCLUDED.key_id, state = 'connected', deployment_id = EXCLUDED.deployment_id, deployment_name = EXCLUDED.deployment_name,
         organization_id = EXCLUDED.organization_id, organization_name = EXCLUDED.organization_name, grants = EXCLUDED.grants,
         connected_at = now(), hosting = EXCLUDED.hosting, last_error = NULL`,
      [input.apiUrl.replace(/\/+$/, ""), key.privateKeyPem, key.publicKey, key.keyId, dep!.id, input.organizationId, org?.display_name ?? "", [...grants], hosting]
    )
  );
  forgetConnection();
  return { deploymentId: dep!.id, keyId: key.keyId };
}

/** Forget this deployment's connection, as a test leaves it. */
export async function disconnectForTest(): Promise<void> {
  await withSystemClearance("A test forgets the connection it made.", () => rawQuery(`DELETE FROM public_graph_connection`));
  forgetConnection();
}

/** Take the connection down for a while (it reads as not connected), or bring it back. */
export async function setConnectedForTest(on: boolean): Promise<void> {
  await withSystemClearance("A test takes its connection down and back.", () =>
    rawQuery(`UPDATE public_graph_connection SET state = $1 WHERE id = 'this'`, [on ? "connected" : "expired"])
  );
  forgetConnection();
}
