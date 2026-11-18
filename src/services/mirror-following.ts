/**
 * Following the public graph, set up and kept in the app (docs/organizations.md,
 * "The mirror"; #1118, phase 2c).
 *
 * The mirror itself is unchanged (services/mirror-apply-service.ts): it
 * applies signed batches, one after another, and refuses any that does not
 * fit. What this adds is where an administrator says what it follows:
 *
 *  - The feed is the public graph's, at the address of this deployment's
 *    connection, fetched with its connection key, which holds `read_feed`.
 *  - The keys a batch may be signed with are those the feed says it signs
 *    with (GET /mirror/feed/key, read when the deployment connects or the
 *    page asks), once an administrator has accepted one after comparing it
 *    with the key Minerval publishes. No batch applies under a key nobody
 *    accepted, and the key a batch carries is never trusted.
 *  - Following starts and pauses when an administrator says so.
 *
 * The settings stay the operator's overrides. Where MIRROR_FEED_URL or
 * MIRROR_FEED_DIR is set, the mirror follows that and the keys
 * MIRROR_FEED_PUBLIC_KEYS names, whatever was chosen here, as it did before
 * (mirror-roles.ts checks those at start); the page says so.
 */
import type { KeyObject } from "node:crypto";
import { readdirSync } from "node:fs";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { membersOnly } from "../permissions.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embedding-model.js";
import {
  configuredSource,
  configuredTrustedKeys,
  mirrorStatus,
  urlSource,
  type BatchSource,
  type MirrorStatus,
} from "./mirror-apply-service.js";
import { keyIdOf, parsePublicKey, sequenceOfFileName } from "./mirror-batch.js";
import { replicatedShape } from "./mirror-manifest.js";
import { publicGraphFetch, readConnection } from "./public-graph-client.js";

export class MirrorFollowingError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409
  ) {
    super(message);
  }
}

/** Whether this deployment may follow the public graph from the app: a private one. The public graph follows nothing. */
export function followsInApp(config = loadConfig()): boolean {
  return membersOnly(config);
}

/** Whether the operator's settings say what the mirror follows, which the app then does not. */
export function followedBySettings(config = loadConfig()): "url" | "dir" | null {
  if (config.mirrorFeedDir) return "dir";
  if (config.mirrorFeedUrl) return "url";
  return null;
}

// ---- the one row --------------------------------------------------------------------

interface FollowingRow {
  state: "following" | "paused";
  started_by: string | null;
  started_at: Date | null;
  paused_by: string | null;
  paused_at: Date | null;
  check_requested_at: Date | null;
  last_checked_at: Date | null;
  last_check_error: string | null;
}

async function followingRow(): Promise<FollowingRow | null> {
  const [row] = await rawQuery<FollowingRow>(`SELECT * FROM mirror_following WHERE id = 'this'`);
  return row ?? null;
}

// ---- the feed's keys ----------------------------------------------------------------

export interface FeedKeyView {
  key_id: string;
  public_key: string;
  feed_id: string | null;
  read_from: string;
  first_seen_at: string;
  accepted: boolean;
  accepted_at: string | null;
  accepted_by: string | null;
  /** Whether the feed named it the last time it was read: the key it signs with now comes first there. */
  current: boolean;
}

/** The keys this deployment has read from the feed, the newest first, with who accepted each. */
export async function feedKeys(): Promise<FeedKeyView[]> {
  const rows = await rawQuery<{
    key_id: string;
    public_key: string;
    feed_id: string | null;
    read_from: string;
    first_seen_at: Date;
    accepted_at: Date | null;
    accepted_by: string | null;
  }>(
    `SELECT k.key_id, k.public_key, k.feed_id, k.read_from, k.first_seen_at, k.accepted_at, c.display_name AS accepted_by
       FROM mirror_feed_keys k LEFT JOIN contributors c ON c.id = k.accepted_by
      ORDER BY k.first_seen_at DESC, k.key_id`
  );
  return rows.map((r, i) => ({
    key_id: r.key_id,
    public_key: r.public_key,
    feed_id: r.feed_id,
    read_from: r.read_from,
    first_seen_at: r.first_seen_at.toISOString(),
    accepted: r.accepted_at !== null,
    accepted_at: r.accepted_at?.toISOString() ?? null,
    accepted_by: r.accepted_by,
    current: i === 0,
  }));
}

/**
 * Read the keys the public graph's feed says it signs with, and keep any not
 * seen before, unaccepted. The feed answers one key, or (from a later
 * release) a list with the current one first. Returns what it read, or null
 * where the feed could not be read: that is said on the page and changes
 * nothing.
 */
export async function readFeedKeys(apiUrl?: string): Promise<{ read: number; error: string | null }> {
  const base = (apiUrl ?? (await readConnection())?.apiUrl ?? "").replace(/\/+$/, "");
  if (!base) return { read: 0, error: "This deployment is not connected to minerval.ai, so there is no feed to read a key from." };
  let body: { public_key?: string; key_id?: string; feed_id?: string | null; keys?: Array<{ public_key?: string }> };
  try {
    const res = await publicGraphFetch(`${base}/mirror/feed/key`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { read: 0, error: `The public graph answered ${res.status} to GET /mirror/feed/key.` };
    body = (await res.json()) as typeof body;
  } catch (err) {
    return { read: 0, error: `The public graph's feed key could not be read (${err instanceof Error ? err.message : String(err)}).` };
  }
  const stated = [...(Array.isArray(body.keys) ? body.keys.map((k) => k.public_key) : []), body.public_key].filter(
    (k): k is string => typeof k === "string"
  );
  // Oldest first into the table, so that the current key, named first, is the newest seen.
  const unique = [...new Set(stated)].reverse();
  let read = 0;
  for (const publicKey of unique) {
    try {
      parsePublicKey(publicKey);
    } catch {
      continue;
    }
    read += 1;
    await rawQuery(
      `INSERT INTO mirror_feed_keys (key_id, public_key, feed_id, read_from) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key_id) DO NOTHING`,
      [keyIdOf(publicKey), publicKey, typeof body.feed_id === "string" ? body.feed_id : null, `${base}/mirror/feed/key`]
    );
  }
  return read > 0 ? { read, error: null } : { read: 0, error: "The public graph's answer to GET /mirror/feed/key held no key this release can read." };
}

/** An administrator accepts a key, having compared it with the key Minerval publishes. */
export async function acceptFeedKey(keyId: string, by: string): Promise<FeedKeyView> {
  const [row] = await rawQuery<{ key_id: string }>(
    `UPDATE mirror_feed_keys SET accepted_at = COALESCE(accepted_at, now()), accepted_by = COALESCE(accepted_by, $2)
      WHERE key_id = $1 RETURNING key_id`,
    [keyId, by]
  );
  if (!row) {
    throw new MirrorFollowingError(
      "NO_SUCH_FEED_KEY",
      "This deployment has not read that key from the feed. Read the feed's key again, from the Mirror page, and accept the key it shows.",
      404
    );
  }
  await logMirrorEvent("mirror_feed_key_accepted", by, { key_id: keyId });
  return (await feedKeys()).find((k) => k.key_id === keyId)!;
}

/**
 * The keys a batch may verify under. Where the operator named keys
 * (MIRROR_FEED_PUBLIC_KEYS), those; otherwise those an administrator
 * accepted here. Empty where neither, and no batch then applies.
 */
export async function trustedKeys(): Promise<KeyObject[]> {
  if (loadConfig().mirrorFeedPublicKeys.length > 0) return configuredTrustedKeys();
  const rows = await rawQuery<{ public_key: string }>(`SELECT public_key FROM mirror_feed_keys WHERE accepted_at IS NOT NULL`);
  return rows.map((r) => parsePublicKey(r.public_key));
}

// ---- what is followed ---------------------------------------------------------------

/**
 * Where batches come from now, or null where nothing is followed: the
 * settings' feed where the operator set one; otherwise the public graph at
 * the connection's address, where an administrator started following and
 * the connection holds read_feed.
 */
export async function followedSource(): Promise<BatchSource | null> {
  const config = loadConfig();
  if (followedBySettings(config)) return configuredSource();
  if (!followsInApp(config)) return null;
  const row = await followingRow();
  if (row?.state !== "following") return null;
  const connection = await readConnection();
  if (connection?.state !== "connected" || !connection.grants.includes("read_feed")) return null;
  return urlSource(connection.apiUrl, "");
}

/** Whether the applier should look now: Check now was pressed since it last looked. */
export async function checkRequested(): Promise<boolean> {
  const row = await followingRow();
  return Boolean(row?.check_requested_at && (!row.last_checked_at || row.check_requested_at > row.last_checked_at));
}

/** The applier says it looked, and what stopped it short of the feed where something did. */
export async function noteChecked(error: string | null): Promise<void> {
  await rawQuery(
    `UPDATE mirror_following SET last_checked_at = now(), last_check_error = $1 WHERE id = 'this'`,
    [error]
  );
}

async function logMirrorEvent(action: string, by: string, detail: Record<string, string | null>): Promise<void> {
  await rawQuery(`INSERT INTO administrative_events (action, actor_id, detail) VALUES ($1, $2, $3::jsonb)`, [
    action,
    by,
    JSON.stringify(detail),
  ]);
}

/** Start following. Refused until each setup check that would refuse every batch passes. */
export async function follow(by: string): Promise<MirrorSetup> {
  const config = loadConfig();
  if (!followsInApp(config)) {
    throw new MirrorFollowingError("NOT_FOLLOWED_IN_APP", "Only a private deployment follows the public graph.");
  }
  if (followedBySettings(config)) {
    throw new MirrorFollowingError(
      "FOLLOWED_BY_SETTINGS",
      "The operator's settings say what this deployment follows (MIRROR_FEED_URL or MIRROR_FEED_DIR), so it is not started or paused here."
    );
  }
  const setup = await mirrorSetup();
  const blocking = setup.checks.filter((c) => c.status === "fail");
  if (blocking.length > 0) {
    throw new MirrorFollowingError("SETUP_INCOMPLETE", `Following cannot start yet: ${blocking.map((c) => c.message).join(" ")}`);
  }
  await rawQuery(
    `INSERT INTO mirror_following (id, state, started_by, started_at, check_requested_at)
     VALUES ('this', 'following', $1, now(), now())
     ON CONFLICT (id) DO UPDATE SET state = 'following', started_by = $1, started_at = now(), check_requested_at = now()`,
    [by]
  );
  await logMirrorEvent("mirror_followed", by, { feed: setup.source.address });
  return mirrorSetup();
}

/** Pause following: the mirror stays as it is, at the batch it last applied. */
export async function pause(by: string): Promise<MirrorSetup> {
  if (followedBySettings()) {
    throw new MirrorFollowingError(
      "FOLLOWED_BY_SETTINGS",
      "The operator's settings say what this deployment follows (MIRROR_FEED_URL or MIRROR_FEED_DIR), so it is not started or paused here."
    );
  }
  const [row] = await rawQuery<{ id: string }>(
    `UPDATE mirror_following SET state = 'paused', paused_by = $1, paused_at = now() WHERE id = 'this' AND state = 'following' RETURNING id`,
    [by]
  );
  if (!row) throw new MirrorFollowingError("NOT_FOLLOWING", "The mirror is not following, so there is nothing to pause.");
  await logMirrorEvent("mirror_paused", by, {});
  return mirrorSetup();
}

/** Ask the applier to look at the feed now rather than at its next turn. */
export async function checkNow(by: string): Promise<MirrorSetup> {
  if (!(await followedSource())) {
    throw new MirrorFollowingError("NOT_FOLLOWING", "The mirror is not following, so there is no feed to check.");
  }
  await rawQuery(
    `INSERT INTO mirror_following (id, state, check_requested_at) VALUES ('this', 'following', now())
     ON CONFLICT (id) DO UPDATE SET check_requested_at = now()`
  );
  await logMirrorEvent("mirror_check_requested", by, {});
  return mirrorSetup();
}

// ---- the page -----------------------------------------------------------------------

export interface MirrorSetupCheck {
  key: "connected" | "feed_key" | "embedding" | "shape";
  status: "pass" | "fail" | "unknown";
  message: string;
  /** Who puts it right, in Health's words. */
  owner: "operator" | "admin" | "organization";
}

/** Who fixes a refusal, by its code, in Health's words. */
export const REFUSAL_OWNER: Record<string, "operator" | "admin"> = {
  schema_newer: "operator",
  row_refused: "operator",
  id_collision: "operator",
  embedding_differs: "operator",
  shape_differs: "operator",
  unknown_key: "admin",
};

export interface MirrorSetup {
  /** Whether this deployment follows the public graph from the app at all. */
  in_app: boolean;
  /** Where batches come from, and whether the operator's settings say so. */
  source: { kind: "network" | "files"; set_by: "app" | "settings"; address: string | null };
  /** 'following', 'paused', or 'not_started'. Where the settings say what is followed, always following. */
  state: "following" | "paused" | "not_started";
  started_at: string | null;
  started_by: string | null;
  paused_at: string | null;
  paused_by: string | null;
  last_checked_at: string | null;
  /** What stopped the last look short of the feed (it could not be read), where something did. */
  last_check_error: string | null;
  check_requested: boolean;
  /** The applier's turn, in seconds. */
  interval_seconds: number;
  checks: MirrorSetupCheck[];
  /** Where the operator named the keys in the settings; the keys below are then not used. */
  keys_set_by_settings: boolean;
  keys: FeedKeyView[];
  /** Read from the feed now, where it was. */
  feed: { head: number | null; latest_snapshot: number | null; error: string | null } | null;
  status: MirrorStatus;
  /** Who fixes the last refusal, where there is one. */
  refusal_owner: "operator" | "admin" | null;
  /** In files mode: the batch files in MIRROR_FEED_DIR and what became of each. */
  files: Array<{ name: string; sequence: number; applied: boolean }> | null;
  /** The newest batches applied here, newest first. */
  batches: AppliedBatchView[];
}

export interface AppliedBatchView {
  sequence: number;
  kind: string;
  cut_at: string;
  applied_at: string;
  received_from: string | null;
  /** Rows written and removed, over every table. */
  written: number;
  removed: number;
  /**
   * What the batch left for someone to look at, in counts of public nodes
   * and rows (mirror-apply-service.ts, ApplyNotes). Given to an
   * administrator only: that a public claim was kept because something of
   * this deployment's own points to it says something exists, at a label
   * the reader may not hold. The Steward at each label is told the rest.
   * Null where the reader is not shown it.
   */
  notes: {
    merged_with_local_rows: number;
    kept_claims: number;
    kept_rows: number;
    local_rows_followed: number;
    local_judgments_retired: number;
  } | null;
}

/** How many applied batches the page lists. */
export const BATCHES_SHOWN = 20;

async function appliedBatches(withNotes: boolean): Promise<AppliedBatchView[]> {
  const rows = await rawQuery<{
    sequence: string;
    kind: string;
    cut_at: Date;
    applied_at: Date;
    received_from: string | null;
    counts: Record<string, { inserted?: number; updated?: number; removed?: number }>;
    notes: Record<string, unknown>;
  }>(
    `SELECT sequence, kind, cut_at, applied_at, received_from, counts, notes
       FROM mirror_applied_batches ORDER BY sequence DESC LIMIT $1`,
    [BATCHES_SHOWN]
  );
  const sum = <T>(list: T[] | undefined, n: (t: T) => number) => (list ?? []).reduce((a, t) => a + n(t), 0);
  return rows.map((r) => {
    const counts = Object.values(r.counts ?? {});
    const n = r.notes as {
      merged_with_local_rows?: { count: number };
      kept_claims?: { count: number };
      kept_rows?: Array<{ count: number }>;
      local_rows_followed?: Array<{ local_rows: Array<{ rows: number }> }>;
      local_judgments_retired?: Array<{ count: number }>;
    };
    return {
      sequence: Number(r.sequence),
      kind: r.kind,
      cut_at: r.cut_at.toISOString(),
      applied_at: r.applied_at.toISOString(),
      received_from: r.received_from,
      written: counts.reduce((a, c) => a + (c.inserted ?? 0) + (c.updated ?? 0), 0),
      removed: counts.reduce((a, c) => a + (c.removed ?? 0), 0),
      notes: withNotes
        ? {
            merged_with_local_rows: n.merged_with_local_rows?.count ?? 0,
            kept_claims: n.kept_claims?.count ?? 0,
            kept_rows: sum(n.kept_rows, (k) => k.count),
            local_rows_followed: sum(n.local_rows_followed, (f) => sum(f.local_rows, (l) => l.rows)),
            local_judgments_retired: sum(n.local_judgments_retired, (j) => j.count),
          }
        : null,
    };
  });
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** What the Mirror page shows: how the mirror is set up, how current it is, and what would stop it. */
export async function mirrorSetup(opts: { notes?: boolean } = {}): Promise<MirrorSetup> {
  const config = loadConfig();
  const bySettings = followedBySettings(config);
  const connection = await readConnection();
  const row = await followingRow();
  const status = await mirrorStatus();
  const keys = await feedKeys();
  const keysBySettings = config.mirrorFeedPublicKeys.length > 0;
  const address = bySettings === "dir" ? config.mirrorFeedDir : bySettings === "url" ? config.mirrorFeedUrl : (connection?.apiUrl ?? null);

  const checks: MirrorSetupCheck[] = [];
  if (bySettings !== "dir") {
    const connected = connection?.state === "connected";
    const holds = connected && connection.grants.includes("read_feed");
    checks.push({
      key: "connected",
      status: bySettings === "url" ? "pass" : holds ? "pass" : "fail",
      owner: connected ? "organization" : "admin",
      message:
        bySettings === "url"
          ? `The operator's settings name the feed (MIRROR_FEED_URL).`
          : holds
            ? `Connected to minerval.ai as ${connection.deploymentName ?? "this deployment"}, holding read_feed.`
            : connected
              ? `The connection does not hold read_feed. An admin of ${connection.organizationName ?? "the organization"} grants it on minerval.ai.`
              : "This deployment is not connected to minerval.ai. Connect it on Overview, asking for read_feed.",
    });
  }
  const accepted = keys.some((k) => k.accepted);
  checks.push({
    key: "feed_key",
    status: keysBySettings || accepted ? "pass" : "fail",
    owner: "admin",
    message: keysBySettings
      ? "The operator's settings name the feed's keys (MIRROR_FEED_PUBLIC_KEYS)."
      : accepted
        ? "The feed's key is accepted."
        : keys.length > 0
          ? "The feed's key has been read and not yet accepted. Compare it with the key Minerval publishes, then accept it."
          : "The feed's key has not been read yet. It is read when the deployment connects, or with Read the key again.",
  });

  // What the feed cuts in now, from its listing, where it says.
  let feed: MirrorSetup["feed"] = null;
  if (bySettings !== "dir" && address && (bySettings === "url" || connection?.state === "connected")) {
    feed = { head: null, latest_snapshot: null, error: null };
    try {
      const res = await publicGraphFetch(`${address.replace(/\/+$/, "")}/mirror/feed?limit=1`, {
        fallbackKey: bySettings === "url" ? config.mirrorFeedApiKey : undefined,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        feed.error = `The feed answered ${res.status} to GET /mirror/feed.`;
      } else {
        const listing = (await res.json()) as {
          head?: number | null;
          latest_snapshot?: number | null;
          cuts_in?: { shape?: string; embedding?: { model?: string; dimensions?: number } };
        };
        feed.head = listing.head ?? null;
        feed.latest_snapshot = listing.latest_snapshot ?? null;
        const e = listing.cuts_in?.embedding;
        checks.push({
          key: "embedding",
          owner: "operator",
          status: !e ? "unknown" : e.model === EMBEDDING_MODEL && e.dimensions === EMBEDDING_DIMENSIONS ? "pass" : "fail",
          message: !e
            ? "The feed does not say which embedding model its vectors come from; a batch from another model would be refused with that reason."
            : e.model === EMBEDDING_MODEL && e.dimensions === EMBEDDING_DIMENSIONS
              ? `The feed's vectors come from ${EMBEDDING_MODEL}, as this deployment's do.`
              : `The feed's vectors come from ${e.model} (${e.dimensions} dimensions) and this deployment's from ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS}). The operator sets the embedding model to the feed's.`,
        });
        const shape = listing.cuts_in?.shape;
        checks.push({
          key: "shape",
          owner: "operator",
          status: !shape ? "unknown" : shape === replicatedShape() ? "pass" : "fail",
          message: !shape
            ? "The feed does not say the shape of the tables it cuts; a batch in another shape would be refused with that reason."
            : shape === replicatedShape()
              ? "The feed cuts the mirrored tables in the shape this release writes."
              : "The feed cuts the mirrored tables in a shape this release does not write. The operator upgrades this deployment to the public graph's release.",
        });
      }
    } catch (err) {
      feed.error = `The feed could not be read (${err instanceof Error ? err.message : String(err)}).`;
    }
  }

  let files: MirrorSetup["files"] = null;
  if (bySettings === "dir" && config.mirrorFeedDir) {
    try {
      const applied = new Set(
        (await rawQuery<{ sequence: string }>(`SELECT sequence FROM mirror_applied_batches`)).map((r) => Number(r.sequence))
      );
      files = readdirSync(config.mirrorFeedDir)
        .map((name) => ({ name, sequence: sequenceOfFileName(name) }))
        .filter((f): f is { name: string; sequence: number } => f.sequence !== null)
        .sort((a, b) => a.sequence - b.sequence)
        .map((f) => ({ ...f, applied: applied.has(f.sequence) }));
    } catch {
      files = [];
    }
  }

  const names = await rawQuery<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM contributors WHERE id = ANY($1::uuid[])`,
    [[row?.started_by, row?.paused_by].filter((x): x is string => Boolean(x))]
  );
  const nameOf = (id: string | null | undefined) => (id ? (names.find((n) => n.id === id)?.display_name ?? null) : null);

  return {
    in_app: followsInApp(config),
    source: { kind: bySettings === "dir" ? "files" : "network", set_by: bySettings ? "settings" : "app", address },
    state: bySettings ? "following" : row?.state === "following" ? "following" : row?.state === "paused" ? "paused" : "not_started",
    started_at: iso(row?.started_at),
    started_by: nameOf(row?.started_by),
    paused_at: iso(row?.paused_at),
    paused_by: nameOf(row?.paused_by),
    last_checked_at: iso(row?.last_checked_at),
    last_check_error: row?.last_check_error ?? null,
    check_requested: Boolean(row?.check_requested_at && (!row.last_checked_at || row.check_requested_at > row.last_checked_at)),
    interval_seconds: Math.max(1, config.mirrorApplyIntervalSeconds),
    checks,
    keys_set_by_settings: keysBySettings,
    keys,
    feed,
    status,
    refusal_owner: status.last_refusal ? (REFUSAL_OWNER[status.last_refusal.code] ?? "operator") : null,
    files,
    batches: await appliedBatches(opts.notes === true),
  };
}

// ---- for Health, the Inbox and the sidebar ------------------------------------------

export interface MirrorAttention {
  state: "following" | "paused" | "not_started";
  set_by: "app" | "settings";
  /** A key read from the feed that nobody has accepted, while none is: no batch can apply until one is. */
  key_waiting: boolean;
  /** The last refusal since the newest batch applied, with who fixes it. */
  refusal: { code: string; message: string; owner: "operator" | "admin" } | null;
  /** What stopped the last look short of the feed, where something did. */
  check_error: string | null;
}

/** What needs someone about the mirror, read here without asking the feed. Null where nothing is or could be followed. */
export async function mirrorAttention(): Promise<MirrorAttention | null> {
  const config = loadConfig();
  const bySettings = followedBySettings(config);
  if (!bySettings && !followsInApp(config)) return null;
  const row = await followingRow();
  const state = bySettings ? "following" : (row?.state ?? "not_started");
  const keys = bySettings || config.mirrorFeedPublicKeys.length > 0 ? [] : await feedKeys();
  const status = state === "not_started" ? null : await mirrorStatus();
  const refusal = status?.last_refusal ?? null;
  return {
    state,
    set_by: bySettings ? "settings" : "app",
    key_waiting: keys.length > 0 && !keys.some((k) => k.accepted),
    refusal: refusal ? { code: refusal.code, message: refusal.message, owner: REFUSAL_OWNER[refusal.code] ?? "operator" } : null,
    check_error: state === "following" ? (row?.last_check_error ?? null) : null,
  };
}
