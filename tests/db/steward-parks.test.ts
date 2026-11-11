/**
 * Parked nodes against real Postgres (#846): a node whose Steward passes
 * failed is out of the queue and stays out until someone pays for another
 * attempt knowing that is what they buy. Its failure is published as a fixed
 * class, never the raw error text; a parent's reader sees which premises are
 * parked; and the recovery script resets the parks a maintainer names.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { rawQuery } from "../../src/db/client.js";
import { enqueueSteward } from "../../src/services/queue-service.js";
import { commissionNodePass } from "../../src/services/commission-service.js";
import { getClaimTree } from "../../src/services/tree-service.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { runGraphRead } from "../../src/services/graph-read-service.js";
import { executeNotifySteward } from "../../src/llm/tools/notify-steward.js";
import { stewardFailureSet } from "../../src/services/steward-lease.js";
import {
  classifyStewardErrorText,
  stewardErrorReasonSql,
} from "../../src/services/steward-park-reason.js";
import { parseRecoverArgs, recoverParkedStewards } from "../../scripts/recover-parked-stewards.js";
import { runReadOnlyQuery } from "../../src/services/sql-service.js";
import { loadConfig } from "../../src/config.js";
import { TEST_DATABASE_URL } from "./urls.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";

/** Raw text of the kind steward_error really holds: nothing here may be published. */
const RAW_REFUSAL = "Model claude-opus-5-5 refused the request (category: cyber) request_id=req_011CSecretRefusal";
const RAW_DB = 'permission denied for table claims (role "minerval_app_internal") at db-7.internal.example';

async function park(
  claimId: string,
  opts: { error?: string; reason?: string | null; attempts?: number; at?: string } = {}
): Promise<void> {
  await rawQuery(
    `UPDATE claims
        SET steward_state = 'error', steward_error = $2, steward_error_reason = $3,
            steward_attempts = $4, stewarded_at = $5::timestamptz
      WHERE id = $1`,
    [
      claimId,
      opts.error ?? RAW_REFUSAL,
      opts.reason === undefined ? "model_refusal" : opts.reason,
      opts.attempts ?? 3,
      opts.at ?? "2026-07-14T09:00:00Z",
    ]
  );
}

async function row(claimId: string) {
  const [r] = await rawQuery<{
    steward_state: string;
    steward_error: string | null;
    steward_error_reason: string | null;
    steward_attempts: number;
  }>(
    `SELECT steward_state, steward_error, steward_error_reason, steward_attempts FROM claims WHERE id = $1`,
    [claimId]
  );
  return r!;
}

async function edge(parent: string, child: string): Promise<void> {
  await rawQuery(
    `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
     VALUES ($1, $2, 'requires', 'the parent needs it')`,
    [parent, child]
  );
}

describe("the public class of a Steward failure", () => {
  it("classifies stored text in SQL exactly as the code does (the migration's backfill)", async () => {
    const texts = [
      "401 authentication_error: API key is invalid",
      RAW_REFUSAL,
      RAW_DB,
      'duplicate key value violates unique constraint "claims_text_key"',
      'relation "public_read.nodez" does not exist',
      "Unknown tool: frobnicate",
      "stop_reason tool_use with no tool call",
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"too long"}}',
      "request_too_large",
      "OpenRouter returned no choices",
      "boom: null reference in decomposition",
      "100% of nothing_at_all",
      "",
    ];
    const rows = await rawQuery<{ t: string; reason: string }>(
      `SELECT t, ${stewardErrorReasonSql("t")} AS reason FROM unnest($1::text[]) AS t`,
      [texts]
    );
    expect(rows).toHaveLength(texts.length);
    for (const r of rows) expect(r.reason, r.t).toBe(classifyStewardErrorText(r.t));
    // Not vacuous: the samples cover every class.
    expect(new Set(rows.map((r) => r.reason))).toEqual(
      new Set(["credentials_fault", "model_refusal", "database_fault", "tool_failure", "provider_error", "other"])
    );
  });

  it("backfills rows that failed before the column existed, as the migration does", async () => {
    const old = await seedClaim("parked before the column");
    await park(old, { error: "401 authentication_error: API key is invalid", reason: null });
    await rawQuery(
      `UPDATE claims
          SET steward_error_reason = ${stewardErrorReasonSql("steward_error")}
        WHERE steward_error IS NOT NULL AND steward_error_reason IS NULL AND id = $1`,
      [old]
    );
    expect((await row(old)).steward_error_reason).toBe("credentials_fault");
  });

  it("shows only the class in public_read.nodes, and only while the node is parked", async () => {
    const parked = await seedClaim("parked for the view");
    const failedOnce = await seedClaim("failed once, still queued");
    const unclassified = await seedClaim("parked, never classified");
    await park(parked, { error: RAW_DB, reason: "database_fault" });
    await rawQuery(
      `UPDATE claims SET steward_error = 'boom', steward_error_reason = 'other', steward_attempts = 1 WHERE id = $1`,
      [failedOnce]
    );
    await park(unclassified, { error: "boom", reason: null });

    // The same scratch login tests/db/sql-views.test.ts uses.
    const role = "minerval_sql_dbtest";
    await rawQuery(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${role} LOGIN PASSWORD 'dbtest-sql' CONNECTION LIMIT 3 IN ROLE minerval_sql;
      END IF; END $$`);
    const url = new URL(TEST_DATABASE_URL);
    url.username = role;
    url.password = "dbtest-sql";
    Object.assign(loadConfig(), { sqlAgentDatabaseUrl: url.toString() });
    const res = await runReadOnlyQuery(
      `SELECT id, steward_state, steward_park_reason FROM nodes WHERE id = ANY($1::uuid[])`,
      [[parked, failedOnce, unclassified]],
      { audience: "agent" }
    );
    const byId = new Map(res.rows.map((r) => [r[0], r]));
    expect(byId.get(parked)).toEqual([parked, "error", "database_fault"]);
    expect(byId.get(failedOnce)).toEqual([failedOnce, "pending", null]);
    expect(byId.get(unclassified)).toEqual([unclassified, "error", "other"]);
    // The raw text is not a column of the view at all.
    await expect(
      runReadOnlyQuery(`SELECT steward_error FROM nodes LIMIT 1`, [], { audience: "agent" })
    ).rejects.toThrow();
  });
});

describe("a failure that parks at once", () => {
  it("parks on the first failure when told to, and otherwise only at the cap", async () => {
    const refused = await seedClaim("refused");
    const flaky = await seedClaim("flaky");
    for (const id of [refused, flaky]) {
      await rawQuery(`UPDATE claims SET steward_state = 'running', stewarded_at = now() WHERE id = $1`, [id]);
    }
    const fail = (id: string, reason: string, parkNow: boolean) =>
      rawQuery(
        `UPDATE claims SET ${stewardFailureSet("$2", "$3", "$4", "$5::boolean")}, updated_at = now() WHERE id = $1`,
        [id, "pending", "raw text", reason, parkNow]
      );
    await fail(refused, "model_refusal", true);
    await fail(flaky, "other", false);
    expect(await row(refused)).toMatchObject({
      steward_state: "error",
      steward_error_reason: "model_refusal",
      steward_attempts: 1,
    });
    expect(await row(flaky)).toMatchObject({ steward_state: "pending", steward_error_reason: "other", steward_attempts: 1 });
  });
});

describe("a parked node and the queue", () => {
  it("stays parked under an unpaid message, which is kept for the pass someone later buys", async () => {
    const id = await seedClaim("parked, noted");
    await park(id);
    await rawQuery(`DELETE FROM actions WHERE claim_id = $1`, [id]);
    await enqueueSteward({ claimId: id, trigger: "subclaim_change", context: "A subclaim moved." });
    expect(await row(id)).toMatchObject({ steward_state: "error", steward_attempts: 3 });
    const msgs = await rawQuery<{ body: string }>(`SELECT body FROM node_messages WHERE node_id = $1`, [id]);
    expect(msgs.map((m) => m.body)).toEqual(["A subclaim moved."]);
    // Not a candidate: no ledger row was opened for it.
    const actions = await rawQuery(`SELECT id FROM actions WHERE claim_id = $1 AND status = 'open'`, [id]);
    expect(actions).toHaveLength(0);
  });

  it("tells a Steward whose unpaid note reaches a parked node that it will wait", async () => {
    const sender = await seedClaim("note sender");
    const target = await seedClaim("parked note target");
    await park(target);
    const out = JSON.parse(
      await executeNotifySteward({ role: "steward", claimId: sender }, { target_ids: [target], message: "Please look again." })
    );
    expect(out.notified[0].note).toMatch(/parked/);
    expect((await row(target)).steward_state).toBe("error");
  });

  it("returns to the queue for a commission, whose result says what the money buys", async () => {
    const funder = await seedUser("park funder");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL, dailyBudgetMicroUsd: 20 * OWL });
    const id = await seedClaim("parked, commissioned");
    await park(id, { error: RAW_REFUSAL, reason: "model_refusal", attempts: 3, at: "2026-07-14T09:00:00Z" });

    const res = await commissionNodePass({
      payer: { kind: "grant", grantId },
      claimId: id,
      budgetMicroUsd: 2 * OWL,
      brief: "Try this premise again.",
      commissionedBy: "program_officer",
    });
    expect(res).toMatchObject({
      ok: true,
      status: "commissioned",
      parked: { reason: "model_refusal", failed_passes: 3, since: "2026-07-14T09:00:00.000Z" },
    });
    const note = (res as { parked: { note: string } }).parked.note;
    expect(note).toContain("parked since 2026-07-14 after 3 failed passes: the model refused the request");
    expect(note).toContain("buys one more attempt");
    // Public wording only.
    expect(JSON.stringify(res)).not.toContain("req_011CSecretRefusal");

    // Queued, with its count kept: the next failure parks it again.
    expect(await row(id)).toMatchObject({ steward_state: "pending", steward_attempts: 3 });

    // A node that is not parked carries no such note.
    const plain = await commissionNodePass({
      payer: { kind: "grant", grantId },
      claimId: await seedClaim("never parked"),
      budgetMicroUsd: OWL,
      brief: "x",
      commissionedBy: "program_officer",
    });
    expect(plain).toMatchObject({ ok: true, status: "commissioned" });
    expect(plain).not.toHaveProperty("parked");
  });
});

describe("a parked premise, as its parent's reader sees it", () => {
  it("marks an unjudged parked subclaim in the tree and in get_claim's subclaims, with the class only", async () => {
    const parent = await seedClaim("parent of parked");
    const parkedChild = await seedClaim("parked premise");
    const waiting = await seedClaim("waiting premise");
    const assessedThenParked = await seedClaim("assessed, later parked");
    for (const c of [parkedChild, waiting, assessedThenParked]) await edge(parent, c);
    await park(parkedChild, { error: RAW_DB, reason: "database_fault", attempts: 3, at: "2026-08-10T12:00:00Z" });
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace)
       VALUES ($1, 'supported', 0.7, 'Holds.', 'trace')`,
      [assessedThenParked]
    );
    await park(assessedThenParked);

    const marker = {
      reason: "database_fault",
      reason_label: "a database fault",
      since: "2026-08-10T12:00:00.000Z",
      failed_passes: 3,
    };

    const tree = (await getClaimTree(parent, 2))!;
    const byId = new Map(tree.children.map((c) => [c.id, c]));
    expect(byId.get(parkedChild)!.steward_parked).toEqual(marker);
    expect(byId.get(waiting)).not.toHaveProperty("steward_parked");
    // It has a verdict to read: the marker is for premises with none.
    expect(byId.get(assessedThenParked)).not.toHaveProperty("steward_parked");
    expect(tree).not.toHaveProperty("steward_parked");

    // get_decomposition is that tree.
    const read = await runGraphRead("get_decomposition", { claim_id: parent });
    expect(JSON.stringify(read)).toContain('"steward_parked"');

    const view = (await getClaimView(parent, { include: ["subclaims"] }))!;
    const subs = view.subclaims as Array<Record<string, unknown>>;
    expect(subs.find((s) => s.id === parkedChild)!.steward_parked).toEqual(marker);
    expect(subs.find((s) => s.id === waiting)).not.toHaveProperty("steward_parked");
    expect(subs.find((s) => s.id === assessedThenParked)).not.toHaveProperty("steward_parked");

    for (const payload of [tree, read, view]) {
      const text = JSON.stringify(payload);
      expect(text).not.toContain("minerval_app_internal");
      expect(text).not.toContain("db-7.internal.example");
    }
  });

  it("marks the root of a tree when the root itself is parked and unjudged", async () => {
    const root = await seedClaim("parked root");
    await park(root, { reason: null, error: "boom" });
    const tree = (await getClaimTree(root, 1))!;
    expect(tree.steward_parked).toMatchObject({ reason: "other", failed_passes: 3 });
  });
});

describe("recover-parked-stewards", () => {
  async function seedParks() {
    const tag = randomUUID();
    const auth = await seedClaim("recover auth");
    const refusal = await seedClaim("recover refusal");
    const boom = await seedClaim("recover boom");
    await park(auth, { error: `401 authentication_error: API key is invalid [${tag}]`, reason: "credentials_fault" });
    await park(refusal, { error: `Model x refused the request [${tag}]`, reason: "model_refusal" });
    await park(boom, { error: `boom [${tag}]`, reason: "other" });
    return { tag, auth, refusal, boom };
  }

  it("is a dry run unless confirmed", async () => {
    const { tag, auth } = await seedParks();
    const res = await recoverParkedStewards(parseRecoverArgs(["--match", `[${tag}]`]));
    expect(res.selected).toHaveLength(3);
    expect(res.reset).toBe(0);
    expect((await row(auth)).steward_state).toBe("error");
  });

  it("resets the parks whose error contains the text, clearing error, class and attempts", async () => {
    const { tag, auth, refusal, boom } = await seedParks();
    const res = await recoverParkedStewards(
      parseRecoverArgs(["--match", `authentication_error: API key is invalid [${tag}]`, "--confirm"])
    );
    expect(res.selected.map((c) => c.id)).toEqual([auth]);
    expect(res.reset).toBe(1);
    expect(await row(auth)).toEqual({
      steward_state: "pending",
      steward_error: null,
      steward_error_reason: null,
      steward_attempts: 0,
    });
    expect((await row(refusal)).steward_state).toBe("error");
    expect((await row(boom)).steward_state).toBe("error");
  });

  it("resets explicit ids, and reports an id that is not a parked claim instead of touching it", async () => {
    const { refusal, boom } = await seedParks();
    const healthy = await seedClaim("recover healthy");
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [healthy]);
    const res = await recoverParkedStewards(parseRecoverArgs(["--ids", `${refusal},${healthy}`, "--confirm"]));
    expect(res.selected.map((c) => c.id)).toEqual([refusal]);
    expect(res.notParked).toEqual([healthy]);
    expect(res.reset).toBe(1);
    expect((await row(refusal)).steward_state).toBe("pending");
    expect((await row(healthy)).steward_state).toBe("done");
    expect((await row(boom)).steward_state).toBe("error");
  });

  it("by default recovers what the pipeline now calls transient: the credential outage's parks", async () => {
    const { auth, refusal, boom } = await seedParks();
    const res = await recoverParkedStewards(parseRecoverArgs([]));
    const ids = res.selected.map((c) => c.id);
    expect(ids).toContain(auth);
    expect(ids).not.toContain(refusal);
    expect(ids).not.toContain(boom);
  });
});
