import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

/**
 * What the solver may write (docs/mathematics.md §7.4): the attempt's
 * notebook, its lean_checks rows, and its report; never a claim, an
 * assessment, an argument, an evaluation, a relationship, an instance, a
 * contribution, or any money table. The database client is replaced by a
 * recorder and the attempt service and meter run for real over it, so
 * every statement the run issues is seen.
 */
const db = vi.hoisted(() => ({
  writes: [] as Array<{ verb: string; table: string }>,
  reads: [] as string[],
}));

function recordSql(q: string): void {
  const m = /^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/i.exec(q);
  if (m) db.writes.push({ verb: m[1]!.toUpperCase(), table: m[2]!.toLowerCase() });
  else db.reads.push(q.replace(/\s+/g, " ").trim().slice(0, 80));
}

async function handle(q: string, params: unknown[] = []): Promise<unknown[]> {
  recordSql(q);
  if (/FROM platform_flags/.test(q)) return [];
  if (/SELECT status FROM proof_attempts/.test(q)) return [{ status: "running" }];
  if (/SELECT notebook FROM proof_attempts/.test(q)) return [{ notebook: {} }];
  if (/INSERT INTO lean_checks/.test(q)) {
    return [
      {
        id: "chk-1",
        formalization_id: params[0],
        attempt_id: params[4],
        kind: params[1],
        mode: "attempt",
        verdict: params[6],
        submission_sha256: params[2],
        submission_source: params[3],
        checks: {},
        diagnostics: [],
        truncated: false,
        resource: {},
        pin_id: params[11],
        image_digest: params[12],
        checker_version: params[13],
        cost_micro_usd: params[14],
        created_at: new Date(),
        finished_at: new Date(),
      },
    ];
  }
  if (/FROM lean_checks/.test(q) && /WHERE id = \$1 AND attempt_id = \$2/.test(q)) {
    return [
      {
        id: "chk-1",
        formalization_id: "f",
        attempt_id: "a",
        kind: "proof",
        mode: "attempt",
        verdict: "accepted",
        submission_sha256: "x",
        submission_source: "theorem proof : Statement := trivial",
        checks: {},
        diagnostics: [],
        truncated: false,
        resource: {},
        pin_id: "p",
        image_digest: "d",
        checker_version: "v",
        cost_micro_usd: 0,
        created_at: new Date(),
        finished_at: null,
      },
    ];
  }
  if (/FROM lean_checks/.test(q)) return [];
  if (/UPDATE proof_attempts/.test(q) && /RETURNING notebook/.test(q)) {
    return [{ notebook: { [String(params[1])]: String(params[2]) } }];
  }
  return [];
}

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(handle),
  withTransaction: vi.fn(async (fn: (tx: { query: typeof handle }) => Promise<unknown>) =>
    fn({ query: handle })
  ),
  getDb: () => ({
    insert: (table: unknown) => ({
      values: async () => {
        db.writes.push({ verb: "INSERT INTO", table: getTableName(table as never) });
      },
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: async () => {
          db.writes.push({ verb: "UPDATE", table: getTableName(table as never) });
        },
      }),
    }),
  }),
}));

const config = vi.hoisted(() => ({
  env: "test",
  solverModel: "claude-fable-5-1",
  solverLeanMaxChecks: 60,
  solverLeanMaxElaborations: 200,
  attemptMaxIterations: 500,
  attemptMaxWallHours: 6,
  attemptOverageFraction: 0.25,
  leanCpuHourCostMicroUsd: 200_000,
  leanCheckOverheadMicroUsd: 20_000,
  // Tracing forced on for the solver, as production runs it: the trace
  // tables are part of what the run is allowed to write.
  traceAlwaysAgents: ["math_solver"],
  traceLevel: "off",
}));
vi.mock("../../../src/config.js", () => ({ loadConfig: () => config }));

const script = vi.hoisted(() => ({
  turns: [] as Array<Array<{ name: string; input: Record<string, unknown> }>>,
}));

vi.mock("../../../src/llm/client.js", () => ({
  longRunToolLoop: vi.fn(async (options: any) => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let turns = 0;
    let last: any = null;
    const state = () => ({ turn: turns, messages: [], startedAt: 0, elapsedMs: 0, lastResult: last, usage });
    for (const tools of script.turns) {
      const v = await options.beforeTurn?.(state());
      if (v?.stop) return { result: last, turns, stopReason: "hook", hookStop: v.stop };
      turns++;
      last = {
        content: "",
        model: "claude-fable-5-1",
        usage,
        stopReason: "tool_use",
        toolUses: tools.map((t, i) => ({ id: `t${turns}-${i}`, ...t })),
        rawContent: [],
      };
      for (const tu of last.toolUses) {
        if (options.onFinalTool?.(tu.name, tu.input) != null) {
          await options.afterTurn?.(state(), last);
          return { result: last, turns, stopReason: "final_tool" };
        }
      }
      for (const tu of last.toolUses) await options.executeTool(tu.name, tu.input);
      options.reminder?.(state());
      await options.afterTurn?.(state(), last);
    }
    return { result: last, turns, stopReason: "end_turn" };
  }),
}));

import { runMathSolver } from "../../../src/llm/agents/math-solver.js";
import { runWithUsageContext, withCostMeter } from "../../../src/llm/usage-context.js";
import { FakeLeanCheckerClient } from "../../../src/services/lean-checker-fake.js";
import type { FormalizationRow } from "../../../src/services/attempt-service.js";

const FORBIDDEN_TABLES = [
  "claims",
  "assessments",
  "arguments",
  "argument_evaluations",
  "claim_relationships",
  "claim_instances",
  "contributions",
  // Money.
  "owl_ledger",
  "action_allocations",
  "budget_jobs",
  "grants",
  "regrants",
  "prize_pools",
  "prize_pool_entries",
  "bounties",
  "prize_claims",
  "prize_payouts",
  "orders",
];

const ALLOWED_TABLES = new Set([
  "proof_attempts",
  "lean_checks",
  "actions",
  "llm_usage",
  "agent_runs",
  "agent_steps",
]);

const formalization: FormalizationRow = {
  id: "f1f1f1f1-0000-4000-8000-000000000001",
  claim_id: "c1c1c1c1-0000-4000-8000-000000000001",
  version: 1,
  status: "published",
  pin_id: "mathlib-v4.33.0",
  lean_toolchain: "leanprover/lean4:v4.33.0",
  mathlib_rev: "0".repeat(40),
  mathlib_tag: "v4.33.0",
  image_digest: "sha256:fake",
  namespace: "Minerval.S0a1b2c3d_v1",
  statement_source:
    "import Mathlib\nnamespace Minerval.S0a1b2c3d_v1\ndef Statement : Prop := True\nend Minerval.S0a1b2c3d_v1",
  source_hash: "src",
  expr_hash: "expr",
  pp_type: "True",
  correspondence: "exact",
  published_at: new Date(),
  review_period_ends_at: null,
};

beforeEach(() => {
  db.writes = [];
  db.reads = [];
});

describe("the solver writes nothing to the graph or the money tables", () => {
  it("touches only the attempt, its checks, its action's heartbeat, the meter, and the trace", async () => {
    script.turns = [
      [
        { name: "notebook_write", input: { section: "plan", content: "trivial" } },
        { name: "lean_search", input: { query: "True" } },
        { name: "lean_elaborate", input: { statement: "example : True := trivial" } },
        { name: "lean_check", input: { kind: "proof", proof: "theorem proof : Statement := trivial" } },
      ],
      [
        {
          name: "report",
          input: {
            outcome: "proof",
            lean_proof: null,
            lean_check_id: "chk-1",
            informal_argument: "it is trivial",
            reduction_statement: null,
            counterexample: null,
            approaches_tried: ["trivial"],
            obstruction: "",
            what_would_help: "",
            confidence: 1,
          },
        },
      ],
    ];
    const { value } = await withCostMeter(() =>
      runWithUsageContext({ jobId: "job-1", claimId: formalization.claim_id }, () =>
        runMathSolver({
          attempt: {
            id: "a1a1a1a1-0000-4000-8000-000000000001",
            claim_id: formalization.claim_id,
            formalization_id: formalization.id,
            action_id: "ac1",
            variant: "max",
            effort: "max",
            model: "claude-fable-5-1",
            is_calibration: false,
          },
          claim: { id: formalization.claim_id, text: "True." },
          formalization,
          variant: "max",
          effort: "max",
          ceilingMicroUsd: 10_000_000,
          checker: new FakeLeanCheckerClient(),
        })
      )
    );
    // Let the fire-and-forget trace and meter inserts settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(value.status).toBe("completed");
    expect(value.outcome).toBe("proof");
    expect(value.leanCheckId).toBe("chk-1");

    const written = new Set(db.writes.map((w) => w.table));
    for (const table of FORBIDDEN_TABLES) {
      expect(written.has(table), `wrote ${table}`).toBe(false);
    }
    for (const table of written) {
      expect(ALLOWED_TABLES.has(table), `unexpected write to ${table}`).toBe(true);
    }
    // And it did write what it may: the notebook, the check row, the
    // heartbeat on the attempt and its action, and the metered rows.
    expect(written.has("proof_attempts")).toBe(true);
    expect(written.has("lean_checks")).toBe(true);
    expect(written.has("actions")).toBe(true);
    expect(written.has("llm_usage")).toBe(true);
    expect(db.writes.filter((w) => w.table === "lean_checks")).toEqual([
      { verb: "INSERT INTO", table: "lean_checks" },
    ]);
    // The action write is the heartbeat only.
    expect(db.writes.filter((w) => w.table === "actions").every((w) => w.verb === "UPDATE")).toBe(true);
  });
});
