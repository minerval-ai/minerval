/**
 * File sets as the people who direct a deployment keep them, and as a run
 * is offered them (src/file-sets.ts; the tables are in db/schema.ts).
 *
 * The person's side: add a set, fill it (upload files into it, or register
 * a directory that already lies under the operator's root), close it, and
 * switch it off. Each of those acts writes a row to administrative_events
 * in the same transaction, as a connection's do (permission-service.ts).
 *
 * The run's side: fileSetsOfferedAt answers which sets a run at a label
 * has. Only a closed set that is on is ever offered.
 *
 * Where the bytes are. An uploaded set is a directory of this deployment's
 * store (FILE_SET_STORE_DIR), named by the set's slug; this process writes
 * it and the sandbox mounts the same store read-only. A registered
 * directory stays where it is, under FILE_SET_DIRECTORY_ROOT, which both
 * mount read-only. A self-hosted deployment needs a disk and nothing else.
 * A set's row holds its path relative to the store or the root, never an
 * absolute path, because the two processes mount them at different places.
 *
 * A read here is held to the reader's clearance: a set is listed, opened
 * and changed only by a person cleared for its label, and to anyone else it
 * does not exist.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, opendir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { loadConfig } from "../config.js";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import {
  FILE_SET_DESCRIPTION_MAX_CHARS,
  FILE_SET_NAME_MAX_CHARS,
  FILE_SET_SLUG_MAX_CHARS,
  FILE_SET_STAKE_MAX_CHARS,
  directoryProblem,
  filePathProblem,
  fileSetSlugFromName,
  isFileSetSlug,
  manifestHash,
  type FileSetOrigin,
} from "../file-sets.js";
import { labelsReadableFrom, logAdministrativeEvent } from "./permission-service.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";

export interface FileSetStoreConfig {
  fileSetStoreDir?: string;
  fileSetDirectoryRoot?: string;
  fileSetUploadMaxBytes?: number;
}

// ---- where the bytes are ---------------------------------------------------

/** The store uploaded sets are kept in, or null when the deployment has none. */
export function storeDir(config: FileSetStoreConfig = loadConfig()): string | null {
  return config.fileSetStoreDir?.trim() ? config.fileSetStoreDir.trim() : null;
}

/** The root a directory must be under to be registered, or null when the deployment has none. */
export function directoryRoot(config: FileSetStoreConfig = loadConfig()): string | null {
  return config.fileSetDirectoryRoot?.trim() ? config.fileSetDirectoryRoot.trim() : null;
}

/**
 * The directory a set's files are in, as this process sees it, or null when
 * the deployment no longer has the store or the root it was added under.
 */
export function fileSetDirectory(
  set: { origin: string; storageKey: string },
  config: FileSetStoreConfig = loadConfig()
): string | null {
  const root = set.origin === "upload" ? storeDir(config) : directoryRoot(config);
  return root ? join(root, set.storageKey) : null;
}

/** SHA-256 of a file's bytes, read as a stream. */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Every regular file under a directory, by its path relative to it, in no
 * particular order. A symbolic link is not followed and not listed: it
 * could point outside the directory, and what it points at is not this
 * set's. `skipped` counts links and anything else that is not a file.
 */
async function* walkFiles(root: string, skipped: { n: number }, relative = ""): AsyncGenerator<string> {
  const directory = await opendir(relative ? join(root, relative) : root);
  for await (const entry of directory) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) skipped.n += 1;
    else if (entry.isDirectory()) yield* walkFiles(root, skipped, path);
    else if (entry.isFile()) yield path;
    else skipped.n += 1;
  }
}

/** Take the write bits off a closed set's files and directories. Best effort: the hashes are what fix a set. */
async function makeReadOnly(root: string): Promise<void> {
  const skipped = { n: 0 };
  const directories = new Set<string>([root]);
  try {
    for await (const path of walkFiles(root, skipped)) {
      await chmod(join(root, path), 0o444);
      let parent = dirname(join(root, path));
      while (parent.startsWith(root) && !directories.has(parent)) {
        directories.add(parent);
        parent = dirname(parent);
      }
    }
    for (const directory of directories) await chmod(directory, 0o555);
  } catch {
    // A store that does not take modes still holds the set.
  }
}

// ---- rows and views ---------------------------------------------------------

interface FileSetRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  origin: FileSetOrigin;
  storage_key: string;
  party_id: string;
  party_name: string;
  party_is_own: boolean;
  stake: string;
  sensitivity_label: string;
  state: string;
  problem: string | null;
  file_count: number;
  total_bytes: string | number;
  manifest_hash: string | null;
  closed_at: Date | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  files_so_far: number;
  bytes_so_far: string | number;
  commands: number;
  analyses_kept: number;
  files_kept: number;
}

const FILE_SET_SELECT = `
  SELECT f.id, f.name, f.slug, f.description, f.origin, f.storage_key, f.party_id,
         p.name AS party_name, p.is_own_organization AS party_is_own, f.stake, f.sensitivity_label,
         f.state, f.problem, f.file_count, f.total_bytes, f.manifest_hash, f.closed_at, f.enabled,
         f.created_at, f.updated_at,
         (SELECT count(*)::int FROM file_set_files x WHERE x.file_set_id = f.id) AS files_so_far,
         (SELECT coalesce(sum(x.bytes), 0) FROM file_set_files x WHERE x.file_set_id = f.id) AS bytes_so_far,
         (SELECT count(*)::int FROM sandbox_calls k
           WHERE k.file_sets @> jsonb_build_array(jsonb_build_object('id', f.id::text))) AS commands,
         (SELECT count(*)::int FROM sandbox_calls k
           WHERE k.source_id IS NOT NULL
             AND k.file_sets @> jsonb_build_array(jsonb_build_object('id', f.id::text))) AS analyses_kept,
         (SELECT count(*)::int FROM file_set_keeps x WHERE x.file_set_id = f.id) AS files_kept
    FROM file_sets f
    JOIN parties p ON p.id = f.party_id`;

export interface FileSetView {
  id: string;
  name: string;
  /** The set's directory name in the sandbox, and the first part of the address of a file kept from it. */
  slug: string;
  description: string;
  /** upload | directory */
  origin: string;
  /** For a registered directory, its path under the root directories are registered from. */
  directory: string | null;
  party: { id: string; name: string; is_own_organization: boolean };
  stake: string;
  label: string;
  /** open | hashing | closed | failed */
  state: string;
  /** Why a set failed to fill; null otherwise. */
  problem: string | null;
  /** The files and bytes in it: final once closed, so far while it fills. */
  file_count: number;
  total_bytes: number;
  /** One SHA-256 over every file's hash and path; null until the set is closed. */
  manifest_sha256: string | null;
  closed_at: string | null;
  /** False when switched off: no run is offered it. */
  enabled: boolean;
  /** Commands agents ran with the set mounted, and the sources kept from it. */
  commands: number;
  analyses_kept: number;
  files_kept: number;
  created_at: string;
  updated_at: string;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

function view(r: FileSetRow): FileSetView {
  const closed = r.state === "closed";
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    origin: r.origin,
    directory: r.origin === "directory" ? r.storage_key : null,
    party: { id: r.party_id, name: r.party_name, is_own_organization: r.party_is_own },
    stake: r.stake,
    label: r.sensitivity_label,
    state: r.state,
    problem: r.problem,
    file_count: closed ? r.file_count : r.files_so_far,
    total_bytes: Number(closed ? r.total_bytes : r.bytes_so_far),
    manifest_sha256: r.manifest_hash,
    closed_at: iso(r.closed_at),
    enabled: r.enabled,
    commands: r.commands,
    analyses_kept: r.analyses_kept,
    files_kept: r.files_kept,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

/** Every set at a label the reader is cleared for, by name. */
export async function listFileSets(clearance: readonly string[]): Promise<FileSetView[]> {
  const rows = await rawQuery<FileSetRow>(
    `${FILE_SET_SELECT} WHERE f.sensitivity_label = ANY($1::text[]) ORDER BY lower(f.name)`,
    [[...clearance]]
  );
  return rows.map(view);
}

async function findRow(id: string, clearance: readonly string[]): Promise<FileSetRow | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await rawQuery<FileSetRow>(
    `${FILE_SET_SELECT} WHERE f.id = $1 AND f.sensitivity_label = ANY($2::text[])`,
    [id, [...clearance]]
  );
  return row ?? null;
}

/** One set, for a reader cleared for its label; null for anyone else, as for a set that does not exist. */
export async function getFileSet(id: string, clearance: readonly string[]): Promise<FileSetView | null> {
  const row = await findRow(id, clearance);
  return row ? view(row) : null;
}

export interface FileSetFileView {
  path: string;
  bytes: number;
  sha256: string;
}

/** A page of a set's manifest, in order of path. `after` is the last path of the page before. */
export async function listFileSetFiles(
  id: string,
  opts: { limit?: number; after?: string },
  clearance: readonly string[]
): Promise<FileSetFileView[] | null> {
  if (!(await findRow(id, clearance))) return null;
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 200)), 1000);
  // Ordered by the path's bytes, which is the manifest's order and does not
  // depend on the database's locale.
  const rows = await rawQuery<{ path: string; bytes: string | number; sha256: string }>(
    `SELECT path, bytes, sha256 FROM file_set_files
      WHERE file_set_id = $1 AND ($2::text IS NULL OR path COLLATE "C" > $2::text COLLATE "C")
      ORDER BY path COLLATE "C"
      LIMIT $3`,
    [id, opts.after ?? null, limit]
  );
  return rows.map((r) => ({ path: r.path, bytes: Number(r.bytes), sha256: r.sha256 }));
}

// ---- adding -----------------------------------------------------------------

export type FileSetFailureCode =
  | "INVALID_NAME"
  | "INVALID_SLUG"
  | "INVALID_DESCRIPTION"
  | "INVALID_STAKE"
  | "INVALID_DIRECTORY"
  | "INVALID_PATH"
  | "UNKNOWN_PARTY"
  | "LABEL_NOT_YOURS"
  | "NAME_TAKEN"
  | "SLUG_TAKEN"
  | "NO_STORE"
  | "NO_DIRECTORY_ROOT"
  | "DIRECTORY_NOT_FOUND"
  | "NOT_FOUND"
  | "CLOSED"
  | "NOT_AN_UPLOAD"
  | "PATH_TAKEN"
  | "TOO_LARGE"
  | "EMPTY"
  | "STILL_HASHING"
  | "NOTHING_TO_CHANGE";

type Refusal = { ok: false; code: FileSetFailureCode; message: string };
const refuse = (code: FileSetFailureCode, message: string): Refusal => ({ ok: false, code, message });

/** What a closed set says to any attempt to change it. */
const CLOSED_MESSAGE =
  "This set is closed: its files were hashed when it was filled, and nothing in it is added, changed " +
  "or removed afterwards. New files are a new set.";

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code ?? e?.cause?.code;
}

function constraintOf(err: unknown): string | undefined {
  const e = err as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.constraint ?? e?.cause?.constraint;
}

export interface NewFileSet {
  name: string;
  slug?: string;
  description?: string;
  partyId: string;
  stake: string;
  label: string;
  /** A directory under the operator's root, to register where it lies. Absent for a set filled by upload. */
  directory?: string;
}

/**
 * Add a set. With `directory` it is a registered directory, added in the
 * state 'hashing': the caller then starts fillFromDirectory, which walks
 * it, hashes each file and closes the set. Without, it is an empty set in
 * the store, open for uploadFile until closeFileSet.
 *
 * The label must be one the person adding the set may read: nobody places
 * material at a label they could not themselves open.
 */
export async function addFileSet(
  input: NewFileSet,
  actorId: string,
  clearance: readonly string[],
  config: FileSetStoreConfig = loadConfig()
): Promise<{ ok: true; id: string; origin: FileSetOrigin } | Refusal> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name || name.length > FILE_SET_NAME_MAX_CHARS) {
    return refuse("INVALID_NAME", `A file set needs a name of at most ${FILE_SET_NAME_MAX_CHARS} characters.`);
  }
  // The name is written into what agents are told, inside quotation marks.
  if (/["\n\r]/.test(name)) return refuse("INVALID_NAME", "A file set's name is one line with no quotation marks.");
  const slug = (input.slug ?? fileSetSlugFromName(name)).trim();
  if (!isFileSetSlug(slug)) {
    return refuse(
      "INVALID_SLUG",
      `slug is a short lower-case word that names the set's directory in the sandbox: letters and digits, with ` +
        `single hyphens or underscores between parts, starting with a letter, at most ${FILE_SET_SLUG_MAX_CHARS} characters.`
    );
  }
  const description = (input.description ?? "").trim().replace(/\s+/g, " ");
  if (description.length > FILE_SET_DESCRIPTION_MAX_CHARS || description.includes('"')) {
    return refuse(
      "INVALID_DESCRIPTION",
      `description says what the set holds, in at most ${FILE_SET_DESCRIPTION_MAX_CHARS} characters with no quotation marks.`
    );
  }
  const stake = input.stake.trim();
  if (!stake || stake.length > FILE_SET_STAKE_MAX_CHARS) {
    return refuse(
      "INVALID_STAKE",
      `A file set needs the stake of the party whose files they are, in a sentence or two (at most ` +
        `${FILE_SET_STAKE_MAX_CHARS} characters): what that party stands to gain or lose from what the files ` +
        `show. It is recorded on every source kept from the set, as a fact about the source.`
    );
  }
  if (!UUID_RE.test(input.partyId)) return refuse("UNKNOWN_PARTY", "No party has that id.");
  const label = input.label.trim();
  // One answer for a label that does not exist and one the person may not
  // read, so the route does not say which labels a deployment defines.
  if (!clearance.includes(label)) {
    return refuse(
      "LABEL_NOT_YOURS",
      `"${label}" is not a label you may read. A file set is added at a label the person adding it may read.`
    );
  }

  let origin: FileSetOrigin = "upload";
  let storageKey = slug;
  if (input.directory !== undefined) {
    origin = "directory";
    const root = directoryRoot(config);
    if (!root) {
      return refuse(
        "NO_DIRECTORY_ROOT",
        "This deployment has no root to register directories from (FILE_SET_DIRECTORY_ROOT is not set), so a set can only be uploaded."
      );
    }
    const directory = input.directory.trim().replace(/\/+$/, "");
    const problem = directoryProblem(directory);
    if (problem) return refuse("INVALID_DIRECTORY", problem);
    // The directory as it really is must be under the root as it really is:
    // a link out of the root names somebody else's files.
    let real: string;
    let realRoot: string;
    try {
      realRoot = await realpath(root);
      real = await realpath(join(root, directory));
      if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
    } catch {
      return refuse("DIRECTORY_NOT_FOUND", `There is no directory "${directory}" under the root directories are registered from.`);
    }
    if (!real.startsWith(realRoot + sep)) {
      return refuse("DIRECTORY_NOT_FOUND", `There is no directory "${directory}" under the root directories are registered from.`);
    }
    storageKey = real.slice(realRoot.length + 1).split(sep).join("/");
  } else if (!storeDir(config)) {
    return refuse(
      "NO_STORE",
      "This deployment has no store for uploaded sets (FILE_SET_STORE_DIR is not set), so a set can only be a directory registered where it lies."
    );
  }

  try {
    return await withTransaction(async (tx) => {
      const party = await tx.query(`SELECT 1 FROM parties WHERE id = $1`, [input.partyId]);
      if (party.length === 0) return refuse("UNKNOWN_PARTY", "No party has that id.");
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO file_sets (name, slug, description, origin, storage_key, party_id, stake, sensitivity_label, state, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [name, slug, description, origin, storageKey, input.partyId, stake, label, origin === "upload" ? "open" : "hashing", actorId]
      );
      await logAdministrativeEvent(tx, "file_set_added", actorId, {
        file_set_id: row!.id,
        party_id: input.partyId,
        label,
      });
      if (origin === "upload") {
        // The set's own directory, made with its row. The slug is unique, so
        // a directory already there is left over from a row that never
        // committed, and is the same empty directory.
        await mkdir(join(storeDir(config)!, slug), { recursive: true, mode: 0o755 });
      }
      return { ok: true as const, id: row!.id, origin };
    });
  } catch (err) {
    if (sqlState(err) === UNIQUE_VIOLATION) {
      return constraintOf(err) === "uq_file_sets_slug"
        ? refuse("SLUG_TAKEN", `Another file set already uses the slug "${slug}".`)
        : refuse("NAME_TAKEN", `A file set named "${name}" already exists.`);
    }
    throw err;
  }
}

// ---- filling by upload ------------------------------------------------------

/**
 * Take one file into an open set: stream it to the store, hashing it as it
 * goes, and record it in the set's manifest. The bytes go to a temporary
 * file first and are moved into place only once the manifest row is in, so
 * a set never holds a file its manifest does not.
 */
export async function uploadFile(
  id: string,
  path: string,
  body: Readable,
  clearance: readonly string[],
  config: FileSetStoreConfig = loadConfig()
): Promise<{ ok: true; file: FileSetFileView } | Refusal> {
  const row = await findRow(id, clearance);
  if (!row) return refuse("NOT_FOUND", "File set not found");
  if (row.origin !== "upload") {
    return refuse("NOT_AN_UPLOAD", "This set is a registered directory: its files are the directory's, and none is uploaded into it.");
  }
  if (row.state !== "open") return refuse("CLOSED", CLOSED_MESSAGE);
  const problem = filePathProblem(path);
  if (problem) return refuse("INVALID_PATH", problem);
  const store = storeDir(config);
  if (!store) return refuse("NO_STORE", "This deployment has no store for uploaded sets (FILE_SET_STORE_DIR is not set).");

  const max = config.fileSetUploadMaxBytes ?? Number.MAX_SAFE_INTEGER;
  const tooLarge = () =>
    refuse(
      "TOO_LARGE",
      `This file would take the set past ${max.toLocaleString("en-US")} bytes, the most an uploaded set may hold ` +
        `here. Upload is for sets of modest size, since every byte passes through the API; register larger data ` +
        `as a directory where it lies.`
    );
  const room = max - Number(row.bytes_so_far);
  if (room <= 0) return tooLarge();

  const incoming = join(store, ".incoming");
  await mkdir(incoming, { recursive: true, mode: 0o700 });
  const temporary = join(incoming, randomUUID());
  const hash = createHash("sha256");
  let bytes = 0;
  let over = false;
  try {
    await pipeline(
      body,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > room) {
            over = true;
            throw new Error("over the set's size");
          }
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(temporary, { mode: 0o644 })
    );
  } catch (err) {
    await rm(temporary, { force: true });
    if (over) return tooLarge();
    throw err;
  }
  const sha256 = hash.digest("hex");
  const target = join(store, row.storage_key, path);

  try {
    return await withTransaction(async (tx) => {
      const [now] = await tx.query<{ state: string; total: string | number }>(
        `SELECT f.state, (SELECT coalesce(sum(bytes), 0) FROM file_set_files x WHERE x.file_set_id = f.id) AS total
           FROM file_sets f WHERE f.id = $1 FOR UPDATE`,
        [id]
      );
      if (!now || now.state !== "open") return refuse("CLOSED", CLOSED_MESSAGE);
      if (Number(now.total) + bytes > max) return tooLarge();
      await tx.query(`INSERT INTO file_set_files (file_set_id, path, bytes, sha256) VALUES ($1, $2, $3, $4)`, [
        id,
        path,
        bytes,
        sha256,
      ]);
      await tx.query(`UPDATE file_sets SET updated_at = now() WHERE id = $1`, [id]);
      try {
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await rename(temporary, target);
      } catch {
        // A part of the path is already a file in the set, or the path is
        // already a directory of it.
        throw new PathConflict();
      }
      return { ok: true as const, file: { path, bytes, sha256 } };
    });
  } catch (err) {
    await rm(temporary, { force: true });
    if (err instanceof PathConflict) {
      return refuse("PATH_TAKEN", `"${path}" cannot be added: part of that path is already a file in the set, or it is already a directory of it.`);
    }
    if (sqlState(err) === UNIQUE_VIOLATION) {
      return refuse("PATH_TAKEN", `The set already has a file at "${path}". A file in a set is not replaced.`);
    }
    throw err;
  } finally {
    await rm(temporary, { force: true });
  }
}

class PathConflict extends Error {}

// ---- closing ----------------------------------------------------------------

/** Mark a set closed from its manifest rows, and log it. Called with the set's row locked. */
async function closeLocked(tx: TxQuery, id: string, actorId: string | null): Promise<{ files: number; manifest: string }> {
  const files = await tx.query<{ path: string; sha256: string; bytes: string | number }>(
    `SELECT path, sha256, bytes FROM file_set_files WHERE file_set_id = $1`,
    [id]
  );
  const manifest = manifestHash(files);
  const total = files.reduce((sum, f) => sum + Number(f.bytes), 0);
  await tx.query(
    `UPDATE file_sets
        SET state = 'closed', problem = NULL, file_count = $2, total_bytes = $3, manifest_hash = $4,
            closed_at = now(), updated_at = now()
      WHERE id = $1`,
    [id, files.length, total, manifest]
  );
  await logAdministrativeEvent(tx, "file_set_closed", actorId, {
    file_set_id: id,
    files: String(files.length),
    manifest_sha256: manifest,
  });
  return { files: files.length, manifest };
}

/**
 * Close an uploaded set: fix its manifest hash and offer it to runs. After
 * this nothing is added to it. For a registered directory whose walk failed
 * or was cut short, the caller starts the walk again instead
 * (fillFromDirectory); `restart` says so.
 */
export async function closeFileSet(
  id: string,
  actorId: string,
  clearance: readonly string[],
  config: FileSetStoreConfig = loadConfig()
): Promise<{ ok: true; restart: boolean } | Refusal> {
  const row = await findRow(id, clearance);
  if (!row) return refuse("NOT_FOUND", "File set not found");
  if (row.state === "closed") return refuse("CLOSED", CLOSED_MESSAGE);
  if (row.origin === "directory") {
    if (walking.has(id)) {
      return refuse("STILL_HASHING", "This directory is still being walked and hashed. The set closes by itself when that is done.");
    }
    return { ok: true, restart: true };
  }
  const closed = await withTransaction(async (tx) => {
    const [now] = await tx.query<{ state: string }>(`SELECT state FROM file_sets WHERE id = $1 FOR UPDATE`, [id]);
    if (!now || now.state !== "open") return refuse("CLOSED", CLOSED_MESSAGE);
    const [count] = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM file_set_files WHERE file_set_id = $1`, [id]);
    if ((count?.n ?? 0) === 0) return refuse("EMPTY", "This set has no files yet. A set is closed once its files are in.");
    await closeLocked(tx, id, actorId);
    return { ok: true as const, restart: false };
  });
  if (closed.ok) {
    const directory = fileSetDirectory({ origin: row.origin, storageKey: row.storage_key }, config);
    if (directory) await makeReadOnly(directory);
  }
  return closed;
}

// ---- filling from a registered directory -----------------------------------

/** The sets whose directories this process is walking now. */
const walking = new Set<string>();

/**
 * Walk a registered directory, hash every file where it lies, and close
 * the set. Nothing is copied. Starts from nothing each time, so a walk that
 * was cut short is simply run again. A directory with no file, or one that
 * cannot be read through, leaves the set 'failed' with why.
 *
 * This can take as long as the data is large, so the route that registers a
 * directory does not wait for it: the set's state says where it is.
 */
export async function fillFromDirectory(id: string, config: FileSetStoreConfig = loadConfig()): Promise<void> {
  if (walking.has(id)) return;
  const [set] = await rawQuery<{ origin: string; storage_key: string; state: string; created_by: string | null }>(
    `SELECT origin, storage_key, state, created_by FROM file_sets WHERE id = $1`,
    [id]
  );
  if (!set || set.origin !== "directory" || set.state === "closed") return;
  walking.add(id);
  try {
    await rawQuery(`UPDATE file_sets SET state = 'hashing', problem = NULL, updated_at = now() WHERE id = $1`, [id]);
    await rawQuery(`DELETE FROM file_set_files WHERE file_set_id = $1`, [id]);
    const root = fileSetDirectory({ origin: set.origin, storageKey: set.storage_key }, config);
    if (!root) throw new Error("this deployment no longer has a root to register directories from");
    const skipped = { n: 0 };
    let files = 0;
    for await (const path of walkFiles(root, skipped)) {
      const problem = filePathProblem(path);
      if (problem) throw new Error(`the file ${JSON.stringify(path)} has a path a set cannot hold: ${problem}`);
      const { sha256, bytes } = await hashFile(join(root, path));
      await rawQuery(`INSERT INTO file_set_files (file_set_id, path, bytes, sha256) VALUES ($1, $2, $3, $4)`, [
        id,
        path,
        bytes,
        sha256,
      ]);
      files += 1;
      if (files % 200 === 0) await rawQuery(`UPDATE file_sets SET updated_at = now() WHERE id = $1`, [id]);
    }
    if (files === 0) throw new Error("the directory holds no files");
    await withTransaction(async (tx) => {
      await tx.query(`SELECT 1 FROM file_sets WHERE id = $1 FOR UPDATE`, [id]);
      // The walk closes the set for the person who registered the directory.
      await closeLocked(tx, id, set.created_by);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await rawQuery(`UPDATE file_sets SET state = 'failed', problem = $2, updated_at = now() WHERE id = $1 AND state <> 'closed'`, [
      id,
      `The directory could not be hashed: ${message}.`,
    ]);
  } finally {
    walking.delete(id);
  }
}

// ---- switching off ----------------------------------------------------------

/**
 * Switch a set off or on. Off, no run is offered it. Nothing else about a
 * set changes after it is added, and a set is never deleted: the commands
 * run against it and the sources kept from it refer to it, and they stand.
 */
export async function changeFileSet(
  id: string,
  input: { enabled: boolean },
  actorId: string,
  clearance: readonly string[]
): Promise<{ ok: true } | Refusal> {
  if (!(await findRow(id, clearance))) return refuse("NOT_FOUND", "File set not found");
  return withTransaction(async (tx) => {
    const [before] = await tx.query<{ enabled: boolean }>(`SELECT enabled FROM file_sets WHERE id = $1 FOR UPDATE`, [id]);
    if (!before) return refuse("NOT_FOUND", "File set not found");
    if (before.enabled === input.enabled) {
      return refuse("NOTHING_TO_CHANGE", "Nothing in the request differs from the set as it is.");
    }
    await tx.query(`UPDATE file_sets SET enabled = $2, updated_at = now() WHERE id = $1`, [id, input.enabled]);
    await logAdministrativeEvent(tx, "file_set_changed", actorId, {
      file_set_id: id,
      changed: "enabled",
      enabled: String(input.enabled),
    });
    return { ok: true as const };
  });
}

// ---- what a run is offered --------------------------------------------------

/** A set as a run has it. */
export interface RunFileSet {
  id: string;
  name: string;
  slug: string;
  description: string;
  origin: FileSetOrigin;
  storageKey: string;
  partyId: string;
  partyName: string;
  stake: string;
  label: string;
  fileCount: number;
  totalBytes: number;
  manifestHash: string;
  closedAt: Date;
}

/**
 * The sets a run working at `label` has: every closed set that is on and
 * whose label that label reads, by name. A set still filling is not
 * offered: until it is closed its hash is not fixed.
 */
export async function fileSetsOfferedAt(label: string): Promise<RunFileSet[]> {
  const readable = await labelsReadableFrom([label]);
  const rows = await rawQuery<FileSetRow>(
    `${FILE_SET_SELECT}
      WHERE f.enabled AND f.state = 'closed' AND f.sensitivity_label = ANY($1::text[])
      ORDER BY lower(f.name)`,
    [readable]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    origin: r.origin,
    storageKey: r.storage_key,
    partyId: r.party_id,
    partyName: r.party_name,
    stake: r.stake,
    label: r.sensitivity_label,
    fileCount: r.file_count,
    totalBytes: Number(r.total_bytes),
    manifestHash: r.manifest_hash!,
    closedAt: new Date(r.closed_at!),
  }));
}

// ---- the commands a person sees --------------------------------------------

export interface SandboxCallView {
  /** The call's id, as the agent that ran the command was given it. */
  id: string;
  called_at: string;
  duration_ms: number | null;
  /** running | exited | timed_out | memory | output_ceiling | scratch_full | killed | failed */
  outcome: string;
  exit_code: number | null;
  /** Why a failed call failed: the deployment's own account of it. */
  error: string | null;
  output_chars: number | null;
  output_sha256: string | null;
  /** The sets the command could read, by id and name. */
  file_sets: Array<{ id: string; name: string }>;
  run_id: string | null;
  agent: string | null;
  /** The node the run was working on, when it was working on one. */
  claim_id: string | null;
  /** The source kept from the call, when an agent's work rested on it. */
  source_id: string | null;
  kept_at: string | null;
  /** The command and the files given with it, for a reader cleared for the call's label; absent otherwise. */
  command?: string;
  files?: Array<{ path: string; sha256: string; chars: number }>;
  command_withheld?: true;
}

/**
 * The commands agents ran in the sandbox, newest first, without their
 * output. With `fileSetId`, those that had that set mounted. A command and
 * the files given with it are what an agent wrote at the call's label, so
 * they are shown only to a reader whose clearance covers that label; that a
 * command ran, when, against which sets and how it ended is shown to anyone
 * who may see the set. A kept analysis is read as the source it became.
 */
export async function listSandboxCalls(
  opts: { fileSetId?: string; limit?: number; before?: string; keptOnly?: boolean },
  clearance: readonly string[]
): Promise<SandboxCallView[] | null> {
  if (opts.fileSetId !== undefined && !(await findRow(opts.fileSetId, clearance))) return null;
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 100)), 500);
  const before = opts.before && !Number.isNaN(Date.parse(opts.before)) ? opts.before : null;
  // Only calls whose every set the reader may see are listed: a set's name
  // is not shown to a reader who is not cleared for it.
  const rows = await rawQuery<{
    id: string;
    called_at: Date;
    duration_ms: number | null;
    outcome: string | null;
    exit_code: number | null;
    error: string | null;
    output_chars: number | null;
    output_hash: string | null;
    file_sets: Array<{ id: string; name: string }>;
    run_id: string | null;
    agent: string | null;
    claim_id: string | null;
    source_id: string | null;
    kept_at: Date | null;
    command: string;
    files: Array<{ path: string; sha256: string; content: string }>;
    sensitivity_label: string;
  }>(
    `SELECT k.id, k.called_at, k.duration_ms, k.outcome, k.exit_code, k.error, k.output_chars, k.output_hash,
            k.file_sets, k.run_id, k.agent, k.claim_id, k.source_id, k.kept_at, k.command, k.files,
            k.sensitivity_label
       FROM sandbox_calls k
      WHERE ($1::text IS NULL OR k.file_sets @> jsonb_build_array(jsonb_build_object('id', $1::text)))
        AND ($2::timestamptz IS NULL OR k.called_at < $2::timestamptz)
        AND (NOT $3::boolean OR k.source_id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(k.file_sets) s
           WHERE NOT EXISTS (
             SELECT 1 FROM file_sets f
              WHERE f.id::text = s->>'id' AND f.sensitivity_label = ANY($5::text[])))
      ORDER BY k.called_at DESC, k.id DESC
      LIMIT $4`,
    [opts.fileSetId ?? null, before, opts.keptOnly === true, limit, [...clearance]]
  );
  const cleared = new Set(clearance);
  return rows.map((r) => ({
    id: r.id,
    called_at: iso(r.called_at)!,
    duration_ms: r.duration_ms,
    outcome: r.outcome ?? "running",
    exit_code: r.exit_code,
    error: r.outcome === "failed" ? r.error : null,
    output_chars: r.output_chars,
    output_sha256: r.output_hash,
    file_sets: (r.file_sets ?? []).map((s) => ({ id: s.id, name: s.name })),
    run_id: r.run_id,
    agent: r.agent,
    claim_id: r.claim_id,
    source_id: r.source_id,
    kept_at: iso(r.kept_at),
    ...(cleared.has(r.sensitivity_label)
      ? {
          command: r.command,
          files: (r.files ?? []).map((f) => ({ path: f.path, sha256: f.sha256, chars: f.content.length })),
        }
      : { command_withheld: true as const }),
  }));
}

// ---- for the preflight ------------------------------------------------------

/** What the preflight needs to know of one set (docs/file-sets.md, "What the preflight should check"). */
export interface FileSetCheck {
  id: string;
  name: string;
  /** Whether the set's directory is where this process looks for it. */
  present: boolean;
  /** Files of the manifest that are missing, or no longer the size they were hashed at (the first few). */
  missing: string[];
  changed: string[];
  /** With `rehash`: files whose bytes no longer match the hash taken when the set was added (the first few). */
  mismatched: string[];
  ok: boolean;
}

const CHECK_LISTED_MAX = 20;

/**
 * Check one closed set against its manifest: every file is where the
 * manifest says, at the size it was hashed at, and, with `rehash`, with the
 * bytes it was hashed at. Hashing a large set again takes as long as adding
 * it did, so that part is asked for.
 */
export async function verifyFileSet(
  id: string,
  opts: { rehash?: boolean } = {},
  config: FileSetStoreConfig = loadConfig()
): Promise<FileSetCheck | null> {
  const [set] = await rawQuery<{ name: string; origin: string; storage_key: string }>(
    `SELECT name, origin, storage_key FROM file_sets WHERE id = $1 AND state = 'closed'`,
    [id]
  );
  if (!set) return null;
  const check: FileSetCheck = { id, name: set.name, present: false, missing: [], changed: [], mismatched: [], ok: false };
  const root = fileSetDirectory({ origin: set.origin, storageKey: set.storage_key }, config);
  try {
    check.present = root !== null && (await stat(root)).isDirectory();
  } catch {
    check.present = false;
  }
  if (!check.present || !root) return check;
  const files = await rawQuery<{ path: string; bytes: string | number; sha256: string }>(
    `SELECT path, bytes, sha256 FROM file_set_files WHERE file_set_id = $1 ORDER BY path COLLATE "C"`,
    [id]
  );
  let bad = 0;
  const note = (list: string[], path: string) => {
    bad += 1;
    if (list.length < CHECK_LISTED_MAX) list.push(path);
  };
  for (const file of files) {
    let size: number;
    try {
      const st = await lstat(join(root, file.path));
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      note(check.missing, file.path);
      continue;
    }
    if (size !== Number(file.bytes)) note(check.changed, file.path);
    else if (opts.rehash && (await hashFile(join(root, file.path))).sha256 !== file.sha256) note(check.mismatched, file.path);
  }
  check.ok = bad === 0;
  return check;
}

/** Check every closed set that is on. Not called by anything in this change: the preflight is meant to call it. */
export async function checkFileSets(opts: { rehash?: boolean } = {}): Promise<FileSetCheck[]> {
  const rows = await rawQuery<{ id: string }>(
    `SELECT id FROM file_sets WHERE enabled AND state = 'closed' ORDER BY lower(name)`
  );
  const checks: FileSetCheck[] = [];
  for (const row of rows) {
    const check = await verifyFileSet(row.id, opts);
    if (check) checks.push(check);
  }
  return checks;
}
