/**
 * The eval-run registry table (#334 L1): migration 0042 applied, jsonb
 * round-trips, and id-prefix lookup (what `corpus:compare db:<id>` does)
 * resolves.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";

describe("eval_runs registry", () => {
  it("stores and returns a scorecard with its config fingerprint", async () => {
    const config = {
      pipelineEpoch: "2026-08-owl-economy",
      gitCommit: "abc1234",
      models: { steward: "m1", curator: "m1", matcher: "m2", judge: "m3" },
    };
    const scorecard = { cluster: "dbtest", structural: { extraction: { totalClaims: 3 } } };
    const [inserted] = await rawQuery<{ id: string }>(
      `INSERT INTO eval_runs (cluster, kind, config, scorecard, run_dir)
       VALUES ('dbtest', 'score', $1, $2, '/tmp/run') RETURNING id`,
      [JSON.stringify(config), JSON.stringify(scorecard)]
    );
    expect(inserted!.id).toBeTruthy();

    const rows = await rawQuery<{
      cluster: string;
      config: typeof config;
      scorecard: typeof scorecard;
    }>(
      `SELECT cluster, config, scorecard FROM eval_runs WHERE id::text LIKE $1 || '%'`,
      [inserted!.id.slice(0, 8)]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cluster).toBe("dbtest");
    expect(rows[0]!.config.pipelineEpoch).toBe("2026-08-owl-economy");
    expect(rows[0]!.scorecard.structural.extraction.totalClaims).toBe(3);
  });
});
