/**
 * Shared by the regression tests for the third review of the label wall
 * (review-3-*.test.ts): labels `r3-a`, `r3-b`, `r3-c` as the reviews use
 * them (`r3-a` and `r3-b` read `public`, `r3-c` reads `r3-a` and `public`,
 * `r3-a` and `r3-b` do not read each other), the kinds of reader, and a
 * cleanup that leaves the suite's database with `public` alone.
 */
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { runAtLabel, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";

export const A = "r3-a";
export const B = "r3-b";
export const C = "r3-c";
export const LABELS = [A, B, C];
export const tag = randomUUID().slice(0, 8);

export const system = <T>(fn: () => Promise<T>) =>
  withSystemClearance("A review test seeds and checks rows at every label.", fn);
export const at = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "a review test", fn);
/** A Steward's run at a label. */
export const stewardAt = <T>(label: string, fn: () => Promise<T>) =>
  runAtLabel(label, "a review test's run", () => withAgent("steward", fn));
/** A signed-in person's request, as members-only.ts enters it: a clearance and no label. */
export const asPerson = <T>(clearance: string[], fn: () => Promise<T>) => runWithUsageContext({ clearance }, fn);
export const sqlState = (err: unknown) =>
  (err as { code?: string } | null)?.code ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
export const caught = (fn: () => Promise<unknown>): Promise<unknown> => fn().then(() => null, (e: unknown) => e);

const seeded: { claims: string[]; sources: string[]; users: string[] } = { claims: [], sources: [], users: [] };

export async function wall(): Promise<void> {
  setNoContextSessionForTests(null);
  await system(async () => {
    await rawQuery(
      `INSERT INTO labels (name, description) VALUES ($1, 'One partner.'), ($2, 'Another partner.'), ($3, 'Reads the first.') ON CONFLICT (name) DO NOTHING`,
      LABELS
    );
    await rawQuery(
      `INSERT INTO label_reads (label, reads) VALUES ($1, 'public'), ($2, 'public'), ($3, $1), ($3, 'public') ON CONFLICT DO NOTHING`,
      LABELS
    );
  });
  await ensureEnforcement();
}

export async function seedNode(label: string, text: string, kind = "claim"): Promise<string> {
  const [row] = await system(() =>
    rawQuery<{ id: string }>(
      `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at, sensitivity_label)
       VALUES ($1, $2, 'done', 'complete', now(), $3) RETURNING id`,
      [`${text} (${tag} ${randomUUID().slice(0, 6)})`, kind, label]
    )
  );
  seeded.claims.push(row!.id);
  return row!.id;
}

/** A source at `label`, attached to the node by an instance at the same label. */
export async function attachSource(node: string, label: string, text = "What the document says.", stance = "affirms"): Promise<{ source: string; instance: string }> {
  return system(async () => {
    const [source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, sensitivity_label) VALUES ($1, 'A document held at a label', $2) RETURNING id`,
      [`https://review3.example/${randomUUID()}`, label]
    );
    seeded.sources.push(source!.id);
    const [instance] = await rawQuery<{ id: string }>(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance, sensitivity_label) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [node, source!.id, text, stance, label]
    );
    return { source: source!.id, instance: instance!.id };
  });
}

export async function seedUser(): Promise<string> {
  const [row] = await system(() =>
    rawQuery<{ id: string }>(`INSERT INTO contributors (display_name, external_id) VALUES ('review3 member', $1) RETURNING id`, [`review3:${randomUUID()}`])
  );
  seeded.users.push(row!.id);
  return row!.id;
}

/** A current version of a claim's judgment, written as the owner. */
export const version = (node: string, label: string, status: string, words: string, confidence = 0.9) =>
  system(() =>
    rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace, is_current, sensitivity_label) VALUES ($1, $2, $5, $3, $3, true, $4)`,
      [node, status, words, label, confidence]
    )
  );

/**
 * Remove everything at the review's labels, the nodes and sources this file
 * seeded at `public`, and the labels themselves, so that the files after
 * this one meet a database with `public` alone. Rows hang off each other,
 * so the labelled tables are gone over until a pass removes nothing.
 */
export async function unwall(extraNodes: string[] = []): Promise<void> {
  await system(async () => {
    const tables = (
      await rawQuery<{ t: string }>(
        `SELECT c.relname::text AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)`
      )
    ).map((r) => r.t);
    const nodes = [...seeded.claims, ...extraNodes];
    for (let pass = 0; pass < 6; pass++) {
      let removed = 0;
      for (const table of tables) {
        removed += (await rawQuery(`DELETE FROM "${table}" WHERE sensitivity_label = ANY($1::text[]) RETURNING 1`, [LABELS]).catch(() => [])).length;
      }
      for (const table of ["curation_requests", "audit_runs", "action_allocations", "assessment_orders", "actions", "node_messages", "audit_log", "contributions"]) {
        const column = table === "curation_requests" ? "anchor_claim_id" : table === "node_messages" ? "node_id" : "claim_id";
        if (table === "audit_runs") continue;
        removed += (await rawQuery(`DELETE FROM "${table}" WHERE ${column} = ANY($1::uuid[]) RETURNING 1`, [nodes]).catch(() => [])).length;
      }
      removed += (await rawQuery(`DELETE FROM claims WHERE id = ANY($1::uuid[]) RETURNING 1`, [nodes]).catch(() => [])).length;
      removed += (await rawQuery(`DELETE FROM sources WHERE id = ANY($1::uuid[]) RETURNING 1`, [seeded.sources]).catch(() => [])).length;
      if (removed === 0) break;
    }
    await rawQuery(`DELETE FROM audit_runs WHERE triggered_by = 'monitor_signal' AND context LIKE '%' || $1 || '%'`, [tag]).catch(() => undefined);
    await rawQuery(`DELETE FROM contributors WHERE id = ANY($1::uuid[])`, [seeded.users]).catch(() => undefined);
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [LABELS]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [LABELS]);
  }).catch((err: unknown) => console.warn("[review-3] cleanup:", err instanceof Error ? err.message : err));
}
