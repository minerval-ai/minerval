/**
 * Sessions that pause and resume (session-service.ts), against real
 * Postgres: research commissioned from a Steward's session runs on the
 * ledger, and its report returns into the paused session, which a
 * commissioned pass then resumes with its transcript; an answer arriving
 * while the run still works is shown in its next tool result; an answer
 * whose session expired goes to the node's inbox instead.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const researcher = vi.hoisted(() => {
  process.env.RESEARCHER_ENABLED = "true";
  return { report: { answer: "The registry lists a different primary outcome." } as Record<string, unknown> | null, billed: 300_000 };
});

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));

vi.mock("../../src/llm/agents/researcher.js", async (orig) => {
  const real = await orig<typeof import("../../src/llm/agents/researcher.js")>();
  const { getUsageContext } = await import("../../src/llm/usage-context.js");
  return {
    ...real,
    runResearcher: vi.fn(async () => {
      const meter = getUsageContext().meter;
      if (meter) meter.billedMicroUsd += researcher.billed;
      return { status: "completed", report: researcher.report, turns: 3, stopReason: "report", servedModels: [], toolNames: [], error: null };
    }),
  };
});

import { rawQuery } from "../../src/db/client.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import { runWithUsageContext } from "../../src/llm/usage-context.js";
import { commissionResearch } from "../../src/services/research-commission-service.js";
import {
  deliverReply,
  registerAwait,
  resumeMessages,
  suspendSession,
  sweepSessions,
  takeLiveReplies,
  takeReadySession,
} from "../../src/services/session-service.js";
import { answerMessages, postMessage } from "../../src/services/inbox-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { processNextEngineAction } from "../../src/workers/engine-executor.js";

beforeAll(async () => {
  await rawQuery(`UPDATE grants SET status = 'completed' WHERE is_platform = true OR policy IN ('general', 'governance')`);
  resetAllocationPolicyCache();
});

async function node(label: string): Promise<string> {
  const id = await seedClaim(label);
  await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [id]);
  return id;
}

async function mandate(): Promise<string> {
  const { grantId } = await seedGrantWithJob({ funderId: await seedUser("session-funder"), budgetMicroUsd: 50 * OWL });
  await rawQuery(`UPDATE grants SET status = 'active', daily_budget_micro_usd = 0 WHERE id = $1`, [grantId]);
  return grantId;
}

const session = (nodeId: string) => ({ id: randomUUID(), role: "steward", nodeId });

async function sessionRow(id: string) {
  const [s] = await rawQuery<{ status: string; replies: Array<{ text: string; delivered: boolean }>; transcript: unknown }>(
    `SELECT status, replies, transcript FROM agent_sessions WHERE id = $1`,
    [id]
  );
  return s ?? null;
}

describe("research returning into a paused session", () => {
  it("runs on the ledger, returns its report to the session, and commissions the pass that resumes it", async () => {
    const grantId = await mandate();
    const claimId = await node("session research");
    const s = session(claimId);
    const commissioned = await runWithUsageContext({ session: s }, () =>
      commissionResearch({
        payer: { kind: "grant", grantId },
        nodeId: claimId,
        task: "Find the trial's registered primary outcome and compare it with the reported one.",
        budgetMicroUsd: 2 * OWL,
        tier: "standard",
        requestedBy: "claim_steward",
        wait: true,
      })
    );
    expect(commissioned).toMatchObject({ ok: true, waits: true });
    const runId = (commissioned as { runId: string }).runId;

    // The run ends its turn waiting: the session pauses with its transcript.
    const status = await suspendSession({
      id: s.id,
      transcript: [
        { role: "user", content: "Steward this claim." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private", signature: "x" },
            { type: "text", text: "I commissioned research and will wait for it." },
          ],
        },
      ] as never,
      model: "test-model",
      budgetLeftMicroUsd: OWL,
      payer: { kind: "grant", grantId },
    });
    expect(status).toBe("waiting");
    const paused = await sessionRow(s.id);
    // Thinking blocks are not kept: they belong to the turn that made them.
    expect(JSON.stringify(paused!.transcript)).not.toContain("private");

    // Only the research row runs here.
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE status = 'open' AND exclusion_group <> $1`, [`research:${runId}`]);
    const ran = await processNextEngineAction();
    expect(ran).toMatchObject({ status: "processed", kind: "research" });

    const ready = await sessionRow(s.id);
    expect(ready!.status).toBe("ready");
    expect(ready!.replies).toHaveLength(1);
    expect(ready!.replies[0]!.text).toContain("The registry lists a different primary outcome.");

    // The research settled: it spent 0.3 of its 2 owls, the rest came back.
    const [research] = await rawQuery<{ spent: string; released: boolean }>(
      `SELECT spent_micro_usd AS spent, released_at IS NOT NULL AS released FROM action_allocations WHERE exclusion_group = $1`,
      [`research:${runId}`]
    );
    expect(Number(research!.spent)).toBe(300_000);
    expect(research!.released).toBe(true);

    // The resumption is a pass on the node, paid by the same mandate at what the run had left.
    const [resume] = await rawQuery<{ amount: string; grant_id: string }>(
      `SELECT amount_micro_usd AS amount, grant_id FROM action_allocations
        WHERE claim_id = $1 AND commissioned_by = 'session_resume' AND released_at IS NULL`,
      [claimId]
    );
    expect(resume).toMatchObject({ grant_id: grantId });
    expect(Number(resume!.amount)).toBe(OWL);

    // The pass takes the session and continues its conversation with the report.
    const taken = await takeReadySession(claimId, "steward");
    expect(taken?.session.id).toBe(s.id);
    const messages = await resumeMessages(taken!.session, taken!.replies, {});
    expect(messages).toHaveLength(3);
    const last = JSON.stringify(messages[2]);
    expect(last).toContain("Your session resumes");
    expect(last).toContain("The registry lists a different primary outcome.");
    expect((await sessionRow(s.id))!.status).toBe("running");
    // Nothing waits any more: ending this pass closes the session.
    expect(
      await suspendSession({ id: s.id, transcript: messages as never, model: "m", budgetLeftMicroUsd: 0, payer: null })
    ).toBe("closed");
  });

  it("sends the report to the node's inbox when no session waits for it", async () => {
    const grantId = await mandate();
    const claimId = await node("inbox research");
    const res = await commissionResearch({
      payer: { kind: "grant", grantId },
      nodeId: claimId,
      task: "Check whether the dataset the claim cites was later corrected or withdrawn.",
      budgetMicroUsd: OWL,
      tier: "cheap",
      requestedBy: "claim_steward",
      wait: true,
    });
    expect(res).toMatchObject({ ok: true, waits: false });
    await rawQuery(`UPDATE actions SET status = 'cancelled' WHERE status = 'open' AND exclusion_group <> $1`, [
      `research:${(res as { runId: string }).runId}`,
    ]);
    await processNextEngineAction();
    const [m] = await rawQuery<{ trigger: string; sender_kind: string; body: string }>(
      `SELECT trigger, sender_kind, body FROM node_messages WHERE node_id = $1`,
      [claimId]
    );
    expect(m).toMatchObject({ trigger: "research_report", sender_kind: "researcher" });
    expect(m!.body).toContain("The registry lists a different primary outcome.");
  });
});

describe("answers between Stewards", () => {
  it("returns an answer into the asking session while its run still works, shown once", async () => {
    const asker = await node("asker");
    const answerer = await node("answerer");
    const s = session(asker);
    const messageId = (await postMessage({
      nodeId: answerer,
      trigger: "steward_note",
      body: "Does your estimate still assume the 2019 figure?",
      sender: { kind: "steward", nodeId: asker },
    }))!;
    await runWithUsageContext({ session: s }, () => registerAwait("reply", messageId));
    await rawQuery(`UPDATE node_messages SET reply_to_session = $2 WHERE id = $1`, [messageId, s.id]);

    await answerMessages(answerer, new Map([["m1", messageId]]), [
      { message: "m1", outcome: "changed", note: "No: I moved to the 2023 revision." },
    ]);
    const live = await takeLiveReplies(s.id);
    expect(live).toHaveLength(1);
    expect(live[0]!.text).toContain("I moved to the 2023 revision.");
    expect(await takeLiveReplies(s.id)).toHaveLength(0);
    // It went to the session, not to the asker's inbox.
    const inbox = await rawQuery(`SELECT 1 FROM node_messages WHERE node_id = $1 AND trigger = 'message_reply'`, [asker]);
    expect(inbox).toHaveLength(0);
  });

  it("sends an answer whose session expired to the asker's inbox", async () => {
    const asker = await node("expired asker");
    const s = session(asker);
    await runWithUsageContext({ session: s }, () => registerAwait("reply", randomUUID()));
    await suspendSession({ id: s.id, transcript: [{ role: "user", content: "x" }] as never, model: "m", budgetLeftMicroUsd: 0, payer: null });
    await rawQuery(`UPDATE agent_sessions SET deadline = now() - interval '1 hour' WHERE id = $1`, [s.id]);
    expect(await sweepSessions()).toBeGreaterThanOrEqual(1);
    expect((await sessionRow(s.id))!.status).toBe("expired");
    const routed = await deliverReply({
      sessionId: s.id,
      kind: "reply",
      ref: randomUUID(),
      text: "A late answer.",
      fallback: { nodeId: asker, trigger: "message_reply", sender: { kind: "system" } },
    });
    expect(routed).toBe("inbox");
    const [m] = await rawQuery<{ body: string }>(`SELECT body FROM node_messages WHERE node_id = $1`, [asker]);
    expect(m!.body).toBe("A late answer.");
  });
});
