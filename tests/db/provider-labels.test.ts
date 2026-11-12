/**
 * Providers cleared by label (src/provider-labels.ts), against the real
 * `labels` table: a run at a second label is served only once its model's
 * provider is cleared for that label, a label the setting names that the
 * table does not hold is reported, and the provider that served a run is in
 * its log beside the label, under the seal.
 *
 * The second label is defined the way tests/db/labels.test.ts defines it: a
 * row, shared by the suite, never removed. The label used as "not defined"
 * is never written anywhere.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

// Tracing is off under vitest by default; the run's log is part of what is checked.
vi.hoisted(() => {
  process.env.TRACE_LEVEL = "full";
});

// No model is called: the provider answers from here, and counts what it was sent.
const provider = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../../src/llm/providers/index.js", async (orig) => ({
  ...(await orig<typeof import("../../src/llm/providers/index.js")>()),
  getAdapter: () => ({ name: "anthropic", complete: provider.complete }),
}));

import { rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { complete } from "../../src/llm/client.js";
import { MODELS } from "../../src/llm/models.js";
import { resetProviderClearanceForTests } from "../../src/llm/provider-clearance.js";
import { getUsageContext, runWithUsageContext, withAgent } from "../../src/llm/usage-context.js";
import { ProviderNotClearedError, UndefinedProviderLabelError } from "../../src/provider-labels.js";
import { undefinedLabels } from "../../src/services/label-service.js";
import { verifyRunLog } from "../../src/services/run-view-service.js";

const INTERNAL = "internal";
const NOT_DEFINED = "reach-test-never-defined";

// The deployment's PROVIDER_LABELS as config loading parsed it: the loaded
// config is one object per process, so setting it there is what the client reads.
const deployment = loadConfig() as unknown as { providerLabels: Record<string, string[]> };
const loaded = deployment.providerLabels;
afterAll(() => {
  deployment.providerLabels = loaded;
});

beforeAll(async () => {
  await rawQuery(
    `INSERT INTO labels (name, description) VALUES ($1, 'Readable inside the organisation.')
     ON CONFLICT (name) DO NOTHING`,
    [INTERNAL]
  );
});

beforeEach(() => {
  provider.complete.mockReset();
  provider.complete.mockImplementation(async (options: { model: string }) => ({
    content: "Done.",
    model: options.model,
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  }));
  resetProviderClearanceForTests();
  deployment.providerLabels = {};
});

/** A run that makes one model call; returns the run's id whether or not the call was allowed. */
async function runWithOneCall(): Promise<{ runId: string; error: unknown }> {
  let runId = "";
  const error = await withAgent("matcher", async () => {
    runId = getUsageContext().trace!.runId;
    await getUsageContext().trace!.ready;
    await complete({
      model: MODELS.sonnet,
      system: "You are a test.",
      messages: [{ role: "user", content: "Say done." }],
    });
  }).then(
    () => null,
    (err: unknown) => err
  );
  return { runId, error };
}

/** Wait for the run to close, which in the default mode comes after it returns. */
async function closed(runId: string) {
  for (let i = 0; i < 250; i++) {
    const [row] = await rawQuery<{ outcome: string; error: string | null; sensitivity_label: string; log_hash: string | null }>(
      `SELECT outcome, error, sensitivity_label, log_hash FROM agent_runs WHERE id = $1 AND finished_at IS NOT NULL`,
      [runId]
    );
    if (row) return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("the run did not close");
}

async function stepsOf(runId: string) {
  return rawQuery<{ seq: number; kind: string; setup: { label?: string; provider?: string | null; model?: string } | null }>(
    `SELECT seq, kind, content->'setup' AS setup FROM agent_steps WHERE run_id = $1 ORDER BY seq`,
    [runId]
  );
}

describe("the labels a setting may name", () => {
  it("are those with a row in the table", async () => {
    expect(await undefinedLabels([])).toEqual([]);
    expect(await undefinedLabels(["public", INTERNAL])).toEqual([]);
    expect(await undefinedLabels([INTERNAL, NOT_DEFINED, "public"])).toEqual([NOT_DEFINED]);
  });
});

describe("a public run", () => {
  it("is served with no setting, and its log names the provider", async () => {
    const { runId, error } = await runWithOneCall();
    expect(error).toBeNull();
    expect(provider.complete).toHaveBeenCalledTimes(1);
    await closed(runId);
    expect((await stepsOf(runId))[0]).toMatchObject({
      seq: 0,
      kind: "prompt",
      setup: { label: "public", provider: "anthropic", model: MODELS.sonnet },
    });
  });
});

describe("a run at a second label", () => {
  it("fails before any request when no provider is cleared for it, naming the setting", async () => {
    const { runId, error } = await runWithUsageContext({ label: INTERNAL }, runWithOneCall);
    expect(error).toBeInstanceOf(ProviderNotClearedError);
    expect((error as Error).message).toBe(
      'anthropic is not cleared for the label "internal", so nothing was sent to it. PROVIDER_LABELS ' +
        "lists the labels each model provider and outside service may receive text at, and one it " +
        'does not list is cleared for "public" alone. To clear this one, set its entry to ' +
        '"anthropic":["public","internal"].'
    );
    expect(provider.complete).not.toHaveBeenCalled();

    // The run was opened at its label and closed in error, with nothing in
    // its log and nothing metered: it was refused before it began.
    const run = await closed(runId);
    expect(run).toMatchObject({ outcome: "error", sensitivity_label: INTERNAL });
    expect(run.error).toContain("PROVIDER_LABELS");
    expect(await stepsOf(runId)).toEqual([]);
    const [spent] = await rawQuery<{ n: string }>(`SELECT count(*)::text AS n FROM llm_usage WHERE run_id = $1`, [runId]);
    expect(spent!.n).toBe("0");
  });

  it("is not served because another provider is cleared, or because its own is cleared for another label", async () => {
    deployment.providerLabels = { openrouter: ["public", INTERNAL], anthropic: ["public"] };
    const { error } = await runWithUsageContext({ label: INTERNAL }, runWithOneCall);
    expect(error).toBeInstanceOf(ProviderNotClearedError);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("is served once its provider is cleared for it, and the provider is in its log under the seal", async () => {
    deployment.providerLabels = { anthropic: ["public", INTERNAL] };
    const { runId, error } = await runWithUsageContext({ label: INTERNAL }, runWithOneCall);
    expect(error).toBeNull();
    expect(provider.complete).toHaveBeenCalledTimes(1);

    const run = await closed(runId);
    expect(run).toMatchObject({ outcome: "ok", sensitivity_label: INTERNAL });
    expect((await stepsOf(runId))[0]).toMatchObject({
      seq: 0,
      kind: "prompt",
      setup: { label: INTERNAL, provider: "anthropic", model: MODELS.sonnet },
    });
    const check = await verifyRunLog(runId);
    expect(check).toMatchObject({ sealed: true, intact: true, problem: null, log_hash: run.log_hash });
  });
});

describe("a setting that names a label the table does not hold", () => {
  it("is reported on the first call, public ones included, and creates no label", async () => {
    deployment.providerLabels = { anthropic: ["public", INTERNAL, NOT_DEFINED], embeddings: [NOT_DEFINED] };
    const { error } = await runWithOneCall();
    expect(error).toBeInstanceOf(UndefinedProviderLabelError);
    expect((error as Error).message).toBe(
      `PROVIDER_LABELS names "${NOT_DEFINED}" (for anthropic, embeddings), which this deployment does ` +
        "not define as a label, so nothing was sent. A label is a row in labels and is never created " +
        "from configuration: define it first, or correct the name in PROVIDER_LABELS."
    );
    expect(provider.complete).not.toHaveBeenCalled();
    expect(await rawQuery(`SELECT 1 FROM labels WHERE name = $1`, [NOT_DEFINED])).toEqual([]);

    // With the name corrected, the same run is served.
    deployment.providerLabels = { anthropic: ["public", INTERNAL] };
    const again = await runWithUsageContext({ label: INTERNAL }, runWithOneCall);
    expect(again.error).toBeNull();
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
});
