/**
 * The preflight against a real database (src/preflight.ts): what it reads
 * of the database and its migrations, the run log's test of itself, and the
 * gate on agent work, which refuses a deployment that holds private material
 * while a blocking check fails and asks nothing of one that holds only
 * public material.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { PUBLIC_LABEL } from "../../src/labels.js";
import {
  RUN_LOG_TEST_AGENT,
  agentWorkGate,
  evaluatePreflight,
  gatherPreflightFacts,
  holdsPrivateMaterial,
  readDatabaseFacts,
  runLogSelfTest,
  runPreflight,
} from "../../src/preflight.js";
import { startGatedWork } from "../../src/workers/agent-work-gate.js";

const config = loadConfig() as {
  runLogMode: "best_effort" | "record";
  githubIssuesRepo: string;
  providerLabels: Record<string, string[]>;
  modelEndpoints: Array<{ name: string; baseUrl: string; keyEnv?: string; inputUsdPerMtok: number; outputUsdPerMtok: number }>;
};
const configured = { ...config };
afterEach(() => {
  config.runLogMode = configured.runLogMode;
  config.githubIssuesRepo = configured.githubIssuesRepo;
  config.providerLabels = configured.providerLabels;
  config.modelEndpoints = configured.modelEndpoints;
  delete process.env.PREFLIGHT_TEST_ENDPOINT_KEY;
});

/**
 * Run `fn` where `public` is the only label, as on the public graph, and
 * hand it a way to define another. Other files leave labels of their own in
 * the scratch database and rows that carry them, so the real table is set
 * aside under another name and a stand-in takes its place for the read of
 * `labels` by name, which is the read under test (the same arrangement as
 * tests/db/label-carried.test.ts).
 */
async function whereOnlyPublicIsDefined<T>(fn: (defineLabel: (name: string) => Promise<void>) => Promise<T>): Promise<T> {
  await rawQuery(`ALTER TABLE labels RENAME TO labels_set_aside`);
  try {
    await rawQuery(`CREATE TABLE labels (LIKE labels_set_aside INCLUDING DEFAULTS)`);
    await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'Readable by anyone.')`, [PUBLIC_LABEL]);
    return await fn(async (name) => {
      await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'Defined for one test.')`, [name]);
    });
  } finally {
    await rawQuery(`DROP TABLE IF EXISTS labels`);
    await rawQuery(`ALTER TABLE labels_set_aside RENAME TO labels`);
  }
}

async function testRunsLeft(): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM agent_runs WHERE agent = $1`, [
    RUN_LOG_TEST_AGENT,
  ]);
  return row!.n;
}

function check(report: Awaited<ReturnType<typeof runPreflight>>, name: string) {
  return report.checks.find((c) => c.name === name)!;
}

describe("the database check", () => {
  it("finds the scratch database reachable, with pgvector, and with every migration in the folder applied", async () => {
    const database = await readDatabaseFacts();
    if (!database.reachable) throw new Error(database.error);
    expect(database.pgvector).toBe(true);
    expect(database.folder!.length).toBeGreaterThan(100);
    // The dates the migrator recorded are the journal's, one for one.
    expect([...database.applied].sort()).toEqual(database.folder!.map((m) => m.when).sort());

    const report = await runPreflight();
    expect(check(report, "database")).toMatchObject({
      status: "pass",
      message: `The database is reachable, has pgvector, and has all ${database.folder!.length} migrations applied.`,
    });
  });

  it("fails when the database is a migration behind the code, naming it", async () => {
    const [last] = await rawQuery<{ id: number; hash: string; created_at: string }>(
      `SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`
    );
    await rawQuery(`DELETE FROM drizzle.__drizzle_migrations WHERE id = $1`, [last!.id]);
    try {
      const database = await readDatabaseFacts();
      if (!database.reachable) throw new Error(database.error);
      const folder = database.folder!;
      const report = evaluatePreflight({ ...(await gatherPreflightFacts()), database });
      expect(check(report, "database")).toMatchObject({
        status: "fail",
        message:
          `The database is behind the code: 1 of ${folder.length} migrations have not been applied ` +
          `(the first is ${folder[folder.length - 1]!.tag}).`,
      });
    } finally {
      await rawQuery(`INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES ($1, $2, $3)`, [
        last!.id,
        last!.hash,
        last!.created_at,
      ]);
    }
  });

  it("fails when no migrations folder is beside the code", async () => {
    const database = await readDatabaseFacts(null);
    expect(database).toMatchObject({ reachable: true, folder: null });
  });
});

describe("the run log's test of itself", () => {
  it("writes a run, seals it, checks its chain and removes it, with tracing off as it is under test", async () => {
    expect(process.env.TRACE_LEVEL).toBeUndefined();
    expect(await runLogSelfTest()).toEqual({ ok: true, steps: 2 });
    expect(await testRunsLeft()).toBe(0);
  });

  it("writes the run through the writer the agents use: its two steps are there, chained, while it exists", async () => {
    // Keep the run from being removed for the length of one look at it.
    const kept: Array<{ agent: string; steps: number; sealed: boolean; private: boolean; chained: number }> = [];
    await rawQuery(`
      CREATE FUNCTION preflight_test_keep() RETURNS trigger AS $$
      BEGIN
        IF OLD.agent = 'preflight' THEN
          CREATE TABLE IF NOT EXISTS preflight_test_seen AS
            SELECT OLD.agent AS agent, OLD.steps AS steps, OLD.sealed_at IS NOT NULL AS sealed,
                   cardinality(OLD.private_reasons) > 0 AS private,
                   (SELECT count(*)::int FROM agent_steps s
                     WHERE s.run_id = OLD.id AND s.hash IS NOT NULL AND s.prev_hash IS NOT NULL) AS chained;
        END IF;
        RETURN OLD;
      END $$ LANGUAGE plpgsql`);
    await rawQuery(
      `CREATE TRIGGER preflight_test_keep BEFORE DELETE ON agent_runs FOR EACH ROW EXECUTE FUNCTION preflight_test_keep()`
    );
    try {
      expect(await runLogSelfTest()).toEqual({ ok: true, steps: 2 });
      kept.push(...(await rawQuery<(typeof kept)[number]>(`SELECT * FROM preflight_test_seen`)));
    } finally {
      await rawQuery(`DROP TRIGGER preflight_test_keep ON agent_runs`);
      await rawQuery(`DROP FUNCTION preflight_test_keep()`);
      await rawQuery(`DROP TABLE IF EXISTS preflight_test_seen`);
    }
    // Sealed, both steps chained, and not public while it existed.
    expect(kept).toEqual([{ agent: "preflight", steps: 2, sealed: true, private: true, chained: 2 }]);
    expect(await testRunsLeft()).toBe(0);
  });

  it("says so when a step cannot be written, and still leaves nothing behind", async () => {
    await rawQuery(`
      CREATE FUNCTION preflight_test_refuse() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'steps are refused for this test'; END $$ LANGUAGE plpgsql`);
    await rawQuery(
      `CREATE TRIGGER preflight_test_refuse BEFORE INSERT ON agent_steps FOR EACH ROW EXECUTE FUNCTION preflight_test_refuse()`
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await runLogSelfTest()).toEqual({
        ok: false,
        reason: "the run or one of its steps could not be written, so it closed unsealed",
      });
    } finally {
      errors.mockRestore();
      await rawQuery(`DROP TRIGGER preflight_test_refuse ON agent_steps`);
      await rawQuery(`DROP FUNCTION preflight_test_refuse()`);
    }
    expect(await testRunsLeft()).toBe(0);
  });
});

describe("a deployment that holds only public material", () => {
  it("is told from its labels, and has no blocking check and nothing refused", async () => {
    await whereOnlyPublicIsDefined(async () => {
      expect(await holdsPrivateMaterial()).toBe(false);
      // A state that would block a private deployment three times over.
      config.githubIssuesRepo = "an-owner/a-repo";
      const report = await runPreflight();
      expect(report.holds_private_material).toBe(false);
      expect(report.checks.every((c) => c.blocking === false)).toBe(true);
      expect(report.agent_work).toBe("allowed");
      expect(check(report, "run_log").status).toBe("pass");
      expect(check(report, "reports_stay_inside").status).toBe("not_applicable");
      // Nothing is asked about clearing a provider where there is no other label to clear one for.
      for (const name of ["model_clearance", "embeddings_clearance", "outside_service_clearance"]) {
        expect(check(report, name).status, name).toBe("not_applicable");
      }
      expect(check(report, "provider_labels").status).toBe("not_applicable");
      expect(await agentWorkGate()).toEqual({ open: true, holdsPrivate: false, failed: [] });
    });
  });

  it("starts its work at the seam, with nothing logged", async () => {
    await whereOnlyPublicIsDefined(async () => {
      const start = vi.fn(() => [{ stop: vi.fn() }]);
      const logger = { info: vi.fn(), error: vi.fn() };
      const work = startGatedWork({ start, logger, recheckMs: 3_600_000 });
      try {
        await work.check();
        expect(start).toHaveBeenCalledTimes(1);
        expect(work.running()).toBe(true);
        expect(logger.error).not.toHaveBeenCalled();
      } finally {
        work.stop();
      }
    });
  });
});

describe("a deployment that holds private material", () => {
  it("is refused at the seam while a blocking check fails, and starts once it passes", async () => {
    await whereOnlyPublicIsDefined(async (defineLabel) => {
      await defineLabel("internal");
      expect(await holdsPrivateMaterial()).toBe(true);
      config.githubIssuesRepo = "";

      // The run log is in best-effort mode, which a private deployment may not be.
      const start = vi.fn(() => [{ stop: vi.fn() }]);
      const logger = { info: vi.fn(), error: vi.fn() };
      const work = startGatedWork({ start, logger, recheckMs: 3_600_000 });
      try {
        await work.check();
        expect(start).not.toHaveBeenCalled();
        expect(work.running()).toBe(false);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error.mock.calls[0]![0]).toMatch(
          /^Agent work is not started: this deployment holds private material and 1 preflight check that must pass first has failed\. run_log: The run log is in best-effort mode/
        );

        const report = await runPreflight();
        expect(report.agent_work).toBe("refused");
        expect(report.checks.filter((c) => c.blocking).map((c) => c.name)).toEqual([
          "database",
          "run_log",
          "provider_labels",
          "reports_stay_inside",
        ]);
        // Nobody has cleared a provider for the new label, which fails without closing the gate.
        expect(check(report, "model_clearance")).toMatchObject({ status: "fail", blocking: false });

        // Record mode, and the same seam starts the work it refused.
        config.runLogMode = "record";
        await work.check();
        expect(start).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith("The preflight's blocking checks pass; starting agent work.");
      } finally {
        work.stop();
      }
      expect(await testRunsLeft()).toBe(0);
    });
  });

  it("reads its labels by name, sorted here, and which endpoint keys are not set", async () => {
    await whereOnlyPublicIsDefined(async (defineLabel) => {
      expect((await gatherPreflightFacts()).privateLabels).toEqual([]);
      // Underscores and case sort differently under the database's locale than here.
      for (const name of ["restricted", "internal_b", "Internal", "internal-a"]) await defineLabel(name);
      config.modelEndpoints = [
        { name: "keyed", baseUrl: "http://a.test/v1", keyEnv: "PREFLIGHT_TEST_ENDPOINT_KEY", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
        { name: "open", baseUrl: "http://b.test/v1", inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
      ];
      const facts = await gatherPreflightFacts();
      expect(facts.holdsPrivate).toBe(true);
      expect(facts.privateLabels).toEqual(["Internal", "internal-a", "internal_b", "restricted"].sort());
      expect(facts.endpointKeysMissing).toEqual(["PREFLIGHT_TEST_ENDPOINT_KEY"]);
      process.env.PREFLIGHT_TEST_ENDPOINT_KEY = "k";
      expect((await gatherPreflightFacts()).endpointKeysMissing).toEqual([]);
    });
  });

  it("is refused while provider_labels names a label nobody has defined, and starts once it is defined", async () => {
    await whereOnlyPublicIsDefined(async (defineLabel) => {
      await defineLabel("internal");
      config.runLogMode = "record";
      config.githubIssuesRepo = "";
      config.providerLabels = { anthropic: ["public", "internal", "restricted"] };

      const gate = await agentWorkGate();
      expect(gate.open).toBe(false);
      expect(gate.failed.map((c) => c.name)).toEqual(["provider_labels"]);
      expect(gate.failed[0]!.message).toBe(
        'provider_labels names "restricted" (for anthropic), which this deployment does not define as a label, ' +
          "so every model call and every call to an outside service is refused, at every label, until it is " +
          "defined or the name is corrected."
      );

      await defineLabel("restricted");
      expect((await agentWorkGate()).open).toBe(true);
      const report = await runPreflight();
      expect(check(report, "provider_labels")).toMatchObject({
        status: "pass",
        message: 'Every label provider_labels names is defined ("internal", "restricted").',
      });
      // Anthropic is cleared for both; the roles on other providers are named, label by label.
      expect(check(report, "model_clearance").status).toBe("fail");
      expect(check(report, "embeddings_clearance")).toMatchObject({
        status: "pass",
        message: expect.stringMatching(/^Embeddings are not cleared for the labels "internal" and "restricted", /),
      });
    });
  });

  it("is refused while its agents' reports would be filed outside", async () => {
    await whereOnlyPublicIsDefined(async (defineLabel) => {
      await defineLabel("internal");
      config.runLogMode = "record";
      config.githubIssuesRepo = "an-owner/a-repo";
      const gate = await agentWorkGate();
      expect(gate.open).toBe(false);
      expect(gate.failed.map((c) => c.name)).toEqual(["reports_stay_inside"]);
    });
  });
});
