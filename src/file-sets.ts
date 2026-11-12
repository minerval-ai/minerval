/**
 * File sets: files of any kind, taken in as a set and explored in a sandbox
 * the deployment runs (docs/file-sets.md).
 *
 * Data exports, logs, evaluation transcripts, code: too large or too raw to
 * be documents. A set is the third of the three ways material comes in,
 * beside a document and a connection (src/connections.ts), and it follows
 * the connection's shape wherever the same question arises.
 *
 * The rules, each with where it is kept:
 *
 *  - A set has a name, the party whose material it is with that party's
 *    stake, and one label. A holder of the permission to direct adds one,
 *    from a signed-in session, at a label that person may read, and each
 *    such act is logged (services/file-set-service.ts, routes/file-sets.ts).
 *    Sets exist only in a members-only deployment; the public graph has
 *    none and runs none of this.
 *  - A set is filled one of two ways: files uploaded through a route and
 *    kept in the deployment's own store, or a directory already under a
 *    root the operator configured, read where it lies. Every file is hashed
 *    as it is added, and the set gets one hash over all of them
 *    (manifestHash below).
 *  - A set is closed once filled. No file is added, changed or removed
 *    afterwards. New files are a new set: there are no versions, so a hash
 *    names one set of bytes for good.
 *  - A run is offered a set when the label it works at reads the set's
 *    label (labelsReadableFrom), and is told in its brief which sets it has
 *    and whose material each is (llm/tools/file-set-tools.ts).
 *  - Commands run in the sandbox service (sandbox/ in this repository),
 *    which has no network and holds a command to the sets its run was
 *    given. Every command is stored whole with its output and its hash
 *    (sandbox_calls). A command is not a source until an agent's work rests
 *    on it: keep_analysis then makes the source row a judgment can cite.
 *    The call and that source carry the label of the run that ran the
 *    command, since the command is the run's own words.
 *  - A file of a set, or a passage of one, becomes a source with keep_file.
 *    That source is derived mechanically from the file and is the same
 *    whoever asks, so it carries the set's label (services/analysis-service.ts).
 *
 * This file holds what the rest shares and needs no database: the names,
 * the shape of a path and of an address, the manifest hash, and the
 * sentences a person adding a set is shown.
 */
import { createHash } from "node:crypto";

/** How a set's files came to be where they are. */
export const FILE_SET_ORIGINS = ["upload", "directory"] as const;
export type FileSetOrigin = (typeof FILE_SET_ORIGINS)[number];

/** A set's name is shown to people and to agents, so it is kept to a name. */
export const FILE_SET_NAME_MAX_CHARS = 120;
/** The stake is recorded on every source kept from the set, at the length a source's interest takes. */
export const FILE_SET_STAKE_MAX_CHARS = 1000;
/** What whoever adds a set says it holds, in a sentence or two. */
export const FILE_SET_DESCRIPTION_MAX_CHARS = 500;

/**
 * A set's slug: a short lower-case word, with single hyphens or underscores
 * between its parts. It is the set's directory name in the store and in the
 * sandbox, and the first part of the address of every file kept from it.
 */
export const FILE_SET_SLUG_PATTERN = "^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$";
export const FILE_SET_SLUG_MAX_CHARS = 48;
const SLUG_RE = new RegExp(FILE_SET_SLUG_PATTERN);

export function isFileSetSlug(value: string): boolean {
  return value.length <= FILE_SET_SLUG_MAX_CHARS && SLUG_RE.test(value);
}

/** A slug made from a set's name, for whoever gave none. */
export function fileSetSlugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^([0-9])/, "s$1")
    .slice(0, FILE_SET_SLUG_MAX_CHARS)
    .replace(/-+$/g, "");
  return slug || "set";
}

/** The longest path a file in a set may have, in characters. */
export const FILE_PATH_MAX_CHARS = 1000;

/**
 * Why `path` cannot be a file's path inside a set, or null when it can. A
 * path is relative, with `/` between its parts, and no part is empty, `.`
 * or `..`: it names a file under the set's own directory and nowhere else.
 */
export function filePathProblem(path: string): string | null {
  if (path.length === 0 || path.length > FILE_PATH_MAX_CHARS) {
    return `A file's path is 1 to ${FILE_PATH_MAX_CHARS} characters.`;
  }
  if (path.startsWith("/") || path.includes("\\")) {
    return "A file's path is relative to the set, with / between its parts.";
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "A file's path has no control characters.";
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") {
      return "A file's path names a file inside the set: no part of it is empty, . or ..";
    }
  }
  return null;
}

/**
 * A relative directory under the operator's root, as a registration names
 * it: the same shape as a file's path. Null when it is one.
 */
export function directoryProblem(directory: string): string | null {
  const problem = filePathProblem(directory);
  return problem
    ? "directory is a path under the root this deployment registers directories from, relative to that root: " +
        "no leading /, and no part that is empty, . or .."
    : null;
}

/** One file as a set's manifest holds it. */
export interface ManifestFile {
  path: string;
  sha256: string;
}

/**
 * The hash that fixes a whole set: SHA-256 over one line per file,
 * `<sha256>  <path>\n` (the format `sha256sum` prints), with the files in
 * order of their paths as bytes. Anyone holding the files can compute it:
 *
 *   find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sed 's#  \./#  #' | sha256sum
 */
export function manifestHash(files: readonly ManifestFile[]): string {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  const hash = createHash("sha256");
  for (const file of sorted) hash.update(`${file.sha256}  ${file.path}\n`, "utf8");
  return hash.digest("hex");
}

/**
 * What a person is told where sets are added. The routes return it with
 * what they serve, so a page shows the same words.
 */
export const FILE_SET_NOTICE =
  "A file set is closed once its files are in: nothing in it is changed or removed afterwards, and " +
  "new files are a new set. Each file is hashed when it is added and the set has one hash over all " +
  "of them, so what an agent's analysis read can be checked later. Agents whose work is at a label " +
  "that reads the set's label can read every file in it, by running commands in a sandbox that has " +
  "no network. The set belongs to the party you name, and the stake you give for that party is " +
  "recorded on every source an agent keeps from it, as a fact about the source. A directory " +
  "registered where it lies is not copied: keep it as it is, because a file that no longer matches " +
  "its hash cannot be kept as a source.";

/**
 * The address of a file kept from a set, or of a passage of one: what
 * `sources.url` holds for it and what an agent cites it by. It is not a web
 * address and nothing fetches it. The path is written as it is in the set,
 * with only the characters an address cannot carry escaped, so a reader can
 * see which file it is.
 */
export const KEPT_FILE_ADDRESS_SCHEME = "fileset:";

export function keptFileAddress(slug: string, path: string, lines?: { first: number; last: number } | null): string {
  const escaped = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `${KEPT_FILE_ADDRESS_SCHEME}${slug}/${escaped}${lines ? `#L${lines.first}-${lines.last}` : ""}`;
}

export function isKeptFileAddress(value: string): boolean {
  return value.startsWith(KEPT_FILE_ADDRESS_SCHEME);
}

/**
 * The address of an analysis kept from the sandbox: one command, what was
 * given with it and what it printed.
 */
export const ANALYSIS_ADDRESS_SCHEME = "analysis:";

export function analysisAddress(callId: string): string {
  return `${ANALYSIS_ADDRESS_SCHEME}${callId}`;
}

export function isAnalysisAddress(value: string): boolean {
  return value.startsWith(ANALYSIS_ADDRESS_SCHEME);
}

/**
 * The most text an agent may give with one command as files (a script,
 * usually), all of them together. They are stored with the call in one row
 * and sent to the sandbox in one request.
 */
export const COMMAND_FILES_MAX_CHARS = 400_000;
/** The longest command line. A longer program is a file given with the command. */
export const COMMAND_MAX_CHARS = 20_000;

/**
 * The largest file, or passage of one, that keep_file makes a source of. A
 * source's text is held whole in one row, like a connection's result.
 */
export const KEPT_FILE_MAX_CHARS = 2_000_000;
