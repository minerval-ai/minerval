/**
 * Third review, finding 1 and the rule the coordinator drew from it: text
 * written at a label is composed only from rows that label reads.
 *
 * A sweep that looks for something to say (a candidate for audit, how many
 * reports wait, which partition is due a consistency sweep) used to look
 * once, on the owner's connection, with every label in sight, and then
 * write what it found at one label. On the owner's connection the judgment
 * in force for a public node is whichever version reads the most, so a
 * public audit request stated a private version's verdict and counted
 * private instances. Each such sweep now works label by label
 * (everyLabel in src/services/label-service.ts): it looks inside each
 * label, and writes there what it found there.
 *
 * Each case seeds a public node whose private side is what would have
 * leaked, runs the sweep as its worker runs it, and reads what a
 * public-only connection is then given.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { auditSchedulerTick } from "../../src/workers/audit-scheduler.js";
import { flagMonitorCandidates } from "../../src/workers/monitor-scheduler.js";
import { A, B, asPerson, attachSource, seedNode, system, tag, unwall, version, wall } from "./review-3-common.js";

beforeAll(wall, 120_000);
afterAll(async () => {
  await system(async () => {
    await rawQuery(`DELETE FROM audit_runs WHERE requested_at > now() - interval '1 hour' AND triggered_by IN ('monitor_signal', 'report_triage', 'scheduled_sweep')`);
    await rawQuery(`DELETE FROM actions WHERE kind IN ('audit', 'consistency_sweep') AND created_at > now() - interval '1 hour'`);
    await rawQuery(`DELETE FROM agent_reports WHERE title LIKE '%' || $1 || '%'`, [tag]);
  }).catch(() => undefined);
  await unwall();
}, 120_000);

describe("the monitor's sweep", () => {
  let node = "";
  beforeAll(async () => {
    node = await seedNode("public", "PUBLIC: the reservoir is safe to drink from");
    await system(() => rawQuery(`UPDATE claims SET importance = 1000 WHERE id = $1`, [node]));
    // The public judgment is unsettled. The version at a is settled, with high confidence.
    await version(node, "public", "inconclusive", "Public reasoning.", 0.4);
    // The disagreement is among instances recorded at a, from sources at a.
    for (const stance of ["affirms", "denies", "denies"]) await attachSource(node, A, "A-ONLY passage", stance);
    await version(node, A, "contradicted", "A-ONLY reasoning from partner A lab results.", 0.97);
  });

  it("asks for an audit of a's version at a, worded from what a reads, and writes nothing of it where public reads", async () => {
    // Called as the worker calls it: with nothing in context.
    const result = await flagMonitorCandidates({ maxFlags: 50 });
    const mine = result.flags.filter((f) => f.claimId === node);
    expect(mine.map((f) => f.signal)).toEqual(["performed_settling"]);
    const all = await system(() =>
      rawQuery<{ context: string; l: string }>(`SELECT context, sensitivity_label AS l FROM audit_runs WHERE context LIKE '%' || $1 || '%'`, [node])
    );
    expect(all.map((r) => r.l)).toEqual([A]);
    expect(all[0]!.context).toContain("is assessed contradicted at confidence 0.97");
    expect(all[0]!.context).toContain("its instances affirm it 1 time(s) and deny it 2 time(s) across 3 sources");
    // What a public-only connection reads: no request about the node at all.
    // It was never a candidate on what public holds.
    for (const reader of [["public"], [B, "public"]]) {
      expect(await asPerson(reader, () => rawQuery(`SELECT 1 FROM audit_runs WHERE context LIKE '%' || $1 || '%'`, [node]))).toEqual([]);
      expect(await asPerson(reader, () => rawQuery(`SELECT 1 FROM actions WHERE kind = 'audit' AND label LIKE '%' || $1 || '%'`, [node]))).toEqual([]);
    }
    // A second sweep in the same period asks for nothing more.
    const again = await flagMonitorCandidates({ maxFlags: 50 });
    expect(again.flags.filter((f) => f.claimId === node && f.runId !== null)).toEqual([]);
  });
});

describe("the audit scheduler", () => {
  it("asks for a triage of a's reports at a, and says nothing at public of how many a holds", async () => {
    await system(async () => {
      for (const n of [1, 2, 3]) {
        await rawQuery(
          `INSERT INTO agent_reports (kind, severity, title, agent, dedupe_key, sensitivity_label)
           VALUES ('tool_failure', 'low', $1, 'steward', $2, $3)`,
          [`A-ONLY report ${n} (${tag})`, `r3:${tag}:${n}`, A]
        );
      }
    });
    const before = await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM audit_runs WHERE triggered_by = 'report_triage' AND sensitivity_label = 'public'`));
    await auditSchedulerTick();
    const atA = await system(() =>
      rawQuery<{ context: string }>(`SELECT context FROM audit_runs WHERE triggered_by = 'report_triage' AND sensitivity_label = $1`, [A])
    );
    expect(atA).toHaveLength(1);
    expect(atA[0]!.context).toContain("Scheduled triage of the 3 report(s)");
    // The three reports are a's: no request at public was made because of them, and none states their number.
    const publicNow = await system(() =>
      rawQuery<{ context: string }>(`SELECT context FROM audit_runs WHERE triggered_by = 'report_triage' AND sensitivity_label = 'public' AND requested_at > now() - interval '1 minute'`)
    );
    for (const r of publicNow) expect(r.context).not.toContain("of the 3 report(s)");
    const publicReports = await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM agent_reports WHERE status = 'new' AND sensitivity_label = 'public' AND last_seen_at > now() - interval '24 hours'`));
    if (publicReports[0]!.n === 0) {
      expect(await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM audit_runs WHERE triggered_by = 'report_triage' AND sensitivity_label = 'public'`))).toEqual(before);
    }
    expect(await asPerson(["public"], () => rawQuery(`SELECT 1 FROM audit_runs WHERE context LIKE '%of the 3 report(s)%'`))).toEqual([]);
  });
});

