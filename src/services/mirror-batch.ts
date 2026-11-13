/**
 * A batch of the mirror feed: its form, its hash, its signature, and the
 * checks that need no database (docs/mirror.md).
 *
 * A batch is one JSON document:
 *
 *   format        1
 *   feed_id       the feed it belongs to, minted with the feed's first batch
 *   sequence      1, 2, 3, ... with no repeat and no gap
 *   kind          "snapshot" (every published row) or "changes"
 *   part          { first, last }: a cut too large for one batch is split
 *                 into consecutive batches; `first` is the sequence the cut
 *                 began at and `last` says whether this batch ends it
 *   cut_at        when the publisher read its tables: the mirror shows the
 *                 public graph as of this time
 *   migration     { number, tag }: the schema the batch was cut from
 *   shape         the hash of the mirrored tables' shape (mirror-manifest.ts)
 *   embedding     { model, dimensions } of the vectors the rows carry
 *   publisher     { web_base_url }: where the public graph's pages are
 *   previous_hash the hash of the batch before it; for the first batch, the
 *                 feed's genesis
 *   rows          [{ table, rows: [...] }]: full rows, replicated columns
 *                 only, tables parents first
 *   deletions     [{ table, keys: [...] }]: rows that no longer exist
 *   retractions   [{ table, keys: [...] }]: rows that exist but are no
 *                 longer public
 *   key_id, public_key   the signing key (Ed25519), for whoever reads the
 *                 batch; an applier checks against the key it was configured
 *                 with, never this one
 *   hash          sha256("minerval-mirror-feed/1\n" + canonical JSON of
 *                 everything above)
 *   signature     Ed25519 over the hash's bytes, base64
 *
 * Canonical JSON is the run log's (run-log.ts): keys sorted, no whitespace,
 * scalars as JSON.stringify writes them. So the hash survives any reformatting
 * of the document in transit, and batches chain as a run's steps do: each
 * names the hash of the one before it, so a batch that is altered, dropped,
 * reordered or inserted shows.
 *
 * The signature is what a mirror trusts. The chain says the batches are a
 * sequence; only the signature says whose.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalContent } from "./run-log.js";

export const MIRROR_FEED_FORMAT = 1;
const DOMAIN = `minerval-mirror-feed/${MIRROR_FEED_FORMAT}`;

export type MirrorBatchKind = "snapshot" | "changes";

export interface MirrorTableRows {
  table: string;
  rows: Array<Record<string, unknown>>;
}

export interface MirrorTableKeys {
  table: string;
  keys: string[];
}

/** Everything a batch says, before it is hashed and signed. */
export interface MirrorBatchBody {
  format: number;
  feed_id: string;
  sequence: number;
  kind: MirrorBatchKind;
  part: { first: number; last: boolean };
  cut_at: string;
  migration: { number: number; tag: string };
  shape: string;
  embedding: { model: string; dimensions: number };
  publisher: { web_base_url: string };
  previous_hash: string;
  rows: MirrorTableRows[];
  deletions: MirrorTableKeys[];
  retractions: MirrorTableKeys[];
  key_id: string;
  public_key: string;
}

export interface MirrorBatch extends MirrorBatchBody {
  hash: string;
  signature: string;
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** What the first batch of a feed names as the batch before it. */
export function feedGenesisHash(feedId: string): string {
  return sha256(`${DOMAIN}\n${feedId.toLowerCase()}`);
}

/** The hash of a batch: over its canonical JSON, without `hash` and `signature`. */
export function batchHash(body: MirrorBatchBody): string {
  const { hash: _hash, signature: _signature, ...rest } = body as MirrorBatch;
  return sha256(`${DOMAIN}\n${canonicalContent(JSON.parse(JSON.stringify(rest)))}`);
}

// ---- keys ---------------------------------------------------------------------

/** The 32 raw bytes of an Ed25519 public key, base64: how the feed states its key. */
export function publicKeyString(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an Ed25519 public key");
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

/** A short name for a key: sha256 of its raw bytes. */
export function keyIdOf(publicKey: string): string {
  return sha256(Buffer.from(publicKey, "base64"));
}

/**
 * A public key from how an operator may have written it: the base64 of its
 * 32 raw bytes (what the feed publishes), or a PEM. Throws with a plain
 * message on anything else.
 */
export function parsePublicKey(text: string): KeyObject {
  const trimmed = text.trim();
  try {
    if (trimmed.includes("-----BEGIN")) {
      const key = createPublicKey(trimmed.replace(/\\n/g, "\n"));
      if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
      return key;
    }
    const raw = Buffer.from(trimmed, "base64");
    if (raw.length !== 32) throw new Error("not 32 bytes");
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
  } catch {
    throw new Error(
      "a mirror feed public key must be an Ed25519 key, written as the base64 of its 32 bytes " +
        "(as GET /mirror/feed/key gives it) or as a PEM"
    );
  }
}

/** The signing key from its PEM (PKCS#8, Ed25519). */
export function parseSigningKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem.replace(/\\n/g, "\n").trim());
  } catch {
    throw new Error("MIRROR_SIGNING_KEY is not a private key in PEM form");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("MIRROR_SIGNING_KEY must be an Ed25519 private key");
  }
  return key;
}

/** A new signing key pair: the private key as PEM, the public key as the feed states it. */
export function generateSigningKey(): { privateKeyPem: string; publicKey: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const stated = publicKeyString(publicKey);
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: stated,
    keyId: keyIdOf(stated),
  };
}

// ---- signing and checking -------------------------------------------------------

/** Hash and sign a batch. `body.key_id` and `body.public_key` must be the signing key's. */
export function signBatch(body: MirrorBatchBody, signingKey: KeyObject): MirrorBatch {
  const hash = batchHash(body);
  const signature = cryptoSign(null, Buffer.from(hash, "hex"), signingKey).toString("base64");
  return { ...body, hash, signature };
}

/**
 * Why a batch was not applied. Each code has one plain sentence an operator
 * reads (the refusal's message); the code is for the record and for tests.
 */
export const MIRROR_REFUSAL_CODES = [
  /** Not a batch this code can read. */
  "malformed",
  /** The contents are not what the hash was taken over. */
  "hash_mismatch",
  /** Signed by a key this deployment was not configured to trust. */
  "unknown_key",
  /** The signature does not verify. */
  "bad_signature",
  /** From a different feed than the one this mirror follows. */
  "other_feed",
  /** Neither the next batch nor the start of a later snapshot. */
  "sequence_gap",
  /** A different batch was applied at this sequence. */
  "sequence_conflict",
  /** Does not name the last applied batch as the one before it. */
  "chain_broken",
  /** A mirror that has applied nothing was given a batch that is not the start of a snapshot. */
  "not_a_snapshot",
  /** Cut from a newer schema in which the mirrored tables have a different shape: this deployment must upgrade. */
  "schema_newer",
  /** Cut from the same or an older schema, when the mirrored tables had a different shape. */
  "shape_differs",
  /** Its vectors were made with a different embedding model. */
  "embedding_differs",
  /** A row in it has the id of a row this deployment made itself. */
  "id_collision",
  /** The database refused a row (a key a local row already holds, a constraint). */
  "row_refused",
] as const;
export type MirrorRefusalCode = (typeof MIRROR_REFUSAL_CODES)[number];

/** A batch was not applied, and nothing of it was written. */
export class MirrorRefusal extends Error {
  constructor(
    readonly code: MirrorRefusalCode,
    message: string,
    readonly batch: { sequence: number | null; hash: string | null } = { sequence: null, hash: null }
  ) {
    super(message);
    this.name = "MirrorRefusal";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTableList(value: unknown, member: "rows" | "keys"): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { table?: unknown }).table === "string" &&
        Array.isArray((entry as Record<string, unknown>)[member])
    )
  );
}

/**
 * Read a batch from what arrived (parsed JSON, or its text). Throws
 * `malformed` when it is not a batch of this format, with what is wrong.
 */
export function readBatch(input: unknown): MirrorBatch {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new MirrorRefusal("malformed", "This is not a mirror batch: it is not JSON.");
    }
  }
  const b = value as Partial<MirrorBatch> | null;
  const at = { sequence: typeof b?.sequence === "number" ? b.sequence : null, hash: typeof b?.hash === "string" ? b.hash : null };
  const bad = (what: string) =>
    new MirrorRefusal("malformed", `This is not a mirror batch this deployment can read: ${what}.`, at);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw bad("it is not a JSON object");
  if (b.format !== MIRROR_FEED_FORMAT) {
    throw bad(`its format is ${JSON.stringify(b.format)} and this code reads format ${MIRROR_FEED_FORMAT}`);
  }
  if (typeof b.feed_id !== "string" || !UUID.test(b.feed_id)) throw bad("it names no feed");
  if (!Number.isSafeInteger(b.sequence) || b.sequence! < 1) throw bad("it has no sequence number");
  if (b.kind !== "snapshot" && b.kind !== "changes") throw bad("its kind is neither snapshot nor changes");
  if (
    !b.part ||
    !Number.isSafeInteger(b.part.first) ||
    typeof b.part.last !== "boolean" ||
    b.part.first > b.sequence! ||
    b.part.first < 1
  ) {
    throw bad("it does not say which part of a cut it is");
  }
  if (typeof b.cut_at !== "string" || Number.isNaN(Date.parse(b.cut_at))) throw bad("it does not say when it was cut");
  if (!b.migration || !Number.isSafeInteger(b.migration.number) || typeof b.migration.tag !== "string") {
    throw bad("it does not name the schema migration it was cut from");
  }
  if (typeof b.shape !== "string" || !HEX64.test(b.shape)) throw bad("it does not state the shape of its tables");
  if (!b.embedding || typeof b.embedding.model !== "string" || !Number.isSafeInteger(b.embedding.dimensions)) {
    throw bad("it does not name its embedding model");
  }
  if (!b.publisher || typeof b.publisher.web_base_url !== "string") throw bad("it does not name its publisher");
  if (typeof b.previous_hash !== "string" || !HEX64.test(b.previous_hash)) throw bad("it names no previous batch");
  if (!isTableList(b.rows, "rows")) throw bad("its rows are not a list of tables");
  if (!isTableList(b.deletions, "keys") || !isTableList(b.retractions, "keys")) {
    throw bad("its deletions or retractions are not a list of tables");
  }
  if (typeof b.key_id !== "string" || typeof b.public_key !== "string") throw bad("it names no signing key");
  if (typeof b.hash !== "string" || !HEX64.test(b.hash)) throw bad("it has no hash");
  if (typeof b.signature !== "string" || b.signature.length === 0) throw bad("it has no signature");
  return b as MirrorBatch;
}

/**
 * Check a batch against itself and against the keys this deployment trusts:
 * the hash is the hash of its contents, and the signature over that hash
 * verifies under one of the trusted keys. The key the batch carries is not
 * used: a forged batch would carry its forger's.
 */
export function verifyBatch(batch: MirrorBatch, trusted: readonly KeyObject[]): void {
  const at = { sequence: batch.sequence, hash: batch.hash };
  if (batchHash(batch) !== batch.hash) {
    throw new MirrorRefusal(
      "hash_mismatch",
      `Batch ${batch.sequence} was not applied: its contents do not match its hash, so it was altered or damaged after it was cut.`,
      at
    );
  }
  const signature = Buffer.from(batch.signature, "base64");
  const message = Buffer.from(batch.hash, "hex");
  const byId = trusted.filter((key) => keyIdOf(publicKeyString(key)) === batch.key_id);
  if (byId.length === 0) {
    // Tell the two failures apart: a signature that verifies under no
    // trusted key but names a key we do not hold is a key question.
    throw new MirrorRefusal(
      "unknown_key",
      `Batch ${batch.sequence} was not applied: it is signed with key ${batch.key_id.slice(0, 16)}, ` +
        `which is not a key this deployment trusts (MIRROR_FEED_PUBLIC_KEYS). ` +
        `If the feed's key has changed, confirm the new key with the publisher by another route before adding it.`,
      at
    );
  }
  if (!byId.some((key) => cryptoVerify(null, message, key, signature))) {
    throw new MirrorRefusal(
      "bad_signature",
      `Batch ${batch.sequence} was not applied: its signature does not verify, so it was not cut by the holder of the feed's key.`,
      at
    );
  }
}

// ---- ordering rows that point at each other --------------------------------------

/**
 * Order rows of one table so that every row comes after the rows of the same
 * table it points to, and return them in groups that must stay in one batch.
 *
 * A cut may be split into several batches, each applied in its own
 * transaction, and a row cannot be written before a row it references. Rows
 * of different tables are safe because tables are written parents first.
 * Rows of one table that reference each other (a claim merged into another,
 * a segment inside a section) are ordered here: referenced rows first, and
 * rows that reference each other in a circle kept together as one group,
 * which one statement writes at once.
 *
 * `references(key)` gives the keys, among `keys`, that the row points to.
 */
export function orderByReferences(keys: readonly string[], references: (key: string) => readonly string[]): string[][] {
  // Tarjan's strongly connected components, iteratively. It emits a
  // component only after every component it can reach, which is exactly
  // "referenced rows first".
  const present = new Set(keys);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];
  let next = 0;

  for (const root of keys) {
    if (index.has(root)) continue;
    const work: Array<{ key: string; edges: readonly string[]; at: number }> = [];
    const open = (key: string) => {
      index.set(key, next);
      low.set(key, next);
      next++;
      stack.push(key);
      onStack.add(key);
      work.push({ key, edges: references(key).filter((k) => present.has(k) && k !== key), at: 0 });
    };
    open(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.at < frame.edges.length) {
        const to = frame.edges[frame.at++]!;
        if (!index.has(to)) open(to);
        else if (onStack.has(to)) low.set(frame.key, Math.min(low.get(frame.key)!, index.get(to)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
      if (low.get(frame.key) === index.get(frame.key)) {
        const group: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          group.push(member);
          if (member === frame.key) break;
        }
        groups.push(group.reverse());
      }
    }
  }
  return groups;
}

/** The file a batch is carried in: zero-padded so a directory lists in order. */
export function batchFileName(sequence: number): string {
  return `mirror-batch-${String(sequence).padStart(12, "0")}.json`;
}

export function sequenceOfFileName(name: string): number | null {
  const m = /^mirror-batch-(\d{12})\.json$/.exec(name);
  return m ? Number(m[1]) : null;
}
