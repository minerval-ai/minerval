/**
 * Load a graph from any disposable database into the shape
 * graph-agreement.ts compares (the same query agreement.ts runs), plus the
 * snapshot-URL helper, for drivers that compute agreement in-process rather
 * than through the corpus:agreement CLI (the adversarial suite computes one
 * agreement per arm and does not want a child process per arm).
 */
import pg from "pg";
import { CORPUS_DATABASE_URL } from "./lib.js";
import { dbNameOf, snapshotDbName } from "./snapshot-core.js";
import type { AgreementGraph } from "./graph-agreement.js";

/** The connection URL of a corpus snapshot (a sibling database). */
export function snapshotUrl(name: string): string {
  const u = new URL(CORPUS_DATABASE_URL);
  u.pathname = `/${snapshotDbName(dbNameOf(CORPUS_DATABASE_URL), name)}`;
  return u.toString();
}

function parseVector(text: string | null): number[] | null {
  if (!text) return null;
  try {
    const arr = JSON.parse(text) as unknown;
    return Array.isArray(arr) ? (arr as number[]) : null;
  } catch {
    return null;
  }
}

export async function loadAgreementGraph(label: string, url: string): Promise<AgreementGraph> {
  if (dbNameOf(url) === "episteme") throw new Error("Refusing to read the main 'episteme' database.");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const claims = await client.query<{
      id: string;
      text: string;
      created_by: string;
      importance: number;
      status: string | null;
      credence: number | null;
      embedding: string | null;
    }>(
      `SELECT c.id, c.text, c.created_by, c.importance,
              a.status, a.claim_credence AS credence,
              c.embedding::text AS embedding
         FROM claims c
         LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current
        WHERE c.state = 'active'`
    );
    const edges = await client.query<{ parent: string; child: string; rel: string }>(
      `SELECT parent_claim_id AS parent, child_claim_id AS child, relation_type AS rel
         FROM claim_relationships`
    );
    return {
      label,
      claims: claims.rows.map((r) => ({
        id: r.id,
        text: r.text,
        createdBy: r.created_by,
        importance: r.importance,
        status: r.status,
        credence: r.credence,
        embedding: parseVector(r.embedding),
      })),
      edges: edges.rows,
    };
  } finally {
    await client.end();
  }
}
