import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  FILE_SET_NOTICE,
  analysisAddress,
  directoryProblem,
  filePathProblem,
  fileSetSlugFromName,
  isAnalysisAddress,
  isFileSetSlug,
  isKeptFileAddress,
  keptFileAddress,
  manifestHash,
} from "../../src/file-sets.js";
import { isReadingAddress } from "../../src/connections.js";
import { TOOL_READS, toolPrivateReason } from "../../src/llm/run-visibility.js";
import { FILE_SET_TOOL_NAMES, fileSetsNote, sizeOf } from "../../src/llm/tools/file-set-tools.js";
import { analysisDocument, endedLine, fileDocument, sandboxCostMicroUsd } from "../../src/services/analysis-service.js";
import type { RunFileSet } from "../../src/services/file-set-service.js";
import type { SandboxHealth } from "../../src/services/sandbox-client.js";

/**
 * The parts of a file set that need no database and no sandbox
 * (src/file-sets.ts): how a set and a file in it are named, the hash that
 * fixes a set, the addresses its sources are cited by, and the words a run
 * and a person are given.
 */

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("a set's slug", () => {
  it("is one short lower-case word with single hyphens or underscores", () => {
    for (const ok of ["logs", "eval-logs", "eval_logs_2026", "a1", "x-y-z"]) expect(isFileSetSlug(ok), ok).toBe(true);
    for (const bad of ["", "Logs", "1abc", "a--b", "a-", "-a", "a b", "a/b", "..", "x".repeat(49)]) {
      expect(isFileSetSlug(bad), bad).toBe(false);
    }
    expect(fileSetSlugFromName("October Transcripts (EU)")).toBe("october-transcripts-eu");
    expect(fileSetSlugFromName("2026 logs")).toBe("s2026-logs");
    expect(fileSetSlugFromName("!!!")).toBe("set");
    expect(isFileSetSlug(fileSetSlugFromName("A name that is far longer than any directory name should ever be, by a distance"))).toBe(true);
  });
});

describe("a file's path", () => {
  it("names a file inside the set and nowhere else", () => {
    for (const ok of ["a.txt", "runs/run-1.jsonl", "notes/été 2026.txt", "a/b/c/d", ".hidden", "a..b"]) {
      expect(filePathProblem(ok), ok).toBeNull();
    }
    for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "a/", "./a", "a\\b", "a\nb", "x".repeat(1001)]) {
      expect(filePathProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(directoryProblem("finance/2026-q3")).toBeNull();
    expect(directoryProblem("../store")).toBe(
      "directory is a path under the root this deployment registers directories from, relative to that root: " +
        "no leading /, and no part that is empty, . or .."
    );
  });
});

describe("the hash that fixes a set", () => {
  it("is over one sha256sum line per file, in order of path as bytes, whatever order they were added in", () => {
    const files = [
      { path: "b.txt", sha256: sha256("b") },
      { path: "a/z.txt", sha256: sha256("z") },
      { path: "B.txt", sha256: sha256("B") },
      { path: "é.txt", sha256: sha256("é") },
    ];
    const lines =
      `${sha256("B")}  B.txt\n` + `${sha256("z")}  a/z.txt\n` + `${sha256("b")}  b.txt\n` + `${sha256("é")}  é.txt\n`;
    expect(manifestHash(files)).toBe(sha256(lines));
    expect(manifestHash([...files].reverse())).toBe(sha256(lines));
    // One byte of one file, or one path, and it is another set.
    expect(manifestHash([{ ...files[0]!, sha256: sha256("c") }, ...files.slice(1)])).not.toBe(sha256(lines));
    expect(manifestHash([{ ...files[0]!, path: "c.txt" }, ...files.slice(1)])).not.toBe(sha256(lines));
  });
});

describe("the addresses of what is kept", () => {
  it("name the set and the file as a reader would, and are not web addresses", () => {
    expect(keptFileAddress("eval-logs", "runs/run 7.jsonl")).toBe("fileset:eval-logs/runs/run%207.jsonl");
    expect(keptFileAddress("eval-logs", "a#b/c?.txt", { first: 4, last: 9 })).toBe("fileset:eval-logs/a%23b/c%3F.txt#L4-9");
    expect(analysisAddress("7b0c2c0e-1111-4222-8333-444455556666")).toBe("analysis:7b0c2c0e-1111-4222-8333-444455556666");
    expect(isKeptFileAddress("fileset:eval-logs/a.txt")).toBe(true);
    expect(isAnalysisAddress("analysis:x")).toBe(true);
    for (const other of ["https://example.org/a.txt", "file:///etc/passwd", "reading:warehouse/x"]) {
      expect(isKeptFileAddress(other), other).toBe(false);
      expect(isAnalysisAddress(other), other).toBe(false);
    }
    // The three kinds of kept address do not overlap.
    expect(isReadingAddress("analysis:x") || isReadingAddress("fileset:a/b")).toBe(false);
  });
});

describe("the tools", () => {
  it("are each classified, and a run that calls one has a private transcript", () => {
    expect([...FILE_SET_TOOL_NAMES].sort()).toEqual(["keep_analysis", "keep_file", "open_output", "run_command"]);
    for (const name of FILE_SET_TOOL_NAMES) {
      expect(TOOL_READS[name]?.reads, name).toBe("private");
      expect(toolPrivateReason(name), name).toBe(`tool:${name}`);
    }
  });
});

describe("what a person adding a set is told", () => {
  it("says a set is closed once filled, hashed, read by label, and whose stake is recorded", () => {
    expect(FILE_SET_NOTICE).toBe(
      "A file set is closed once its files are in: nothing in it is changed or removed afterwards, and new files " +
        "are a new set. Each file is hashed when it is added and the set has one hash over all of them, so what an " +
        "agent's analysis read can be checked later. Agents whose work is at a label that reads the set's label can " +
        "read every file in it, by running commands in a sandbox that has no network. The set belongs to the party " +
        "you name, and the stake you give for that party is recorded on every source an agent keeps from it, as a " +
        "fact about the source. A directory registered where it lies is not copied: keep it as it is, because a " +
        "file that no longer matches its hash cannot be kept as a source."
    );
  });
});

const SET: RunFileSet = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Refund ledger",
  slug: "refund-ledger",
  description: "",
  origin: "upload",
  storageKey: "refund-ledger",
  partyId: "22222222-2222-4222-8222-222222222222",
  partyName: "Halden Evaluations",
  stake: "Halden reports these figures on itself.",
  label: "internal",
  fileCount: 3,
  totalBytes: 48_200_000,
  manifestHash: "a".repeat(64),
  closedAt: new Date("2026-11-01T10:00:00.000Z"),
};

const HEALTH: SandboxHealth = {
  version: "1",
  image: "minerval-sandbox:1",
  python: "3.13.1",
  libraries: { numpy: "2.5.3", pandas: "3.0.5", sklearn: "1.9.1", bs4: "4.15.0", yaml: "6.0.3" },
  tools: ["rg", "jq", "sqlite3"],
  landlockAbi: 6,
  paths: { store: "/sets", directoryRoot: "/registered" },
  limits: { commandSeconds: 300, outputBytes: 2_000_000, memoryMb: 2048, scratchMb: 1024 },
};

describe("what a run is told", () => {
  it("is nothing where it has no set", () => {
    expect(fileSetsNote([], { health: HEALTH }, 50_000)).toBe("");
    expect(fileSetsNote([], { failure: { kind: "not_configured", message: "x" } }, 0)).toBe("");
  });

  it("names the libraries as they are installed, and where each kind of set is mounted", () => {
    const note = fileSetsNote(
      [SET, { ...SET, name: "Eval logs", origin: "directory", storageKey: "evals/2026-10", fileCount: 1, totalBytes: 512 }],
      { health: HEALTH },
      50_000
    );
    expect(note).toContain('- "Refund ledger", files of Halden Evaluations: 3 files, 48 MB, at /sets/refund-ledger.\n');
    expect(note).toContain('- "Eval logs", files of Halden Evaluations: 1 file, 512 bytes, at /registered/evals/2026-10.\n\n');
    expect(note).toContain(
      "The sandbox has Python 3.13.1 with numpy, pandas, scikit-learn, beautifulsoup4, PyYAML, and bash with the usual shell tools, among them rg, jq, sqlite3. It has no network, because"
    );
    expect(note).toContain("A command that has run for 300 seconds is stopped, because your run waits on it and every run shares the sandbox.");
    expect(note).toContain("A command that has printed 2,000,000 bytes is stopped, because its output is stored whole in one row");
  });

  it("says what the sandbox's time costs the run, at the rate the deployment set", () => {
    // The starting rate is the one the model provider's sandbox is charged at.
    expect(fileSetsNote([SET], { health: HEALTH }, 50_000)).toContain(
      "A command's time in the sandbox is charged to this run's budget at $0.05 an hour, so a few minutes of computation costs well under a cent."
    );
    expect(fileSetsNote([SET], { health: HEALTH }, 0)).toContain(
      "Time in the sandbox is not charged to this run's budget: it is this deployment's own machine."
    );
    expect(fileSetsNote([SET], { health: HEALTH }, 0)).not.toContain("charged to this run's budget at");
    expect(sandboxCostMicroUsd(3600, 50_000)).toBe(50_000);
    expect(sandboxCostMicroUsd(72, 50_000)).toBe(1000);
    expect(sandboxCostMicroUsd(30, 0)).toBe(0);
  });

  it("gives sizes as a person reads them", () => {
    expect([0, 1, 999, 1000, 4096, 48_200_000, 3_100_000_000, 2_500_000_000_000].map(sizeOf)).toEqual([
      "0 bytes", "1 byte", "999 bytes", "1.0 KB", "4.1 KB", "48 MB", "3.1 GB", "2.5 TB",
    ]);
  });
});

describe("how a command ended", () => {
  it("is said in words, with the limit that stopped it where one did", () => {
    const limits = HEALTH.limits;
    expect(endedLine("exited", 0, limits)).toBe("exit code 0");
    expect(endedLine("exited", 2)).toBe("exit code 2");
    expect(endedLine("timed_out", null, limits)).toBe("stopped at the time limit of 300 seconds, before it finished");
    expect(endedLine("memory", null, limits)).toBe("stopped for using more than the 2,048 MB of memory a command may use");
    expect(endedLine("output_ceiling", null, limits)).toBe(
      "stopped when its output passed 2,000,000 bytes; the output below is the part before that"
    );
    expect(endedLine("scratch_full", null, limits)).toBe("stopped when its scratch directory passed 1,024 MB");
    expect(endedLine("killed", null, limits)).toBe(
      "ended by the system and not by the command itself, which is what happens when the sandbox's machine runs out of memory"
    );
    // A kept analysis is written from the stored call, which does not hold the limits of the day.
    expect(endedLine("timed_out", null)).toBe("stopped at the time limit, before it finished");
  });
});

describe("the text of a kept source", () => {
  it("for an analysis with no set and no file given says so, and still names the sandbox", () => {
    expect(
      analysisDocument({
        calledAt: new Date("2026-11-12T01:46:13.412Z"),
        durationMs: null,
        sandboxVersion: null,
        sandboxImage: null,
        python: null,
        sets: [],
        files: [],
        ended: "timed_out",
        exitCode: null,
        written: [],
        writtenNotListed: 0,
        command: "sleep 600",
        outputSha256: sha256(""),
        output: "",
      })
    ).toBe(
      "An analysis run in this deployment's sandbox, which has no network.\n" +
        "Run: 2026-11-12T01:46:13.412Z\n" +
        "Sandbox: version not recorded, image not recorded, Python not recorded\n" +
        "The command could read no file set.\n" +
        "How it ended: stopped at the time limit, before it finished\n" +
        `Output SHA-256: ${sha256("")}\n\n` +
        "Command:\nsleep 600\n\n" +
        "Output:\n"
    );
  });

  it("for a file is the same for every run: nothing in it says who kept it or when", () => {
    const input = {
      setName: "Refund ledger",
      partyName: "Halden Evaluations",
      path: "ledger/refunds.csv",
      fileSha256: "b".repeat(64),
      bytes: 1234,
      manifestSha256: "a".repeat(64),
      addedAt: new Date("2026-11-01T10:00:00.000Z"),
      totalLines: 3,
      lines: { first: 2, last: 3 },
      content: "2026-09,412\n2026-10,388\n",
    };
    const text = fileDocument(input);
    expect(text).toBe(
      'A file of the file set "Refund ledger", files of Halden Evaluations.\n' +
        "Path: ledger/refunds.csv\n" +
        `File SHA-256: ${"b".repeat(64)} (1,234 bytes), taken when the set was added and matched when this was kept\n` +
        `Set manifest SHA-256: ${"a".repeat(64)}\n` +
        "Set closed: 2026-11-01T10:00:00.000Z\n" +
        "Lines 2 to 3 of 3, as they are in the file:\n\n" +
        "2026-09,412\n2026-10,388\n"
    );
    expect(fileDocument({ ...input })).toBe(text);
  });
});
