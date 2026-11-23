/**
 * Release notes and the signed list of releases (src/release-notes.ts,
 * src/release-entries.ts; docs/releases.md). The facts at the top of a
 * release's notes are what a deployment acts on, so they are held to the
 * code: no setting is added, retired or given a new default without a line
 * in releases/next.md saying so.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFieldDefault } from "../../src/config.js";
import {
  ReleaseNotesError,
  parseNextNotes,
  parseReleaseNotes,
  readReleaseNotes,
  renderReleaseNotes,
  settingsDifference,
  snapshotSettings,
  unsaidSettingChanges,
  type ReleaseFacts,
  type SettingsSnapshot,
} from "../../src/release-notes.js";
import {
  latestRelease,
  listReleases,
  releasePayload,
  signEntry,
  trustedKeys,
  verifyEntry,
  type WithdrawalPayload,
} from "../../src/release-entries.js";
import { RELEASE_PUBLIC_KEYS } from "../../src/release-key.js";
import { publicKeyString } from "../../src/services/mirror-batch.js";
import { VERSION_PATTERN, compareVersions } from "../../src/version.js";

const ROOT = resolve(__dirname, "..", "..");
const RELEASES = join(ROOT, "releases");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const FACTS: ReleaseFacts = {
  version: "0.5.0",
  date: "2026-12-02",
  security: false,
  upgrades_from: "0.3.0",
  settings: {
    added: [{ key: "models.redactor", note: "The Redactor's model. Left unset it runs on the Steward's." }],
    retired: [{ key: "PUBLIC_GRAPH_API_KEY", replaced_by: "the connection to minerval.ai", note: "Read by nothing. Delete it from .env." }],
    defaults_changed: [{ key: "run_log.retention_days", from: "0", to: "90", why: "Logs of runs that wrote nothing were kept for ever." }],
  },
  operator_steps: ["Rebuild all three images; the sandbox's changed."],
};

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ReleaseNotesError) return [...err.problems];
    throw err;
  }
  throw new Error("expected the notes to be refused");
}

describe("the notes in the repository", () => {
  const snapshot = JSON.parse(read("releases/settings.json")) as SettingsSnapshot;
  const next = parseNextNotes(read("releases/next.md"));

  it("read, every release's and the next one's", () => {
    const { notes, problems } = readReleaseNotes(RELEASES);
    expect(problems).toEqual([]);
    for (const n of notes) expect(n.prose.length, n.facts.version).toBeGreaterThan(20);
    expect(next.prose.length).toBeGreaterThan(20);
  });

  it("say every setting added, retired or given a new default since the last release", () => {
    const now = snapshotSettings(null, configFieldDefault);
    expect(
      unsaidSettingChanges(settingsDifference(snapshot, now), next.facts, snapshot),
      "A setting changed and releases/next.md does not say so. Add its line under settings.added, settings.retired or " +
        "settings.defaults_changed: it is what tells a deployment's operator what an upgrade asks of them (docs/releases.md)."
    ).toEqual([]);
  });

  it("keep the settings of the last release as the release wrote them", () => {
    const { notes } = readReleaseNotes(RELEASES);
    const newest = notes[notes.length - 1]?.facts.version ?? null;
    expect(snapshot.version).toBe(newest);
    expect(snapshot.settings.map((s) => s.key)).toEqual([...snapshot.settings.map((s) => s.key)].sort());
    expect(snapshot.settings.length).toBeGreaterThan(250);
  });

  it("merge two pull requests' lines in next.md without a conflict, and travel in the API's image", () => {
    expect(read(".gitattributes")).toMatch(/^releases\/next\.md merge=union$/m);
    expect(read("Dockerfile")).toMatch(/^COPY releases\/ \.\/releases\/$/m);
    expect(read(".dockerignore")).not.toMatch(/^releases/m);
  });
});

describe("a release's notes", () => {
  it("are written and read back the same", () => {
    const text = renderReleaseNotes(FACTS, "## What is new\n\nA thing.");
    expect(parseReleaseNotes(text)).toEqual({ facts: FACTS, prose: "## What is new\n\nA thing." });
    const { version: _v, date: _d, ...rest } = FACTS;
    expect(parseNextNotes(renderReleaseNotes(rest, "Prose."))).toEqual({ facts: rest, prose: "Prose." });
  });

  it("read the form a person writes by hand", () => {
    const notes = parseReleaseNotes(
      [
        "---",
        "version: 0.5.0",
        "date: 2026-12-02",
        "security: true",
        "upgrades_from: 0.3.0",
        "settings:",
        "  defaults_changed:",
        "    - key: run_log.retention_days",
        "      from: 0",
        "      to: 90",
        "      why: Logs of runs that wrote nothing were kept for ever.",
        "operator_steps:",
        "  - Rebuild all three images.",
        "---",
        "",
        "## What is new",
      ].join("\n")
    );
    expect(notes.facts).toMatchObject({
      version: "0.5.0",
      date: "2026-12-02",
      security: true,
      settings: { added: [], retired: [], defaults_changed: [{ key: "run_log.retention_days", from: "0", to: "90" }] },
      operator_steps: ["Rebuild all three images."],
    });
  });

  it("are refused with everything wrong at once", () => {
    expect(problemsOf(() => parseReleaseNotes("# No facts"))).toEqual([
      "It must begin with the block of facts, between two lines of `---`.",
    ]);
    const wrong = problemsOf(() =>
      parseReleaseNotes(
        "---\nversion: 0.5\ndate: December\nsecurity: maybe\nextra: 1\nsettings:\n  added:\n    - note: no key\noperator_steps: do it\n---\n"
      )
    );
    expect(wrong.join("\n")).toMatch(/`extra` is not one of the facts/);
    expect(wrong.join("\n")).toMatch(/`version` must be a release/);
    expect(wrong.join("\n")).toMatch(/`date` must be the day/);
    expect(wrong.join("\n")).toMatch(/`security` must be true or false/);
    expect(wrong.join("\n")).toMatch(/settings\.added\[1\] needs `key`/);
    expect(wrong.join("\n")).toMatch(/`operator_steps` must be a list of sentences/);
    expect(problemsOf(() => parseNextNotes("---\nversion: 0.5.0\nsecurity: false\n---\n")).join(" ")).toMatch(/carry no `version`/);
  });
});

describe("what the next release's notes must say about the settings", () => {
  const before: SettingsSnapshot = {
    version: "0.4.0",
    settings: [
      { key: "models.steward", env: "STEWARD_MODEL", default: "claude-sonnet-5-5" },
      { key: "run_log.retention_days", env: "TRACE_RETENTION_DAYS", default: "30" },
      { key: "old.thing", env: "OLD_THING", default: null },
    ],
  };
  const now: SettingsSnapshot = {
    version: null,
    settings: [
      { key: "models.steward", env: "STEWARD_MODEL", default: "claude-sonnet-5-5" },
      { key: "run_log.retention_days", env: "TRACE_RETENTION_DAYS", default: "90" },
      { key: "models.redactor", env: "REDACTOR_MODEL", default: null },
    ],
  };
  const difference = settingsDifference(before, now);
  const none = { settings: { added: [], retired: [], defaults_changed: [] } };

  it("finds each difference between the last release and now", () => {
    expect(difference.added.map((s) => s.key)).toEqual(["models.redactor"]);
    expect(difference.retired.map((s) => s.key)).toEqual(["old.thing"]);
    expect(difference.defaults_changed).toEqual([{ key: "run_log.retention_days", env: "TRACE_RETENTION_DAYS", from: "30", to: "90" }]);
  });

  it("names each one the notes leave out", () => {
    const unsaid = unsaidSettingChanges(difference, none, before);
    expect(unsaid).toHaveLength(3);
    expect(unsaid.join("\n")).toMatch(/models\.redactor \(REDACTOR_MODEL\) is a new setting/);
    expect(unsaid.join("\n")).toMatch(/old\.thing \(OLD_THING\) is no longer read/);
    expect(unsaid.join("\n")).toMatch(/default of run_log\.retention_days \(TRACE_RETENTION_DAYS\) changed from "30" to "90"/);
  });

  it("is satisfied by a line for each, by the file's name or the variable, and holds the line's figures to the code", () => {
    const said = {
      settings: {
        added: [{ key: "REDACTOR_MODEL", note: "n" }],
        retired: [{ key: "old.thing", replaced_by: "nothing", note: "n" }],
        defaults_changed: [{ key: "run_log.retention_days", from: "30", to: "90", why: "w" }],
      },
    };
    expect(unsaidSettingChanges(difference, said, before)).toEqual([]);
    said.settings.defaults_changed[0]!.from = "0";
    expect(unsaidSettingChanges(difference, said, before).join(" ")).toMatch(/it went from "30" to "90"/);
  });

  it("refuses a line that names no setting", () => {
    const invented = { settings: { added: [{ key: "models.nobody", note: "n" }], retired: [{ key: "never.was", replaced_by: "x", note: "n" }], defaults_changed: [] } };
    const problems = unsaidSettingChanges({ added: [], retired: [], defaults_changed: [] }, invented, before);
    expect(problems.join("\n")).toMatch(/settings\.added names models\.nobody, which is not a setting/);
    expect(problems.join("\n")).toMatch(/settings\.retired names never\.was, which is not a setting the last release had/);
  });
});

describe("the signed list of releases", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keys = trustedKeys([publicKeyString(publicKey)]);
  const prose = "## What is new\n\nA thing.";
  const entry = signEntry(releasePayload(FACTS, prose), privateKey, prose);

  it("has only whole Ed25519 keys in the code, which every release is checked against", () => {
    for (const key of RELEASE_PUBLIC_KEYS) expect(Buffer.from(key, "base64")).toHaveLength(32);
    expect(trustedKeys(RELEASE_PUBLIC_KEYS).size).toBe(RELEASE_PUBLIC_KEYS.length);
  });

  it("accepts an entry the release key signed, with its prose", () => {
    const checked = verifyEntry(JSON.parse(JSON.stringify(entry)), keys);
    expect(checked).toMatchObject({ ok: true, entry: { payload: { version: "0.5.0", revision: 1 }, prose } });
  });

  it("refuses an entry whose facts, prose or signer are not Minerval's", () => {
    const changed = JSON.parse(JSON.stringify(entry));
    changed.payload.security = true;
    expect(verifyEntry(changed, keys)).toMatchObject({ ok: false, code: "BAD_SIGNATURE" });

    expect(verifyEntry({ ...entry, prose: "Other words." }, keys)).toMatchObject({ ok: false, code: "PROSE_CHANGED" });

    const other = generateKeyPairSync("ed25519");
    expect(verifyEntry(signEntry(releasePayload(FACTS, prose), other.privateKey, prose), keys)).toMatchObject({
      ok: false,
      code: "UNKNOWN_KEY",
    });
    // With no key in the code, nothing verifies.
    expect(verifyEntry(entry, trustedKeys([]))).toMatchObject({ ok: false, code: "UNKNOWN_KEY" });

    expect(verifyEntry({ payload: { kind: "release", version: "0.5" }, signature: "x", key_id: "y" }, keys)).toMatchObject({
      ok: false,
      code: "MALFORMED",
    });
    expect(verifyEntry("nonsense", keys)).toMatchObject({ ok: false, code: "MALFORMED" });
  });

  it("shows each release at its latest revision, newest first, with what was corrected and what was withdrawn", () => {
    const older = signEntry(releasePayload({ ...FACTS, version: "0.4.1", date: "2026-11-20" }, "Older."), privateKey);
    const corrected = signEntry(
      releasePayload({ ...FACTS, security: true }, prose, 2, { what: "Marked as a security release.", why: "It fixes an exposure." }),
      privateKey
    );
    const newest = signEntry(releasePayload({ ...FACTS, version: "0.6.0", date: "2026-12-20" }, "Newest."), privateKey);
    const withdrawal: WithdrawalPayload = { kind: "withdrawal", version: "0.6.0", date: "2026-12-21", reason: "It loses work at restart.", move_to: "0.6.1" };
    const listed = listReleases([older, entry, corrected, newest, signEntry(withdrawal, privateKey)]);

    expect(listed.map((r) => r.version)).toEqual(["0.6.0", "0.5.0", "0.4.1"]);
    expect(listed[0]!.withdrawn).toEqual({ date: "2026-12-21", reason: "It loses work at restart.", move_to: "0.6.1" });
    expect(listed[1]).toMatchObject({
      revision: 2,
      security: true,
      corrections: [{ revision: 2, what: "Marked as a security release.", why: "It fixes an exposure." }],
      withdrawn: null,
    });
    // The newest that is not withdrawn.
    expect(latestRelease(listed)?.version).toBe("0.5.0");
    // A withdrawal is signed too.
    const forged = { ...signEntry(withdrawal, privateKey), payload: { ...withdrawal, version: "0.5.0" } };
    expect(verifyEntry(forged, keys)).toMatchObject({ ok: false, code: "BAD_SIGNATURE" });
  });

  it("orders by version, not by when an entry arrived", () => {
    expect(["0.10.0", "0.9.0"].sort(compareVersions)).toEqual(["0.9.0", "0.10.0"]);
    expect("0.5.0").toMatch(VERSION_PATTERN);
  });
});
