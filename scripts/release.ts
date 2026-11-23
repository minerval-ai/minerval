/**
 * Versions and releases, by hand (docs/releases.md).
 *
 *   npm run version:set -- <version>
 *       Write the version in every part at once: package.json and its lock,
 *       web/package.json and its lock, sandbox/MINERVAL_VERSION and the
 *       plugin's manifest. `0.5.0` for a release, `0.6.0-dev` for main
 *       between releases.
 *
 *   npm run release:check
 *       What the tests check, said here: that the notes of every release
 *       read, that releases/next.md lists every setting added, retired or
 *       given a new default since the last release, and that the parts
 *       agree on the version. Exits 1 if anything is wrong.
 *
 *   npm run release:settings
 *       Print the settings as releases/settings.json would hold them now.
 *       The file itself is rewritten only when a release is cut.
 *
 *   npm run release:cut -- <version> [--date=YYYY-MM-DD]
 *       Cut a release from this checkout: releases/next.md becomes
 *       releases/<version>.md with its version and day, a new next.md is
 *       started, releases/settings.json is rewritten from the registry, and
 *       the version is written in every part. Commits nothing and tags
 *       nothing: it prints the commands that do.
 *
 *   npm run release:sign -- keygen
 *       A new Ed25519 release key. Prints the private key (for the release
 *       workflow's RELEASE_SIGNING_KEY, a secret) and the public half (for
 *       src/release-key.ts). Writes nothing.
 *   npm run release:sign -- entries [<version> ...] [--out=<file>]
 *       Sign an entry for each release named (every one in releases/ when
 *       none is), at revision 1, with RELEASE_SIGNING_KEY. Prints the list
 *       as JSON, or writes it to a file: what POST /operator/releases takes,
 *       and what a deployment that reaches nothing outside is given to
 *       upload.
 *   npm run release:sign -- correct <version> --revision=<n> --what=<text> --why=<text>
 *       Sign a correction: the release's notes as they now are, as the next
 *       revision, with what changed and why.
 *   npm run release:sign -- withdraw <version> --reason=<text> --move-to=<version> [--date=YYYY-MM-DD]
 *       Sign a withdrawal.
 *   npm run release:sign -- post <file> --url=<the public graph's API>
 *       Send a file of signed entries to POST /operator/releases, with
 *       MINERVAL_OPERATOR_KEY.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFieldDefault } from "../src/config.js";
import { generateSigningKey, parseSigningKey } from "../src/services/mirror-batch.js";
import { releasePayload, signEntry, type ReleaseEntry, type WithdrawalPayload } from "../src/release-entries.js";
import {
  ReleaseNotesError,
  parseNextNotes,
  parseReleaseNotes,
  readReleaseNotes,
  renderReleaseNotes,
  settingsDifference,
  snapshotSettings,
  unsaidSettingChanges,
  type SettingsSnapshot,
} from "../src/release-notes.js";
import { VERSION_PATTERN, compareVersions } from "../src/version.js";

const ROOT = resolve(import.meta.dirname, "..");
const RELEASES = join(ROOT, "releases");
const at = (path: string) => join(ROOT, path);

const NEXT_PROSE = "## What is new\n\nNothing yet.";

/** The files that state the version, each with how it is read and written. */
const VERSION_FILES: ReadonlyArray<{ path: string; read: (text: string) => string; write: (text: string, version: string) => string }> = [
  ...["package.json", "web/package.json", "plugin/.claude-plugin/plugin.json"].map((path) => ({
    path,
    read: (text: string) => (JSON.parse(text) as { version: string }).version,
    // The first "version" in the file is the package's own.
    write: (text: string, version: string) => text.replace(/"version": "[^"]*"/, `"version": "${version}"`),
  })),
  ...["package-lock.json", "web/package-lock.json"].map((path) => ({
    path,
    read: (text: string) => (JSON.parse(text) as { version: string }).version,
    // A lock states it twice: for the file and for the root package.
    write: (text: string, version: string) => {
      let seen = 0;
      return text.replace(/"version": "[^"]*"/g, (found) => (seen++ < 2 ? `"version": "${version}"` : found));
    },
  })),
  { path: "sandbox/MINERVAL_VERSION", read: (text) => text.trim(), write: (_text, version) => `${version}\n` },
];

function flag(name: string): string | null {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

const positional = (): string[] => process.argv.slice(3).filter((a) => !a.startsWith("--"));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function setVersion(version: string): void {
  if (!VERSION_PATTERN.test(version) || /-dev\./.test(version)) {
    fail(`A version is written MAJOR.MINOR.PATCH, with -dev for main between releases; got ${JSON.stringify(version)}.`);
  }
  for (const file of VERSION_FILES) {
    const text = readFileSync(at(file.path), "utf8");
    writeFileSync(at(file.path), file.write(text, version));
    console.log(`${file.path}: ${version}`);
  }
}

function currentSnapshot(version: string | null): SettingsSnapshot {
  return snapshotSettings(version, configFieldDefault);
}

function readSnapshot(): SettingsSnapshot {
  return JSON.parse(readFileSync(join(RELEASES, "settings.json"), "utf8")) as SettingsSnapshot;
}

/** Everything wrong with the notes and the versions, as sentences. */
function problems(): string[] {
  const found: string[] = [];
  const versions = VERSION_FILES.map((f) => `${f.read(readFileSync(at(f.path), "utf8"))}`);
  if (new Set(versions).size > 1) {
    found.push(`The parts do not agree on the version: ${VERSION_FILES.map((f, i) => `${f.path} says ${versions[i]}`).join(", ")}. Run npm run version:set.`);
  }
  found.push(...readReleaseNotes(RELEASES).problems);
  try {
    const next = parseNextNotes(readFileSync(join(RELEASES, "next.md"), "utf8"));
    const before = readSnapshot();
    found.push(...unsaidSettingChanges(settingsDifference(before, currentSnapshot(null)), next.facts, before));
  } catch (err) {
    found.push(err instanceof Error ? err.message : String(err));
  }
  return found;
}

function cut(version: string): void {
  if (!VERSION_PATTERN.test(version) || version.includes("-dev")) fail(`A release is written MAJOR.MINOR.PATCH; got ${JSON.stringify(version)}.`);
  const date = flag("date") ?? new Date().toISOString().slice(0, 10);
  const { notes } = readReleaseNotes(RELEASES);
  const newest = notes[notes.length - 1]?.facts.version;
  if (newest && compareVersions(version, newest) <= 0) fail(`${version} is not after the newest release, ${newest}.`);
  if (existsSync(join(RELEASES, `${version}.md`))) fail(`releases/${version}.md is already there.`);
  const wrong = problems().filter((p) => !p.startsWith("The parts do not agree"));
  if (wrong.length > 0) fail(`The release is not cut, because the notes are not right:\n${wrong.map((p) => `  - ${p}`).join("\n")}`);

  const next = parseNextNotes(readFileSync(join(RELEASES, "next.md"), "utf8"));
  if (next.prose.trim() === NEXT_PROSE) fail("releases/next.md still says nothing is new. Write what a person reads about this release first.");
  renameSync(join(RELEASES, "next.md"), join(RELEASES, `${version}.md`));
  writeFileSync(join(RELEASES, `${version}.md`), renderReleaseNotes({ version, date, ...next.facts }, next.prose));
  writeFileSync(
    join(RELEASES, "next.md"),
    renderReleaseNotes(
      { security: false, upgrades_from: next.facts.upgrades_from, settings: { added: [], retired: [], defaults_changed: [] }, operator_steps: [] },
      NEXT_PROSE
    )
  );
  writeFileSync(join(RELEASES, "settings.json"), `${JSON.stringify(currentSnapshot(version), null, 2)}\n`);
  setVersion(version);
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  console.log(
    [
      "",
      `Release ${version} is cut in this checkout. Read releases/${version}.md once more, then:`,
      "",
      `  git add -A && git commit -m "Release ${version}"`,
      `  git tag v${version}`,
      `  git push origin HEAD v${version}`,
      "",
      "The tag starts the release workflow, which signs the release and puts it on the list.",
      `Afterwards main carries the next version: npm run version:set -- ${major}.${minor + 1}.0-dev   (or ${major}.${minor}.${patch + 1}-dev)`,
    ].join("\n")
  );
}

function signingKey() {
  const pem = process.env.RELEASE_SIGNING_KEY ?? "";
  if (!pem.trim()) fail("RELEASE_SIGNING_KEY is not set: the release key's private half, as PEM.");
  return parseSigningKey(pem.replace(/\\n/g, "\n"), "RELEASE_SIGNING_KEY");
}

function notesOf(version: string) {
  const path = join(RELEASES, `${version}.md`);
  if (!existsSync(path)) fail(`releases/${version}.md is not there.`);
  return parseReleaseNotes(readFileSync(path, "utf8"), `releases/${version}.md`);
}

function emit(entries: ReleaseEntry[]): void {
  const text = `${JSON.stringify({ entries }, null, 2)}\n`;
  const out = flag("out");
  if (out) {
    writeFileSync(resolve(out), text);
    console.error(`Wrote ${entries.length} signed ${entries.length === 1 ? "entry" : "entries"} to ${out}.`);
  } else {
    process.stdout.write(text);
  }
}

async function sign(): Promise<void> {
  const [what, ...rest] = positional();
  if (what === "keygen") {
    const { privateKeyPem, publicKey, keyId } = generateSigningKey();
    console.log(
      [
        "The private half, for the release workflow's RELEASE_SIGNING_KEY. A secret: it is what makes a release Minerval's.",
        "",
        privateKeyPem.trim(),
        "",
        "The public half, for RELEASE_PUBLIC_KEYS in src/release-key.ts:",
        "",
        `  "${publicKey}",`,
        "",
        `Its id: ${keyId}`,
      ].join("\n")
    );
    return;
  }
  if (what === "entries") {
    const versions = rest.length > 0 ? rest : readReleaseNotes(RELEASES).notes.map((n) => n.facts.version);
    const key = signingKey();
    emit(versions.map((v) => {
      const { facts, prose } = notesOf(v);
      return signEntry(releasePayload(facts, prose), key, prose);
    }));
    return;
  }
  if (what === "correct") {
    const [version] = rest;
    const revision = Number(flag("revision"));
    const changed = flag("what");
    const why = flag("why");
    if (!version || !Number.isInteger(revision) || revision < 2 || !changed || !why) {
      fail("A correction names the release, --revision (2 or more), --what changed and --why.");
    }
    const { facts, prose } = notesOf(version);
    emit([signEntry(releasePayload(facts, prose, revision, { what: changed, why }), signingKey(), prose)]);
    return;
  }
  if (what === "withdraw") {
    const [version] = rest;
    const reason = flag("reason");
    const moveTo = flag("move-to");
    if (!version || !reason || !moveTo) fail("A withdrawal names the release, --reason and --move-to, the version to move to.");
    const payload: WithdrawalPayload = {
      kind: "withdrawal",
      version,
      date: flag("date") ?? new Date().toISOString().slice(0, 10),
      reason,
      move_to: moveTo,
    };
    emit([signEntry(payload, signingKey())]);
    return;
  }
  if (what === "post") {
    const [file] = rest;
    const url = flag("url");
    const operatorKey = process.env.MINERVAL_OPERATOR_KEY ?? "";
    if (!file || !url) fail("post takes the file of signed entries and --url, the public graph's API.");
    if (!operatorKey) fail("MINERVAL_OPERATOR_KEY is not set.");
    const res = await fetch(`${url.replace(/\/$/, "")}/operator/releases`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-operator-key": operatorKey },
      body: readFileSync(resolve(file), "utf8"),
    });
    const body = await res.text();
    if (!res.ok) fail(`The list did not take the entries (${res.status}): ${body.slice(0, 2000)}`);
    console.log(body);
    return;
  }
  fail("sign takes keygen, entries, correct, withdraw or post.");
}

async function main(): Promise<void> {
  const command = process.argv[2];
  try {
    if (command === "set") {
      const [version] = positional();
      if (!version) fail("Give the version.");
      setVersion(version);
    } else if (command === "check") {
      const found = problems();
      if (found.length > 0) fail(found.map((p) => `- ${p}`).join("\n"));
      console.log("The release notes read, next.md says every change to the settings, and the parts agree on the version.");
    } else if (command === "settings") {
      process.stdout.write(`${JSON.stringify(currentSnapshot(readSnapshot().version), null, 2)}\n`);
    } else if (command === "cut") {
      const [version] = positional();
      if (!version) fail("Give the version to cut.");
      cut(version);
    } else if (command === "sign") {
      await sign();
    } else {
      fail("release takes set, check, settings, cut or sign. The comment at the top of scripts/release.ts says what each does.");
    }
  } catch (err) {
    if (err instanceof ReleaseNotesError) fail(err.message);
    throw err;
  }
}

void main();
