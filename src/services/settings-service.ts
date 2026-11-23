/**
 * The settings an administrator changes in the app (docs/settings.md).
 *
 * A setting that is a choice about how the deployment works is the
 * administrators': they set it here, each change is logged, and most are in
 * force within seconds. What they set is a row in deployment_settings, one
 * for each setting, keyed by its name in the registry
 * (src/settings-registry.ts). A setting with no row is on its default.
 *
 * Four layers decide a value, the first that has one winning: the machine's
 * environment, its config file, this table, the code's default
 * (src/config.ts, "The layers"). The first two are whoever runs the
 * machine's, and either fixes the setting: it is shown here with where it
 * comes from, and it is not changed here.
 *
 * Reading the table is how a change takes effect without a restart. Every
 * process keeps the last copy it read and reads the table again every
 * STORED_SETTINGS_RECHECK_MS (startStoredSettings), so a change made in one
 * process is in force in every other within that time, and at once in the
 * process that made it. A setting that is read only where a process starts
 * (its `applies` is "restart") is saved and waits: the process keeps the
 * value it started with.
 *
 * A key someone outside issued (a model provider's, Stripe's) is kept
 * sealed under CREDENTIAL_ENCRYPTION_KEY, the way a connection's credential
 * is, and is never read back: the listing says that one is set, its last
 * four characters, who set it and when.
 *
 * The table is the owner's alone (db/enforcement, owner_only), so it is
 * read and written on the owner's connection once the route has checked the
 * administrator.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import {
  configFieldDefault,
  configFieldProblem,
  configProblem,
  configWith,
  fixedOnTheMachine,
  loadConfig,
  modelsNobodyChose,
  noteStoredSettings,
  storedSettings,
  storedSettingsProblem,
  type Config,
} from "../config.js";
import {
  ConfigFileError,
  appliedConfigFile,
  fromEnvironmentText,
  settingsToEnvironment,
  type ConfigFileValue,
} from "../config-file.js";
import {
  SETTINGS,
  editDistance,
  findSetting,
  settingGroup,
  type Setting,
} from "../settings-registry.js";
import { CREDENTIAL_KEY_ENV, credentialKeys, openCredential, sealCredential } from "./connection-credential.js";
import { logAdministrativeEvent } from "./permission-service.js";
import { labelsBesidesPublic } from "./label-service.js";
import { endpointKeysMissing, evaluatePreflight, gatherPreflightFacts, type PreflightCheckResult } from "../preflight.js";

/**
 * How old a process's copy of the stored settings may be before it reads
 * the table again. It bounds how long a change made in one process takes to
 * be in force in another. The read is one small table.
 */
export const STORED_SETTINGS_RECHECK_MS = 5_000;

/** The longest key an administrator may give, as a connection's credential is bounded. */
export const SETTING_SECRET_MAX_CHARS = 8192;

/** The longest reason kept with a change. */
export const SETTING_REASON_MAX_CHARS = 500;

const SETTINGS_REASON =
  "The deployment's settings are the owner's alone, sealed keys among them, so they are read and written on the owner's connection. A write's caller has checked that the actor administers the deployment.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(SETTINGS_REASON, fn);

/** The name a key given for one of the deployment's own model endpoints is stored under: its variable's. */
const ENDPOINT_KEY_PREFIX = "endpoint_keys.";

interface StoredRow {
  key: string;
  value: string | null;
  sealed_value: string | null;
  last_four: string | null;
  set_by: string | null;
  set_by_name: string | null;
  set_at: Date;
}

/** What the listing says of a stored row besides its value. */
interface StoredMeta {
  lastFour: string | null;
  setBy: { id: string; name: string } | null;
  setAt: Date;
  /** A sealed key that the keys set now do not open: it is set, and not in force. */
  unopened: boolean;
}

/** This process's copy of who set what and when, read with the values. Nothing here is a labelled row. */
let storedMeta = new Map<string, StoredMeta>();
let storedReadAt: number | null = null;

const binding = (key: string) => ({ connectionId: `setting:${key}`, url: key, transport: "setting" });

function seal(key: string, secret: string): { ok: true; sealed: string } | { ok: false; message: string } {
  const sealed = sealCredential(secret, binding(key));
  if (!sealed.ok) {
    return {
      ok: false,
      message:
        `This deployment has no key to keep a secret with: ${CREDENTIAL_KEY_ENV} is not set where it runs, or is not a key. ` +
        `Whoever runs the deployment sets it and starts it again; until then the key can be given in the machine's environment.`,
    };
  }
  return { ok: true, sealed: `${sealed.value.keyId}:${sealed.value.sealed}` };
}

function open(key: string, stored: string): string | null {
  const colon = stored.indexOf(":");
  if (colon < 0) return null;
  const opened = openCredential({ keyId: stored.slice(0, colon), sealed: stored.slice(colon + 1) }, binding(key));
  return opened.ok ? opened.credential : null;
}

/** The environment variable a stored row stands for; null for a row this build has no use for. */
function variableOf(key: string): { env: string; row: Setting | null } | null {
  if (key.startsWith(ENDPOINT_KEY_PREFIX)) return { env: key.slice(ENDPOINT_KEY_PREFIX.length), row: null };
  const row = findSetting(key);
  // A setting that stays on the machine is never read from the table,
  // whatever it holds; nor is one this build has retired or does not know.
  if (!row || row.retired || row.where === "machine") return null;
  return { env: row.env, row };
}

/**
 * Read the stored settings and hand them to the configuration as this
 * process's copy. Returns why they are not in force, or null.
 */
export async function readStoredSettings(): Promise<string | null> {
  const { rows, privateLabels } = await asOwner(async () => ({
    rows: await rawQuery<StoredRow>(
      `SELECT s.key, s.value, s.sealed_value, s.last_four, s.set_by, c.display_name AS set_by_name, s.set_at
         FROM deployment_settings s
         LEFT JOIN contributors c ON c.id = s.set_by
        ORDER BY s.key`
    ),
    privateLabels: (await labelsBesidesPublic()).length > 0,
  }));
  const values: Record<string, string> = {};
  const meta = new Map<string, StoredMeta>();
  for (const r of rows) {
    const at = variableOf(r.key);
    if (!at) continue;
    let value = r.value;
    let unopened = false;
    if (r.sealed_value !== null) {
      value = open(r.key, r.sealed_value);
      unopened = value === null;
    }
    meta.set(r.key, {
      lastFour: r.last_four,
      setBy: r.set_by ? { id: r.set_by, name: r.set_by_name ?? "" } : null,
      setAt: r.set_at,
      unopened,
    });
    // The run log's mode is the machine's once a private label is defined.
    if (at.row?.key === RUN_LOG_MODE && privateLabels) continue;
    if (value !== null) values[at.env] = value;
  }
  storedMeta = meta;
  storedReadAt = Date.now();
  return noteStoredSettings(values);
}

/** The stored settings, read again when this process's copy is older than `maxAgeMs` or there is none. */
export async function freshStoredSettings(maxAgeMs: number = STORED_SETTINGS_RECHECK_MS): Promise<void> {
  if (storedReadAt !== null && Date.now() - storedReadAt < maxAgeMs) return;
  await readStoredSettings();
}

/**
 * Read the stored settings now, and keep this process's copy fresh from
 * then on. Called once by each long-lived process after the database is
 * ready and before anything is built from the configuration. A read that
 * fails leaves the last copy in force and is tried again at the next tick.
 */
export async function startStoredSettings(options: {
  logger?: { error: (...args: unknown[]) => void };
} = {}): Promise<{ stop: () => void; problem: string | null }> {
  let problem: string | null = null;
  try {
    problem = await readStoredSettings();
  } catch (err) {
    // A database that has not been migrated yet has no table: the process
    // starts on the machine's settings and reads again once it has.
    options.logger?.error("[settings] the stored settings could not be read; starting on the machine's:", err);
  }
  // A read that keeps failing the same way is said once, not every few seconds.
  let lastFailure: string | null = null;
  const timer = setInterval(() => {
    void readStoredSettings().then(
      () => {
        lastFailure = null;
      },
      (err) => {
        const said = err instanceof Error ? err.message : String(err);
        if (said !== lastFailure) options.logger?.error("[settings] the stored settings could not be read again:", err);
        lastFailure = said;
      }
    );
  }, STORED_SETTINGS_RECHECK_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), problem };
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

export type SettingSource = "environment" | "file" | "app" | "default";

export interface SettingView {
  key: string;
  env: string;
  group: string;
  kind: Setting["kind"];
  about: string;
  /** Who may change it: "machine" for whoever runs the machine alone, "app" and "app_secret" for the administrators too. */
  where: Setting["where"];
  applies: Setting["applies"];
  tuning: boolean;
  secret: boolean;
  /** The layer its value comes from. */
  source: SettingSource;
  /** Whether the app can change it now: it does not stay on the machine and the machine does not fix it. */
  changeable: boolean;
  /** Where a setting the app cannot change is changed, in a sentence; null for one it can. */
  fixed_by: string | null;
  /** The value in force, as the config file would write it; null for a secret, and for a setting that is not set and has no default. */
  value: ConfigFileValue | null;
  /** The code's default; null for a secret and where there is none. */
  default: ConfigFileValue | null;
  /** For a secret: whether one is set, in any layer. */
  is_set: boolean | null;
  /** For a key given in the app: its last four characters. */
  last_four: string | null;
  /** Who set it in the app and when; null where the app's layer holds nothing for it. */
  set_by: { id: string; name: string } | null;
  set_at: string | null;
  /**
   * For a setting that applies at a restart: the value saved in the app that
   * this process is not yet running with. Null where nothing waits.
   */
  waiting: { value: ConfigFileValue | null } | null;
  /** A key given in the app that the deployment's sealing keys no longer open: set, and not in force. */
  unopened: boolean;
}

function typed(row: Setting, text: string | undefined | null): ConfigFileValue | null {
  if (text === undefined || text === null) return null;
  // An optional setting written as empty is the same as unset, except a list, which is then empty.
  if (text.trim() === "" && row.kind !== "list" && row.kind !== "text") return null;
  return fromEnvironmentText(row, text);
}

function fixedSentence(row: Setting, by: "environment" | "file" | null): string | null {
  const file = appliedConfigFile()?.path;
  if (row.where === "machine") {
    return (
      `It stays on the machine. Whoever runs the deployment sets ${row.env} in its environment` +
      (row.secret ? "" : `, or ${row.key} in its config file`) +
      `, and starts it again.`
    );
  }
  if (by === "file") {
    return `Whoever runs the deployment has set ${row.key} in its config file${file ? ` (${file})` : ""}, which fixes it. Taken out of the file, it can be changed here.`;
  }
  if (by === "environment") {
    return `Whoever runs the deployment has set ${row.env} in its environment, which fixes it. Taken out of the environment, it can be changed here.`;
  }
  return null;
}

function viewOf(row: Setting, holdsPrivate: boolean): SettingView {
  const { now, atStart } = storedSettings();
  const meta = storedMeta.get(row.key) ?? null;
  const machineOnly = row.where === "machine" || (row.key === RUN_LOG_MODE && holdsPrivate);
  const by = fixedOnTheMachine(row.env);
  const inApp = !machineOnly && !by && now[row.env] !== undefined;
  const source: SettingSource = by ?? (inApp ? "app" : "default");
  const secret = row.secret === true;
  const defaultText = row.field ? configFieldDefault(row.field) : null;
  const running = row.applies === "restart" ? atStart : now;
  const inForce = by ? process.env[row.env] : machineOnly ? undefined : running[row.env];
  const waits = !machineOnly && !by && row.applies === "restart" && now[row.env] !== atStart[row.env];
  return {
    key: row.key,
    env: row.env,
    group: settingGroup(row.key),
    kind: row.kind,
    about: row.about,
    where: row.where,
    applies: row.applies,
    tuning: row.tuning === true,
    secret,
    source,
    changeable: !machineOnly && !by,
    fixed_by:
      row.key === RUN_LOG_MODE && holdsPrivate && row.where !== "machine" && !by
        ? "This deployment defines a label besides public, so how much a run depends on its log is for whoever runs the machine to decide: RUN_LOG_MODE in its environment, or run_log.mode in its config file."
        : fixedSentence(row, by),
    value: secret ? null : typed(row, inForce ?? defaultText),
    default: secret ? null : typed(row, defaultText),
    is_set: secret ? Boolean(by) || (inApp && !meta?.unopened) : null,
    last_four: secret && inApp ? (meta?.lastFour ?? null) : null,
    set_by: inApp || waits ? (meta?.setBy ?? null) : null,
    set_at: inApp || waits ? (meta?.setAt.toISOString() ?? null) : null,
    waiting: waits ? { value: secret ? null : typed(row, now[row.env] ?? defaultText) } : null,
    unopened: Boolean(meta?.unopened) && !by,
  };
}

/** A key of one of the deployment's own model endpoints, which is no row of the registry: the endpoint names its variable. */
function endpointKeyViews(config: Config): SettingView[] {
  const { now } = storedSettings();
  const seen = new Set<string>();
  const views: SettingView[] = [];
  for (const endpoint of config.modelEndpoints ?? []) {
    if (!endpoint.keyEnv || seen.has(endpoint.keyEnv)) continue;
    seen.add(endpoint.keyEnv);
    const key = `${ENDPOINT_KEY_PREFIX}${endpoint.keyEnv}`;
    const meta = storedMeta.get(key) ?? null;
    const onTheMachine = (process.env[endpoint.keyEnv] ?? "").trim() !== "";
    const inApp = !onTheMachine && now[endpoint.keyEnv] !== undefined;
    views.push({
      key,
      env: endpoint.keyEnv,
      group: "model_providers",
      kind: "text",
      about: `The key of the endpoint "${endpoint.name}", which names ${endpoint.keyEnv} as the variable that holds it.`,
      where: "app_secret",
      applies: "live",
      tuning: false,
      secret: true,
      source: onTheMachine ? "environment" : inApp ? "app" : "default",
      changeable: !onTheMachine,
      fixed_by: onTheMachine
        ? `Whoever runs the deployment has set ${endpoint.keyEnv} in its environment, which fixes it. Taken out of the environment, it can be given here.`
        : null,
      value: null,
      default: null,
      is_set: onTheMachine || (inApp && !meta?.unopened),
      last_four: inApp ? (meta?.lastFour ?? null) : null,
      set_by: inApp ? (meta?.setBy ?? null) : null,
      set_at: inApp ? (meta?.setAt.toISOString() ?? null) : null,
      waiting: null,
      unopened: Boolean(meta?.unopened) && !onTheMachine,
    });
  }
  return views;
}

/** Whether the deployment defines a label besides the public graph's: it then holds private material (src/preflight.ts). */
async function holdsPrivateLabels(): Promise<boolean> {
  return (await asOwner(() => labelsBesidesPublic())).length > 0;
}

export interface SettingsListing {
  /** Why the settings saved in the app are not in force, when they could not be. */
  problem: string | null;
  /** How many settings saved in the app wait for the API to be started again. */
  waiting_for_restart: number;
  settings: SettingView[];
}

/** Every setting, with its value, the layer it comes from and whether the app may change it. */
export async function listSettings(): Promise<SettingsListing> {
  await readStoredSettings();
  const holdsPrivate = await holdsPrivateLabels();
  const settings = [
    ...SETTINGS.filter((row) => !row.retired).map((row) => viewOf(row, holdsPrivate)),
    ...endpointKeyViews(loadConfig()),
  ];
  return {
    problem: storedSettingsProblem(),
    waiting_for_restart: settings.filter((s) => s.waiting).length,
    settings,
  };
}

// ---------------------------------------------------------------------------
// Changing one
// ---------------------------------------------------------------------------

const RUN_LOG_MODE = "run_log.mode";

export type SettingFailure =
  | "UNKNOWN_SETTING"
  | "RETIRED"
  | "ON_THE_MACHINE"
  | "FIXED_ON_THE_MACHINE"
  | "INVALID_VALUE"
  | "SECRET_NEEDS_SESSION"
  | "NO_SEALING_KEY"
  | "HELD_BY_WORK"
  | "WOULD_FAIL_CHECK"
  | "NOT_SET";

export type SettingOutcome =
  | {
      ok: true;
      setting: SettingView;
      /** Whether the change is in force now, or waits for the API to be started again. */
      in_force: "now" | "at_restart";
      /** Checks that fail with the change and do not block it, each with its sentence. */
      warnings: Array<{ check: string; message: string }>;
    }
  | { ok: false; code: SettingFailure; message: string };

const refuse = (code: SettingFailure, message: string): SettingOutcome => ({ ok: false, code, message });

type Target =
  | { kind: "setting"; row: Setting; key: string; env: string }
  | { kind: "endpoint_key"; key: string; env: string };

function unknownSetting(name: string): SettingOutcome {
  const near = SETTINGS.filter((s) => !s.retired)
    .flatMap((s) => [
      { key: s.key, distance: editDistance(name, s.key) },
      { key: s.key, distance: editDistance(name.toUpperCase(), s.env) },
    ])
    .filter((c) => c.distance <= 2)
    .sort((a, b) => a.distance - b.distance)[0];
  return refuse(
    "UNKNOWN_SETTING",
    `"${name}" is not a setting.${near ? ` Did you mean ${near.key}?` : ""} The list of settings names every one.`
  );
}

async function targetOf(name: string): Promise<{ target: Target } | { refused: SettingOutcome }> {
  if (name.startsWith(ENDPOINT_KEY_PREFIX)) {
    const env = name.slice(ENDPOINT_KEY_PREFIX.length);
    const declared = (loadConfig().modelEndpoints ?? []).some((e) => e.keyEnv === env);
    if (!declared) {
      return {
        refused: refuse(
          "UNKNOWN_SETTING",
          `No model endpoint of this deployment names ${env} as the variable that holds its key. ` +
            `Declare the endpoint first (model_providers.endpoints, with key_env), then give its key.`
        ),
      };
    }
    if ((process.env[env] ?? "").trim() !== "") {
      return {
        refused: refuse(
          "FIXED_ON_THE_MACHINE",
          `Whoever runs the deployment has set ${env} in its environment, which fixes it. Taken out of the environment, it can be given here.`
        ),
      };
    }
    return { target: { kind: "endpoint_key", key: name, env } };
  }
  const row = findSetting(name);
  if (!row) return { refused: unknownSetting(name) };
  if (row.retired) {
    return {
      refused: refuse(
        "RETIRED",
        `${row.key} was retired in ${row.retired.in} and nothing reads it. In its place: ${row.retired.replacedBy}.`
      ),
    };
  }
  if (row.where === "machine") {
    return { refused: refuse("ON_THE_MACHINE", `${row.key} is not changed in the app. ${fixedSentence(row, null)}`) };
  }
  const by = fixedOnTheMachine(row.env);
  if (by) return { refused: refuse("FIXED_ON_THE_MACHINE", fixedSentence(row, by)!) };
  if (row.key === RUN_LOG_MODE && (await holdsPrivateLabels())) {
    return {
      refused: refuse(
        "ON_THE_MACHINE",
        "This deployment defines a label besides public, so how much a run depends on its log is for whoever runs the machine to decide, not an administrator: " +
          "a deployment that holds private material keeps its whole log. They set RUN_LOG_MODE in its environment, or run_log.mode in its config file."
      ),
    };
  }
  return { target: { kind: "setting", row, key: row.key, env: row.env } };
}

/**
 * Rules on a change that the schema cannot know, because they turn on what
 * the deployment holds. Each refusal names what holds the change back.
 */
async function heldByWork(row: Setting, before: Config, after: Config): Promise<string | null> {
  if (row.key === "pricing.owls" && before.owls !== after.owls) {
    const [held] = await asOwner(() =>
      rawQuery<{ accounts: string; micro: string }>(
        `SELECT count(*)::text AS accounts, coalesce(sum(balance), 0)::text AS micro
           FROM (SELECT user_id, sum(amount_micro_usd) AS balance FROM owl_ledger GROUP BY user_id HAVING sum(amount_micro_usd) > 0) held`
      )
    );
    const accounts = Number(held?.accounts ?? 0);
    if (accounts > 0) {
      const owls = Number(held!.micro) / before.owlCostMicroUsd;
      return (
        `Owls here are ${before.owls}, and ${accounts} ${accounts === 1 ? "account holds" : "accounts hold"} ` +
        `${owls.toLocaleString("en-US", { maximumFractionDigits: 2 })} of them between them. An owl that was ${before.owls} and an owl that is ` +
        `${after.owls} would be one balance, so this is not changed while any account holds owls: the Owls page ` +
        `(/admin/owls) and each account's ledger show where they are.`
      );
    }
  }
  if (row.key === "features.off") {
    const switchedOff = after.featuresOff.filter((f) => !before.featuresOff.includes(f));
    if (switchedOff.includes("mathematics")) {
      const [running] = await asOwner(() =>
        rawQuery<{ n: string }>(`SELECT count(*)::text AS n FROM proof_attempts WHERE status IN ('running', 'cancelling')`)
      );
      const n = Number(running?.n ?? 0);
      if (n > 0) {
        return (
          `Mathematics holds ${n} proof ${n === 1 ? "attempt that is" : "attempts that are"} running, which switching it off would strand: ` +
          `the solver would have no model to finish ${n === 1 ? "it" : "them"} on. Let ${n === 1 ? "it" : "them"} finish, or cancel ${n === 1 ? "it" : "them"}, and switch it off then.`
        );
      }
    }
    if (switchedOff.includes("prizes") || switchedOff.includes("mathematics")) {
      const [open] = await asOwner(() =>
        rawQuery<{ n: string }>(
          `SELECT count(*)::text AS n FROM prize_claims
            WHERE status NOT IN ('paid', 'rejected', 'voided', 'withdrawn', 'superseded', 'forfeited')`
        )
      );
      const n = Number(open?.n ?? 0);
      if (n > 0) {
        return (
          `Prizes hold ${n} open prize ${n === 1 ? "claim" : "claims"}, which switching ${switchedOff.includes("prizes") ? "prizes" : "mathematics"} off would strand: ` +
          `nothing would check, review or pay ${n === 1 ? "it" : "them"}. Decide ${n === 1 ? "it" : "them"} first.`
        );
      }
    }
  }
  return null;
}

/**
 * The checks that would newly fail with the configuration as it would be:
 * the preflight is evaluated over the same facts twice, once with each
 * configuration, so what differs is the change's doing. Nothing is called
 * outside.
 */
async function newlyFailing(after: Config, changes: Record<string, string | null>): Promise<PreflightCheckResult[]> {
  const facts = await gatherPreflightFacts({ callOut: false });
  const before = evaluatePreflight(facts);
  const then = evaluatePreflight({
    ...facts,
    config: after,
    endpointKeysMissing: endpointKeysMissing(after).filter((env) => changes[env] === undefined || changes[env] === null),
    modelsNobodyChose: modelsNobodyChose(changes),
    deployment: {
      ...facts.deployment,
      grantsSet: {
        signup: changes.SIGNUP_GRANT_OWLS !== undefined ? Number(changes.SIGNUP_GRANT_OWLS) || 0 : facts.deployment.grantsSet.signup,
        monthly: changes.MONTHLY_GRANT_OWLS !== undefined ? Number(changes.MONTHLY_GRANT_OWLS) || 0 : facts.deployment.grantsSet.monthly,
      },
    },
  });
  const failedBefore = new Set(before.checks.filter((c) => c.status === "fail").map((c) => c.name));
  return then.checks.filter((c) => c.status === "fail" && !failedBefore.has(c.name));
}

function cleanReason(reason: string | null | undefined): string | null {
  const text = (reason ?? "").trim();
  return text.length === 0 ? null : text.slice(0, SETTING_REASON_MAX_CHARS);
}

/** A value as the log keeps it: a setting's text, cut where it is very long. Never a secret. */
const logged = (text: string | null): string | null => (text === null ? null : text.length > 2000 ? `${text.slice(0, 2000)}…` : text);

export interface SetSettingInput {
  /** The setting's name in the registry, or its environment variable. */
  key: string;
  /** The value as the config file would write it. For a secret, the key itself. */
  value: unknown;
  reason?: string | null;
  actorId: string;
  /** Whether the request comes from a signed-in session: a secret is given nowhere else. */
  fromSession: boolean;
}

/**
 * Set a setting. Checked before it is saved: the value by the schema, then
 * the whole configuration with it in, then the preflight's checks over that
 * configuration. A change that would make a blocking check fail is refused
 * with the check's sentence; one that would make another fail is saved, and
 * the answer carries it.
 */
export async function setSetting(input: SetSettingInput): Promise<SettingOutcome> {
  const found = await targetOf(input.key.trim());
  if ("refused" in found) return found.refused;
  const { target } = found;
  const secret = target.kind === "endpoint_key" || target.row.secret === true;

  let text: string;
  let sealed: string | null = null;
  let lastFour: string | null = null;
  if (secret) {
    if (!input.fromSession) {
      return refuse(
        "SECRET_NEEDS_SESSION",
        `${target.key} is a key, and a key is given on the settings page (/admin/settings) by a signed-in administrator, ` +
          `never through a tool or an API key: it would pass through whatever carried it. Ask an administrator to give it there.`
      );
    }
    if (typeof input.value !== "string" || input.value.trim().length === 0) {
      return refuse("INVALID_VALUE", `${target.key} takes the key itself, as text.`);
    }
    text = input.value.trim();
    if (text.length > SETTING_SECRET_MAX_CHARS) {
      return refuse("INVALID_VALUE", `A key is at most ${SETTING_SECRET_MAX_CHARS} characters; this one is ${text.length}.`);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
      return refuse("INVALID_VALUE", "A key holds no control characters. Paste the key alone.");
    }
    const kept = seal(target.key, text);
    if (!kept.ok) return refuse("NO_SEALING_KEY", kept.message);
    sealed = kept.sealed;
    lastFour = text.length >= 12 ? text.slice(-4) : null;
  } else {
    const row = (target as Extract<Target, { kind: "setting" }>).row;
    try {
      text = settingsToEnvironment({ [row.key]: input.value as ConfigFileValue }, configFieldProblem)[row.env]!;
    } catch (err) {
      if (err instanceof ConfigFileError) return refuse("INVALID_VALUE", err.problems.join(" "));
      throw err;
    }
  }

  const changes = { [target.env]: text };
  let after: Config;
  try {
    after = configWith(changes);
  } catch (err) {
    return refuse("INVALID_VALUE", configProblem(err));
  }
  if (target.kind === "setting") {
    const held = await heldByWork(target.row, loadConfig(), after);
    if (held) return refuse("HELD_BY_WORK", held);
  }
  const failing = await newlyFailing(after, changes);
  const blocking = failing.find((c) => c.blocking);
  if (blocking) {
    return refuse(
      "WOULD_FAIL_CHECK",
      `This change is not saved: with it the check "${blocking.name}" would fail, and agent work would be held. ${blocking.message}`
    );
  }

  await asOwner(() =>
    withTransaction(async (tx) => {
      const [before] = await tx.query<{ value: string | null; sealed_value: string | null }>(
        `SELECT value, sealed_value FROM deployment_settings WHERE key = $1 FOR UPDATE`,
        [target.key]
      );
      await tx.query(
        `INSERT INTO deployment_settings (key, value, sealed_value, last_four, set_by, set_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, sealed_value = EXCLUDED.sealed_value, last_four = EXCLUDED.last_four,
               set_by = EXCLUDED.set_by, set_at = now()`,
        [target.key, secret ? null : text, sealed, lastFour, input.actorId]
      );
      await logAdministrativeEvent(tx, "setting_changed", input.actorId, {
        setting: target.key,
        // For a secret, that one was set, and whether one was set before.
        before: secret ? (before ? "set" : "not set") : logged(before?.value ?? null),
        after: secret ? "set" : logged(text),
        secret: secret ? "true" : null,
        reason: cleanReason(input.reason),
      });
    })
  );
  await readStoredSettings();
  return {
    ok: true,
    setting: await viewAfter(target),
    in_force: target.kind === "setting" && target.row.applies === "restart" ? "at_restart" : "now",
    warnings: failing.map((c) => ({ check: c.name, message: c.message })),
  };
}

async function viewAfter(target: Target): Promise<SettingView> {
  if (target.kind === "setting") return viewOf(target.row, await holdsPrivateLabels());
  // An endpoint whose key this is may have been taken away since: its key is then shown as it would be for it.
  const config = loadConfig();
  const declared = (config.modelEndpoints ?? []).some((e) => e.keyEnv === target.env);
  const views = endpointKeyViews(
    declared
      ? config
      : { ...config, modelEndpoints: [{ name: target.env, baseUrl: "", keyEnv: target.env, inputUsdPerMtok: 0, outputUsdPerMtok: 0 }] }
  );
  return views.find((v) => v.key === target.key)!;
}

/**
 * Return a setting to the code's default by removing its row. Checked and
 * logged as a change is. Refused where nothing is set in the app.
 */
export async function resetSetting(input: { key: string; reason?: string | null; actorId: string }): Promise<SettingOutcome> {
  const name = input.key.trim();
  // A row of a setting that has since moved to the machine can still be removed.
  const found = await targetOf(name);
  if ("refused" in found && found.refused.ok === false && found.refused.code !== "ON_THE_MACHINE" && found.refused.code !== "FIXED_ON_THE_MACHINE") {
    return found.refused;
  }
  const row = name.startsWith(ENDPOINT_KEY_PREFIX) ? null : findSetting(name);
  const key = row?.key ?? name;
  const env = row?.env ?? name.slice(ENDPOINT_KEY_PREFIX.length);
  const secret = !row || row.secret === true;

  const changes = { [env]: null };
  let failing: PreflightCheckResult[] = [];
  if ("target" in found) {
    let after: Config;
    try {
      after = configWith(changes);
    } catch (err) {
      return refuse(
        "INVALID_VALUE",
        `${key} cannot be returned to its default: without it the settings cannot be used. ${configProblem(err)}`
      );
    }
    if (row) {
      const held = await heldByWork(row, loadConfig(), after);
      if (held) return refuse("HELD_BY_WORK", held);
    }
    failing = await newlyFailing(after, changes);
    const blocking = failing.find((c) => c.blocking);
    if (blocking) {
      return refuse(
        "WOULD_FAIL_CHECK",
        `${key} is not returned to its default: without it the check "${blocking.name}" would fail, and agent work would be held. ${blocking.message}`
      );
    }
  }

  const removed = await asOwner(() =>
    withTransaction(async (tx) => {
      const gone = await tx.query<{ value: string | null }>(
        `DELETE FROM deployment_settings WHERE key = $1 RETURNING value`,
        [key]
      );
      if (gone.length === 0) return false;
      await logAdministrativeEvent(tx, "setting_reset", input.actorId, {
        setting: key,
        before: secret ? "set" : logged(gone[0]!.value),
        secret: secret ? "true" : null,
        reason: cleanReason(input.reason),
      });
      return true;
    })
  );
  if (!removed) {
    return refuse("NOT_SET", `${key} is not set in the app, so there is nothing to return to its default.`);
  }
  await readStoredSettings();
  const target: Target = row ? { kind: "setting", row, key, env } : { kind: "endpoint_key", key, env };
  return {
    ok: true,
    setting: await viewAfter(target),
    in_force: row?.applies === "restart" ? "at_restart" : "now",
    warnings: failing.map((c) => ({ check: c.name, message: c.message })),
  };
}

/** The settings as a config file's settings: what is set in the app, for an administrator to download. Never a secret. */
export function storedSettingsForFile(): Record<string, ConfigFileValue> {
  const { now } = storedSettings();
  const settings: Record<string, ConfigFileValue> = {};
  for (const row of SETTINGS) {
    if (row.secret || row.retired || row.where === "machine") continue;
    const text = now[row.env];
    if (text !== undefined) settings[row.key] = fromEnvironmentText(row, text);
  }
  return settings;
}

/**
 * Move every key given in the app onto the current sealing key
 * (scripts/reseal-connection-credentials.ts, which does the same for the
 * connections' credentials). A key that does not open is left as it is and
 * named: it is given again on the settings page. Running it twice changes
 * nothing the second time.
 */
export async function resealStoredSettings(): Promise<
  { ok: true; resealed: number; already_current: number; not_opened: string[] } | { ok: false; message: string }
> {
  const keys = credentialKeys();
  if (!keys.current) {
    return { ok: false, message: keys.problem ?? `${CREDENTIAL_KEY_ENV} is not set, so there is no key to seal with.` };
  }
  const current = keys.current.id;
  return asOwner(() =>
    withTransaction(async (tx) => {
      const rows = await tx.query<{ key: string; sealed_value: string }>(
        `SELECT key, sealed_value FROM deployment_settings WHERE sealed_value IS NOT NULL ORDER BY key FOR UPDATE`
      );
      let resealed = 0;
      let already = 0;
      const notOpened: string[] = [];
      for (const row of rows) {
        if (row.sealed_value.startsWith(`${current}:`)) {
          already += 1;
          continue;
        }
        const opened = open(row.key, row.sealed_value);
        const again = opened === null ? null : seal(row.key, opened);
        if (!again || !again.ok) {
          notOpened.push(row.key);
          continue;
        }
        await tx.query(`UPDATE deployment_settings SET sealed_value = $2 WHERE key = $1`, [row.key, again.sealed]);
        resealed += 1;
      }
      return { ok: true as const, resealed, already_current: already, not_opened: notOpened };
    })
  );
}

/** Record that an administrator asked for the API to be started again, with the settings that were waiting on it. */
export async function logRestartRequested(input: {
  actorId: string;
  waiting: readonly string[];
  reason?: string | null;
}): Promise<void> {
  await asOwner(() =>
    withTransaction((tx) =>
      logAdministrativeEvent(tx, "restart_requested", input.actorId, {
        waiting: input.waiting.join("\n"),
        reason: cleanReason(input.reason),
      })
    )
  );
}
