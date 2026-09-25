/**
 * Production monitors CLI (#334 S9): print the monitor overview as tables,
 * against DATABASE_URL or — with --corpus — the isolated corpus DB (the
 * scripts/corpus/lib.ts pin, so a drained corpus run can be read the way
 * production is).
 *
 * Usage:
 *   npm run monitors                       # overview, DATABASE_URL
 *   npm run monitors -- --corpus           # overview, corpus DB
 *   npm run monitors -- --signal=cascade_health [--json] [--limit=N]
 *
 * Every signal is a read; nothing here changes the graph. What each signal
 * is and is not, and the SQL behind it, is in docs/monitors.md.
 */
import { config as loadDotenv } from "dotenv";

function argFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function pct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(0)}%`;
}
function num(x: number | null, digits = 2): string {
  return x == null ? "—" : x.toFixed(digits);
}
function age(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => "  " + cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

async function main(): Promise<void> {
  if (hasFlag("corpus")) {
    // Pins DATABASE_URL to the corpus DB before any src module caches config.
    const lib = await import("./corpus/lib.js");
    lib.assertCorpusDb();
  } else {
    loadDotenv();
  }
  const { closeDb } = await import("../src/db/client.js");
  const monitors = await import("../src/services/monitor-service.js");
  const { formatMicroUsd } = await import("../src/llm/pricing.js");

  const limit = argFlag("limit") ? Number(argFlag("limit")) : undefined;
  const t = monitors.defaultThresholds(limit ? { limit } : {});
  const signal = argFlag("signal") as (typeof monitors.MONITOR_SIGNALS)[number] | undefined;
  if (signal && !monitors.MONITOR_SIGNALS.includes(signal)) {
    console.error(`unknown signal "${signal}" (known: ${monitors.MONITOR_SIGNALS.join(", ")})`);
    process.exit(1);
  }

  try {
    if (signal) {
      const report = await monitors.signalReport(signal, t);
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const o = await monitors.overview(t);
    if (hasFlag("json")) {
      console.log(JSON.stringify(o, null, 2));
      return;
    }

    console.log(`\n=== monitors — ${o.generatedAt} ===`);
    console.log(`  (every signal is a read; candidates are inputs to the Audit Agent, not verdicts — docs/monitors.md)\n`);

    console.log(`--- performed settling: ${o.performedSettling.candidates.length} candidate(s) (confidence ≥ ${t.settledConfidence}, statuses ${t.settledStatuses.join("/")})`);
    if (o.performedSettling.candidates.length) {
      console.log(
        table(
          ["claim", "status", "conf", "cred", "why", "text"],
          o.performedSettling.candidates.map((c) => [
            c.claimId.slice(0, 8), c.status, num(c.confidence), num(c.credence), c.reasons.join(","), c.text.slice(0, 60),
          ])
        )
      );
    }

    console.log(`\n--- empty chairs: ${o.emptyChairs.candidates.length} candidate(s) (contested, ≥ ${t.emptyChairMinInstances} instances all one stance, or arguments all one stance)`);
    if (o.emptyChairs.candidates.length) {
      console.log(
        table(
          ["claim", "inst", "stance", "args", "stance", "text"],
          o.emptyChairs.candidates.map((c) => [
            c.claimId.slice(0, 8), String(c.instances), c.instanceStance ?? "mixed", String(c.arguments), c.argumentStance ?? "mixed", c.text.slice(0, 60),
          ])
        )
      );
    }

    const or = o.overturnRate;
    console.log(`\n--- overturn rate: ${or.reversed}/${or.assessed} assessments later materially reversed (|Δ| ≥ ${t.materialCredenceDelta} or status change)`);
    console.log(
      table(
        ["credence", "n", "reversed", "share"],
        or.bins.map((b) => [`${b.lo.toFixed(1)}–${b.hi.toFixed(1)}`, String(b.n), String(b.reversed), pct(b.share)])
      )
    );
    console.log(
      `  confident (≤0.2 / ≥0.8): ${pct(or.confidentShare)} of ${or.confidentN} · uncertain (0.4–0.6): ${pct(or.uncertainShare)} of ${or.uncertainN} · ` +
        `discriminating: ${or.discriminating == null ? `no verdict (< ${or.minSample} per side)` : or.discriminating ? "yes" : "NO"}`
    );

    const em = o.evidenceMonotonicity;
    console.log(`\n--- evidence monotonicity: ${em.violations.length} violation(s) over ${em.checked} checked of ${em.accepted} accepted (${em.unassessed} not yet re-assessed; tolerance ${em.tolerance})`);
    console.log(`  sign-correct: support ${em.correct.support}, challenge ${em.correct.challenge}`);
    if (em.violations.length) {
      console.log(
        table(
          ["kind", "claim", "before", "after", "Δ", "text"],
          em.violations.map((v) => [v.kind, v.claimId.slice(0, 8), num(v.credenceBefore), num(v.credenceAfter), num(v.delta), v.claimText.slice(0, 50)])
        )
      );
    }

    const ch = o.cascadeHealth;
    console.log(`\n--- cascade health (${t.cascadeDays}d): pooled R = ${num(ch.r)} ${ch.supercritical === null ? "" : ch.supercritical ? "(SUPERCRITICAL, ≥ 1)" : "(subcritical)"} · coalesced ${pct(ch.coalescedShare)}`);
    if (ch.days.length) {
      console.log(
        table(
          ["day", "runs", "material", "caused", "R", "enqueues", "coalesced"],
          ch.days.map((d) => [d.day, String(d.runs), String(d.materialRuns), String(d.materialChildren), num(d.r), String(d.enqueues), pct(d.coalescedShare)])
        )
      );
    }

    const qh = o.queueHealth;
    console.log(`\n--- queue health: pending ${qh.states.pending} · running ${qh.states.running} · error ${qh.states.error} · deferred ${qh.states.deferred} · done ${qh.states.done}`);
    if (qh.oldestPending) console.log(`  oldest pending: ${age(qh.oldestPending.ageSeconds)} — ${qh.oldestPending.claimId.slice(0, 8)} "${qh.oldestPending.text.slice(0, 60)}"`);
    const s = qh.snapshots;
    console.log(`  snapshots (${s.points.length}): earliest ${s.earliest ?? "—"} → latest ${s.latest ?? "—"} (Δ ${s.delta ?? "—"}, ${num(s.slopePerHour)}/h)`);
    if (qh.errorParked.length) {
      console.log(`  error-parked (${qh.errorParked.length}):`);
      console.log(table(["claim", "imp", "attempts", "error"], qh.errorParked.map((p) => [p.claimId.slice(0, 8), num(p.importance), String(p.attempts), (p.error ?? "").slice(0, 70)])));
    }

    console.log(`\n--- agents (24h / 7d)`);
    console.log(
      table(
        ["agent", "calls 24h", "cost 24h", "runs 24h", "err 24h", "calls 7d", "cost 7d", "runs 7d", "err 7d"],
        o.agentRollups.agents.map((a) => [
          a.agent,
          String(a.last24h.calls), formatMicroUsd(a.last24h.costMicroUsd), String(a.last24h.runs), pct(a.last24h.errorRate),
          String(a.last7d.calls), formatMicroUsd(a.last7d.costMicroUsd), String(a.last7d.runs), pct(a.last7d.errorRate),
        ])
      )
    );
    console.log();
  } finally {
    await closeDb().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
