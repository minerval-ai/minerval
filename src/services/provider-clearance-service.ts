/**
 * The administrators' choice of which model providers and outside services
 * may be sent text at each label (src/provider-labels.ts;
 * docs/architecture.md, "Providers cleared by label").
 *
 * The choice is a row in provider_clearances for each provider and label it
 * clears, beside `public`, which every provider is cleared for without a
 * row. Nothing is cleared by default: a label is served by no provider
 * until a holder of `clear_providers` ticks one, on the labels page where
 * the label is defined. Each change is logged in the same transaction
 * (administrative_events), as every administrative act is.
 *
 * Where PROVIDER_LABELS is set, the deployment's settings fix the
 * clearance: the rows are not read, and nothing can be written here.
 *
 * The table is part of the wall (db/enforcement.ts): a connection held to
 * a clearance may read it and may not write it, so it is written on the
 * owner's connection once the route has checked the actor.
 *
 * Reading it is how a change takes effect without a restart. Every process
 * keeps the last copy it read (noteStoredClearance), and the seams that
 * send text at a label other than `public` read the table again when that
 * copy is older than STORED_CLEARANCE_RECHECK_MS (freshStoredClearance), so
 * a change made in one process is in force in every other within that
 * time, and at once in the process that made it.
 */
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { loadConfig } from "../config.js";
import { PUBLIC_LABEL, isWorkableLabel } from "../labels.js";
import {
  clearanceFixedBySettings,
  clearedLabels,
  describeProviders,
  knownProviderNames,
  noteStoredClearance,
  storedClearance,
  storedClearanceReadAt,
  type ProviderDescription,
  type ProviderKeysConfig,
  type StoredClearance,
} from "../provider-labels.js";
import { logAdministrativeEvent } from "./permission-service.js";

/**
 * How old this process's copy of the stored choice may be before a seam
 * that sends text at a private label reads the table again. It bounds how
 * long a clearance taken back in one process is still honoured in another.
 * The read is one small table, so it is kept short.
 */
export const STORED_CLEARANCE_RECHECK_MS = 5_000;

const WALL_REASON =
  "Which providers may be sent a label's text is part of the wall, so it is written on the owner's connection. The caller has checked that the actor may clear providers.";
const asOwner = <T>(fn: () => Promise<T>): Promise<T> => withSystemClearance(WALL_REASON, fn);

/** Read the stored choice from the table, and keep it as this process's copy. */
export async function readStoredClearance(): Promise<StoredClearance> {
  const rows = await rawQuery<{ provider: string; label: string }>(
    `SELECT provider, label FROM provider_clearances ORDER BY provider, label`
  );
  const clearance: Record<string, string[]> = {};
  for (const { provider, label } of rows) (clearance[provider] ??= []).push(label);
  noteStoredClearance(clearance);
  return clearance;
}

/**
 * The stored choice, read again when this process's copy is older than
 * `maxAgeMs` or there is none.
 */
export async function freshStoredClearance(maxAgeMs: number = STORED_CLEARANCE_RECHECK_MS): Promise<StoredClearance> {
  const readAt = storedClearanceReadAt();
  if (readAt !== null && Date.now() - readAt < maxAgeMs) return storedClearance();
  return readStoredClearance();
}

/**
 * Bring this process's copy up to date before a synchronous reader asks
 * about `label`, where it could matter: PROVIDER_LABELS is not set and the
 * label is not `public`.
 */
export async function freshClearanceAt(label: string, config: ProviderKeysConfig = loadConfig()): Promise<void> {
  if (clearanceFixedBySettings(config) || label === PUBLIC_LABEL) return;
  await freshStoredClearance();
}

export interface ProviderClearanceView {
  /**
   * Whether PROVIDER_LABELS (or [provider_labels]) fixes the clearance.
   * Then `labels` says what it fixes, and nothing can be changed here.
   */
  fixed_by_settings: boolean;
  /** Every provider and outside service this deployment knows, with what it would be sent. */
  providers: ProviderDescription[];
  /** Each label besides `public`, with the providers cleared for it, as in force now. */
  labels: Array<{ label: string; cleared: string[] }>;
  /**
   * What is in force for `public`, the public graph's own text: every
   * provider under the stored choice, and the setting's own lines where the
   * settings fix the clearance. `works_here` is whether any run of this
   * deployment works at it: none does once its bottom layers are labels of
   * their own, and then nothing is sent from there whatever is cleared.
   */
  public_graph: { label: string; cleared: string[]; works_here: boolean };
}

/** The clearance as it stands, for the labels page and its MCP tool. */
export async function listProviderClearance(config: ProviderKeysConfig = loadConfig()): Promise<ProviderClearanceView> {
  const fixed = clearanceFixedBySettings(config);
  const stored = fixed ? {} : await readStoredClearance();
  const providers = describeProviders(config);
  const labels = await rawQuery<{ name: string }>(`SELECT name FROM labels WHERE name <> $1 ORDER BY name`, [
    PUBLIC_LABEL,
  ]);
  return {
    fixed_by_settings: fixed,
    providers,
    public_graph: {
      label: PUBLIC_LABEL,
      cleared: providers.map((p) => p.name).filter((p) => clearedLabels(p, config, stored).includes(PUBLIC_LABEL)),
      works_here: isWorkableLabel(PUBLIC_LABEL),
    },
    labels: labels.map(({ name }) => ({
      label: name,
      cleared: providers
        .map((p) => p.name)
        .filter((provider) => clearedLabels(provider, config, stored).includes(name)),
    })),
  };
}

export type ClearanceFailure = "FIXED_BY_SETTINGS" | "PUBLIC_LABEL" | "UNKNOWN_LABEL" | "UNKNOWN_PROVIDER";

export type ClearanceOutcome =
  | { ok: true; cleared: string[]; no_longer_cleared: string[] }
  | { ok: false; code: ClearanceFailure; message: string };

const refuse = (code: ClearanceFailure, message: string): ClearanceOutcome => ({ ok: false, code, message });

/**
 * Why a choice may not be recorded, or null when it may: the settings fix
 * the clearance, the label is `public`, or a name is no provider here.
 */
export function clearanceProblem(
  label: string,
  providers: readonly string[],
  config: ProviderKeysConfig = loadConfig()
): ClearanceOutcome | null {
  if (clearanceFixedBySettings(config)) {
    return refuse(
      "FIXED_BY_SETTINGS",
      "Which providers may be sent each label's text is fixed by this deployment's settings (PROVIDER_LABELS, " +
        "or [provider_labels] in its config file), so it is not changed here. Whoever runs the deployment changes it there."
    );
  }
  if (label === PUBLIC_LABEL) {
    return refuse(
      "PUBLIC_LABEL",
      `Every provider is cleared for "${PUBLIC_LABEL}": what is public may be read by anyone. Only the deployment's ` +
        "settings (PROVIDER_LABELS) can narrow that."
    );
  }
  const known = new Set(knownProviderNames(config));
  const unknown = providers.filter((p) => !known.has(p));
  if (unknown.length > 0) {
    return refuse(
      "UNKNOWN_PROVIDER",
      `${unknown.map((p) => `"${p}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not a model provider or ` +
        `outside service of this deployment. They are: ${[...known].join(", ")}.`
    );
  }
  return null;
}

/**
 * Make `providers` exactly the ones cleared for `label`, inside a
 * transaction the caller holds on the owner's connection, logging the
 * change. The caller has checked clearanceProblem and that the label is a
 * row.
 */
export async function writeClearance(
  tx: TxQuery,
  input: { label: string; providers: readonly string[]; actorId: string }
): Promise<{ cleared: string[]; no_longer_cleared: string[] }> {
  const wanted = [...new Set(input.providers)].sort();
  const before = (
    await tx.query<{ provider: string }>(
      `SELECT provider FROM provider_clearances WHERE label = $1 ORDER BY provider FOR UPDATE`,
      [input.label]
    )
  ).map((r) => r.provider);
  const cleared = wanted.filter((p) => !before.includes(p));
  const noLonger = before.filter((p) => !wanted.includes(p));
  if (noLonger.length > 0) {
    await tx.query(`DELETE FROM provider_clearances WHERE label = $1 AND provider = ANY($2::text[])`, [
      input.label,
      noLonger,
    ]);
  }
  for (const provider of cleared) {
    await tx.query(
      `INSERT INTO provider_clearances (provider, label, cleared_by) VALUES ($1, $2, $3)`,
      [provider, input.label, input.actorId]
    );
  }
  if (cleared.length > 0 || noLonger.length > 0) {
    // Lists are stored as one string, a name to a line, as the
    // connections' are (permission-service.ts reads them back).
    await logAdministrativeEvent(tx, "provider_clearance_set", input.actorId, {
      label: input.label,
      cleared: cleared.join("\n"),
      no_longer_cleared: noLonger.join("\n"),
    });
  }
  return { cleared, no_longer_cleared: noLonger };
}

/**
 * Set which providers are cleared for a label: exactly those given, so an
 * empty list clears none. Takes effect in this process at once, and in
 * every other within STORED_CLEARANCE_RECHECK_MS.
 */
export async function setProviderClearance(
  input: { label: string; providers: readonly string[]; actorId: string },
  config: ProviderKeysConfig = loadConfig()
): Promise<ClearanceOutcome> {
  const label = input.label.trim();
  const providers = input.providers.map((p) => p.trim()).filter((p) => p.length > 0);
  const problem = clearanceProblem(label, providers, config);
  if (problem) return problem;
  const outcome = await asOwner(() =>
    withTransaction(async (tx): Promise<ClearanceOutcome> => {
      const found = await tx.query(`SELECT 1 FROM labels WHERE name = $1`, [label]);
      if (found.length === 0) return refuse("UNKNOWN_LABEL", `This deployment defines no label named "${label}".`);
      return { ok: true, ...(await writeClearance(tx, { label, providers, actorId: input.actorId })) };
    })
  );
  if (outcome.ok) await readStoredClearance();
  return outcome;
}
