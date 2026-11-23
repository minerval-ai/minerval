/**
 * Versions (src/version.ts, services/versions-service.ts; docs/releases.md):
 * one number for every part, a build of main never mistaken for a release,
 * and what a deployment ran before the version it runs now.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  VERSION_PATTERN,
  compareVersions,
  isDevVersion,
  lastWebVersion,
  noteWebVersion,
  releaseOf,
  runningVersion,
  versionWithCommit,
} from "../../src/version.js";
import { passedThrough, upgradeFacts, type VersionRun } from "../../src/services/versions-service.js";

const ROOT = resolve(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("one version for the whole product", () => {
  const version = (JSON.parse(read("package.json")) as { version: string }).version;

  it("is written the same in every part", () => {
    expect(version).toMatch(VERSION_PATTERN);
    expect((JSON.parse(read("web/package.json")) as { version: string }).version).toBe(version);
    expect((JSON.parse(read("plugin/.claude-plugin/plugin.json")) as { version: string }).version).toBe(version);
    expect(read("sandbox/MINERVAL_VERSION").trim()).toBe(version);
    for (const lock of ["package-lock.json", "web/package-lock.json"]) {
      const parsed = JSON.parse(read(lock)) as { version: string; packages: Record<string, { version: string }> };
      expect(parsed.version, lock).toBe(version);
      expect(parsed.packages[""]!.version, lock).toBe(version);
    }
  });

  it("is what the API says it runs, with the commit where the build said it", () => {
    const running = runningVersion();
    expect(running.version.startsWith(version)).toBe(true);
    expect(running.version).toMatch(VERSION_PATTERN);
  });

  it("never lets a build of main be mistaken for a release", () => {
    expect(versionWithCommit("0.6.0-dev", "1a2b3c4d5e6f")).toBe("0.6.0-dev.1a2b3c4");
    expect(versionWithCommit("0.6.0-dev", null)).toBe("0.6.0-dev");
    expect(versionWithCommit("0.6.0", "1a2b3c4d5e6f")).toBe("0.6.0");
    expect(isDevVersion("0.6.0-dev.1a2b3c4")).toBe(true);
    expect(isDevVersion("0.6.0")).toBe(false);
    expect(releaseOf("0.6.0-dev.1a2b3c4")).toBe("0.6.0");
  });

  it("orders versions by their numbers, a build of main before its release", () => {
    const sorted = ["0.10.0", "0.2.0", "0.2.0-dev.abcdef1", "1.0.0", "0.2.1"].sort(compareVersions);
    expect(sorted).toEqual(["0.2.0-dev.abcdef1", "0.2.0", "0.2.1", "0.10.0", "1.0.0"]);
    expect(compareVersions("0.5.0", "0.5.0")).toBe(0);
  });

  it("keeps what the web app said it runs, and nothing that is not a version", () => {
    noteWebVersion("<script>");
    expect(lastWebVersion()).toBeNull();
    noteWebVersion("0.5.0");
    expect(lastWebVersion()).toBe("0.5.0");
  });
});

describe("what a deployment ran before", () => {
  const run = (version: string, first: string, last = first): VersionRun => ({
    version,
    commit: null,
    first_started_at: `${first}T00:00:00.000Z`,
    last_started_at: `${last}T00:00:00.000Z`,
  });

  it("is nothing for a deployment that has only run this version", () => {
    const facts = upgradeFacts({ version: "0.5.0", commit: null }, [run("0.5.0", "2026-12-02")]);
    expect(facts.before).toBeNull();
    expect(facts.running.since).toBe("2026-12-02T00:00:00.000Z");
  });

  it("is the release most recently started before this one", () => {
    const facts = upgradeFacts({ version: "0.5.0", commit: null }, [
      run("0.5.0", "2026-12-02"),
      run("0.4.1", "2026-11-10", "2026-12-01"),
      run("0.3.0", "2026-10-01", "2026-11-09"),
    ]);
    expect(facts.before).toEqual({ version: "0.4.1", until: "2026-12-02T00:00:00.000Z" });
  });

  it("counts rebuilds of main of one release-to-be as one version", () => {
    const facts = upgradeFacts({ version: "0.6.0-dev.bbbbbbb", commit: "bbbbbbb" }, [
      run("0.6.0-dev.bbbbbbb", "2026-12-20"),
      run("0.6.0-dev.aaaaaaa", "2026-12-10"),
      run("0.5.0", "2026-12-02"),
    ]);
    expect(facts.running.since).toBe("2026-12-10T00:00:00.000Z");
    expect(facts.before?.version).toBe("0.5.0");
  });

  it("says which releases an upgrade passed through", () => {
    const between = (v: string) => passedThrough(v, "0.3.0", "0.5.0");
    expect(["0.3.0", "0.4.0", "0.4.1", "0.5.0", "0.5.1"].filter(between)).toEqual(["0.4.0", "0.4.1", "0.5.0"]);
    // From a build of main on the way to 0.4.0, 0.4.0 itself is new.
    expect(passedThrough("0.4.0", "0.4.0-dev.abcdef1", "0.5.0")).toBe(true);
    // With nothing known before, every release up to this one.
    expect(passedThrough("0.2.0", null, "0.5.0")).toBe(true);
  });
});
