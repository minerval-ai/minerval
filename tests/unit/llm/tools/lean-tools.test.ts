import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The Lean tool executors (docs/mathematics.md §6.1, §6.2, §6.3) over the
 * checker fake: gating on a configured checker, graceful degradation when
 * the checker is unreachable, a timeout as a verdict rather than an
 * exception, dedup by submission hash, the metering row on every call, and
 * publish_formalization's refusal of a statement that does not elaborate
 * plus its two-pass publication.
 */

const CLAIM_ID = "9f2a1b3c-0000-4000-8000-000000000001";
const FORMALIZATION_ID = "f0000000-0000-4000-8000-000000000001";
const RUN_ID = "a0000000-0000-4000-8000-00000000000a";

const mocks = vi.hoisted(() => ({
  config: {
    env: "test",
    leanCheckerUrl: "http://lean-checker.test",
    leanCheckerToken: "",
    leanCpuHourCostMicroUsd: 200_000,
    leanCheckOverheadMicroUsd: 20_000,
    formalizationReviewPeriodDays: 14,
    publicApiBaseUrl: "http://localhost:3000",
  },
  metered: [] as Array<Record<string, unknown>>,
  rawQuery: vi.fn(async (_q: string, _p?: unknown[]) => [] as unknown[]),
  // The formalization service, in memory.
  formalizations: new Map<string, Record<string, unknown>>(),
  checks: [] as Array<Record<string, unknown>>,
  stored: [] as Array<Record<string, unknown>>,
  published: [] as Array<Record<string, unknown>>,
  returned: [] as Array<Record<string, unknown>>,
  nextVersion: 1,
}));

vi.mock("../../../../src/config.js", () => ({ loadConfig: () => mocks.config }));

vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: mocks.rawQuery,
  withTransaction: vi.fn(),
  getDb: () => {
    throw new Error("no database in this test");
  },
}));

vi.mock("../../../../src/services/usage-service.js", () => ({
  meterExternalUsage: vi.fn(async (usage: Record<string, unknown>) => {
    mocks.metered.push(usage);
  }),
}));

vi.mock("../../../../src/services/formalization-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/services/formalization-service.js")>();
  return {
    ...actual,
    getFormalizationById: vi.fn(async (id: string) => mocks.formalizations.get(id) ?? null),
    nextFormalizationVersion: vi.fn(async () => mocks.nextVersion),
    findLeanCheck: vi.fn(async (key: Record<string, unknown>) =>
      mocks.checks.find(
        (c) =>
          c.formalization_id === key.formalizationId &&
          c.submission_sha256 === key.submissionSha256 &&
          c.checker_version === key.checkerVersion &&
          c.mode === key.mode
      ) ?? null
    ),
    recordLeanCheck: vi.fn(async (input: { formalizationId: string; record: Record<string, unknown>; submissionSource: string; submittedBy: string; attemptId?: string | null; runId?: string | null }) => {
      const r = input.record;
      const existing = mocks.checks.find(
        (c) =>
          c.formalization_id === input.formalizationId &&
          c.submission_sha256 === r.submission_sha256 &&
          c.checker_version === r.checker_version &&
          c.mode === r.mode
      );
      const row = {
        ...(existing ?? { id: `lc-${mocks.checks.length + 1}`, created_at: new Date() }),
        formalization_id: input.formalizationId,
        mode: r.mode,
        kind: r.kind,
        submission_sha256: r.submission_sha256,
        submission_source: input.submissionSource,
        submitted_by: input.submittedBy,
        attempt_id: input.attemptId ?? null,
        run_id: input.runId ?? null,
        verdict: r.verdict ?? "error",
        checks: r.checks,
        pin_id: r.pin_id,
        checker_version: r.checker_version,
        finished_at: r.finished_at ? new Date(r.finished_at as string) : null,
        cost_micro_usd: 0,
      };
      if (!existing) mocks.checks.push(row);
      else Object.assign(existing, row);
      return row;
    }),
    storeElaboratedFormalization: vi.fn(async (input: Record<string, unknown>) => {
      const e = input.elaboration as Record<string, unknown>;
      const row = {
        id: FORMALIZATION_ID,
        claim_id: input.claimId,
        version: input.version,
        status: input.status ?? "draft",
        namespace: e.namespace,
        pin_id: (e.pin as { pin_id: string }).pin_id,
        statement_source: input.statementSource,
        source_hash: e.source_hash,
        expr_hash: e.expr_hash,
        pp_type: e.pp_type,
        witness_present: e.witness_present,
        correspondence: input.correspondence,
        review_notes: input.reviewNotes,
        own_definitions: (input as { ownDefinitions?: boolean }).ownDefinitions === true,
        authored_by: input.authoredBy,
        model: input.model,
        created_by_run_id: input.runId,
        published_at: null,
        review_period_ends_at: null,
        lean_toolchain: "leanprover/lean4:v4.33.0",
        mathlib_rev: "0",
        mathlib_tag: null,
      };
      mocks.stored.push(row);
      mocks.formalizations.set(row.id, row);
      return row;
    }),
    publishFormalization: vi.fn(async (id: string, opts: Record<string, unknown>) => {
      const row = mocks.formalizations.get(id)!;
      const published = {
        ...row,
        status: "published",
        published_at: new Date("2026-09-03T00:00:00Z"),
        review_period_ends_at: new Date("2026-09-17T00:00:00Z"),
      };
      mocks.formalizations.set(id, published);
      mocks.published.push({ id, ...opts });
      return { published, retired: [] };
    }),
    returnFormalizationToDraft: vi.fn(async (id: string, opts: Record<string, unknown>) => {
      const row = { ...mocks.formalizations.get(id)!, status: "draft" };
      mocks.formalizations.set(id, row);
      mocks.returned.push({ id, ...opts });
      return row;
    }),
  };
});

import {
  FakeLeanCheckerClient,
  FAKE_PIN,
} from "../../../../src/services/lean-checker-fake.js";
import {
  LeanCheckerUnavailable,
  setLeanCheckerClientForTests,
  type LeanCheckerClient,
} from "../../../../src/services/lean-checker-client.js";
import {
  LEAN_TOOL_NAMES,
  executeLeanTool,
  leanCheckPolling,
  registerLeanTools,
} from "../../../../src/llm/tools/lean-tools.js";
import { runWithUsageContext } from "../../../../src/llm/usage-context.js";
import type { SkillToolContext } from "../../../../src/llm/tools/skill-tools.js";

const STATEMENT = `import Mathlib
set_option autoImplicit false
namespace Minerval.S9f2a1b3c_v1
/-- Statement 1 of claim 9f2a1b3c. The canonical form is in the correspondence note. -/
def Statement : Prop :=
  ∀ n : ℕ, 2 < n → ¬ ∃ a b c : ℕ, 0 < a ∧ 0 < b ∧ 0 < c ∧ a ^ n + b ^ n = c ^ n
/-- Witness that the hypotheses are satisfiable. -/
example : ∃ n : ℕ, 2 < n := ⟨3, by norm_num⟩
end Minerval.S9f2a1b3c_v1
`;

const PROOF = `theorem Minerval.S9f2a1b3c_v1.proof : Minerval.S9f2a1b3c_v1.Statement := by
  sorry_free_proof`;

const steward: SkillToolContext = {
  role: "claim-steward",
  claimId: CLAIM_ID,
  run: { trigger: "steward_reassessment", model: "strong-model" },
};

let fake: FakeLeanCheckerClient;

function publishedFormalization() {
  return {
    id: FORMALIZATION_ID,
    claim_id: CLAIM_ID,
    version: 1,
    status: "published",
    namespace: "Minerval.S9f2a1b3c_v1",
    pin_id: FAKE_PIN.pin_id,
    statement_source: STATEMENT,
    source_hash: "src",
    expr_hash: "expr",
    pp_type: "…",
  };
}

beforeEach(() => {
  fake = new FakeLeanCheckerClient();
  setLeanCheckerClientForTests(fake);
  mocks.config.leanCheckerUrl = "http://lean-checker.test";
  mocks.metered.length = 0;
  mocks.rawQuery.mockReset();
  mocks.rawQuery.mockImplementation(async () => []);
  mocks.formalizations.clear();
  mocks.checks.length = 0;
  mocks.stored.length = 0;
  mocks.published.length = 0;
  mocks.returned.length = 0;
  mocks.nextVersion = 1;
  leanCheckPolling.pollMs = 0;
  leanCheckPolling.timeoutMs = 20 * 60_000;
});

afterEach(() => {
  setLeanCheckerClientForTests(null);
});

describe("registration", () => {
  it("registers exactly the four tools the skill declares", () => {
    const registered: string[] = [];
    registerLeanTools((name) => registered.push(name));
    expect(registered).toEqual([...LEAN_TOOL_NAMES]);
    expect([...LEAN_TOOL_NAMES]).toEqual([
      "lean_search",
      "lean_elaborate",
      "lean_check",
      "publish_formalization",
    ]);
  });
});

describe("gating on a configured checker", () => {
  it("answers that the tools are not configured when no checker is set, without dialing anything", async () => {
    setLeanCheckerClientForTests(null);
    mocks.config.leanCheckerUrl = "";
    for (const name of LEAN_TOOL_NAMES) {
      const out = JSON.parse(await executeLeanTool(name, { query: "x" }, steward));
      expect(out).toEqual({
        success: false,
        message: "Lean tools are not configured in this deployment.",
      });
    }
    expect(mocks.metered).toEqual([]);
  });
});

describe("degradation when the checker is unreachable", () => {
  const down: LeanCheckerClient = {
    health: async () => {
      throw new LeanCheckerUnavailable("checker unreachable at http://lean-checker.test/health");
    },
    pins: async () => {
      throw new LeanCheckerUnavailable("checker unreachable at http://lean-checker.test/v1/pins");
    },
    elaborate: async () => {
      throw new LeanCheckerUnavailable("checker unreachable at http://lean-checker.test/v1/elaborate");
    },
    scratch: async () => {
      throw new LeanCheckerUnavailable("down");
    },
    search: async () => {
      throw new LeanCheckerUnavailable("checker unreachable at http://lean-checker.test/v1/search");
    },
    submitCheck: async () => {
      throw new LeanCheckerUnavailable("checker unreachable at http://lean-checker.test/v1/check");
    },
    getCheck: async () => {
      throw new LeanCheckerUnavailable("down");
    },
  };

  it("returns a structured result telling the Steward to assess on the informal evidence", async () => {
    setLeanCheckerClientForTests(down);
    mocks.formalizations.set(FORMALIZATION_ID, publishedFormalization());
    const search = JSON.parse(await executeLeanTool("lean_search", { query: "Nat.Prime" }, steward));
    const elaborate = JSON.parse(await executeLeanTool("lean_elaborate", { statement: STATEMENT }, steward));
    const check = JSON.parse(
      await executeLeanTool("lean_check", { formalization_id: FORMALIZATION_ID, kind: "proof", proof: PROOF }, steward)
    );
    for (const out of [search, elaborate, check]) {
      expect(out.success).toBe(false);
      expect(out.unavailable).toBe(true);
      expect(out.message).toMatch(/Lean checker is unavailable/);
      expect(out.message).toMatch(/formal verification was unavailable/);
    }
  });
});

describe("lean_search and lean_elaborate", () => {
  it("returns hits with the pin note and meters the call", async () => {
    fake.searchHits = [{ name: "Nat.Prime", type: "ℕ → Prop", module: "Mathlib.Data.Nat.Prime.Defs" }];
    const out = JSON.parse(await executeLeanTool("lean_search", { query: "Nat.Prime", limit: 5 }, steward));
    expect(out.success).toBe(true);
    expect(out.hits).toHaveLength(1);
    expect(out.note).toMatch(/lean_elaborate/);
    expect(mocks.metered).toHaveLength(1);
    expect(mocks.metered[0]).toMatchObject({
      provider: "lean",
      model: `lean-checker/${FAKE_PIN.pin_id}`,
      unitKind: "wall_ms",
    });
  });

  it("returns the elaborated form with hashes, and errors with positions when it fails", async () => {
    const ok = JSON.parse(await executeLeanTool("lean_elaborate", { statement: STATEMENT }, steward));
    expect(ok.success).toBe(true);
    expect(ok.namespace).toBe("Minerval.S9f2a1b3c_v1");
    expect(ok.expr_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.witness_present).toBe(true);

    fake.elaborateErrors = [{ message: "unknown identifier 'Nat.Prim'", line: 6, column: 12 }];
    const bad = JSON.parse(await executeLeanTool("lean_elaborate", { statement: STATEMENT }, steward));
    expect(bad.success).toBe(false);
    expect(bad.errors).toEqual([{ message: "unknown identifier 'Nat.Prim'", line: 6, column: 12 }]);
    // Both calls cost real money at the checker's wall time.
    expect(mocks.metered).toHaveLength(2);
    expect(mocks.metered[0]).toMatchObject({ units: 1500, unitKind: "wall_ms" });
    expect(mocks.metered[0]!.costMicroUsd).toBe(Math.round(20_000 + (200_000 * 1500) / 3_600_000));
  });
});

describe("lean_check", () => {
  beforeEach(() => {
    mocks.formalizations.set(FORMALIZATION_ID, publishedFormalization());
  });

  it("submits in steward mode, polls to the verdict, records the row, and meters the check", async () => {
    fake.script(PROOF, { verdict: "accepted", polls: 2, wall_ms: 30_000 });
    const out = await runWithUsageContext({ runId: RUN_ID }, () =>
      executeLeanTool("lean_check", { formalization_id: FORMALIZATION_ID, kind: "proof", proof: PROOF }, steward)
    );
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.verdict).toBe("accepted");
    expect(parsed.summary).toBe("accepted: every gate passed");
    expect(parsed.lean_check_id).toBe("lc-1");
    expect(fake.submissions).toHaveLength(1);
    expect(fake.submissions[0]).toMatchObject({ mode: "steward", kind: "proof", replay: "module" });
    expect(fake.submissions[0]!.statement_source).toBe(STATEMENT);
    expect(mocks.checks).toHaveLength(1);
    expect(mocks.checks[0]).toMatchObject({
      formalization_id: FORMALIZATION_ID,
      mode: "steward",
      submitted_by: "claim_steward",
      run_id: RUN_ID,
      verdict: "accepted",
    });
    expect(mocks.metered).toHaveLength(1);
    expect(mocks.metered[0]).toMatchObject({
      provider: "lean",
      model: `lean-checker/${FAKE_PIN.pin_id}`,
      units: 30_000,
      unitKind: "wall_ms",
      costMicroUsd: Math.round(20_000 + (200_000 * 30_000) / 3_600_000),
    });
  });

  it("returns the stored row for an identical submission unless force is set", async () => {
    fake.script(PROOF, { verdict: "rejected", failed_gate: "axioms" });
    const args = { formalization_id: FORMALIZATION_ID, kind: "proof", proof: PROOF };
    const first = JSON.parse(await executeLeanTool("lean_check", args, steward));
    expect(first.verdict).toBe("rejected");
    expect(first.summary).toMatch(/rejected at the axioms gate/);

    const again = JSON.parse(await executeLeanTool("lean_check", args, steward));
    expect(again.deduplicated).toBe(true);
    expect(again.lean_check_id).toBe(first.lean_check_id);
    expect(again.verdict).toBe("rejected");
    expect(again.message).toMatch(/force: true/);
    // Nothing was submitted or metered the second time.
    expect(fake.submissions).toHaveLength(1);
    expect(mocks.metered).toHaveLength(1);

    const forced = JSON.parse(await executeLeanTool("lean_check", { ...args, force: true }, steward));
    expect(forced.deduplicated).toBe(false);
    expect(fake.submissions).toHaveLength(2);
    expect(fake.submissions[1]!.force).toBe(true);
    expect(mocks.checks).toHaveLength(1);
  });

  it("treats a check that does not finish in time as a verdict of error, not an exception", async () => {
    fake.script(PROOF, { verdict: "accepted", polls: 50 });
    leanCheckPolling.timeoutMs = -1;
    const out = JSON.parse(
      await executeLeanTool("lean_check", { formalization_id: FORMALIZATION_ID, kind: "proof", proof: PROOF }, steward)
    );
    expect(out.success).toBe(true);
    expect(out.verdict).toBe("error");
    expect(out.lean_check_id).toBeNull();
    expect(out.check_id).toBe("chk_1");
    expect(out.message).toMatch(/no evidence/);
    // No row: an error verdict must not be served as "stored" next time.
    expect(mocks.checks).toHaveLength(0);
  });

  it("re-checks an existing lean_checks row or a solver attempt's artifact without the text", async () => {
    mocks.rawQuery.mockImplementation(async (q: string, params?: unknown[]) => {
      if (q.includes("FROM lean_checks WHERE id = $1")) {
        return [{ submission_source: PROOF, kind: "proof", formalization_id: FORMALIZATION_ID, attempt_id: null }];
      }
      if (q.includes("FROM proof_attempts WHERE id = $1")) {
        return params?.[0] === "att-1"
          ? [{ lean_proof: PROOF, formalization_id: FORMALIZATION_ID, outcome: "proof" }]
          : [{ lean_proof: null, formalization_id: FORMALIZATION_ID, outcome: "negative" }];
      }
      return [];
    });
    fake.script(PROOF, { verdict: "accepted" });
    const byRow = JSON.parse(
      await executeLeanTool(
        "lean_check",
        { formalization_id: FORMALIZATION_ID, kind: "proof", lean_check_id: "lc-old", replay: "fresh" },
        steward
      )
    );
    expect(byRow.verdict).toBe("accepted");
    expect(fake.submissions[0]).toMatchObject({ replay: "fresh", submission_source: PROOF });

    const byAttempt = JSON.parse(
      await executeLeanTool(
        "lean_check",
        { formalization_id: FORMALIZATION_ID, kind: "proof", attempt_id: "att-1", force: true },
        steward
      )
    );
    expect(byAttempt.verdict).toBe("accepted");
    expect(mocks.checks.at(-1)).toMatchObject({ attempt_id: "att-1" });

    const noArtifact = JSON.parse(
      await executeLeanTool(
        "lean_check",
        { formalization_id: FORMALIZATION_ID, kind: "proof", attempt_id: "att-2" },
        steward
      )
    );
    expect(noArtifact.success).toBe(false);
    expect(noArtifact.message).toMatch(/no Lean artifact/);
  });

  it("refuses an unknown formalization or one that belongs to another claim", async () => {
    const missing = JSON.parse(
      await executeLeanTool("lean_check", { formalization_id: "nope", kind: "proof", proof: PROOF }, steward)
    );
    expect(missing.success).toBe(false);
    const other = JSON.parse(
      await executeLeanTool(
        "lean_check",
        { formalization_id: FORMALIZATION_ID, kind: "proof", proof: PROOF },
        { ...steward, claimId: "0f000000-0000-4000-8000-000000000009" }
      )
    );
    expect(other.success).toBe(false);
    expect(other.message).toMatch(/not the claim this run serves/);
    expect(fake.submissions).toHaveLength(0);
  });
});

describe("publish_formalization", () => {
  const base = {
    claim_id: CLAIM_ID,
    statement_source: STATEMENT,
    correspondence: "The statement is Fermat's last theorem over the naturals; exponents at most two are excluded by hypothesis.",
    review_notes: "Checked: no aliasing, hypotheses satisfiable (witness n = 3), Mathlib's ℕ exponentiation.",
  };

  beforeEach(() => {
    mocks.rawQuery.mockImplementation(async (q: string) =>
      q.includes("FROM claims WHERE id = $1") ? [{ id: CLAIM_ID, state: "active" }] : []
    );
  });

  it("refuses a statement that does not elaborate and records nothing", async () => {
    fake.elaborateErrors = [{ message: "type mismatch", line: 6, column: 2 }];
    const out = JSON.parse(await executeLeanTool("publish_formalization", base, steward));
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/does not elaborate/);
    expect(out.errors).toHaveLength(1);
    expect(mocks.stored).toHaveLength(0);
    // The elaboration attempt still cost money.
    expect(mocks.metered).toHaveLength(1);
  });

  it("re-elaborates server-side, stores the hashes and pin from that elaboration, and writes reviewed", async () => {
    mocks.nextVersion = 2;
    const draft = base.statement_source.replace(/_v1/g, "_v7").replace(
      "/-- Statement 1 of claim 9f2a1b3c. The canonical form is in the correspondence note. -/",
      "/-- Every even number is the sum of two primes -/"
    );
    const out = await runWithUsageContext({ runId: RUN_ID }, () =>
      executeLeanTool("publish_formalization", { ...base, statement_source: draft }, steward)
    );
    const parsed = JSON.parse(out);
    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("reviewed");
    expect(parsed.version).toBe(2);
    expect(parsed.namespace).toBe("Minerval.S9f2a1b3c_v2");
    // The stored file is the server's assembly: the assigned namespace and
    // the fixed docstring, never the author's prose.
    expect(mocks.stored).toHaveLength(1);
    const stored = mocks.stored[0]!;
    expect(stored.statement_source).toContain("namespace Minerval.S9f2a1b3c_v2");
    expect(stored.statement_source).toContain(
      "/-- Statement 2 of claim 9f2a1b3c. The canonical form is in the correspondence note. -/"
    );
    expect(stored.statement_source).not.toContain("Every even number");
    expect(fake.elaborations).toEqual([stored.statement_source]);
    // The hashes come from the checker's elaboration of that file.
    expect(stored.expr_hash).toBe(parsed.expr_hash);
    expect(stored.source_hash).toBe(FakeLeanCheckerClient.sha256(`${FAKE_PIN.pin_id}\n${stored.statement_source}`));
    expect(stored.pin_id).toBe(FAKE_PIN.pin_id);
    expect(stored).toMatchObject({
      status: "reviewed",
      authored_by: "claim_steward",
      model: "strong-model",
      created_by_run_id: RUN_ID,
      correspondence: base.correspondence,
      review_notes: base.review_notes,
    });
    expect(parsed.message).toMatch(/fresh context/);
  });

  it("requires the correspondence note and the review notes", async () => {
    const noNote = JSON.parse(
      await executeLeanTool("publish_formalization", { ...base, correspondence: " " }, steward)
    );
    expect(noNote.success).toBe(false);
    expect(noNote.message).toMatch(/correspondence note is required/);
    expect(fake.elaborations).toHaveLength(0);
  });

  it("refuses own_definitions without a correspondence note, and records the flag with one", async () => {
    const refused = JSON.parse(
      await executeLeanTool(
        "publish_formalization",
        { ...base, correspondence: "", own_definitions: true },
        steward
      )
    );
    expect(refused.success).toBe(false);
    expect(refused.message).toMatch(/own_definitions is set but the correspondence note is empty/);
    expect(refused.message).toMatch(/Steward's own/);
    expect(fake.elaborations).toHaveLength(0);
    expect(mocks.stored).toHaveLength(0);

    const recorded = JSON.parse(
      await executeLeanTool(
        "publish_formalization",
        {
          ...base,
          correspondence:
            "The definition is the Steward's own; it follows Erdős and Turán (1941), and Mathlib has none.",
          own_definitions: true,
        },
        steward
      )
    );
    expect(recorded.success).toBe(true);
    expect(recorded.own_definitions).toBe(true);
    expect(mocks.stored[0]).toMatchObject({ own_definitions: true });

    // Unstated, the flag is false.
    const plain = JSON.parse(await executeLeanTool("publish_formalization", base, steward));
    expect(plain.success).toBe(true);
    expect(plain.own_definitions).toBe(false);
  });

  describe("the second pass", () => {
    const reviewer: SkillToolContext = {
      role: "claim-steward",
      claimId: CLAIM_ID,
      run: { trigger: "formalization_review", context: FORMALIZATION_ID, model: "strong-model" },
    };

    async function recordReviewed() {
      const out = JSON.parse(await executeLeanTool("publish_formalization", base, steward));
      expect(out.status).toBe("reviewed");
      return out.formalization_id as string;
    }

    it("publishes only from the formalization_review trigger, with confirm: true", async () => {
      const id = await recordReviewed();
      const wrongTrigger = JSON.parse(
        await executeLeanTool("publish_formalization", { ...base, confirm: true, formalization_id: id }, steward)
      );
      expect(wrongTrigger.success).toBe(false);
      expect(wrongTrigger.message).toMatch(/formalization_review/);
      expect(mocks.published).toHaveLength(0);

      const out = JSON.parse(
        await executeLeanTool("publish_formalization", { ...base, confirm: true, formalization_id: id }, reviewer)
      );
      expect(out.success).toBe(true);
      expect(out.status).toBe("published");
      expect(out.review_period_ends_at).toBe("2026-09-17T00:00:00.000Z");
      expect(mocks.published).toEqual([{ id, runId: null, reviewNotes: base.review_notes }]);
      // The reviewer's pass re-elaborated the stored text before publishing.
      expect(fake.elaborations).toHaveLength(2);
      expect(fake.elaborations[1]).toBe(mocks.stored[0]!.statement_source);
    });

    it("returns the statement to draft with the reviewer's notes on confirm: false", async () => {
      const id = await recordReviewed();
      const out = JSON.parse(
        await executeLeanTool(
          "publish_formalization",
          { ...base, confirm: false, formalization_id: id, review_notes: "The crux was moved into a hypothesis." },
          reviewer
        )
      );
      expect(out.success).toBe(true);
      expect(out.status).toBe("draft");
      expect(mocks.returned).toEqual([
        { id, reviewNotes: "The crux was moved into a hypothesis.", runId: null },
      ]);
      expect(mocks.published).toHaveLength(0);
    });

    it("refuses to publish an edited statement or one that no longer elaborates the same", async () => {
      const id = await recordReviewed();
      const edited = JSON.parse(
        await executeLeanTool(
          "publish_formalization",
          {
            ...base,
            confirm: true,
            formalization_id: id,
            statement_source: base.statement_source.replace("2 < n", "1 < n"),
          },
          reviewer
        )
      );
      expect(edited.success).toBe(false);
      expect(edited.message).toMatch(/not the reviewed text/);

      fake.elaborateErrors = [{ message: "unknown constant", line: 6, column: 0 }];
      const drifted = JSON.parse(
        await executeLeanTool("publish_formalization", { ...base, confirm: true, formalization_id: id }, reviewer)
      );
      expect(drifted.success).toBe(false);
      expect(drifted.message).toMatch(/no longer elaborates/);
      expect(mocks.published).toHaveLength(0);
    });
  });
});
