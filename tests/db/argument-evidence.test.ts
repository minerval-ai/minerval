/**
 * What was arguments.evidence_urls (#541), against real SQL.
 *
 *  - A /lean-checks/<id> URL sets the argument's lean_check_id; any other
 *    URL waits in the backlog, and is never recorded as an instance.
 *  - The backlog is sent to the claim's Steward once, one message per
 *    argument, as an argument_evidence_backfill.
 *  - PATCH /claims/:id still takes evidence_urls and does the same.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { addArgument } from "../../src/services/argument-service.js";
import {
  attachArgumentEvidence,
  leanCheckIdFromUrl,
  sendArgumentEvidenceBacklog,
} from "../../src/services/argument-evidence-service.js";

describe("argument evidence", () => {
  it("reads a Lean check id from a relative or absolute URL", () => {
    const id = randomUUID();
    expect(leanCheckIdFromUrl(`/lean-checks/${id}`)).toBe(id);
    expect(leanCheckIdFromUrl(`https://api.minerval.ai/lean-checks/${id.toUpperCase()}/`)).toBe(id);
    expect(leanCheckIdFromUrl("https://example.org/paper")).toBeNull();
  });

  it("queues source URLs for the Steward, sends them once, and records no instance", async () => {
    const claimId = await seedClaim("evidence");
    const argument = await addArgument({ claimId, stance: "for", name: "From the paper", content: "Because." });
    const missingCheck = `/lean-checks/${randomUUID()}`;
    const out = await attachArgumentEvidence(argument.id, [
      "https://example.org/paper",
      "https://example.org/paper",
      missingCheck,
    ]);
    expect(out).toEqual({ leanCheckId: null, queued: ["https://example.org/paper", "https://example.org/paper"], ignored: [missingCheck] });
    const [backlog] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM argument_evidence_backlog WHERE argument_id = $1`,
      [argument.id]
    );
    expect(backlog!.n).toBe(1);

    const sent = await sendArgumentEvidenceBacklog({ argumentId: argument.id });
    expect(sent).toEqual([{ claimId, argumentId: argument.id, urls: ["https://example.org/paper"] }]);
    const [claim] = await rawQuery<{ steward_state: string; steward_trigger: string }>(
      `SELECT steward_state, steward_trigger FROM claims WHERE id = $1`,
      [claimId]
    );
    expect(claim).toMatchObject({ steward_state: "pending", steward_trigger: "argument_evidence_backfill" });
    expect(await sendArgumentEvidenceBacklog({ argumentId: argument.id })).toEqual([]);

    const [instances] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM argument_instances WHERE argument_id = $1`,
      [argument.id]
    );
    expect(instances!.n).toBe(0);
  });

  it("the old column is gone", async () => {
    const cols = await rawQuery<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'arguments' AND column_name IN ('evidence_urls', 'lean_check_id')`
    );
    expect(cols.map((c) => c.column_name)).toEqual(["lean_check_id"]);
  });
});
