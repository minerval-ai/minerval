import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The Audit agent's toolset with and without a domain skill (docs/
 * mathematics.md §3.4, §3.5): the Mathematics skill's audit-agent tools
 * (get_prize_claim, get_proof_attempt) join the run exactly when the
 * decisions under review name a mathematics claim, sit beside the Audit's
 * own prize tools, and dispatch through the skill-tool executor with the
 * audit-agent role.
 */
const mocks = vi.hoisted(() => ({
  loopOptions: [] as Array<Record<string, unknown>>,
  domains: [] as string[],
  skillCalls: [] as Array<{ name: string; input: Record<string, unknown>; ctx: Record<string, unknown> }>,
  auditCalls: [] as string[],
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ auditModel: "audit-model", env: "test", traceLevel: "off", promptCacheTtl: "5m" }),
}));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => {
    throw new Error("no database in this test");
  },
  rawQuery: vi.fn(async () => []),
}));

vi.mock("../../../src/llm/agents/skill-selection.js", () => ({
  domainsForAuditContext: vi.fn(async () => mocks.domains),
}));

vi.mock("../../../src/llm/tools/skill-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/llm/tools/skill-tools.js")>()),
  executeSkillTool: vi.fn(async (name: string, input: Record<string, unknown>, ctx: Record<string, unknown>) => {
    mocks.skillCalls.push({ name, input, ctx });
    return JSON.stringify({ success: true, prize_claim: { prize_claim_id: input.prize_claim_id } });
  }),
}));

vi.mock("../../../src/llm/tools/audit-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/llm/tools/audit-tools.js")>()),
  executeAuditTool: vi.fn(async (name: string) => {
    mocks.auditCalls.push(name);
    return JSON.stringify({ success: true });
  }),
}));

vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: vi.fn(async (options: Record<string, unknown>) => {
    mocks.loopOptions.push(options);
    return { content: "", toolUses: [], stopReason: "end_turn" };
  }),
}));

import { runAudit } from "../../../src/llm/agents/audit-agent.js";

type LoopOptions = {
  tools: Array<{ name: string }>;
  system: string[];
  initialMessages: Array<{ content: string }>;
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
};

async function run(domains: string[]): Promise<LoopOptions> {
  mocks.domains = domains;
  await runAudit({ auditType: "decision_audit", context: "The Claim Steward accepted prize claim pc-1", runId: "run-1" });
  return mocks.loopOptions.at(-1) as unknown as LoopOptions;
}

beforeEach(() => {
  mocks.loopOptions.length = 0;
  mocks.skillCalls.length = 0;
  mocks.auditCalls.length = 0;
});

describe("Audit toolset without a domain", () => {
  it("carries the Audit's own prize tools and no skill tools", async () => {
    const opts = await run([]);
    const names = opts.tools.map((t) => t.name);
    expect(names).toContain("get_prize_claim_record");
    expect(names).toContain("record_prize_audit_outcome");
    expect(names).toContain("withdraw_bounty_after_audit");
    expect(names).not.toContain("get_prize_claim");
    expect(names).not.toContain("get_proof_attempt");
    expect(opts.system).toHaveLength(1);
    expect(opts.initialMessages[0]!.content).not.toContain("Domain skills active");
  });
});

describe("Audit toolset with the mathematics domain", () => {
  it("adds exactly the skill's audit-agent tools after the Audit's own, and says so", async () => {
    const opts = await run(["mathematics"]);
    const names = opts.tools.map((t) => t.name);
    const own = names.indexOf("record_prize_audit_outcome");
    expect(names.slice(-2)).toEqual(["get_proof_attempt", "get_prize_claim"]);
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(names.indexOf("get_prize_claim"));
    // No Steward-only tool leaks in.
    for (const n of ["decide_prize_claim", "publish_formalization", "lean_check", "mark_problem_solved_by_platform"]) {
      expect(names).not.toContain(n);
    }
    expect(opts.system).toHaveLength(2);
    expect(opts.system[1]).toContain("# Domain skill:");
    expect(opts.initialMessages[0]!.content).toContain("Domain skills active for this run: mathematics");
    expect(opts.initialMessages[0]!.content).toContain("get_proof_attempt, get_prize_claim");
  });

  it("dispatches a skill tool through the skill executor as audit-agent, and its own tools through the audit executor", async () => {
    const opts = await run(["mathematics"]);
    const out = JSON.parse(await opts.executeTool("get_prize_claim", { prize_claim_id: "pc-1" }));
    expect(out).toMatchObject({ success: true, prize_claim: { prize_claim_id: "pc-1" } });
    expect(mocks.skillCalls).toEqual([
      {
        name: "get_prize_claim",
        input: { prize_claim_id: "pc-1" },
        ctx: { role: "audit-agent", run: { trigger: "decision_audit", context: "The Claim Steward accepted prize claim pc-1", model: "audit-model" } },
      },
    ]);
    await opts.executeTool("record_prize_audit_outcome", { prize_claim_id: "pc-1", outcome: "clear", note: "holds" });
    expect(mocks.auditCalls).toEqual(["record_prize_audit_outcome"]);
    expect(mocks.skillCalls).toHaveLength(1);
  });
});
