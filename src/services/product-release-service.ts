/**
 * Minerval's releases, as a deployment knows them (docs/releases.md).
 *
 * These are releases of the software, not the gate's releases of pages
 * (services/release-service.ts). A deployment knows of them from two
 * places:
 *
 *   The notes in its own image (`releases/`, src/release-notes.ts): every
 *   release up to the one it runs. From these alone it says, after an
 *   upgrade, what changed since the version it ran before.
 *
 *   The list of releases (product_release_entries): signed entries, each
 *   checked against the release key in the code (src/release-entries.ts).
 *   On the public graph the table is the list itself, filled by Minerval's
 *   release workflow through the operator route. Elsewhere it is the
 *   deployment's copy, read from the public graph once a day and when an
 *   administrator opens Health, or uploaded as a file where the deployment
 *   reaches nothing outside. From it the deployment says what is newer, and
 *   whether the release it runs was withdrawn.
 *
 * The read of the list is unsigned and says nothing: no key, no version,
 * nothing that names the deployment. The public graph learns that some
 * server read the list, which every reader of the site can do. The
 * comparison with the deployment's own version happens here.
 *
 * The tables carry no label. They are read and written on the owner's
 * connection: the worker that reads the list has no reader's clearance, and
 * Health reads them for the whole deployment.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { fixedOnTheMachine, loadConfig, storedSettings, type Config } from "../config.js";
import { appliedConfigFile } from "../config-file.js";
import { findSetting } from "../settings-registry.js";
import { readReleaseNotes, type ReleaseFacts } from "../release-notes.js";
import {
  latestRelease,
  listReleases,
  trustedKeys,
  verifyEntry,
  type EntryRefusal,
  type ListedRelease,
  type ReleaseEntry,
} from "../release-entries.js";
import { RELEASE_PUBLIC_KEYS } from "../release-key.js";
import { compareVersions, isDevVersion, lastWebVersion, releaseOf, runningVersion, type RunningVersion } from "../version.js";
import { logAdministrativeEvent } from "./permission-service.js";
import { passedThrough, upgradeFacts, versionsRun } from "./versions-service.js";
import type { KeyObject } from "node:crypto";

const RELEASES_REASON =
  "The list of Minerval's releases and the record of upgrade steps done are the deployment's own: they carry no label and name no row of the graph.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(RELEASES_REASON, fn);

/** How long the read of the list may take. A caller is waiting on Health. */
const LIST_TIMEOUT_MS = 8_000;
/** The most a list may weigh. A release's facts are a few kilobytes. */
const LIST_MAX_BYTES = 4_000_000;
/** How old the copy may be before opening Health reads the list again. */
export const RELEASES_RECHECK_ON_HEALTH_MS = 10 * 60_000;
const CHECK_FLAG = "releases_check";

// ---- the list ---------------------------------------------------------------------

interface EntryRow {
  payload: unknown;
  prose: string | null;
  signature: string;
  key_id: string;
}

export interface AcceptOutcome {
  /** Entries newly kept. */
  accepted: number;
  /** Entries this deployment already had. */
  already: number;
  /** Entries not kept, each with why. */
  refused: Array<{ version: string | null; code: EntryRefusal; message: string }>;
}

/**
 * Keep the entries that the release key signed. An entry is never changed:
 * one already kept is left as it is. Nothing unsigned, or signed by a key
 * this code does not have, is kept.
 */
export async function acceptReleaseEntries(
  inputs: readonly unknown[],
  keys: ReadonlyMap<string, KeyObject> = trustedKeys(RELEASE_PUBLIC_KEYS)
): Promise<AcceptOutcome> {
  const outcome: AcceptOutcome = { accepted: 0, already: 0, refused: [] };
  const checked: ReleaseEntry[] = [];
  for (const input of inputs) {
    const result = verifyEntry(input, keys);
    if (result.ok) {
      checked.push(result.entry);
    } else {
      const payload = (input as { payload?: { version?: unknown } } | null)?.payload;
      outcome.refused.push({
        version: typeof payload?.version === "string" ? payload.version : null,
        code: result.code,
        message: result.message,
      });
    }
  }
  if (checked.length === 0) return outcome;
  await asOwner(() =>
    withTransaction(async (tx) => {
      for (const entry of checked) {
        const revision = entry.payload.kind === "release" ? entry.payload.revision : 1;
        const kept = await tx.query(
          `INSERT INTO product_release_entries (version, kind, revision, payload, prose, signature, key_id)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
           ON CONFLICT (version, kind, revision) DO UPDATE
             SET prose = COALESCE(product_release_entries.prose, EXCLUDED.prose)
           WHERE product_release_entries.signature = EXCLUDED.signature
           RETURNING (xmax = 0) AS inserted`,
          [entry.payload.version, entry.payload.kind, revision, JSON.stringify(entry.payload), entry.prose ?? null, entry.signature, entry.key_id]
        );
        if ((kept[0] as { inserted?: boolean } | undefined)?.inserted) outcome.accepted += 1;
        else outcome.already += 1;
      }
    })
  );
  return outcome;
}

/**
 * The entries this deployment holds, each checked again against the keys
 * this code has: a key taken out of the code no longer vouches for
 * anything, whenever its entries were kept.
 */
export async function keptEntries(
  keys: ReadonlyMap<string, KeyObject> = trustedKeys(RELEASE_PUBLIC_KEYS)
): Promise<ReleaseEntry[]> {
  const rows = await asOwner(() =>
    rawQuery<EntryRow>(`SELECT payload, prose, signature, key_id FROM product_release_entries ORDER BY version, kind, revision`)
  );
  const entries: ReleaseEntry[] = [];
  for (const row of rows) {
    const checked = verifyEntry({ payload: row.payload, prose: row.prose, signature: row.signature, key_id: row.key_id }, keys);
    if (checked.ok) entries.push(checked.entry);
  }
  return entries;
}

/** The list as a reader is given it: each release at its latest revision, and the signed entries that say so, without prose. */
export async function publicReleaseList(): Promise<{ releases: ListedRelease[]; entries: ReleaseEntry[] }> {
  const entries = await keptEntries();
  return {
    releases: listReleases(entries),
    entries: entries.map(({ prose: _prose, ...entry }) => entry),
  };
}

/** One release with its prose, and every signed entry about it. Null where the list has none. */
export async function publicRelease(
  version: string
): Promise<{ release: ListedRelease; prose: string | null; entries: ReleaseEntry[] } | null> {
  const entries = (await keptEntries()).filter((e) => e.payload.version === version);
  const [release] = listReleases(entries);
  if (!release) return null;
  const shown = entries.find((e) => e.payload.kind === "release" && e.payload.revision === release.revision);
  return { release, prose: shown?.prose ?? null, entries };
}

// ---- reading the list from the public graph -----------------------------------------

export interface ListCheck {
  /** When the list was last asked for; null where it never was. */
  at: string | null;
  ok: boolean;
  /** Why the last read failed, in a sentence. */
  error: string | null;
}

async function lastCheck(): Promise<ListCheck> {
  const [row] = await asOwner(() => rawQuery<{ value: unknown }>(`SELECT value FROM platform_flags WHERE key = $1`, [CHECK_FLAG]));
  const value = row?.value as Partial<ListCheck> | undefined;
  return {
    at: typeof value?.at === "string" ? value.at : null,
    ok: value?.ok === true,
    error: typeof value?.error === "string" ? value.error : null,
  };
}

async function noteCheck(check: ListCheck): Promise<void> {
  await asOwner(() =>
    rawQuery(
      `INSERT INTO platform_flags (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [CHECK_FLAG, JSON.stringify(check)]
    )
  );
}

/** Whether the list this deployment would read is its own: it is then the list, and reads nothing. */
export function servesTheList(config: Pick<Config, "releasesUrl" | "publicApiBaseUrl">): boolean {
  try {
    return new URL(config.releasesUrl).host === new URL(config.publicApiBaseUrl).host;
  } catch {
    return false;
  }
}

/** Whether this deployment reads the list of releases from outside at all. */
export function readsTheList(config: Pick<Config, "releasesCheck" | "releasesUrl" | "publicApiBaseUrl"> = loadConfig()): boolean {
  return config.releasesCheck === "daily" && !servesTheList(config);
}

/**
 * Read the list from the public graph and keep what the release key signed.
 * Nothing is sent but the request for the list: no key, no version, no
 * header that names this deployment. With `maxAgeMs`, a copy read more
 * recently than that is left as it is.
 */
export async function checkForReleases(options: { maxAgeMs?: number; fetchList?: typeof fetch } = {}): Promise<ListCheck> {
  const config = loadConfig();
  const before = await lastCheck();
  if (!readsTheList(config)) return before;
  if (options.maxAgeMs !== undefined && before.at !== null && Date.now() - Date.parse(before.at) < options.maxAgeMs) {
    return before;
  }
  const check: ListCheck = { at: new Date().toISOString(), ok: false, error: null };
  try {
    const url = `${config.releasesUrl.replace(/\/$/, "")}/setup/releases`;
    const res = await (options.fetchList ?? fetch)(url, {
      // Asked as any reader would: nothing here says who asks or what they run.
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`the list answered ${res.status}`);
    const text = await res.text();
    if (text.length > LIST_MAX_BYTES) throw new Error("the list is larger than a list of releases is");
    const body = JSON.parse(text) as { entries?: unknown };
    if (!Array.isArray(body.entries)) throw new Error("the answer was not a list of releases");
    const outcome = await acceptReleaseEntries(body.entries);
    if (outcome.refused.length > 0 && outcome.accepted + outcome.already === 0) {
      throw new Error(`none of its ${outcome.refused.length} entries carries Minerval's signature as this version knows it: ${outcome.refused[0]!.message}`);
    }
    check.ok = true;
  } catch (err) {
    check.error = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);
  }
  await noteCheck(check).catch(() => undefined);
  return check;
}

// ---- what a release asks of this deployment -------------------------------------------

export interface RetiredStillSet {
  key: string;
  env: string;
  /** Where it is still set: the machine's environment or its config file. */
  where: "environment" | "file";
  replaced_by: string;
  note: string;
}

export interface DefaultPinned {
  key: string;
  env: string;
  from: string;
  to: string;
  why: string;
  /** Where the old default is pinned: the machine's environment or config file, or the app's settings. */
  where: "environment" | "file" | "app";
}

export interface SettingToLookAt {
  key: string;
  note: string;
  /** Whether anything sets it here. */
  set: boolean;
}

export interface ReleaseAsks {
  version: string;
  date: string;
  security: boolean;
  /** Each step the operator must take on the machine, with whether an administrator has marked it done. */
  operator_steps: Array<{ step: string; done: boolean; done_at: string | null; done_by: string | null }>;
  /** Settings the release retired that this deployment still sets. */
  retired_still_set: RetiredStillSet[];
  /** Defaults the release changed that this deployment pins to their old value. */
  defaults_pinned: DefaultPinned[];
  /** Settings the release added. */
  added: SettingToLookAt[];
}

/** The environment variable a release's notes name: by the registry where it knows the name, as written otherwise. */
function variableOf(name: string): { key: string; env: string } {
  const row = findSetting(name);
  if (row) return { key: row.key, env: row.env };
  return { key: name, env: /^[A-Z][A-Z0-9_]*$/.test(name) ? name : name.toUpperCase().replace(/[^A-Z0-9]+/g, "_") };
}

/** Where a variable is set on the machine, a retired one included: the registry's layering reads only settings that are read. */
function setOnTheMachine(env: string): "environment" | "file" | null {
  return fixedOnTheMachine(env);
}

type StepsDone = ReadonlyMap<string, { done_at: string; done_by: string | null }>;

/** What one release asks of this deployment, from its facts and what the deployment sets. */
export function releaseAsks(facts: ReleaseFacts, done: StepsDone = new Map()): ReleaseAsks {
  const stored = storedSettings().now;
  return {
    version: facts.version,
    date: facts.date,
    security: facts.security,
    operator_steps: facts.operator_steps.map((step) => {
      const at = done.get(`${facts.version}\n${step}`);
      return { step, done: at !== undefined, done_at: at?.done_at ?? null, done_by: at?.done_by ?? null };
    }),
    retired_still_set: facts.settings.retired.flatMap((line) => {
      const { key, env } = variableOf(line.key);
      const where = setOnTheMachine(env);
      return where ? [{ key, env, where, replaced_by: line.replaced_by, note: line.note }] : [];
    }),
    defaults_pinned: facts.settings.defaults_changed.flatMap((line) => {
      const { key, env } = variableOf(line.key);
      const onMachine = setOnTheMachine(env);
      const value = onMachine ? process.env[env] : stored[env];
      if (value === undefined || value.trim() !== line.from.trim()) return [];
      return [{ key, env, from: line.from, to: line.to, why: line.why, where: onMachine ?? ("app" as const) }];
    }),
    added: facts.settings.added.map((line) => {
      const { key, env } = variableOf(line.key);
      return { key, note: line.note, set: setOnTheMachine(env) !== null || stored[env] !== undefined };
    }),
  };
}

async function stepsDone(): Promise<StepsDone> {
  const rows = await asOwner(() =>
    rawQuery<{ version: string; step: string; done_at: Date; display_name: string | null }>(
      `SELECT d.version, d.step, d.done_at, c.display_name
         FROM release_steps_done d LEFT JOIN contributors c ON c.id = d.done_by`
    )
  );
  return new Map(rows.map((r) => [`${r.version}\n${r.step}`, { done_at: r.done_at.toISOString(), done_by: r.display_name }]));
}

export type StepFailure = "UNKNOWN_STEP";

/**
 * Mark an operator step of a release done. The step must be one the
 * release's notes give, in this image or on the list: a person says it was
 * done on the machine, and the log says who said so.
 */
export async function markReleaseStepDone(input: {
  version: string;
  step: string;
  actorId: string;
}): Promise<{ ok: true } | { ok: false; code: StepFailure; message: string }> {
  const step = input.step.trim();
  const fromImage = readReleaseNotes().notes.find((n) => n.facts.version === input.version)?.facts.operator_steps ?? [];
  const fromList = listReleases(await keptEntries()).find((r) => r.version === input.version)?.operator_steps ?? [];
  if (![...fromImage, ...fromList].includes(step)) {
    return { ok: false, code: "UNKNOWN_STEP", message: `Release ${input.version} has no such step.` };
  }
  await asOwner(() =>
    withTransaction(async (tx) => {
      const made = await tx.query(
        `INSERT INTO release_steps_done (version, step, done_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING version`,
        [input.version, step, input.actorId]
      );
      if (made.length > 0) {
        await logAdministrativeEvent(tx, "release_step_done", input.actorId, { version: input.version, step });
      }
    })
  );
  return { ok: true };
}

// ---- what Health shows ------------------------------------------------------------------

export interface VersionPart {
  /** What it runs, each part of the deployment. Null for a part not heard from. */
  running: RunningVersion & { since: string | null };
  parts: { api: string; web: string | null; sandbox: string | null };
  /** Whether this is a build of the main branch between releases: the notes below cover releases only. */
  dev: boolean;
  /** The version it ran before this one, and until when. Null where it has only run this one. */
  before: { version: string; until: string } | null;
  /** Each release between the version it ran before and the one it runs, oldest first, with what it asks. */
  changes: ReleaseAsks[];
  /** Notes in the image that could not be read. */
  notes_problems: string[];
  list: {
    /** Whether the deployment reads the list from outside, and from where. */
    check: "daily" | "never";
    reads: boolean;
    url: string;
    checked_at: string | null;
    error: string | null;
    /** How many releases its copy of the list holds. */
    known: number;
    /** How many release keys this version of Minerval has. With none, no entry of any list can be checked. */
    keys: number;
  };
  /** Set where the release it runs was withdrawn: said first, before anything else. */
  withdrawn: { date: string; reason: string; move_to: string } | null;
  /** The releases after this one, newest first, with what upgrading to each would ask. */
  newer: Array<ReleaseAsks & { withdrawn: boolean; upgrades_from: string | null }>;
  /** The newest release that is not withdrawn, where it is newer than this one. */
  latest: string | null;
  /** A release this deployment must go through first, where the latest cannot be reached from the version it runs. */
  through: string | null;
  /** The commands that upgrade to `latest`, or to `through` where there is one. */
  upgrade_commands: string[] | null;
}

/** What upgrading from `running` asks of `to`'s list: the oldest version each release can be reached from. */
function throughFirst(running: string, listed: readonly ListedRelease[], latest: ListedRelease): string | null {
  if (!latest.upgrades_from || compareVersions(running, latest.upgrades_from) >= 0) return null;
  // The newest release that this version can reach, and that can reach on from there.
  const reachable = listed
    .filter((r) => !r.withdrawn && compareVersions(r.version, running) > 0 && compareVersions(r.version, latest.version) < 0)
    .filter((r) => !r.upgrades_from || compareVersions(running, r.upgrades_from) >= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  return reachable[0]?.version ?? latest.upgrades_from;
}

/** The `version` part of the setup checklist: what the deployment runs, what changed, and what is newer. */
export async function versionPart(sandboxVersion: string | null = null): Promise<VersionPart> {
  const config = loadConfig();
  const running = runningVersion();
  const [runs, done, entries, check] = await Promise.all([
    versionsRun().catch(() => []),
    stepsDone().catch(() => new Map() as StepsDone),
    keptEntries().catch(() => [] as ReleaseEntry[]),
    lastCheck().catch((): ListCheck => ({ at: null, ok: false, error: null })),
  ]);
  const upgrade = upgradeFacts(running, runs);
  const image = readReleaseNotes();
  const changes = upgrade.before
    ? image.notes
        .filter((n) => passedThrough(n.facts.version, upgrade.before!.version, running.version))
        .map((n) => releaseAsks(n.facts, done))
    : [];
  const listed = listReleases(entries);
  const mine = releaseOf(running.version);
  const own = listed.find((r) => r.version === mine && !isDevVersion(running.version));
  const newer = listed.filter((r) => compareVersions(r.version, running.version) > 0);
  const latest = latestRelease(newer);
  const through = latest ? throughFirst(mine, listed, latest) : null;
  const target = through ?? latest?.version ?? null;
  return {
    running: upgrade.running,
    parts: { api: running.version, web: lastWebVersion(), sandbox: sandboxVersion },
    dev: isDevVersion(running.version),
    before: upgrade.before,
    changes,
    notes_problems: image.problems,
    list: {
      check: config.releasesCheck,
      reads: readsTheList(config),
      url: config.releasesUrl,
      checked_at: check.at,
      error: check.ok ? null : check.error,
      known: listed.length,
      keys: RELEASE_PUBLIC_KEYS.length,
    },
    withdrawn: own?.withdrawn ?? null,
    newer: newer.map((r) => ({
      ...releaseAsks(r, done),
      withdrawn: r.withdrawn !== null,
      upgrades_from: r.upgrades_from,
    })),
    latest: latest?.version ?? null,
    through,
    upgrade_commands: target
      ? ["git fetch --tags", `git checkout v${target}`, "docker compose build", "docker compose up -d"]
      : null,
  };
}

export interface ReleasesFacts {
  /** Whether the deployment reads the list from outside. */
  reads: boolean;
  check: "daily" | "never";
  /** Whether this deployment is the list. */
  serves: boolean;
  checkedAt: string | null;
  error: string | null;
  /** How many release keys this version has, and how many releases its copy of the list holds. */
  keys: number;
  known: number;
  /** Set where the release it runs was withdrawn. */
  withdrawn: { version: string; reason: string; move_to: string } | null;
  /** Security releases newer than the one it runs. */
  securityNewer: string[];
}

/** What the preflight's `releases` check looks at. */
export async function releasesFacts(): Promise<ReleasesFacts> {
  const config = loadConfig();
  const running = runningVersion();
  const [entries, check] = await Promise.all([keptEntries(), lastCheck()]);
  const listed = listReleases(entries);
  const own = isDevVersion(running.version) ? undefined : listed.find((r) => r.version === running.version);
  return {
    reads: readsTheList(config),
    check: config.releasesCheck,
    serves: servesTheList(config),
    checkedAt: check.at,
    error: check.ok ? null : check.error,
    keys: RELEASE_PUBLIC_KEYS.length,
    known: listed.length,
    withdrawn: own?.withdrawn ? { version: own.version, reason: own.withdrawn.reason, move_to: own.withdrawn.move_to } : null,
    securityNewer: listed
      .filter((r) => r.security && !r.withdrawn && compareVersions(r.version, running.version) > 0)
      .map((r) => r.version),
  };
}

/** Where the config file is, for a line that says where a setting is still set. */
export function configFileNamed(): string | null {
  return appliedConfigFile()?.path ?? null;
}

// ---- the daily read ----------------------------------------------------------------------

/**
 * Read the list once shortly after start and once a day from then on, where
 * the deployment reads it at all. A failed read is kept as the last check's
 * error, which Health shows; it is tried again the next day and whenever an
 * administrator opens Health.
 */
export function startReleaseCheck(options: { logger?: { error: (...args: unknown[]) => void } } = {}): { stop: () => void } {
  if (!readsTheList()) return { stop: () => {} };
  const read = () =>
    void checkForReleases().then(
      (check) => {
        if (!check.ok && check.error) options.logger?.error(`[releases] the list of releases could not be read: ${check.error}`);
      },
      (err) => options.logger?.error("[releases] reading the list of releases failed:", err)
    );
  const first = setTimeout(read, 30_000);
  first.unref();
  const timer = setInterval(read, 24 * 3_600_000);
  timer.unref();
  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
