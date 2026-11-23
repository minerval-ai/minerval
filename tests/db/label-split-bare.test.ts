/**
 * The split (src/services/label-split.ts) on a members-only deployment that
 * had `public` and nothing else, and whose settings fix which providers are
 * sent each label's text. On its own database (tests/db/urls.ts).
 *
 * Two things differ from a deployment that already had labels of its own:
 * the database was holding nothing to a clearance and starts to, and no
 * provider is stored as cleared, because the setting is what is in force.
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `${url.pathname}_own_split_bare`;
  process.env.DATABASE_URL = url.toString();
  process.env.READS = "members";
  process.env.LOG_LEVEL = "fatal";
  delete process.env.PROVIDER_LABELS;
});

import { currentReadClearance, deploymentHoldsLabels, rawQuery } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { enforcementFacts, enforcementProblems } from "../../src/db/enforcement.js";
import { loadConfig } from "../../src/config.js";
import { baseLabel, layersAreSplit, publishedLabel } from "../../src/labels.js";
import { currentLabel } from "../../src/llm/usage-context.js";
import { ensureLabelSplit } from "../../src/services/label-split.js";

const system = <T>(fn: () => Promise<T>) => withSystemClearance("The split's test checks rows at every label.", fn);

describe("the split of a deployment that had public alone", () => {
  it("starts holding reads to a clearance, moves what was there, and stores no provider where the settings fix them", async () => {
    expect(new URL(loadConfig().databaseUrl).pathname.endsWith("_own_split_bare")).toBe(true);
    expect(await deploymentHoldsLabels()).toBe(false);
    const [node] = await rawQuery<{ id: string }>(
      `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at) VALUES ('A node of a deployment with one label', 'claim', 'done', 'complete', now()) RETURNING id`
    );
    expect((await rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM claims WHERE id = $1`, [node!.id]))[0]!.l).toBe("public");

    const config = { ...loadConfig(), providerLabels: { anthropic: ["public"] } };
    const result = await ensureLabelSplit(config);
    setNoContextSessionForTests({ role: "owner", label: baseLabel() });

    expect(result).toMatchObject({ split: true, base: "members", published: "published" });
    expect(result.lines.join("\n")).toContain(`PROVIDER_LABELS fixes which providers are sent each label's text: add "members" and "published"`);
    expect(layersAreSplit()).toBe(true);
    expect([baseLabel(), publishedLabel(), currentLabel()]).toEqual(["members", "published", "members"]);
    expect(await deploymentHoldsLabels()).toBe(true);
    expect(enforcementProblems(await enforcementFacts())).toEqual([]);
    expect(await system(() => rawQuery(`SELECT sensitivity_label AS l FROM claims WHERE id = $1`, [node!.id]))).toEqual([{ l: "members" }]);
    expect(await system(() => rawQuery(`SELECT count(*)::int AS n FROM provider_clearances`))).toEqual([{ n: 0 }]);
    expect(await system(() => rawQuery(`SELECT count(*)::int AS n FROM label_reads`))).toEqual([{ n: 0 }]);

    // Nothing in context now reads what anyone may read, which is not the node.
    setNoContextSessionForTests(null);
    try {
      expect(await currentReadClearance()).toEqual(["public", "published"]);
      expect(await rawQuery(`SELECT 1 FROM claims WHERE id = $1`, [node!.id])).toEqual([]);
    } finally {
      setNoContextSessionForTests({ role: "owner", label: baseLabel() });
    }
  });
});
