/**
 * The label a credential works at, in the catalog (the request_label
 * migration): `work_label` on API keys and access tokens, and on the
 * consent a token is issued from.
 *
 * The column is not `sensitivity_label`, on purpose. That name marks a
 * table whose rows are held to a reader's clearance, and a key or a token
 * is the account's own. What reads the column comes with the code that
 * gives a request its label; here it is only checked that the column is
 * there, that a credential made without naming one works at `public`, and
 * that it can name only a label that exists.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedUser } from "./helpers.js";

const FOREIGN_KEY_VIOLATION = "23503";
const sqlState = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
};

describe("work_label", () => {
  it("is on keys, tokens and consents, and those tables still carry no sensitivity_label", async () => {
    const columns = await rawQuery<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT table_name::text, column_name::text, is_nullable::text, column_default::text
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('api_keys', 'oauth_tokens', 'oauth_authorization_requests')
          AND column_name IN ('work_label', 'sensitivity_label')`
    );
    const found = columns
      .map((c) => `${c.table_name}.${c.column_name} ${c.is_nullable === "NO" ? "not null" : "null"} ${c.column_default ?? ""}`.trim())
      .sort();
    expect(found).toEqual([
      "api_keys.work_label not null 'public'::text",
      "oauth_authorization_requests.work_label null",
      "oauth_tokens.work_label not null 'public'::text",
    ]);
  });

  it("is public for a key made without naming one, and can name only a label that exists", async () => {
    const userId = await seedUser("work-label");
    const [key] = await rawQuery<{ work_label: string }>(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'a key', 'epk_test', $2) RETURNING work_label`,
      [userId, `hash-${randomUUID()}`]
    );
    expect(key!.work_label).toBe("public");
    await expect(
      rawQuery(
        `INSERT INTO api_keys (user_id, name, key_prefix, key_hash, work_label) VALUES ($1, 'a key', 'epk_test', $2, 'no-such-label')`,
        [userId, `hash-${randomUUID()}`]
      )
    ).rejects.toSatisfy((err) => sqlState(err) === FOREIGN_KEY_VIOLATION);
  });
});
