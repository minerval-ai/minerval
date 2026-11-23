/**
 * The list of Minerval's releases, as signed entries (docs/releases.md,
 * "What is current").
 *
 * An entry is a statement Minerval signed and is never edited:
 *
 *   release     a release's facts at one revision. A correction is the next
 *               revision, with what changed and why; the list shows the
 *               latest and keeps the rest.
 *   withdrawal  a release found to be bad: the reason, and the version to
 *               move to.
 *
 * What is signed is the entry's `payload`: Ed25519 over
 * sha256("minerval-release/1\n" + canonical JSON of the payload), by the
 * release key (src/release-key.ts). Canonical JSON is the run log's
 * (services/run-log.ts), as the mirror feed's batches use. A release's
 * prose is not in the payload, so the list can be read without it; the
 * payload carries the prose's hash, which fixes it.
 *
 * Nothing here reads the database: it makes, checks and reduces entries.
 */
import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { canonicalContent } from "./services/run-log.js";
import { keyIdOf, publicKeyString } from "./services/mirror-batch.js";
import type { ReleaseFacts } from "./release-notes.js";
import { VERSION_PATTERN, compareVersions } from "./version.js";

export const RELEASE_ENTRY_FORMAT = 1;
const DOMAIN = `minerval-release/${RELEASE_ENTRY_FORMAT}`;

export interface ReleasePayload extends ReleaseFacts {
  kind: "release";
  /** 1 for the release as cut; each correction is the next number. */
  revision: number;
  /** For a correction: what changed from the revision before, and why. */
  correction?: { what: string; why: string };
  /** sha256 of the prose, in hex. */
  prose_sha256: string;
}

export interface WithdrawalPayload {
  kind: "withdrawal";
  /** The release withdrawn. */
  version: string;
  /** The day it was withdrawn, YYYY-MM-DD. */
  date: string;
  reason: string;
  /** The version a deployment running it should move to. */
  move_to: string;
}

export type EntryPayload = ReleasePayload | WithdrawalPayload;

/** An entry as it travels and is kept. */
export interface ReleaseEntry {
  payload: EntryPayload;
  /** A release's prose, where the entry carries it. */
  prose?: string | null;
  /** Ed25519 over the payload's hash, base64. */
  signature: string;
  /** Which key signed it (keyIdOf of its public half). */
  key_id: string;
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export const proseHash = (prose: string): string => sha256(prose);

function payloadHash(payload: EntryPayload): Buffer {
  return Buffer.from(sha256(`${DOMAIN}\n${canonicalContent(JSON.parse(JSON.stringify(payload)))}`), "hex");
}

/** Sign a payload with the release key's private half. */
export function signEntry(payload: EntryPayload, signingKey: KeyObject, prose?: string): ReleaseEntry {
  const publicKey = publicKeyString(createPublicKey(signingKey));
  return {
    payload,
    ...(prose !== undefined ? { prose } : {}),
    signature: cryptoSign(null, payloadHash(payload), signingKey).toString("base64"),
    key_id: keyIdOf(publicKey),
  };
}

/** The release keys a deployment checks against, by id. */
export function trustedKeys(publicKeys: readonly string[]): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const text of publicKeys) {
    const raw = Buffer.from(text.trim(), "base64");
    if (raw.length !== 32) continue;
    keys.set(
      keyIdOf(text.trim()),
      createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" })
    );
  }
  return keys;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const release = (v: unknown): v is string => typeof v === "string" && VERSION_PATTERN.test(v) && !v.includes("-dev");

/** What is wrong with a payload's shape, or null. The signature is checked separately. */
function payloadProblem(payload: unknown): string | null {
  if (!isRecord(payload)) return "it has no payload";
  if (!release(payload.version)) return "its version is not a release";
  if (typeof payload.date !== "string" || !DAY.test(payload.date)) return "its date is not a day";
  if (payload.kind === "withdrawal") {
    if (typeof payload.reason !== "string" || payload.reason.trim() === "") return "a withdrawal needs its reason";
    if (!release(payload.move_to)) return "a withdrawal needs the version to move to";
    return null;
  }
  if (payload.kind !== "release") return "it is neither a release nor a withdrawal";
  if (!Number.isInteger(payload.revision) || (payload.revision as number) < 1) return "its revision is not a number from 1";
  if (typeof payload.security !== "boolean") return "it does not say whether it is a security release";
  if (payload.upgrades_from !== null && !release(payload.upgrades_from)) return "upgrades_from is not a release";
  if (typeof payload.prose_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(payload.prose_sha256)) return "it does not fix its prose";
  const settings = payload.settings;
  if (
    !isRecord(settings) ||
    !Array.isArray(settings.added) ||
    !Array.isArray(settings.retired) ||
    !Array.isArray(settings.defaults_changed)
  ) {
    return "its settings are not in three lists";
  }
  if (!Array.isArray(payload.operator_steps) || payload.operator_steps.some((s) => typeof s !== "string")) {
    return "its operator steps are not a list of sentences";
  }
  if ((payload.revision as number) > 1) {
    const c = payload.correction;
    if (!isRecord(c) || typeof c.what !== "string" || typeof c.why !== "string") return "a correction must say what changed and why";
  }
  return null;
}

export type EntryRefusal = "MALFORMED" | "UNKNOWN_KEY" | "BAD_SIGNATURE" | "PROSE_CHANGED";

/**
 * Check one entry against the release keys: its shape, that a key this
 * code has signed exactly this payload, and that any prose it carries is
 * the prose the payload fixes. Returns the entry as checked, or why not.
 */
export function verifyEntry(
  input: unknown,
  keys: ReadonlyMap<string, KeyObject>
): { ok: true; entry: ReleaseEntry } | { ok: false; code: EntryRefusal; message: string } {
  if (!isRecord(input) || typeof input.signature !== "string" || typeof input.key_id !== "string") {
    return { ok: false, code: "MALFORMED", message: "An entry needs a payload, a signature and the id of the key that signed it." };
  }
  const problem = payloadProblem(input.payload);
  if (problem) return { ok: false, code: "MALFORMED", message: `An entry is not one this code reads: ${problem}.` };
  const payload = input.payload as EntryPayload;
  const key = keys.get(input.key_id);
  if (!key) {
    return {
      ok: false,
      code: "UNKNOWN_KEY",
      message: `The entry for ${payload.version} is signed with a key this version of Minerval does not have (${input.key_id.slice(0, 16)}).`,
    };
  }
  let signed = false;
  try {
    signed = cryptoVerify(null, payloadHash(payload), key, Buffer.from(input.signature, "base64"));
  } catch {
    signed = false;
  }
  if (!signed) {
    return {
      ok: false,
      code: "BAD_SIGNATURE",
      message: `The entry for ${payload.version} does not carry Minerval's signature over what it says.`,
    };
  }
  const prose = typeof input.prose === "string" ? input.prose : null;
  if (prose !== null && payload.kind === "release" && proseHash(prose) !== payload.prose_sha256) {
    return { ok: false, code: "PROSE_CHANGED", message: `The notes of ${payload.version} are not the ones Minerval signed.` };
  }
  return {
    ok: true,
    entry: {
      payload,
      ...(payload.kind === "release" && prose !== null ? { prose } : {}),
      signature: input.signature,
      key_id: input.key_id,
    },
  };
}

// ---- the list a set of entries makes --------------------------------------------

export interface ListedRelease {
  version: string;
  date: string;
  security: boolean;
  upgrades_from: string | null;
  settings: ReleaseFacts["settings"];
  operator_steps: string[];
  /** The revision shown: the latest. */
  revision: number;
  /** Each correction made since the release was cut, oldest first. */
  corrections: Array<{ revision: number; what: string; why: string }>;
  /** Set where the release was withdrawn. */
  withdrawn: { date: string; reason: string; move_to: string } | null;
}

/** The releases a set of checked entries describes, newest first: each at its latest revision, with whether it was withdrawn. */
export function listReleases(entries: readonly ReleaseEntry[]): ListedRelease[] {
  const byVersion = new Map<string, { latest: ReleasePayload | null; corrections: ListedRelease["corrections"]; withdrawn: WithdrawalPayload | null }>();
  for (const { payload } of entries) {
    const at = byVersion.get(payload.version) ?? { latest: null, corrections: [], withdrawn: null };
    if (payload.kind === "withdrawal") {
      at.withdrawn = payload;
    } else {
      if (!at.latest || payload.revision > at.latest.revision) at.latest = payload;
      if (payload.correction) at.corrections.push({ revision: payload.revision, ...payload.correction });
    }
    byVersion.set(payload.version, at);
  }
  const listed: ListedRelease[] = [];
  for (const [version, at] of byVersion) {
    // A withdrawal of a release this list has no entry for says nothing a reader can use.
    if (!at.latest) continue;
    listed.push({
      version,
      date: at.latest.date,
      security: at.latest.security,
      upgrades_from: at.latest.upgrades_from,
      settings: at.latest.settings,
      operator_steps: at.latest.operator_steps,
      revision: at.latest.revision,
      corrections: at.corrections.sort((a, b) => a.revision - b.revision),
      withdrawn: at.withdrawn ? { date: at.withdrawn.date, reason: at.withdrawn.reason, move_to: at.withdrawn.move_to } : null,
    });
  }
  return listed.sort((a, b) => compareVersions(b.version, a.version));
}

/** The newest release that is not withdrawn; null where there is none. */
export function latestRelease(listed: readonly ListedRelease[]): ListedRelease | null {
  return listed.find((r) => !r.withdrawn) ?? null;
}

/** A release's payload from its notes: what the release workflow signs when a release is cut. */
export function releasePayload(
  facts: ReleaseFacts,
  prose: string,
  revision = 1,
  correction?: { what: string; why: string }
): ReleasePayload {
  return {
    kind: "release",
    ...facts,
    revision,
    ...(correction ? { correction } : {}),
    prose_sha256: proseHash(prose),
  };
}
