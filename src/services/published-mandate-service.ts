/**
 * A mandate another graph publishes here, and what can be asked of it
 * (docs/published-pages.md, "A published mandate").
 *
 * An organization that runs a private graph can let a mandate through its
 * gate to outside: that the mandate exists, its name and its terms, as its
 * Redactor and the people at that gate left them. It arrives here in a
 * package signed with the key the organization's account registered
 * (published-page-service.ts, registerPublisher), and stands on the
 * publisher's own record. It is the organization's face on this graph: a
 * request here can be addressed to it, as a request inside a deployment is
 * addressed to the face of a label above (label_faces), and the request's
 * own record then shows what became of it.
 *
 * With the mandate comes how the publisher's gate is set for its work: for
 * each thing that answers a request, whether the gate is open, whether
 * what its Redactor lets through goes with nobody deciding after it, or
 * whether a person decides as well. That is stamped by the publishing
 * deployment from its gates' own rows, in fixed words, and nobody writes
 * it. Each package is kept as received, so a changed term or setting is a
 * later row with its date, and the earlier ones stay.
 *
 * What a publisher says of its own mandate is its own statement on its own
 * record, like the interest it declares when it registers. It is not a
 * contribution to a node and is not reviewed as one. Nothing here checks
 * that the publisher's gate is set as the package says: a page it then
 * publishes says which setting it was released under, and the two can be
 * read against each other.
 */
import { createHash, verify as cryptoVerify } from "node:crypto";
import { rawQuery, withTransaction } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";
import { parsePublicKey } from "./mirror-batch.js";
import { canonicalContent } from "./run-log.js";

export const PUBLISHED_MANDATE_FORMAT = "minerval-published-mandate/1";

export class PublishedMandateError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** One setting of the publisher's gate, as its deployment stamped it (gate-face.ts, FaceSetting). */
export interface MandateSetting {
  what: string;
  kind: string;
  the_gate: "open" | "redactor" | "person";
  in_words: string;
  from: string;
  set_on: string | null;
  kept_back_hours?: number;
  in_batches_of_hours?: number;
}

export interface MandateFace {
  format: string;
  settings: MandateSetting[];
  for_requests_under: Array<{ public_node_id: string; kind: string; the_gate: "open" | "redactor" | "person"; in_words: string; set_on: string }>;
  narrower_settings_not_listed: number;
  pages_flow: string;
  other_parties: string;
  money: string;
}

export type MandatePart = { kind: string; text: string } | { kind: string; held: { by: string[]; because: string[] } };

export interface PublishedMandatePackage {
  format: string;
  publisher: { key_id: string; public_key: string };
  deployment: { hosting: string };
  mandate: {
    /** The publisher's own id for the offer. A request here is addressed to it. */
    ref: string;
    offered_at: string;
    /** Set once the publisher has withdrawn the mandate: nothing new can be asked of it. */
    withdrawn: null | { at: string };
    /** The version of the mandate's terms this package carries. */
    version_of: string;
    name: string | null;
    parts: MandatePart[];
    removals: Record<string, number>;
    policy: null | { version: number; hash: string };
    released_under: Array<{ for_party: string; the_gate: string; in_words: string; from: string; set_on: string | null }>;
  };
  face: MandateFace | null;
  sequence: number;
  previous_hash: string | null;
  built_at: string;
  hash: string;
  signature: string;
}

/** The hash a package is signed over: everything in it but the hash and the signature. */
export function mandatePackageHash(pkg: Record<string, unknown>): string {
  const { hash: _hash, signature: _signature, ...body } = pkg;
  return createHash("sha256")
    .update(`${PUBLISHED_MANDATE_FORMAT}\n${canonicalContent(JSON.parse(JSON.stringify(body)))}`, "utf8")
    .digest("hex");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = ["open", "redactor", "person"];
/** The most a mandate's name and terms may run to: they are shown whole on the publisher's record and to any agent that lists what can be asked. */
const NAME_MAX_CHARS = 200;
const TERMS_MAX_CHARS = 8000;

/** What is wrong with a package's form, or null. */
function malformed(p: PublishedMandatePackage): string | null {
  if (!p || typeof p !== "object") return "it is not an object";
  if (p.format !== PUBLISHED_MANDATE_FORMAT) return `its format is not ${PUBLISHED_MANDATE_FORMAT}`;
  if (!p.publisher || typeof p.publisher.key_id !== "string" || typeof p.publisher.public_key !== "string") return "it names no publisher's key";
  if (!p.deployment || typeof p.deployment.hosting !== "string") return "it does not say where its deployment runs";
  const m = p.mandate;
  if (!m || typeof m.ref !== "string" || !UUID_RE.test(m.ref)) return "it names no mandate";
  if (!Array.isArray(m.parts) || !Array.isArray(m.released_under)) return "its mandate has no list of parts or no record of the gate's setting";
  if (m.name !== null && typeof m.name !== "string") return "its mandate's name is not text";
  for (const part of m.parts) {
    if (!part || typeof part.kind !== "string") return "one of its parts has no kind";
    if (!("text" in part ? typeof part.text === "string" : part.held && Array.isArray(part.held.by) && Array.isArray(part.held.because))) return "one of its parts is neither text nor a held part";
  }
  if (!Number.isSafeInteger(p.sequence) || p.sequence < 1) return "it has no place in its sequence";
  if (typeof p.hash !== "string" || typeof p.signature !== "string") return "it has no hash or no signature";
  if (p.face !== null) {
    if (!p.face || !Array.isArray(p.face.settings) || !Array.isArray(p.face.for_requests_under)) return "its statement of the gate's settings has no list of settings";
    for (const s of [...p.face.settings, ...p.face.for_requests_under]) {
      if (!s || !MODES.includes(s.the_gate) || typeof s.kind !== "string") return "one of its settings is not open, redactor or person";
    }
    if (typeof p.face.money !== "string" || typeof p.face.other_parties !== "string" || typeof p.face.pages_flow !== "string") return "its statement of the gate's settings is incomplete";
  }
  return null;
}

/** The mandate's terms as one text: each released paragraph, and each held part named in its place. */
export function termsOf(m: PublishedMandatePackage["mandate"]): string {
  return m.parts
    .filter((p) => p.kind !== "name")
    .map((p) => ("text" in p ? p.text : `[Held by ${p.held.by.join(" and ") || "its publisher"}${p.held.because.length > 0 ? `: ${p.held.because.join("; ")}` : ""}]`))
    .join("\n\n");
}

export interface MandateAdmission {
  published_mandate_id: string;
  /** What a request is addressed to (`ask_of`). */
  face_id: string;
  sequence: number;
  status: "received" | "already_received";
  in_words: string;
}

/**
 * Take in one package of a published mandate from the account that
 * registered the key it is signed with. Checked before anything is kept:
 * its form, its hash, the key's signature, the account, and its place after
 * the package before it.
 */
export async function admitMandatePackage(input: { accountId: string; pkg: unknown }): Promise<MandateAdmission> {
  const pkg = input.pkg as PublishedMandatePackage;
  const bad = malformed(pkg);
  if (bad) throw new PublishedMandateError("MALFORMED", `This package was not taken, and nothing of it was kept: ${bad}.`);
  if (mandatePackageHash(pkg as unknown as Record<string, unknown>) !== pkg.hash) {
    throw new PublishedMandateError("DOES_NOT_VERIFY", "This package was not taken: its content is not what its hash was made over.");
  }
  const [publisher] = await rawQuery<{ account_id: string; public_key: string; hosting: string; name: string }>(
    `SELECT p.account_id, p.public_key, p.hosting, c.display_name AS name FROM publishers p JOIN contributors c ON c.id = p.account_id
      WHERE p.key_id = $1 AND p.retired_at IS NULL`,
    [pkg.publisher.key_id]
  );
  if (!publisher) {
    throw new PublishedMandateError("UNREGISTERED_KEY", "This package is signed with a key no account has registered on this graph. The organization's own account registers its deployment's key (POST /publishers) first.");
  }
  let signed = false;
  try {
    signed = cryptoVerify(null, Buffer.from(pkg.hash, "hex"), parsePublicKey(publisher.public_key), Buffer.from(pkg.signature, "base64"));
  } catch {
    signed = false;
  }
  if (!signed) throw new PublishedMandateError("DOES_NOT_VERIFY", "This package was not taken: it is not signed by the key it names, as this graph holds that key.");
  if (publisher.account_id !== input.accountId) {
    throw new PublishedMandateError("NOT_YOUR_KEY", "This package is signed with a key another account registered. A publisher submits its own packages, under its own account.");
  }
  if (publisher.hosting !== pkg.deployment.hosting) {
    throw new PublishedMandateError("HOSTING_DIFFERS", "This package says its deployment runs somewhere other than the key's registration says. Register the key again with where the deployment runs now.");
  }
  const name = (pkg.mandate.name ?? "").trim();
  const terms = termsOf(pkg.mandate);
  if (name.length > NAME_MAX_CHARS || terms.length > TERMS_MAX_CHARS) {
    throw new PublishedMandateError("TOO_LONG", `A published mandate's name is at most ${NAME_MAX_CHARS} characters and its terms at most ${TERMS_MAX_CHARS}: they are shown whole wherever the mandate is listed.`);
  }
  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`published-mandate:${pkg.publisher.key_id}:${pkg.mandate.ref}`]);
    const [already] = await tx.query<{ id: string; face_id: string; sequence: number }>(`SELECT id, face_id, sequence FROM published_mandates WHERE hash = $1`, [pkg.hash]);
    if (already) {
      return { published_mandate_id: already.id, face_id: already.face_id, sequence: already.sequence, status: "already_received" as const, in_words: "This graph already has this package. Nothing changed." };
    }
    const [last] = await tx.query<{ sequence: number; hash: string; face_id: string }>(
      `SELECT sequence, hash, face_id FROM published_mandates WHERE key_id = $1 AND ref = $2 ORDER BY sequence DESC LIMIT 1`,
      [pkg.publisher.key_id, pkg.mandate.ref]
    );
    const have = last?.sequence ?? 0;
    if (pkg.sequence !== have + 1) {
      throw new PublishedMandateError("OUT_OF_ORDER", `This graph has packages 1 to ${have} of this mandate, and this is package ${pkg.sequence}. Send package ${have + 1} next: each names the one before it.`);
    }
    if (last && last.hash !== pkg.previous_hash) {
      throw new PublishedMandateError("CHAIN_BROKEN", `Package ${pkg.sequence} does not name package ${have}, as this graph received it, as the one before it.`);
    }
    const shownName = name || "A mandate whose name its publisher holds";
    const shownTerms = terms || "Its publisher holds its terms.";
    let faceId = last?.face_id ?? null;
    if (!faceId) {
      // The face keeps the publisher's own id for the offer, so that the publisher finds the requests addressed to
      // it in the feed. An id some other row already holds is not taken over.
      const [taken] = await tx.query<{ id: string }>(`SELECT id FROM label_faces WHERE id = $1`, [pkg.mandate.ref]);
      if (taken) throw new PublishedMandateError("REF_IN_USE", "The id this package gives its mandate is already in use on this graph. A deployment's own ids are random, so this is not a package a deployment built.");
      const [face] = await tx.query<{ id: string }>(
        `INSERT INTO label_faces (id, publisher_account_id, name, can_be_asked, written_by, withdrawn_at, sensitivity_label)
         VALUES ($1, $2, $3, $4, $2, $5, $6) RETURNING id`,
        [pkg.mandate.ref, input.accountId, shownName, shownTerms, pkg.mandate.withdrawn ? new Date() : null, currentLabel()]
      );
      faceId = face!.id;
    } else {
      await tx.query(
        `UPDATE label_faces SET name = $2, can_be_asked = $3, updated_at = now(),
                withdrawn_at = CASE WHEN $4::boolean THEN COALESCE(withdrawn_at, now()) ELSE NULL END
          WHERE id = $1 AND publisher_account_id = $5`,
        [faceId, shownName, shownTerms, pkg.mandate.withdrawn !== null, input.accountId]
      );
    }
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO published_mandates (face_id, account_id, key_id, ref, sequence, hash, package, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id`,
      [faceId, input.accountId, pkg.publisher.key_id, pkg.mandate.ref, pkg.sequence, pkg.hash, JSON.stringify(pkg), currentLabel()]
    );
    return {
      published_mandate_id: row!.id,
      face_id: faceId,
      sequence: pkg.sequence,
      status: "received" as const,
      in_words: pkg.mandate.withdrawn
        ? "The mandate is withdrawn on this graph: nothing new can be asked of it, and what was asked keeps saying what it was addressed to."
        : `The mandate stands on ${publisher.name}'s record on this graph, with how its gate is set for the mandate's work. A request here can be addressed to it (ask_of: ${faceId}).`,
    };
  });
}

const GATE_SAID: Record<string, string> = {
  open: "open: it goes as written",
  redactor: "what its Redactor lets through under its published policy goes, with no person deciding after it",
  person: "a person decides as well, after its Redactor",
};

/** One setting in a line. */
export function settingLine(s: MandateSetting): string {
  return (
    `${s.what}: ${GATE_SAID[s.the_gate] ?? s.the_gate} (${s.from}${s.set_on ? `, set on ${s.set_on}` : ""})` +
    (s.kept_back_hours ? `, kept back ${s.kept_back_hours} hours` : "") +
    (s.in_batches_of_hours ? `, sent in batches every ${s.in_batches_of_hours} hours` : "") +
    "."
  );
}

/** What changed between two packages of one mandate, in fixed words. */
function changesBetween(before: PublishedMandatePackage | null, after: PublishedMandatePackage): string[] {
  if (!before) return ["First published."];
  const out: string[] = [];
  if (after.mandate.withdrawn && !before.mandate.withdrawn) out.push("Withdrawn: nothing new can be asked of it.");
  if (!after.mandate.withdrawn && before.mandate.withdrawn) out.push("Published again.");
  if ((before.mandate.name ?? "") !== (after.mandate.name ?? "")) out.push("Its name changed.");
  if (termsOf(before.mandate) !== termsOf(after.mandate)) out.push("Its terms changed.");
  const was = new Map((before.face?.settings ?? []).map((s) => [s.kind, s]));
  for (const s of after.face?.settings ?? []) {
    const old = was.get(s.kind);
    if (!old) out.push(`A setting is now stated. ${settingLine(s)}`);
    else if (old.the_gate !== s.the_gate) out.push(`A setting changed, from "${GATE_SAID[old.the_gate] ?? old.the_gate}" to this. ${settingLine(s)}`);
    else if ((old.kept_back_hours ?? 0) !== (s.kept_back_hours ?? 0) || (old.in_batches_of_hours ?? 0) !== (s.in_batches_of_hours ?? 0)) out.push(`A setting's delay changed. ${settingLine(s)}`);
  }
  const under = (p: PublishedMandatePackage) => JSON.stringify(p.face?.for_requests_under ?? []);
  if (under(before) !== under(after)) out.push("Its settings for requests under particular nodes changed.");
  if ((before.face?.narrower_settings_not_listed ?? 0) !== (after.face?.narrower_settings_not_listed ?? 0)) out.push("The number of its narrower settings, which are not listed, changed.");
  return out.length > 0 ? out : ["Sent again with nothing that is shown here changed."];
}

export interface PublishedMandateView {
  /** What a request is addressed to (`ask_of` on a proposed request, or on file_request). */
  face_id: string;
  publisher: { account_id: string; name: string };
  name: string;
  terms: string;
  withdrawn_at: string | null;
  first_published_at: string;
  last_changed_at: string;
  /** How the publisher's gate to outside is set for this mandate's work, as its deployment stamped it. */
  gate: null | {
    settings: Array<MandateSetting & { in_a_line: string }>;
    for_requests_under: MandateFace["for_requests_under"];
    narrower_settings_not_listed: number;
    pages_flow: string;
    other_parties: string;
    money: string;
  };
  /** Where a part of its name or terms is held, or a passage was removed, at the publisher's gate. */
  as_released: { parts_held: number; removals: Record<string, number>; released_under: PublishedMandatePackage["mandate"]["released_under"] };
  /** Each package received, newest first, with what changed in it. */
  history: Array<{ package: number; received_at: string; changes: string[] }>;
  requests_addressed_to_it: number;
  note: string;
}

const VIEW_NOTE =
  "A published mandate is its publisher's own statement, in a package signed with the key its account registered. The settings are stamped by " +
  "the publisher's deployment from its gate and are not checked here: each page it publishes says which setting it was released under, and " +
  "a request addressed to the mandate shows what became of it.";

/** The mandates published on this graph: of one account, or all that can be asked. */
export async function publishedMandates(opts: { accountId?: string; faceId?: string; live?: boolean } = {}): Promise<PublishedMandateView[]> {
  const faces = await rawQuery<{ id: string; account_id: string; publisher: string; name: string; can_be_asked: string; withdrawn_at: Date | null; created_at: Date; asked: string }>(
    `SELECT f.id, f.publisher_account_id AS account_id, c.display_name AS publisher, f.name, f.can_be_asked, f.withdrawn_at, f.created_at,
            (SELECT count(*) FROM requests r WHERE r.asked_of_face_id = f.id) AS asked
       FROM label_faces f JOIN contributors c ON c.id = f.publisher_account_id
      WHERE f.publisher_account_id IS NOT NULL
        AND ($1::uuid IS NULL OR f.publisher_account_id = $1) AND ($2::uuid IS NULL OR f.id = $2) AND (NOT $3::boolean OR f.withdrawn_at IS NULL)
      ORDER BY f.created_at DESC, f.id`,
    [opts.accountId ?? null, opts.faceId ?? null, opts.live === true]
  );
  const out: PublishedMandateView[] = [];
  for (const f of faces) {
    const packages = await rawQuery<{ sequence: number; package: PublishedMandatePackage; received_at: Date }>(
      `SELECT sequence, package, received_at FROM published_mandates WHERE face_id = $1 ORDER BY sequence`,
      [f.id]
    );
    const latest = packages[packages.length - 1];
    if (!latest) continue;
    const face = latest.package.face;
    out.push({
      face_id: f.id,
      publisher: { account_id: f.account_id, name: f.publisher },
      name: f.name,
      terms: f.can_be_asked,
      withdrawn_at: f.withdrawn_at?.toISOString() ?? null,
      first_published_at: packages[0]!.received_at.toISOString(),
      last_changed_at: latest.received_at.toISOString(),
      gate: face
        ? {
            settings: face.settings.map((s) => ({ ...s, in_a_line: settingLine(s) })),
            for_requests_under: face.for_requests_under,
            narrower_settings_not_listed: face.narrower_settings_not_listed,
            pages_flow: face.pages_flow,
            other_parties: face.other_parties,
            money: face.money,
          }
        : null,
      as_released: {
        parts_held: latest.package.mandate.parts.filter((p) => "held" in p).length,
        removals: latest.package.mandate.removals ?? {},
        released_under: latest.package.mandate.released_under,
      },
      history: packages.map((p, i) => ({ package: p.sequence, received_at: p.received_at.toISOString(), changes: changesBetween(i === 0 ? null : packages[i - 1]!.package, p.package) })).reverse(),
      requests_addressed_to_it: Number(f.asked),
      note: VIEW_NOTE,
    });
  }
  return out;
}

/** One package of a published mandate exactly as it was signed, for anyone to check. */
export async function mandatePackageAsSigned(faceId: string, sequence?: number): Promise<{ sequence: number; package: PublishedMandatePackage; publisher_key: string | null } | null> {
  const [row] = await rawQuery<{ sequence: number; package: PublishedMandatePackage; key: string | null }>(
    `SELECT m.sequence, m.package, (SELECT p.public_key FROM publishers p WHERE p.key_id = m.key_id ORDER BY p.registered_at DESC LIMIT 1) AS key
       FROM published_mandates m WHERE m.face_id = $1 AND ($2::int IS NULL OR m.sequence = $2) ORDER BY m.sequence DESC LIMIT 1`,
    [faceId, sequence ?? null]
  );
  return row ? { sequence: row.sequence, package: row.package, publisher_key: row.key } : null;
}

/**
 * The face a request on this graph may be addressed to, or null: a mandate
 * published here that has not been withdrawn. Read by the paths that file
 * a request (`ask_of`).
 */
export async function publishedFace(faceId: string): Promise<{ id: string; name: string; publisher: string } | null> {
  if (!UUID_RE.test(faceId)) return null;
  const [row] = await rawQuery<{ id: string; name: string; publisher: string }>(
    `SELECT f.id, f.name, c.display_name AS publisher FROM label_faces f JOIN contributors c ON c.id = f.publisher_account_id
      WHERE f.id = $1 AND f.publisher_account_id IS NOT NULL AND f.withdrawn_at IS NULL`,
    [faceId]
  );
  return row ?? null;
}

export const NO_SUCH_PUBLISHED_MANDATE = "No mandate published on this graph, and not withdrawn, has that id. list_published_mandates (GET /published-mandates) lists what can be asked.";
