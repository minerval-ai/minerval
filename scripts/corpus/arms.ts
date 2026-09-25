/**
 * Shared mechanics for two-arm experiments (the model-swap and property
 * runners): run a child corpus script in its own process, and find the
 * run.json a child corpus:run just wrote. Each arm is a child process
 * because config caches on first read, so an override for one arm has to be
 * in the environment (or a flag lib.ts honours) before anything loads.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_DATABASE_URL, REPO_ROOT, RUNS_ROOT } from "./lib.js";
import type { ArmRecord } from "./swap-lib.js";
import type { AgreementReport, MatchedPair } from "./graph-agreement.js";

export function runChild(script: string, args: string[], env: Record<string, string>): void {
  const result = spawnSync("npx", ["tsx", script, ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env, CORPUS_DATABASE_URL },
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

/** The run.json of the newest run dir for `cluster` started at or after `since`. */
export function latestRunRecord(cluster: string, since: Date): ArmRecord {
  const dirs = readdirSync(RUNS_ROOT)
    .filter((d) => d.startsWith(`${cluster}-`) && existsSync(join(RUNS_ROOT, d, "run.json")))
    .map((d) => ({ d, mtime: statSync(join(RUNS_ROOT, d, "run.json")).mtimeMs }))
    .sort((x, y) => y.mtime - x.mtime);
  for (const { d } of dirs) {
    const rec = JSON.parse(readFileSync(join(RUNS_ROOT, d, "run.json"), "utf8")) as ArmRecord;
    if (new Date(rec.startedAt).getTime() >= since.getTime() - 5_000) return rec;
  }
  throw new Error(`no run.json for ${cluster} written since ${since.toISOString()} under ${RUNS_ROOT}`);
}

/**
 * The replay of a two-arm experiment (#334, the evals page's "show me"
 * half): each arm read back from its snapshot over the window its run
 * record gives, the matching taken from the agreement the driver already
 * computed, written next to the driver's own record. Best-effort by
 * design: a replay failure is reported and never fails the experiment
 * that produced the evidence.
 */
export async function emitTwoArmReplay(opts: {
  kind: "property" | "swap";
  name: string;
  title: string;
  cluster: string;
  about: string;
  outDir: string;
  arms: { a: ArmRecord | null; b: ArmRecord };
  snapshots: { a: string; b: string };
  variation: { a: string | null; b: string | null };
  agreement: { report: AgreementReport; pairs?: MatchedPair[] };
  summary: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const { assembleReplay, collectArm, fingerprintFromRecord, matchingFromAgreement, snapshotUrl, writeReplay } =
      await import("./replay.js");
    const arm = async (key: "a" | "b", rec: ArmRecord | null, snap: string, variation: string | null) =>
      collectArm({
        databaseUrl: snapshotUrl(CORPUS_DATABASE_URL, snap),
        // A baseline arm reused from an earlier snapshot has no run record:
        // everything the snapshot holds is its window.
        since: rec ? new Date(rec.startedAt) : new Date(0),
        until: rec ? new Date(rec.finishedAt) : undefined,
        key,
        label: `${opts.cluster} (${key})`,
        variation,
        fingerprint: fingerprintFromRecord(rec ?? {}),
        database: snap,
        capped: rec?.capped ?? false,
      });
    const [a, b] = await Promise.all([
      arm("a", opts.arms.a, opts.snapshots.a, opts.variation.a),
      arm("b", opts.arms.b, opts.snapshots.b, opts.variation.b),
    ]);
    const replay = assembleReplay({
      kind: opts.kind,
      name: opts.name,
      title: opts.title,
      cluster: opts.cluster,
      about: opts.about,
      arms: [a, b],
      matching: [matchingFromAgreement("a", "b", opts.agreement.report, opts.agreement.pairs)],
      summary: opts.summary,
    });
    const path = writeReplay(opts.outDir, replay);
    console.log(`  replay: ${path}`);
    return path;
  } catch (err) {
    console.warn(`[${opts.kind}] replay export failed (the result files are intact):`, err instanceof Error ? err.message : err);
    return null;
  }
}
