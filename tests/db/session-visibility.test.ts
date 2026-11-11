/**
 * Run visibility across sessions (llm/run-visibility.ts): a research report
 * that arrives in a run makes it private, a paused session keeps its run's
 * private reasons, and the run that resumes it takes them on.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.hoisted(() => {
  process.env.TRACE_LEVEL = "full";
});

import { rawQuery } from "../../src/db/client.js";
import { getUsageContext, markCurrentRunPrivate, withAgent } from "../../src/llm/usage-context.js";
import { takeArrivals } from "../../src/llm/tools/session-tools.js";
import {
  RESEARCH_REPORT_REASON,
  sessionPrivateReasons,
  suspendSession,
} from "../../src/services/session-service.js";

async function openSession(replies: unknown[] = []): Promise<string> {
  const id = randomUUID();
  await rawQuery(
    `INSERT INTO agent_sessions (id, role, status, awaiting, replies)
     VALUES ($1, 'curator', 'running', $2::jsonb, $3::jsonb)`,
    [id, JSON.stringify([{ kind: "research", ref: "r1" }]), JSON.stringify(replies)]
  );
  return id;
}

async function reasonsOf(runId: string): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    const [row] = await rawQuery<{ private_reasons: string[]; finished_at: Date | null }>(
      `SELECT private_reasons, finished_at FROM agent_runs WHERE id = $1`,
      [runId]
    );
    if (row?.finished_at) {
      await new Promise((r) => setTimeout(r, 50));
      const [again] = await rawQuery<{ private_reasons: string[] }>(
        `SELECT private_reasons FROM agent_runs WHERE id = $1`,
        [runId]
      );
      return again!.private_reasons;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run did not settle");
}

describe("run visibility across sessions", () => {
  it("makes a run private when a research report arrives in it", async () => {
    const sessionId = await openSession([
      { kind: "research", ref: "r1", text: "The two nodes cite one survey.", at: new Date().toISOString(), delivered: false },
    ]);
    const runId = await withAgent("curator", async () => {
      expect(await takeArrivals(sessionId)).toContain("Research run r1 has reported");
      return getUsageContext().runId!;
    });
    expect(await reasonsOf(runId)).toEqual([RESEARCH_REPORT_REASON]);
  });

  it("leaves a run public when what arrives is an answer from another Steward", async () => {
    const sessionId = await openSession([
      { kind: "reply", ref: "m1", text: "Yes, that subclaim is settled.", at: new Date().toISOString(), delivered: false },
    ]);
    const runId = await withAgent("curator", async () => {
      await takeArrivals(sessionId);
      return getUsageContext().runId!;
    });
    expect(await reasonsOf(runId)).toEqual([]);
  });

  it("keeps a paused run's reasons on its session, for the run that resumes it", async () => {
    const sessionId = await openSession();
    await withAgent("curator", async () => {
      markCurrentRunPrivate("tool:inspect_ledger");
      await suspendSession({
        id: sessionId,
        transcript: [{ role: "user", content: "Curate these." }] as never,
        model: "m",
        budgetLeftMicroUsd: 0,
        payer: null,
      });
    });
    const [s] = await rawQuery<{ private_reasons: string[]; status: string }>(
      `SELECT private_reasons, status FROM agent_sessions WHERE id = $1`,
      [sessionId]
    );
    expect(s!.private_reasons).toEqual(["tool:inspect_ledger"]);
    const replies = [{ kind: "research" as const, ref: "r1", text: "report", at: "", delivered: false }];
    expect(sessionPrivateReasons(s!, replies).sort()).toEqual([RESEARCH_REPORT_REASON, "tool:inspect_ledger"].sort());
    expect(sessionPrivateReasons({ private_reasons: [] }, [])).toEqual([]);
  });
});
