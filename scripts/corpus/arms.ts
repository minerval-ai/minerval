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
