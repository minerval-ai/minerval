/**
 * The version this process runs (docs/releases.md, "Versions").
 *
 * One version for the whole product: the API, the web app, the sandbox, the
 * plugin and the migrations are released together, from one commit, under
 * one number. It lives in package.json; a release is the commit that sets
 * it, tagged `v<version>`. `main` between releases carries the next version
 * with `-dev`, and runs as `<next version>-dev.<commit>`, so a build of
 * `main` is never mistaken for a release.
 *
 * Each image knows its version from a file in its own build context
 * (package.json here), which `npm run version:set` writes in all of them at
 * once, so `docker compose build` on a checked-out tag needs nothing passed
 * to it. MINERVAL_VERSION, where the build set it, says the same and wins;
 * MINERVAL_COMMIT is the commit, which only the build can know.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

export interface RunningVersion {
  /** The version: `0.5.0` for a release, `0.6.0-dev.1a2b3c4` for a build of `main`. */
  version: string;
  /** The commit the code was built from; null where the build did not say. */
  commit: string | null;
}

/** A version as this product writes one: MAJOR.MINOR.PATCH, with `-dev` or `-dev.<commit>` on a build of main. */
export const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(-dev(?:\.[0-9a-f]{4,40})?)?$/;

let fromPackage: string | null | undefined;

/** The version package.json states, read once: beside the code in an image, at the repository's root in a checkout. */
function packageVersion(): string | null {
  if (fromPackage !== undefined) return fromPackage;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(here, "..", "package.json"), join(process.cwd(), "package.json")]) {
    if (!existsSync(path)) continue;
    try {
      const { name, version } = JSON.parse(readFileSync(path, "utf8")) as { name?: string; version?: string };
      if (name === "minerval" && typeof version === "string") return (fromPackage = version);
    } catch {
      // Not this one.
    }
  }
  return (fromPackage = null);
}

/** What a version and a commit make together: a `-dev` version takes the commit's first seven characters. */
export function versionWithCommit(version: string, commit: string | null): string {
  return version.endsWith("-dev") && commit ? `${version}.${commit.slice(0, 7)}` : version;
}

export function runningVersion(): RunningVersion {
  const config = loadConfig();
  const commit = config.gitSha?.trim() || null;
  const stated = config.version || packageVersion() || "0.0.0-dev";
  return { version: versionWithCommit(stated, commit), commit };
}

/** Whether a version is a build of `main` and not a release. */
export const isDevVersion = (version: string): boolean => /-dev(\.|$)/.test(version);

/** The release a version is, or is on the way to: `0.6.0` for `0.6.0-dev.1a2b3c4`. */
export const releaseOf = (version: string): string => version.replace(/-dev(\..*)?$/, "");

/**
 * Compare two versions by their numbers: negative where `a` is the older.
 * A `-dev` build of a version comes before that version's release. A string
 * that is no version sorts first.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    const m = VERSION_PATTERN.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1] : [-1, -1, -1, 0];
  };
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

// ---- what the other parts report -------------------------------------------

/**
 * The version the web app last said it runs, in a header on its own
 * requests (x-minerval-web-version, sent with the deployment's service
 * key). Kept so the `version` check can say whether every part was built
 * from the same release; null until the web app has called.
 */
let webVersion: { version: string; at: number } | null = null;

export function noteWebVersion(version: string): void {
  if (VERSION_PATTERN.test(version)) webVersion = { version, at: Date.now() };
}

export function lastWebVersion(): string | null {
  return webVersion?.version ?? null;
}
