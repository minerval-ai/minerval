/**
 * The check of a published page (docs/published-pages.md, "The check").
 *
 * A deployment that shows a node's page outside carries it out as a signed
 * package: the page as the outside reads it, the policy it was redacted
 * under, and a record of how it was made. This file checks a package
 * against itself. It is the whole of the standalone verifier
 * (scripts/published-page.ts verify), it is what the public graph runs
 * before it admits a package, and it is what a reader's browser runs from
 * the claim's page.
 *
 * It imports nothing and uses only Web Crypto, TextEncoder and atob, which
 * a browser and Node both have. It reads no database, no network and no
 * clock. web/lib/published-page/ holds a copy the sync script writes, and a
 * test fails when the two differ.
 *
 * What it checks, and what it cannot, are said in plain words in its
 * result, because the result is read by people deciding how far to rely on
 * the page.
 *
 * The constructions, so that the check can be redone with nothing but
 * SHA-256 and Ed25519:
 *
 *   hash of a package = hex SHA-256 of
 *       its format ("minerval-published-page/2") + "\n" + canonical JSON
 *       of the package without its `hash` and `signature`
 *     canonical JSON: object keys sorted, no whitespace, scalars as
 *     JSON.stringify writes them (the run log's form, services/run-log.ts)
 *   signature         = Ed25519 over the 32 bytes of the hash, base64
 *   key id            = hex SHA-256 of the key's 32 raw bytes
 *   the page's tree   = services/page-fingerprint.ts, repeated below
 */

export const PUBLISHED_PAGE_FORMAT = "minerval-published-page/2";

/**
 * The format before it (docs/releasing-a-page.md, "Old names in the code").
 * A package in it is the same package under its earlier names: `showing`
 * for `release`, `node.showing_began` for `node.release_began`,
 * `always_shown` and `always_shown_hash` for `always_released` and
 * `always_released_hash`, a page's and a version's `shown_at` for
 * `released_at`, and no `fingerprint_format`, since every page in it is
 * fingerprinted under the construction before the current one. A package
 * signed in it stays in it: it is checked as it was signed, and read
 * through currentPackage.
 */
export const PUBLISHED_PAGE_FORMAT_1 = "minerval-published-page/1";

/** The formats this check reads. */
export const PUBLISHED_PAGE_FORMATS: readonly string[] = [PUBLISHED_PAGE_FORMAT, PUBLISHED_PAGE_FORMAT_1];

/**
 * The constructions a page's fingerprint is made under
 * (services/page-fingerprint.ts): the current one, and the one before it,
 * which every page of a package in format /1 is under. A package in /2 names
 * its page's in `page.fingerprint_format`, and the root is rebuilt under
 * that one alone.
 */
export const TREE_FORMAT = "minerval-released-page/2";
export const TREE_FORMAT_1 = "minerval-shown-page/1";
const TREE_FORMATS: readonly string[] = [TREE_FORMAT, TREE_FORMAT_1];

/** Where a deployment runs, in the only words a record may say it in. */
export const HOSTING_WORDS = {
  own_machines: "the organization's own machines",
  minerval: "Minerval's machines",
  third_party: "a third party's machines",
} as const;
export type Hosting = keyof typeof HOSTING_WORDS;

/** What attests to a run from outside its publisher's control. Today nothing can, and the record says so. */
export const ATTESTATION_WORDS = {
  nothing: "nothing outside the publisher's control attests to the run",
} as const;
export type Attestation = keyof typeof ATTESTATION_WORDS;

export const PAGE_STATES = ["not_yet_assessed", "released_whole", "released_in_part", "held"] as const;
export type PageState = (typeof PAGE_STATES)[number];

export interface PackageMark {
  at: number;
  category: string;
}

export interface PackagePart {
  part: number;
  kind: string;
  /** The kind as the tree binds it: an argument's says which way it bears. */
  descriptor: string;
  hash: string;
  /** Present when the part was released. */
  text?: string;
  marks?: PackageMark[];
  salt?: string;
  /** Present while the part is held: who has not released it, the reasons given from the fixed list, and since when. */
  held?: { by: string[]; reasons: string[]; since: string | null };
}

export interface PackageVersion {
  page_id: string;
  version_of: string;
  state: PageState | "not_redacted";
  held_because?: string;
  held_since?: string;
  released_at?: string;
  parts_held?: number;
  of_parts?: number;
  held_kinds?: string;
  removals?: Record<string, number>;
  /**
   * How the publisher's gate to outside was set for this version when it
   * was released, for each party it rests on: open, the Redactor's decision,
   * or a person's decision as well, how wide the setting was and the day it
   * was set. Stamped by the publishing deployment's gate, in its fixed
   * words. Absent from a package built before the gate stamped it.
   */
  released_under?: Array<{ for_party: string; the_gate: "open" | "redactor" | "person"; in_words: string; from: string; set_on: string | null }>;
  fingerprint: string | null;
}

export interface PackageAct {
  at: string;
  what: string;
  on?: string;
  page_id?: string;
  /** "person 1", "the Redactor", "the gate's setting" or "the process". People are numbered in the order they first acted; no name crosses. */
  by: string;
  /** The permissions the person held when they acted. */
  holding: string[];
  for_party?: string;
  reason?: string;
}

export interface PackageSaidBack {
  contribution: string;
  received_at: string;
  repeats?: string;
  reassessment?: "not paid for" | "paid for, and not yet made" | "made";
  reassessment_as_of?: string;
}

export interface PublishedPagePackage {
  format: string;
  publisher: { key_id: string; public_key: string };
  deployment: {
    hosting: Hosting;
    attested_by: Attestation;
    /**
     * Whether the deployment asks the public graph for a fresh public
     * assessment of a public node when its own version of the node changes
     * (docs/outward-acts.md), and whether a public mandate of its own pays
     * for that. Stamped by the system. Absent from a package built before
     * the setting existed.
     */
    keeps_public_versions_current?: { setting: "on" | "off"; a_public_mandate_pays_for_it: boolean };
  };
  release: {
    id: string;
    form: "once" | "standing";
    /**
     * What the release covers: one node, the node with what sits under it,
     * every node one mandate's work assessed, or every node assessed at the
     * label (shape.ts, releaseCovers). The scope is not part of what the
     * check confirms beyond being one of these: it is the publisher's word.
     */
    scope: PageScope;
    asked_at: string;
    /** Whether each package is sent by a person, or follows from a choice made when the release was asked for. */
    send: "by_a_person_each_time" | "as_released";
    ended: null | { at: string; because: string };
  };
  node: {
    /** The node's id on the public graph. */
    public_id: string;
    covered_from: string;
    first_assessed_at: string | null;
    release_began: "before the node was first assessed" | "after the node was first assessed";
    left: null | { at: string; because: string };
  };
  /** 1, 2, 3, ... for this node under this release, each naming the hash of the one before. */
  sequence: number;
  previous_hash: string | null;
  /** The node's state now: that of its latest version. */
  state: PageState;
  /**
   * The latest version that is shown, with its text; or, where none has
   * been shown, the latest version, held. A later version that is held is
   * in the history and does not take the last shown page away.
   */
  page: null | {
    id: string;
    version_of: string;
    state: Exclude<PageState, "not_yet_assessed">;
    held: null | { because: string; since: string };
    released_at: string | null;
    redaction_round: number;
    fingerprint: string | null;
    /** The construction the fingerprint is made under: TREE_FORMAT, or TREE_FORMAT_1 for a page recorded before it. */
    fingerprint_format: string;
    earlier_fingerprints: unknown[];
    /** What is always shown, exactly as hashed. Null while the page is held. */
    always_released: null | { text: string; salt: string };
    always_released_hash: string | null;
    parts: PackagePart[];
    audit: string | null;
  };
  policy: null | { version: number; hash: string; text: string };
  record: {
    made: null | {
      prompt_set: string | null;
      assessed_by_model: string | null;
      redacted_by_model: string | null;
      role_additions: unknown[];
      run_log: null | { sealed: boolean; seal: string | null; steps: number | null; chain_verifies: boolean | null };
      paid_for: null | { by: string; stake: string };
    };
    acts: PackageAct[];
    versions: PackageVersion[];
    /**
     * The contributions made on the public graph through this page that the
     * deployment has received, by their ids there, each with whether it has
     * been read and where the reassessment it opened stands, in fixed
     * words. No word of a contribution is here. Absent where none was
     * received.
     */
    said_back?: PackageSaidBack[];
  };
  built_at: string;
  hash: string;
  signature: string;
}

/** What a check found. Every list is sentences a person can read. */
export interface PackageCheck {
  /** Nothing that was checked failed. */
  ok: boolean;
  confirmed: string[];
  failed: string[];
  /** What this check cannot show, and why. Never empty: a check that looked complete would mislead. */
  cannot_show: string[];
  released_parts: number;
  held_parts: number;
}

/**
 * The words a registration signs: the key holder's statement that an
 * account on the public graph speaks for the key, and where the deployment
 * runs. Signed so that nobody registers a key they do not hold.
 */
export function registrationStatement(input: { account: string; publicKey: string; hosting: string }): string {
  return `minerval-publisher-registration/1\n${input.account}\n${input.publicKey}\n${input.hosting}`;
}

// ---- small tools ------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const isDate = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function sha256(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
}

/** The hash a package's signature is over, under the format the package names (the current one where it names none this check reads). */
export async function packageHash(pkg: Record<string, unknown>): Promise<string> {
  const { hash: _hash, signature: _signature, ...body } = pkg;
  const format = typeof pkg.format === "string" && PUBLISHED_PAGE_FORMATS.includes(pkg.format) ? pkg.format : PUBLISHED_PAGE_FORMAT;
  return sha256(`${format}\n${canonical(JSON.parse(JSON.stringify(body)))}`);
}

/**
 * A package as the current format reads it. A package in the format before
 * it is given with its release under `release` and `node.release_began`,
 * and its own fields beside them; everything else is the same object. Read
 * through this; check, hash and store the package as it was signed.
 */
export function currentPackage<T>(pkg: T): T {
  const p = pkg as unknown as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || p.format !== PUBLISHED_PAGE_FORMAT_1 || "release" in p) return pkg;
  const node = (p.node ?? null) as Record<string, unknown> | null;
  const page = (p.page ?? null) as Record<string, unknown> | null;
  const record = (p.record ?? null) as Record<string, unknown> | null;
  const version = (v: unknown) =>
    v && typeof v === "object" && "shown_at" in v ? { ...(v as Record<string, unknown>), released_at: (v as Record<string, unknown>).shown_at } : v;
  return {
    ...p,
    release: p.showing,
    node: node && typeof node === "object" ? { ...node, release_began: node.showing_began } : node,
    page:
      page && typeof page === "object"
        ? {
            ...page,
            released_at: page.shown_at,
            always_released: page.always_shown,
            always_released_hash: page.always_shown_hash,
            fingerprint_format: TREE_FORMAT_1,
          }
        : page,
    record: record && typeof record === "object" && Array.isArray(record.versions) ? { ...record, versions: record.versions.map(version) } : record,
  } as unknown as T;
}

/** A key's short name: the hash of its 32 raw bytes, given as base64. */
export async function keyIdOfPublicKey(publicKey: string): Promise<string | null> {
  const raw = fromBase64(publicKey.trim());
  return raw && raw.length === 32 ? sha256(raw) : null;
}

// ---- the tree, as services/page-fingerprint.ts builds it ---------------------------

const markOf = (category: string) => `[redacted: ${category}]`;

async function partCommitment(salt: string, text: string, marks: readonly PackageMark[]): Promise<string> {
  return sha256(`part\n${salt}\n${JSON.stringify(marks.map((m) => [m.at, m.category]))}\n${text}`);
}

async function treeTop(leaves: readonly string[]): Promise<string> {
  if (leaves.length === 0) return sha256("empty");
  if (leaves.length === 1) return leaves[0]!;
  let split = 1;
  while (split * 2 < leaves.length) split *= 2;
  return sha256(`node\n${await treeTop(leaves.slice(0, split))}\n${await treeTop(leaves.slice(split))}`);
}

async function treeRoot(leaves: ReadonlyArray<{ position: number; descriptor: string; commitment: string }>, format: string): Promise<string> {
  const hashes: string[] = [];
  for (const l of leaves) hashes.push(await sha256(`leaf\n${l.position}\n${l.descriptor}\n${l.commitment}`));
  return sha256(`root\n${format}\n${leaves.length}\n${await treeTop(hashes)}`);
}

// ---- the check ----------------------------------------------------------------------

export interface VerifyOptions {
  /**
   * The publisher's key as learned somewhere other than the package (the
   * public graph's record of the publisher), base64 of its 32 bytes. Without
   * it the check can say that the package is signed by the key it carries,
   * and not whose key that is.
   */
  publisherKey?: string | null;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** The scopes of a release whose packages carry a node's page (services/release-service.ts, RELEASE_SCOPES, less `item`). */
export const PAGE_SCOPES: readonly string[] = ["node", "under", "mandate", "boundary"];
export type PageScope = "node" | "under" | "mandate" | "boundary";

/** Whether the package has the form this check reads. Returns what is wrong, in words, or null. */
function malformed(p: PublishedPagePackage): string | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "it is not a JSON object";
  if (!PUBLISHED_PAGE_FORMATS.includes(p.format)) return `its format is ${JSON.stringify(p.format)} and this check reads ${PUBLISHED_PAGE_FORMATS.map((f) => `"${f}"`).join(" and ")}`;
  if (!p.publisher || typeof p.publisher.key_id !== "string" || typeof p.publisher.public_key !== "string") return "it names no signing key";
  if (typeof p.hash !== "string" || !HEX64.test(p.hash)) return "it has no hash";
  if (typeof p.signature !== "string" || p.signature.length === 0) return "it has no signature";
  if (!p.deployment || !(p.deployment.hosting in HOSTING_WORDS)) return "it does not say where the deployment runs in one of the fixed ways";
  if (!(p.deployment.attested_by in ATTESTATION_WORDS)) return "it does not say what attests to the run in one of the fixed ways";
  const s = p.release;
  if (!s || typeof s.id !== "string" || (s.form !== "once" && s.form !== "standing") || !PAGE_SCOPES.includes(s.scope) || !isDate(s.asked_at)) {
    return "it does not describe the release: its form, its scope and when it was asked for";
  }
  if (s.send !== "by_a_person_each_time" && s.send !== "as_released") return "it does not say how its packages are sent";
  if (s.ended !== null && (!s.ended || !isDate(s.ended.at) || typeof s.ended.because !== "string")) return "its ending has no date or no reason";
  const n = p.node;
  if (!n || typeof n.public_id !== "string" || !isDate(n.covered_from)) return "it does not name the node or say when the release came to cover it";
  if (n.first_assessed_at !== null && !isDate(n.first_assessed_at)) return "the date the node was first assessed is not a date";
  if (!Number.isSafeInteger(p.sequence) || p.sequence < 1) return "it has no sequence number";
  if (p.sequence === 1 ? p.previous_hash !== null : typeof p.previous_hash !== "string" || !HEX64.test(p.previous_hash)) {
    return "it does not name the package before it";
  }
  if (!(PAGE_STATES as readonly string[]).includes(p.state)) return "its state is not one of the four";
  if (p.page !== null) {
    if (typeof p.page !== "object" || typeof p.page.id !== "string" || !isDate(p.page.version_of) || !Array.isArray(p.page.parts)) return "its page has no id, no date or no parts";
    if (!TREE_FORMATS.includes(p.page.fingerprint_format)) return "its page does not name a construction of the fingerprint this check knows";
    for (const part of p.page.parts) {
      if (!part || !Number.isSafeInteger(part.part) || typeof part.descriptor !== "string" || typeof part.kind !== "string" || typeof part.hash !== "string" || !HEX64.test(part.hash)) {
        return "one of its parts has no place, no kind or no hash";
      }
    }
  }
  if (p.policy !== null && (!p.policy || typeof p.policy.text !== "string" || typeof p.policy.hash !== "string")) return "its policy has no text or no hash";
  const r = p.record;
  if (!r || !Array.isArray(r.acts) || !Array.isArray(r.versions)) return "its record has no list of acts or no history of versions";
  for (const a of r.acts) {
    if (!a || !isDate(a.at) || typeof a.what !== "string" || typeof a.by !== "string" || !Array.isArray(a.holding)) return "an act in its record has no date, no actor or no list of permissions";
  }
  for (const v of r.versions) {
    if (!v || typeof v.page_id !== "string" || !isDate(v.version_of) || typeof v.state !== "string") return "a version in its history has no id, no date or no state";
  }
  if (!isDate(p.built_at)) return "it does not say when it was built";
  return null;
}

/**
 * Check a published page's package against itself, and against the
 * publisher's key where one is given. Resolves to what was confirmed, what
 * failed, and what a check of this kind cannot show.
 */
export async function verifyPublishedPage(input: unknown, opts: VerifyOptions = {}): Promise<PackageCheck> {
  const confirmed: string[] = [];
  const failed: string[] = [];
  const cannot: string[] = [];
  let released = 0;
  let held = 0;
  const done = (): PackageCheck => ({ ok: failed.length === 0, confirmed, failed, cannot_show: cannot, released_parts: released, held_parts: held });

  let signed: PublishedPagePackage;
  try {
    signed = (typeof input === "string" ? JSON.parse(input) : input) as PublishedPagePackage;
  } catch {
    failed.push("This is not a published page's package: it is not JSON.");
    cannot.push("Nothing else was checked.");
    return done();
  }
  const pkg = currentPackage(signed);
  const wrong = malformed(pkg);
  if (wrong) {
    failed.push(`This is not a published page's package this check can read: ${wrong}.`);
    cannot.push("Nothing else was checked.");
    return done();
  }

  // 1. The contents are what the hash was taken over.
  const hash = await packageHash(signed as unknown as Record<string, unknown>);
  if (hash === pkg.hash) confirmed.push("The package's contents match its hash: nothing in it was changed after it was signed.");
  else failed.push("The package's contents do not match its hash, so it was altered or damaged after it was signed.");

  // 2. The signature, and whose key it is.
  const keyBytes = fromBase64(pkg.publisher.public_key);
  const signature = fromBase64(pkg.signature);
  const keyId = await keyIdOfPublicKey(pkg.publisher.public_key);
  if (!keyBytes || keyBytes.length !== 32 || !signature || keyId !== pkg.publisher.key_id) {
    failed.push("The signing key the package carries is not an Ed25519 key with the id it states.");
  } else {
    let verified: boolean | null = null;
    try {
      const key = await crypto.subtle.importKey("raw", keyBytes as unknown as ArrayBuffer, { name: "Ed25519" }, false, ["verify"]);
      verified = await crypto.subtle.verify({ name: "Ed25519" }, key, signature as unknown as ArrayBuffer, fromHex(pkg.hash) as unknown as ArrayBuffer);
    } catch {
      verified = null;
    }
    if (verified === null) {
      cannot.push("Whether the signature is good. This browser or runtime cannot check an Ed25519 signature; the command-line check can.");
    } else if (!verified) {
      failed.push("The signature does not verify, so the package was not signed by the holder of the key it names.");
    } else if (opts.publisherKey) {
      if (opts.publisherKey.trim() === pkg.publisher.public_key.trim()) {
        confirmed.push(`The signature is good, and the key (${pkg.publisher.key_id.slice(0, 16)}) is the one given to this check as the publisher's.`);
      } else {
        failed.push("The signature is good under the key the package carries, but that is not the key given to this check as the publisher's.");
      }
    } else {
      confirmed.push(`The signature is good under the key the package carries (${pkg.publisher.key_id.slice(0, 16)}).`);
      cannot.push("Whose key that is. Compare it with the key on the publisher's page on the public graph.");
    }
  }

  // 3. The page against its fingerprint.
  const page = pkg.page;
  if (page === null) {
    if (pkg.state !== "not_yet_assessed") failed.push(`The package carries no page, but says the node's state is "${pkg.state}".`);
    else confirmed.push("The package says the node is not yet assessed, and carries no page.");
  } else {
    const pageReleased = page.always_released !== null;
    if (!pageReleased && page.parts.some((part) => typeof part.text === "string")) {
      failed.push("The page is said to be held, but the package carries the text of one of its parts.");
    }
    const leaves: Array<{ position: number; descriptor: string; commitment: string }> = [];
    let treeProblems = 0;
    if (page.always_released_hash) {
      if (pageReleased) {
        if ((await partCommitment(page.always_released!.salt, page.always_released!.text, [])) !== page.always_released_hash) {
          treeProblems++;
          failed.push("The verdict and what is shown with it do not match their hash: they are not what was recorded.");
        }
      }
      leaves.push({ position: 0, descriptor: "verdict", commitment: page.always_released_hash });
    }
    for (const [i, part] of page.parts.entries()) {
      if (part.part !== i + 1) {
        treeProblems++;
        failed.push(`The part given in place ${i + 1} is recorded at place ${part.part}: the parts are out of order, or one is missing.`);
      }
      if (typeof part.text === "string") {
        released++;
        const marks = part.marks ?? [];
        if (typeof part.salt !== "string" || part.salt.length === 0) {
          treeProblems++;
          failed.push(`Part ${part.part} is shown without its salt, so it cannot be checked against its hash.`);
        } else {
          for (const mark of marks) {
            if (!part.text.startsWith(markOf(mark.category), mark.at)) {
              treeProblems++;
              failed.push(`Part ${part.part} lists a removal marked "${mark.category}" at a place where the text has no such mark.`);
            }
          }
          if ((await partCommitment(part.salt, part.text, marks)) !== part.hash) {
            treeProblems++;
            failed.push(`Part ${part.part} does not match its hash: its text, its marks or its salt is not what was recorded.`);
          }
        }
      } else {
        held++;
        if (!part.held) {
          treeProblems++;
          failed.push(`Part ${part.part} carries no text and is not said to be held.`);
        }
      }
      leaves.push({ position: part.part, descriptor: part.descriptor, commitment: part.hash });
    }
    if (page.fingerprint) {
      const root = await treeRoot(leaves, page.fingerprint_format);
      if (root !== page.fingerprint) {
        failed.push("The parts do not rebuild the page's fingerprint: a part was changed, moved, added or left out, or its kind is not the one recorded.");
      } else if (treeProblems === 0) {
        confirmed.push(
          pageReleased
            ? `The page rebuilds its fingerprint: ${plural(released, "released part is", "released parts are")} word for word what was recorded when the redaction finished, ` +
                `with each removal marked where it was made, and ${plural(held, "held part is", "held parts are")} in the recorded place and of the recorded kind.`
            : `The page is held, and its ${plural(page.parts.length, "part", "parts")} by kind and hash rebuild the fingerprint recorded when the redaction finished.`
        );
      }
    } else if (pageReleased || page.parts.length > 0) {
      failed.push("The page has parts but no fingerprint to check them against.");
    } else {
      confirmed.push("The page is held and has not been redacted yet, so it has no parts and no fingerprint.");
    }

    // The state the page states is the one its parts show.
    const expected: PageState = !pageReleased ? "held" : held === 0 ? "released_whole" : "released_in_part";
    if (page.state !== expected) failed.push(`The package says the page is "${page.state}", and its parts show "${expected}".`);
    if (!pageReleased && !page.held) failed.push("The page is held, and the package does not say why or since when.");

    // What is always shown agrees with the rest of the package.
    if (pageReleased) {
      let header: Record<string, unknown> | null = null;
      try {
        header = JSON.parse(page.always_released!.text) as Record<string, unknown>;
      } catch {
        failed.push("What is always shown with the page is not readable as recorded.");
      }
      if (header) {
        const made = (header.made ?? {}) as { policy?: { hash?: string | null }; prompt_set?: string | null };
        if (typeof header.parts === "number" && header.parts !== page.parts.length) {
          failed.push(`The page was recorded with ${header.parts} parts and the package carries ${page.parts.length}.`);
        }
        const counted = Object.values((header.removals ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
        const marked = page.parts.reduce((n, part) => n + (typeof part.text === "string" ? (part.marks ?? []).length : 0), 0);
        if (held === 0 ? marked !== counted : marked > counted) {
          failed.push(`The page was recorded with ${counted} removals and its released parts carry ${marked} marks.`);
        }
        if (pkg.policy && made.policy?.hash && made.policy.hash !== pkg.policy.hash) {
          failed.push("The policy in the package is not the version the page was redacted under.");
        }
        if (pkg.record.made && made.prompt_set !== undefined && pkg.record.made.prompt_set !== made.prompt_set) {
          failed.push("The record names a different prompt set from the one recorded with the page.");
        }
        if (typeof header.judged_at === "string" && Date.parse(header.judged_at) !== Date.parse(page.version_of)) {
          failed.push("The page's date is not the date recorded with its verdict.");
        }
      }
    }
  }

  // 4. The policy is the text its hash was taken over.
  if (pkg.policy) {
    if ((await sha256(pkg.policy.text)) === pkg.policy.hash) confirmed.push(`The redaction policy in the package (version ${pkg.policy.version}) is the text its hash names.`);
    else failed.push("The redaction policy's text does not match its hash.");
  } else if (page?.always_released) {
    failed.push("The page is released, and the package carries no redaction policy.");
  }

  // 5. The record's stamped fields are well formed.
  const made = pkg.record.made;
  if (page?.always_released && !made) failed.push("The page is released, and the record does not say how it was made.");
  if (made) {
    if (made.prompt_set !== null && !HEX64.test(made.prompt_set ?? "")) failed.push("The prompt set in the record is not a hash.");
    if (made.run_log && made.run_log.sealed && !HEX64.test(made.run_log.seal ?? "")) failed.push("The run log is said to be sealed, and the record gives no seal.");
  }
  if (page && !pkg.record.versions.some((v) => v.page_id === page.id && v.state === page.state)) {
    failed.push("The version in the package is not in its own history of versions, or is there in another state.");
  }
  // The node's state is that of its latest version, which may be a later one than the page carried.
  const latest = [...pkg.record.versions].filter((v) => v.state !== "not_redacted").sort((a, b) => Date.parse(b.version_of) - Date.parse(a.version_of))[0];
  if (pkg.state !== (latest?.state ?? "not_yet_assessed")) {
    failed.push(`The package says the node's state is "${pkg.state}", and its history's latest version is "${latest?.state ?? "not_yet_assessed"}".`);
  }
  if (failed.length === 0) {
    confirmed.push(
      `The record is well formed: ${plural(pkg.record.versions.length, "version", "versions")} in the history, ` +
        `${plural(pkg.record.acts.length, "act", "acts")} by people and the process, each with the permissions held.`
    );
  }

  // What a check of this kind cannot show.
  const where = HOSTING_WORDS[pkg.deployment.hosting];
  cannot.push(
    `That the assessment in the log was the only one made. The record says the deployment runs on ${where} and that ` +
      `${ATTESTATION_WORDS[pkg.deployment.attested_by]}` +
      (pkg.deployment.hosting === "own_machines" ? ", so its publisher could have assessed more than once and kept one." : ".")
  );
  if (made?.run_log) {
    cannot.push(
      "That the run's log is whole. The package gives the log's seal and what the deployment found when it checked its own chain; the log itself stays in the deployment."
    );
  }
  if (held > 0 || (page && !page.always_released)) cannot.push("What the held parts say. The check confirms their kinds, their places and that they have not changed.");
  if (page?.always_released) cannot.push("What was removed inside the released parts, or whether the policy called for it. The marks show where and under which category.");
  cannot.push(
    "That the dates and permissions in the record are true. They are the deployment's own record, signed by its key: the signature shows who states them, not that they are so."
  );
  cannot.push("That the prompt set is one you know. Compare its hash with the prompt set the public graph publishes.");
  return done();
}
