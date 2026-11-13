/**
 * Published pages on the graph that receives them (docs/published-pages.md,
 * "On the public graph").
 *
 * Another graph can show what its Steward concluded about a node from
 * evidence that is not public: the page as written, less what a policy
 * removed and what the parties whose material it is hold, carried in a
 * signed package (services/outbound-service.ts). Here that package is a
 * source its publisher submits. It gets no trust and no standing of its
 * own. It can be strong evidence, and how strong is the judgment of the
 * node's Steward, from what the package's record shows.
 *
 * What is mechanical and what is judgment:
 *
 *  - Who a publisher is: an account that has registered a deployment's
 *    signing key, shown it holds the key, and said where the deployment
 *    runs in fixed words. The registration is a public record.
 *  - Admission checks the package against itself and against the
 *    registered key (published-page/verify.ts) and stores it as signed. A
 *    package that does not check out is refused with what failed.
 *  - Nothing attaches itself. Anyone can stand up a deployment and
 *    register a key, so a package's first arrival for a node files an
 *    ordinary contribution on that node, which the Contribution Reviewer
 *    reviews as it reviews any contribution. Admitted, the page is
 *    attached to the node as a source and the node's Steward is told,
 *    which opens a reassessment that runs when someone funds it. Whether
 *    the source stays on the node's page is that Steward's judgment, as
 *    for any source.
 *  - Later packages of an admitted publication (more of a page released, a
 *    later version, a version held, the showing ended) are stored and the
 *    Steward is told. Every package received is kept.
 */
import { createHash, verify as cryptoVerify } from "node:crypto";
import { loadConfig } from "../config.js";
import { rawQuery, withTransaction } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";
import { publishedPageAsText, shapeOfPublishedPage, type PublishedPageShape } from "../published-page/shape.js";
import {
  ATTESTATION_WORDS,
  HOSTING_WORDS,
  registrationStatement,
  verifyPublishedPage,
  type Hosting,
  type PackageCheck,
  type PublishedPagePackage,
} from "../published-page/verify.js";
import { createContribution } from "./contribution-service.js";
import { keyIdOf, parsePublicKey } from "./mirror-batch.js";
import { getPromptSet } from "./prompt-set.js";
import { enqueueContribution, enqueueSteward } from "./queue-service.js";

export class PublishedPageError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
}

const day = (iso: string | Date | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : "a date not recorded");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// ---- publishers --------------------------------------------------------------------

interface PublisherRow {
  id: string;
  account_id: string;
  key_id: string;
  public_key: string;
  hosting: Hosting;
  declared_interest: string | null;
  registered_at: Date;
  retired_at: Date | null;
  name: string;
}

const PUBLISHER_COLUMNS = `p.id, p.account_id, p.key_id, p.public_key, p.hosting, p.declared_interest, p.registered_at, p.retired_at, c.display_name AS name`;

/** The longest statement of interest a registration carries. A backstop: it is a sentence or two shown on a public page. */
export const DECLARED_INTEREST_MAX_CHARS = 1000;

/**
 * Register a deployment's signing key to an account. The request is signed
 * with the key, over words that name the account and where the deployment
 * runs, so that nobody registers a key they do not hold. A key registered
 * again by its account (it moved to other machines, or says something new
 * of its interest) retires the earlier registration, which stays on record.
 */
export async function registerPublisher(input: {
  accountId: string;
  /** The account as the registration names it: its sign-in identity. */
  account: string;
  publicKey: string;
  hosting: string;
  signature: string;
  declaredInterest?: string | null;
}): Promise<{ publisher_id: string; key_id: string; hosting: string; in_words: string }> {
  if (!(input.hosting in HOSTING_WORDS)) {
    throw new PublishedPageError("BAD_HOSTING", `Say where the deployment runs as one of: ${Object.entries(HOSTING_WORDS).map(([k, v]) => `${k} (${v})`).join(", ")}.`);
  }
  let keyId: string;
  let verified = false;
  try {
    const key = parsePublicKey(input.publicKey);
    keyId = keyIdOf(input.publicKey.trim());
    verified = cryptoVerify(
      null,
      Buffer.from(registrationStatement({ account: input.account, publicKey: input.publicKey.trim(), hosting: input.hosting }), "utf8"),
      key,
      Buffer.from(input.signature, "base64")
    );
  } catch {
    throw new PublishedPageError("BAD_KEY", "The key is not an Ed25519 public key, written as the base64 of its 32 bytes.");
  }
  if (!verified) {
    throw new PublishedPageError(
      "NOT_SIGNED_BY_THE_KEY",
      "The registration is not signed by the key it registers, for this account and this statement of where the deployment runs. " +
        "`npx tsx scripts/published-page.ts registration <your account's identity here>` in the deployment prints one that is."
    );
  }
  const interest = input.declaredInterest?.trim() || null;
  if (interest && interest.length > DECLARED_INTEREST_MAX_CHARS) {
    throw new PublishedPageError("TOO_LONG", `A statement of interest is at most ${DECLARED_INTEREST_MAX_CHARS} characters: it is shown whole beside every page you publish.`);
  }
  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`publisher-key:${keyId}`]);
    const [live] = await tx.query<{ id: string; account_id: string }>(`SELECT id, account_id FROM publishers WHERE key_id = $1 AND retired_at IS NULL`, [keyId]);
    if (live && live.account_id !== input.accountId) {
      throw new PublishedPageError("KEY_REGISTERED", "Another account has registered this key. A key speaks for one account at a time.");
    }
    if (live) await tx.query(`UPDATE publishers SET retired_at = now() WHERE id = $1`, [live.id]);
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO publishers (account_id, key_id, public_key, hosting, declared_interest, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.accountId, keyId, input.publicKey.trim(), input.hosting, interest, currentLabel()]
    );
    return {
      publisher_id: row!.id,
      key_id: keyId,
      hosting: input.hosting,
      in_words:
        `This account is on record as the publisher for key ${keyId.slice(0, 16)}, of a deployment that runs on ${HOSTING_WORDS[input.hosting as Hosting]}. ` +
        `The registration is public. A page published under this key is submitted by this account, and is reviewed and weighed as any contribution is.`,
    };
  });
}

async function livePublisher(keyId: string): Promise<PublisherRow | null> {
  const [row] = await rawQuery<PublisherRow>(
    `SELECT ${PUBLISHER_COLUMNS} FROM publishers p JOIN contributors c ON c.id = p.account_id WHERE p.key_id = $1 AND p.retired_at IS NULL`,
    [keyId]
  );
  return row ?? null;
}

// ---- the page as a source ------------------------------------------------------------

function verdictWords(verdict: Record<string, unknown> | null): string {
  const v = verdict ?? {};
  if ("status" in v) {
    return `Status: ${String(v.status)}. Confidence: ${String(v.confidence)}.${v.credence !== null && v.credence !== undefined ? ` Credence: ${String(v.credence)}.` : " No credence was given."}`;
  }
  if ("estimate" in v) return `Estimate: ${JSON.stringify(v.estimate)}.`;
  return `Standing: ${String(v.standing)}.${v.confidence !== null && v.confidence !== undefined ? ` Confidence: ${String(v.confidence)}.` : ""}`;
}

const STATE_WORDS: Record<string, string> = {
  not_yet_assessed: "not yet assessed",
  released_whole: "released whole",
  released_in_part: "released in part",
  held: "held",
  not_redacted: "replaced by a later version before it was redacted",
};

/** One version of the page in a line, as the history lists it. */
export function versionLine(v: PublishedPagePackage["record"]["versions"][number]): string {
  const state = STATE_WORDS[v.state] ?? v.state;
  if (v.state === "held" || v.state === "not_redacted") {
    return `version of ${day(v.version_of)}: ${state}${v.held_because ? ` (${v.held_because})` : ""}, since ${day(v.held_since)}`;
  }
  const removed = Object.values(v.removals ?? {}).reduce((a, b) => a + b, 0);
  return (
    `version of ${day(v.version_of)}: ${state}` +
    (v.state === "released_in_part" ? `, ${v.parts_held} of ${v.of_parts} parts held (${v.held_kinds})` : `, ${v.of_parts} parts`) +
    `, ${removed} removal${removed === 1 ? "" : "s"} under the policy, shown on ${day(v.shown_at)}`
  );
}

/** Whether the prompt set a page was made under is the one this graph's agents work under now. */
function promptSetWords(hash: string | null): string {
  if (!hash) return "prompt set not recorded";
  return `prompt set ${hash.slice(0, 16)}, which is ${hash === getPromptSet().hash ? "" : "not "}the prompt set this graph's agents work under now`;
}

function runLogWords(log: NonNullable<PublishedPagePackage["record"]["made"]>["run_log"]): string {
  if (!log) return "The version names no assessing run, so nothing is said of a log.";
  if (!log.sealed) return "The assessing run's log is not sealed.";
  return (
    `The assessing run's log is sealed (${log.steps ?? "an unrecorded number of"} steps, seal ${String(log.seal).slice(0, 16)}). ` +
    (log.chain_verifies === true
      ? "The deployment found its chain intact when it recorded the page."
      : log.chain_verifies === false
        ? "The deployment found its chain broken when it recorded the page."
        : "The deployment did not say whether its chain is intact.")
  );
}

/**
 * The package as the text of a source: what a Steward, a reviewer or any
 * reader without a page to render it on reads. The facts first, each from
 * the package or from the check made when it arrived, then the page.
 */
export function sourceTextOf(
  pkg: PublishedPagePackage,
  publisher: { name: string; declared_interest: string | null },
  check: PackageCheck,
  /** The publisher's other pages and the requests it took up, from this graph's record (publisher-record-service.ts). */
  publishersRecord: string[] = []
): string {
  const shape = shapeOfPublishedPage(pkg)!;
  const made = pkg.record.made;
  const removals = Object.entries(shape.removals);
  const lines = [
    "A page published from another graph, made there on evidence that is not public. Each part below is as its author, " +
      "that graph's Steward for this node, wrote it. What a policy removed is marked where it was removed, and each part " +
      "that is held is named in its place.",
    "",
    `Published by ${publisher.name} (key ${pkg.publisher.key_id.slice(0, 16)}), whose deployment is recorded as running on ` +
      `${HOSTING_WORDS[pkg.deployment.hosting]}; ${ATTESTATION_WORDS[pkg.deployment.attested_by]}.`,
    publisher.declared_interest ? `The publisher says of its own interest: ${publisher.declared_interest}` : "The publisher has said nothing of its own interest.",
    `The showing: ${pkg.showing.form === "standing" ? "standing, so each later version follows" : "once, so nothing is undertaken about later versions"}; ` +
      `${pkg.showing.scope === "under" ? "the node with what sits under it" : "the node alone"}; asked for on ${day(pkg.showing.asked_at)}; ` +
      `it began ${pkg.node.showing_began}.` +
      (pkg.showing.ended ? ` It ended on ${day(pkg.showing.ended.at)}: ${pkg.showing.ended.because}.` : ""),
    `Version of ${day(pkg.page!.version_of)}. ${verdictWords(shape.verdict)}`,
    `Coverage there: ${(shape.coverage?.on ?? []).join(", ") || "examined"}.`,
    shape.sources.length === 0
      ? "Sources read there: none recorded."
      : `Sources read there: ${shape.sources
          .map(
            (s) =>
              `source ${s.source}: ${s.kind.replace(/_/g, " ")}, supplied by ${s.supplied_by.replace(/_/g, " ")}, ` +
              `${s.interest_recorded ? "an interest in this node is recorded for it" : "no interest in this node is recorded for it"}` +
              (s.fingerprint ? `, fingerprint ${s.fingerprint.slice(0, 16)}` : "")
          )
          .join(" | ")}.`,
    `How it was made: ${promptSetWords(made?.prompt_set ?? null)}; redaction policy version ${pkg.policy?.version ?? "not recorded"}; ` +
      `assessed by ${made?.assessed_by_model ?? "a model not recorded"}; redacted by ${made?.redacted_by_model ?? "a model not recorded"}; ` +
      `additions by the deployment to a role's prompt: ${(made?.role_additions ?? []).length === 0 ? "none" : JSON.stringify(made!.role_additions)}.`,
    runLogWords(made?.run_log ?? null),
    `Paid for by: ${made?.paid_for?.by ?? "not recorded"}${made?.paid_for && made.paid_for.stake !== "not recorded" ? `; ${made.paid_for.stake}` : ""}.`,
    `Removals under the policy: ${removals.length === 0 ? "none" : removals.map(([c, n]) => `${c}: ${n}`).join(", ")}.`,
    `Audit's check of the redaction there: ${pkg.page!.audit ?? "not recorded"}`,
    shape.held_parts === 0 ? `Parts: ${shape.parts}, all released.` : `Parts: ${shape.parts}, of which ${shape.held_parts} ${shape.held_parts === 1 ? "is" : "are"} held (${shape.held_kinds}).`,
    `Who acted on the showing: ${pkg.record.acts
      .map((a) => `${day(a.at)} ${a.by}${a.holding.length > 0 ? ` (holding ${a.holding.join(", ")})` : ""} ${a.what}${a.on ? ` ${a.on}` : ""}${a.for_party ? ` for ${a.for_party}` : ""}${a.reason ? `: ${a.reason}` : ""}`)
      .join("; ")}.`,
    `Versions made while the showing stood: ${pkg.record.versions.map(versionLine).join("; ")}.`,
    ...(pkg.deployment.keeps_public_versions_current
      ? [
          `The deployment's setting for asking this graph for a fresh public assessment when its own version of a public node changes: ${pkg.deployment.keeps_public_versions_current.setting}` +
            (pkg.deployment.keeps_public_versions_current.setting === "on"
              ? pkg.deployment.keeps_public_versions_current.a_public_mandate_pays_for_it
                ? ", and a public mandate of its own pays for it."
                : ", and no public mandate of its own pays for it, so nothing is asked."
              : "."),
        ]
      : []),
    ...((pkg.record.said_back ?? []).length > 0
      ? [
          `Contributions made here through this page that the deployment says it received: ${pkg.record.said_back!
            .map((e) => `${day(e.received_at)}${e.repeats ? ", the same text as an earlier one" : ""}${e.reassessment ? `, reassessment ${e.reassessment}` : ""}`)
            .join("; ")}.`,
        ]
      : []),
    ...(publishersRecord.length > 0 ? [`From this graph's own record of the publisher: ${publishersRecord.join(" ")}`] : []),
    `What this graph checked when the package arrived: ${check.confirmed.join(" ")}`,
    `What that check cannot show: ${check.cannot_show.join(" ")}`,
    "",
    publishedPageAsText(pkg),
  ];
  return lines.join("\n").trimEnd();
}

const SOURCE_ADDRESS = (publishedPageId: string, sequence: number) => `minerval:published-page/${publishedPageId}/${sequence}`;

// ---- what the Reviewer and the Steward are told -----------------------------------------

/** The node's latest version, from the package's history. */
function latestVersion(pkg: PublishedPagePackage): PublishedPagePackage["record"]["versions"][number] | null {
  return [...pkg.record.versions].filter((v) => v.state !== "not_redacted").sort((a, b) => Date.parse(b.version_of) - Date.parse(a.version_of))[0] ?? null;
}

function stateSentence(pkg: PublishedPagePackage): string {
  const shape = shapeOfPublishedPage(pkg);
  if (pkg.state === "not_yet_assessed") return "The node is not yet assessed there, so no page has been sent.";
  const latest = latestVersion(pkg);
  const heldLater =
    pkg.state === "held" && latest
      ? `The version of ${day(latest.version_of)} is held (${latest.held_because ?? "no reason recorded"}) since ${day(latest.held_since)}. None of its text was sent.`
      : "";
  if (!shape) return heldLater;
  const removed = Object.values(shape.removals).reduce((a, b) => a + b, 0);
  return (
    `The version of ${day(pkg.page!.version_of)} is shown: ${removed} passage${removed === 1 ? " was" : "s were"} removed under the deployment's ` +
    `published policy and marked in place, and ${shape.held_parts} of its ${shape.parts} part${shape.parts === 1 ? "" : "s"} ${shape.held_parts === 1 ? "is" : "are"} held` +
    (shape.held_parts > 0 ? ` (${shape.held_kinds})` : "") +
    "." +
    (heldLater ? ` A later version exists and is not shown. ${heldLater}` : "")
  );
}

/** The contribution a publication's first package files: stamped facts in fixed words, with nothing the submitter wrote. */
export function submissionWords(pkg: PublishedPagePackage, publisher: { name: string }, check: PackageCheck, address: string | null): string {
  return [
    `A published page, submitted by its publisher. ${publisher.name} asks for the page its deployment shows of this node to be admitted as one of the node's sources.`,
    `It is another graph's Steward's assessment of this node, made on evidence that is not public, and sent as that Steward wrote it, less what a policy removed and what is held.`,
    `The showing is ${pkg.showing.form === "standing" ? "standing: each later version follows, and a version that is held is sent as held" : "once: the page as it stood, and nothing later"}. ` +
      `It was asked for on ${day(pkg.showing.asked_at)} and began ${pkg.node.showing_began}.`,
    stateSentence(pkg),
    `The package is signed with key ${pkg.publisher.key_id.slice(0, 16)}, which this account registered. Checked when it arrived: ${check.confirmed.join(" ")}`,
    address ? `The page with its record is this contribution's source (${address}).` : "There is no page to read yet. What is admitted is the publication: that it exists, its state, and each version as it follows.",
  ].join("\n\n");
}

/** What the node's Steward is told when a publication is admitted, or a later package of an admitted one arrives. */
export function arrivalMessage(input: { pkg: PublishedPagePackage; publisher: string; address: string | null; first: boolean; attached: boolean }): string {
  const { pkg } = input;
  const shape = shapeOfPublishedPage(pkg);
  const lead = input.first
    ? `${input.publisher} has published its graph's page of this node here, and the Contribution Reviewer admitted the submission.`
    : `A later package has arrived for the page of this node that ${input.publisher} publishes.`;
  if (!shape) {
    return (
      `${lead} ${stateSentence(pkg)}` +
      (pkg.showing.ended ? ` The showing ended on ${day(pkg.showing.ended.at)}: ${pkg.showing.ended.because}.` : "") +
      ` That a version exists and is not shown is part of this node's record, for you to read as you read any omission.`
    );
  }
  return (
    `${lead} It is that graph's Steward's assessment of this node as written, made on evidence this graph cannot read. ${stateSentence(pkg)} ` +
    (input.attached
      ? `It is attached to this node as a source of the kind published_page (${input.address}). `
      : `It is a source of the kind published_page (${input.address}), and is not attached to this node, because this node's Steward detached an earlier package of it. `) +
    `The source's text is the page with its record: the prompt set and model it was made under, what the assessing run's log shows, where the deployment runs, ` +
    `how the assessment was paid for, who acted on the showing and with which permissions, whether the showing began before the node was first assessed, and every ` +
    `version made since. This graph checked the package's signature and that the text sent is what was fingerprinted before anyone decided what to release; the ` +
    `source says what that check cannot show. ` +
    (shape.wording ? `The page gives the node's wording as it was assessed there. Where that differs from this node's wording, the verdict is of that wording. ` : "") +
    (pkg.showing.ended ? `The showing ended on ${day(pkg.showing.ended.at)}: ${pkg.showing.ended.because}. ` : "") +
    `It is evidence for you to weigh as you weigh any source, and whether it belongs on this node's page is your judgment (detach_claim_instance takes it off). ` +
    `It does not replace this node's assessment, which is yours to reach.`
  );
}

// ---- admission -----------------------------------------------------------------------------

interface PublicationRow {
  id: string;
  account_id: string;
  key_id: string;
  showing_id: string;
  node_id: string;
  contribution_id: string | null;
  latest_sequence: number;
  first_received_at: Date;
}

const PUBLICATION_COLUMNS = `id, account_id, key_id, showing_id, node_id, contribution_id, latest_sequence, first_received_at`;

export interface Admission {
  published_page_id: string;
  sequence: number;
  status: "received" | "already_received";
  source_id: string | null;
  contribution_id: string | null;
  /** Whether this package is the first for its node under its showing, which is what is charged for. */
  first: boolean;
  in_words: string;
}

/**
 * Check a package before anything is charged or written. Returns the
 * package as read, its publisher, the node, and the check's result; throws
 * with the reason when it is not admitted.
 */
export async function examinePackage(input: { accountId: string; pkg: unknown }): Promise<{
  pkg: PublishedPagePackage;
  publisher: PublisherRow;
  check: PackageCheck;
  publication: PublicationRow | null;
  already: { id: string; sequence: number; source_id: string | null } | null;
}> {
  const size = Buffer.byteLength(JSON.stringify(input.pkg ?? null), "utf8");
  const limit = loadConfig().publishedPageMaxBytes;
  if (size > limit) {
    throw new PublishedPageError("TOO_LARGE", `This package is ${size} bytes and the most this graph takes is ${limit}: a page is one node's assessment with its arguments and readings, and the limit is there so that one request cannot hold the server.`);
  }
  const claimed = (input.pkg as { publisher?: { key_id?: unknown } } | null)?.publisher?.key_id;
  const publisher = typeof claimed === "string" ? await livePublisher(claimed) : null;
  // Checked against the registered key where there is one, so a package that fails says why in its own terms first.
  const check = await verifyPublishedPage(input.pkg, { publisherKey: publisher?.public_key ?? null });
  if (!check.ok) {
    throw new PublishedPageError("DOES_NOT_VERIFY", `This package was not admitted, and nothing of it was kept: ${check.failed.join(" ")}`, { failed: check.failed });
  }
  const pkg = input.pkg as PublishedPagePackage;
  if (!publisher) {
    throw new PublishedPageError(
      "UNREGISTERED_KEY",
      `This package is signed with key ${pkg.publisher.key_id.slice(0, 16)}, which no account has registered on this graph, so it was not admitted. ` +
        `The organization's own account registers its deployment's key (POST /publishers) and then submits its packages itself.`
    );
  }
  if (publisher.account_id !== input.accountId) {
    throw new PublishedPageError("NOT_YOUR_KEY", "This package is signed with a key another account registered. A publisher submits its own packages, under its own account.");
  }
  if (publisher.hosting !== pkg.deployment.hosting) {
    throw new PublishedPageError(
      "HOSTING_DIFFERS",
      `This package says its deployment runs on ${HOSTING_WORDS[pkg.deployment.hosting]}, and the key's registration says ${HOSTING_WORDS[publisher.hosting]}. ` +
        `Register the key again with where the deployment runs now, so that the public record and the packages agree.`
    );
  }
  const [node] = await rawQuery<{ id: string; state: string; merged_into: string | null }>(`SELECT id, state, merged_into FROM claims WHERE id = $1`, [pkg.node.public_id]);
  if (!node) throw new PublishedPageError("NODE_NOT_FOUND", "This graph holds no node with the id the package names, so there is no page for it to appear on. A node that exists only in your deployment is proposed here first, as any node is.");
  if (node.state !== "active") {
    throw new PublishedPageError(
      "NODE_NOT_ACTIVE",
      node.merged_into ? `The node the package names was merged into ${node.merged_into}. Its page is sent to that node.` : "The node the package names is no longer active on this graph.",
      node.merged_into ? { merged_into: node.merged_into } : undefined
    );
  }
  const [already] = await rawQuery<{ id: string; sequence: number; source_id: string | null; published_page_id: string }>(
    `SELECT id, sequence, source_id, published_page_id FROM published_page_packages WHERE hash = $1`,
    [pkg.hash]
  );
  const [publication] = await rawQuery<PublicationRow>(
    `SELECT ${PUBLICATION_COLUMNS} FROM published_pages WHERE key_id = $1 AND showing_id = $2 AND node_id = $3`,
    [pkg.publisher.key_id, pkg.showing.id, pkg.node.public_id]
  );
  if (!already) {
    const have = publication?.latest_sequence ?? 0;
    if (pkg.sequence !== have + 1) {
      throw new PublishedPageError(
        "OUT_OF_ORDER",
        have === 0
          ? `This is package ${pkg.sequence} for this node under this showing, and this graph has none yet. Send package 1 first: each names the one before it.`
          : `This graph has packages 1 to ${have} for this node under this showing, and this is package ${pkg.sequence}. Send package ${have + 1} next: each names the one before it.`
      );
    }
    if (publication) {
      const [last] = await rawQuery<{ hash: string }>(`SELECT hash FROM published_page_packages WHERE published_page_id = $1 AND sequence = $2`, [publication.id, have]);
      if (last && last.hash !== pkg.previous_hash) {
        throw new PublishedPageError("CHAIN_BROKEN", `Package ${pkg.sequence} does not name package ${have}, as this graph received it, as the one before it.`);
      }
      if (publication.contribution_id) {
        const [c] = await rawQuery<{ review_status: string }>(`SELECT review_status FROM contributions WHERE id = $1`, [publication.contribution_id]);
        if (c?.review_status === "rejected") {
          throw new PublishedPageError(
            "NOT_ADMITTED",
            `This publication was submitted to the node and not admitted (contribution ${publication.contribution_id}, whose record and reasons are public). ` +
              `Later packages of it are not taken. An appeal of that decision is how it is looked at again.`
          );
        }
      }
    }
  }
  return { pkg, publisher, check, publication: publication ?? null, already: already ?? null };
}

/**
 * Admit a package that examinePackage passed: keep it as signed, make its
 * page a source where it carries one, and file or follow the publication's
 * contribution on the node.
 */
export async function admitPackage(examined: Awaited<ReturnType<typeof examinePackage>>): Promise<Admission> {
  const { pkg, publisher, check } = examined;
  if (examined.already) {
    return {
      published_page_id: examined.publication!.id,
      sequence: examined.already.sequence,
      status: "already_received",
      source_id: examined.already.source_id,
      contribution_id: examined.publication!.contribution_id,
      first: false,
      in_words: "This graph already has this package. Nothing changed.",
    };
  }
  const shown = shapeOfPublishedPage(pkg) !== null;
  const stored = await withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`published-page:${pkg.publisher.key_id}:${pkg.showing.id}:${pkg.node.public_id}`]);
    let publication = examined.publication;
    if (!publication) {
      // Under the lock above: another request may have made the row since this one was examined.
      const [made] = await tx.query<PublicationRow>(`SELECT ${PUBLICATION_COLUMNS} FROM published_pages WHERE key_id = $1 AND showing_id = $2 AND node_id = $3`, [
        pkg.publisher.key_id,
        pkg.showing.id,
        pkg.node.public_id,
      ]);
      publication =
        made ??
        (
          await tx.query<PublicationRow>(
            `INSERT INTO published_pages (account_id, key_id, showing_id, node_id, sensitivity_label) VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLICATION_COLUMNS}`,
            [publisher.account_id, pkg.publisher.key_id, pkg.showing.id, pkg.node.public_id, currentLabel()]
          )
        )[0]!;
    }
    let sourceId: string | null = null;
    const address = SOURCE_ADDRESS(publication!.id, pkg.sequence);
    if (shown) {
      const { publisherFacts, publisherFactsLines } = await import("./publisher-record-service.js");
      const text = sourceTextOf(pkg, publisher, check, publisherFactsLines(await publisherFacts(publication.account_id, { except: publication.id }), "its other pages"));
      const [source] = await tx.query<{ id: string }>(
        `INSERT INTO sources (url, title, content_hash, raw_content, source_type, publisher, published_date, page_url_hash, sensitivity_label)
         VALUES ($1, $2, $3, $4, 'published_page', $5, $6, '', $7) RETURNING id`,
        [
          address,
          `Redacted assessment on sealed evidence, published by ${publisher.name} (version of ${day(pkg.page!.version_of)})`,
          sha256(text),
          text,
          publisher.name,
          day(pkg.page!.version_of),
          currentLabel(),
        ]
      );
      sourceId = source!.id;
      // The publisher's interest in the node, as a fact about the source (constitution §9): it chose to show this page.
      await tx.query(
        `INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, sensitivity_label) VALUES ($1, $2, $3, $4, 'published_page', $5)`,
        [
          sourceId,
          pkg.node.public_id,
          publisher.name,
          `${publisher.name} published this page from its own deployment: it chose to show this node's page, and its deployment holds the evidence the page was made on.` +
            (publisher.declared_interest ? ` It says of its own interest: ${publisher.declared_interest}` : ""),
          currentLabel(),
        ]
      );
    }
    await tx.query(
      `INSERT INTO published_page_packages (published_page_id, sequence, hash, state, package, checked, source_id, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
      [publication!.id, pkg.sequence, pkg.hash, pkg.state, JSON.stringify(pkg), JSON.stringify(check), sourceId, currentLabel()]
    );
    await tx.query(`UPDATE published_pages SET latest_sequence = $2 WHERE id = $1`, [publication!.id, pkg.sequence]);
    return { publication: publication!, sourceId, address: shown ? address : null };
  });

  let contributionId = stored.publication.contribution_id;
  const first = contributionId === null;
  if (first) {
    // The ordinary door: a contribution on the node, reviewed as any contribution is.
    const contribution = await createContribution({
      claimId: pkg.node.public_id,
      contributorId: publisher.account_id,
      contributionType: "add_instance",
      content: submissionWords(pkg, publisher, check, stored.address),
      evidenceUrls: stored.address ? [stored.address] : [],
    });
    contributionId = contribution.id;
    await rawQuery(`UPDATE contributions SET source_id = $2 WHERE id = $1`, [contribution.id, stored.sourceId]);
    await rawQuery(`UPDATE published_pages SET contribution_id = $2 WHERE id = $1`, [stored.publication.id, contribution.id]);
    await enqueueContribution({ contributionId: contribution.id });
  } else {
    const [c] = await rawQuery<{ review_status: string }>(`SELECT review_status FROM contributions WHERE id = $1`, [contributionId]);
    if (c?.review_status === "accepted") await takeIn(stored.publication.id, { first: false });
  }
  return {
    published_page_id: stored.publication.id,
    sequence: pkg.sequence,
    status: "received",
    source_id: stored.sourceId,
    contribution_id: contributionId,
    first,
    in_words: first
      ? "The package checks out and is kept. The publication is submitted to the node as a contribution, which is reviewed as any contribution is; once admitted, the page is attached to the node as a source and its Steward is told. The reassessment that takes it into the node's own assessment runs when someone funds it, and you may fund it like anyone."
      : "The package checks out and is kept as the next in its publication's record.",
  };
}

/** Whether a contribution is a publication's submission. */
export async function publicationOfContribution(contributionId: string): Promise<string | null> {
  const [row] = await rawQuery<{ id: string }>(`SELECT id FROM published_pages WHERE contribution_id = $1`, [contributionId]);
  return row?.id ?? null;
}

/**
 * Bring the node up to the latest package of an admitted publication:
 * attach its page to the node as a source, in place of the earlier package
 * of the same publication, and tell the node's Steward, which opens a
 * reassessment that runs when it is funded. A package with no page
 * attaches nothing and the Steward is still told. Where the Steward has
 * detached the publication's page from the node, a later package is not
 * attached again: that judgment stands until the Steward changes it.
 */
export async function takeIn(publishedPageId: string, opts: { first: boolean }): Promise<{ attached: boolean }> {
  const [publication] = await rawQuery<PublicationRow & { publisher: string }>(
    `SELECT p.id, p.account_id, p.key_id, p.showing_id, p.node_id, p.contribution_id, p.latest_sequence, p.first_received_at, c.display_name AS publisher
       FROM published_pages p JOIN contributors c ON c.id = p.account_id WHERE p.id = $1`,
    [publishedPageId]
  );
  if (!publication) return { attached: false };
  const [latest] = await rawQuery<{ sequence: number; package: PublishedPagePackage; source_id: string | null }>(
    `SELECT sequence, package, source_id FROM published_page_packages WHERE published_page_id = $1 ORDER BY sequence DESC LIMIT 1`,
    [publishedPageId]
  );
  if (!latest) return { attached: false };
  const pkg = latest.package;
  const prefix = `minerval:published-page/${publication.id}/%`;
  let attached = false;
  if (latest.source_id) {
    attached = await withTransaction(async (tx) => {
      const [removedByJudgment] = await tx.query(
        `SELECT 1 FROM claim_instances i JOIN sources s ON s.id = i.source_id
          WHERE i.claim_id = $1 AND s.url LIKE $2 AND i.detached_at IS NOT NULL AND i.detached_by <> 'published_page'
            AND NOT EXISTS (SELECT 1 FROM claim_instances j JOIN sources t ON t.id = j.source_id
                             WHERE j.claim_id = $1 AND t.url LIKE $2 AND j.detached_at IS NULL)`,
        [publication.node_id, prefix]
      );
      if (removedByJudgment) return false;
      await tx.query(
        `UPDATE claim_instances i SET detached_at = now(), detached_by = 'published_page', detached_reason = 'A later package of this published page replaced it.'
          WHERE i.claim_id = $1 AND i.detached_at IS NULL AND i.source_id <> $3
            AND EXISTS (SELECT 1 FROM sources s WHERE s.id = i.source_id AND s.url LIKE $2)`,
        [publication.node_id, prefix, latest.source_id]
      );
      const [has] = await tx.query(`SELECT 1 FROM claim_instances WHERE claim_id = $1 AND source_id = $2 AND detached_at IS NULL`, [publication.node_id, latest.source_id]);
      if (!has) {
        await tx.query(
          `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, context, stance, speaker, created_by, sensitivity_label)
           VALUES ($1, $2, $3, $4, 'mentions', $5, 'published_page', $6)`,
          [
            publication.node_id,
            latest.source_id,
            verdictWords(shapeOfPublishedPage(pkg)?.verdict ?? null),
            "The verdict of another graph's page of this node, made on evidence that is not public. The source's text is the page as published, with removals marked and held parts named, and the record of how it was made.",
            publication.publisher,
            currentLabel(),
          ]
        );
      }
      return true;
    });
  }
  // One waiting message for a publication, saying where it stands now. A
  // later package's message takes the place of an earlier one of this
  // publication that no pass has read yet: the earlier one described a
  // state that is no longer the latest, and every package is kept.
  if (!opts.first) {
    await rawQuery(
      `DELETE FROM node_messages WHERE node_id = $1 AND read_at IS NULL AND sender_kind = 'system' AND sender_ref LIKE $2`,
      [publication.node_id, `published:${publication.id}:%`]
    );
  }
  await enqueueSteward({
    claimId: publication.node_id,
    trigger: opts.first ? "contribution_accepted" : "page_shown",
    context: arrivalMessage({
      pkg,
      publisher: publication.publisher,
      address: latest.source_id ? SOURCE_ADDRESS(publication.id, latest.sequence) : null,
      first: opts.first,
      attached,
    }),
    sender: opts.first ? { kind: "contribution_reviewer", ref: publication.contribution_id } : { kind: "system", ref: `published:${publication.id}:${latest.sequence}` },
  });
  return { attached };
}

// ---- reading ---------------------------------------------------------------------------------

interface PackageRow {
  id: string;
  sequence: number;
  hash: string;
  state: string;
  package: PublishedPagePackage;
  checked: PackageCheck;
  source_id: string | null;
  received_at: Date;
}

async function standingOnNode(publication: PublicationRow): Promise<Record<string, unknown>> {
  const [c] = publication.contribution_id
    ? await rawQuery<{ review_status: string }>(`SELECT review_status FROM contributions WHERE id = $1`, [publication.contribution_id])
    : [];
  const prefix = `minerval:published-page/${publication.id}/%`;
  const [attached] = await rawQuery<{ sequence: string; at: Date }>(
    `SELECT split_part(s.url, '/', 3) AS sequence, i.created_at AS at FROM claim_instances i JOIN sources s ON s.id = i.source_id
      WHERE i.claim_id = $1 AND s.url LIKE $2 AND i.detached_at IS NULL ORDER BY i.created_at DESC LIMIT 1`,
    [publication.node_id, prefix]
  );
  const [detached] = await rawQuery<{ reason: string | null }>(
    `SELECT i.detached_reason AS reason FROM claim_instances i JOIN sources s ON s.id = i.source_id
      WHERE i.claim_id = $1 AND s.url LIKE $2 AND i.detached_at IS NOT NULL AND i.detached_by <> 'published_page' ORDER BY i.detached_at DESC LIMIT 1`,
    [publication.node_id, prefix]
  );
  // Which package the node's judgment in force was made on, from the record a judgment keeps of its inputs.
  const [weighed] = await rawQuery<{ sequence: string; at: Date }>(
    `SELECT split_part(s.url, '/', 3) AS sequence, j.assessed_at AS at
       FROM (SELECT id, assessed_at FROM assessments_in_force WHERE claim_id = $1
             UNION ALL SELECT id, assessed_at FROM quantity_estimates_in_force WHERE claim_id = $1
             UNION ALL SELECT id, assessed_at FROM question_assessments_in_force WHERE claim_id = $1) j
       JOIN judgment_inputs ji ON ji.judgment_id = j.id AND ji.input_kind = 'source'
       JOIN sources s ON s.id = ji.source_id
      WHERE s.url LIKE $2 ORDER BY s.retrieved_at DESC LIMIT 1`,
    [publication.node_id, prefix]
  );
  const review = c?.review_status ?? "not_submitted";
  return {
    contribution_id: publication.contribution_id,
    review: review === "accepted" ? "admitted" : review === "rejected" ? "not admitted" : "waiting for review",
    on_the_nodes_page: !!attached,
    ...(attached ? { attached_package: Number(attached.sequence), attached_at: attached.at.toISOString() } : {}),
    ...(!attached && detached ? { taken_off_by_the_nodes_steward: detached.reason ?? "no reason recorded" } : {}),
    ...(weighed ? { weighed_in_the_nodes_assessment: { package: Number(weighed.sequence), assessed_at: weighed.at.toISOString() } } : { weighed_in_the_nodes_assessment: null }),
  };
}

function summaryOf(publication: PublicationRow, publisher: string, latest: PackageRow | undefined): Record<string, unknown> {
  const pkg = latest?.package;
  return {
    published_page_id: publication.id,
    node_id: publication.node_id,
    publisher: { account_id: publication.account_id, name: publisher, key_id: publication.key_id },
    form: pkg?.showing.form ?? null,
    scope: pkg?.showing.scope ?? null,
    showing_began: pkg?.node.showing_began ?? null,
    asked_at: pkg?.showing.asked_at ?? null,
    ended: pkg?.showing.ended ?? null,
    // The node's state there now: that of its latest version.
    state: pkg?.state ?? null,
    version_of: (pkg ? latestVersion(pkg)?.version_of : null) ?? null,
    ...(pkg?.state === "held" ? { held: { because: latestVersion(pkg)?.held_because ?? null, since: latestVersion(pkg)?.held_since ?? null } } : {}),
    // The page that is shown: the latest version released, which a later held version does not take away.
    ...(pkg && pkg.page && !pkg.page.held
      ? {
          shown_version_of: pkg.page.version_of,
          shown_state: pkg.page.state,
          parts: pkg.page.parts.length,
          parts_held: pkg.page.parts.filter((p) => typeof p.text !== "string").length,
          held_kinds: shapeOfPublishedPage(pkg)?.held_kinds ?? "",
        }
      : {}),
    packages_received: publication.latest_sequence,
    first_received_at: publication.first_received_at.toISOString(),
  };
}

/** The published pages of a node, or of a publisher: each publication with its state now and where it stands on the node. */
export async function listPublishedPages(opts: { nodeId?: string; accountId?: string }): Promise<Array<Record<string, unknown>>> {
  const rows = await rawQuery<PublicationRow & { publisher: string; node: string | null }>(
    `SELECT p.id, p.account_id, p.key_id, p.showing_id, p.node_id, p.contribution_id, p.latest_sequence, p.first_received_at,
            c.display_name AS publisher, n.text AS node
       FROM published_pages p JOIN contributors c ON c.id = p.account_id LEFT JOIN claims n ON n.id = p.node_id
      WHERE ($1::uuid IS NULL OR p.node_id = $1) AND ($2::uuid IS NULL OR p.account_id = $2)
      ORDER BY p.first_received_at DESC LIMIT 200`,
    [opts.nodeId ?? null, opts.accountId ?? null]
  );
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const [latest] = await rawQuery<PackageRow>(
      `SELECT id, sequence, hash, state, package, checked, source_id, received_at FROM published_page_packages WHERE published_page_id = $1 ORDER BY sequence DESC LIMIT 1`,
      [r.id]
    );
    const { saidBackOnPage } = await import("./publisher-record-service.js");
    const said = (await saidBackOnPage(r.id)).filter((e) => e.review === "admitted");
    out.push({
      ...summaryOf(r, r.publisher, latest),
      node: r.node,
      on_the_node: await standingOnNode(r),
      // Contributions made here through the page and admitted, and how many of them stand with no answer from the publishing graph.
      said_back: { admitted: said.length, unanswered: said.filter((e) => e.state === "unanswered" || e.state === "not_acknowledged").length },
    });
  }
  return out;
}

export interface PublishedPageView extends Record<string, unknown> {
  page: PublishedPageShape | null;
}

/**
 * One published page: the page in the shape of a node's page, its record,
 * the history of versions, what the check confirmed when it arrived, and
 * where it stands on the node. `sequence` reads an earlier package.
 */
export async function readPublishedPage(publishedPageId: string, opts: { sequence?: number } = {}): Promise<PublishedPageView | null> {
  const [publication] = await rawQuery<PublicationRow & { publisher: string }>(
    `SELECT p.id, p.account_id, p.key_id, p.showing_id, p.node_id, p.contribution_id, p.latest_sequence, p.first_received_at, c.display_name AS publisher
       FROM published_pages p JOIN contributors c ON c.id = p.account_id WHERE p.id = $1`,
    [publishedPageId]
  );
  if (!publication) return null;
  const packages = await rawQuery<PackageRow>(
    `SELECT id, sequence, hash, state, package, checked, source_id, received_at FROM published_page_packages WHERE published_page_id = $1 ORDER BY sequence DESC`,
    [publishedPageId]
  );
  const chosen = opts.sequence ? packages.find((p) => p.sequence === opts.sequence) : packages[0];
  if (!chosen) return null;
  // A package carries the latest version that is shown, so the newest package has the page to show.
  const shownRow = chosen;
  const pkg = chosen.package;
  const shownPkg = shownRow.package;
  const registration = await livePublisher(publication.key_id);
  const made = shownPkg.record.made;
  return {
    ...summaryOf(publication, publication.publisher, chosen),
    package: chosen.sequence,
    received_at: chosen.received_at.toISOString(),
    on_the_node: await standingOnNode(publication),
    publisher: {
      account_id: publication.account_id,
      name: publication.publisher,
      key_id: publication.key_id,
      public_key: pkg.publisher.public_key,
      runs_on: HOSTING_WORDS[pkg.deployment.hosting],
      attested_by: ATTESTATION_WORDS[pkg.deployment.attested_by],
      declared_interest: registration?.declared_interest ?? null,
      registered_at: registration?.registered_at.toISOString() ?? null,
    },
    // The page shown: the one in this package, or the last one shown where this package carries none.
    shown_package: shapeOfPublishedPage(shownPkg) ? shownRow.sequence : null,
    shown_version_of: shapeOfPublishedPage(shownPkg) ? shownPkg.page!.version_of : null,
    page: shapeOfPublishedPage(shownPkg),
    source_id: shownRow.source_id,
    audit: shownPkg.page?.audit ?? null,
    fingerprint: shownPkg.page?.fingerprint ?? null,
    policy: shownPkg.policy ? { version: shownPkg.policy.version, hash: shownPkg.policy.hash, text: shownPkg.policy.text } : null,
    record: {
      made,
      prompt_set_is_this_graphs: made?.prompt_set ? made.prompt_set === getPromptSet().hash : null,
      sent: pkg.showing.send === "as_released" ? "as each package was built, by a choice made when the showing was asked for" : "by a person each time",
      acts: pkg.record.acts,
    },
    versions: pkg.record.versions,
    // Contributions made here through this page, each with what became of it (publisher-record-service.ts).
    said_back: await (await import("./publisher-record-service.js")).saidBackOnPage(publication.id),
    keeps_public_versions_current: pkg.deployment.keeps_public_versions_current ?? null,
    check: chosen.checked,
    packages: packages.map((p) => ({ package: p.sequence, state: p.state, received_at: p.received_at.toISOString(), hash: p.hash })),
  };
}

/** One package exactly as it was signed and received, for anyone to check. */
export async function packageAsSigned(publishedPageId: string, sequence?: number): Promise<{ sequence: number; package: PublishedPagePackage; publisher_key: string | null } | null> {
  const [row] = await rawQuery<{ sequence: number; package: PublishedPagePackage; key_id: string }>(
    `SELECT k.sequence, k.package, p.key_id FROM published_page_packages k JOIN published_pages p ON p.id = k.published_page_id
      WHERE k.published_page_id = $1 AND ($2::int IS NULL OR k.sequence = $2) ORDER BY k.sequence DESC LIMIT 1`,
    [publishedPageId, sequence ?? null]
  );
  if (!row) return null;
  // The key as this graph's own record of the publisher holds it, for a check that asks whose key signed the package.
  const [registered] = await rawQuery<{ public_key: string }>(`SELECT public_key FROM publishers WHERE key_id = $1 ORDER BY registered_at DESC LIMIT 1`, [row.key_id]);
  return { sequence: row.sequence, package: row.package, publisher_key: registered?.public_key ?? null };
}

/** A publisher's public record: each registration of a key, with where the deployment was said to run, and what it has published. */
export async function publisherRecord(accountId: string): Promise<Record<string, unknown> | null> {
  const registrations = await rawQuery<PublisherRow>(
    `SELECT ${PUBLISHER_COLUMNS} FROM publishers p JOIN contributors c ON c.id = p.account_id WHERE p.account_id = $1 ORDER BY p.registered_at DESC`,
    [accountId]
  );
  if (registrations.length === 0) return null;
  return {
    account_id: accountId,
    name: registrations[0]!.name,
    registrations: registrations.map((r) => ({
      key_id: r.key_id,
      public_key: r.public_key,
      runs_on: HOSTING_WORDS[r.hosting],
      attested_by: ATTESTATION_WORDS.nothing,
      declared_interest: r.declared_interest,
      registered_at: r.registered_at.toISOString(),
      retired_at: r.retired_at?.toISOString() ?? null,
    })),
    published_pages: await listPublishedPages({ accountId }),
    // What this graph's own record holds of the publisher, as counts and dates (publisher-record-service.ts).
    record: await (async () => {
      const { publisherFacts, publisherFactsLines } = await import("./publisher-record-service.js");
      const facts = await publisherFacts(accountId);
      return { facts, in_words: publisherFactsLines(facts) };
    })(),
    record_note:
      "These are counts and dates read from this graph's record when the page is opened. They are not a score, and they say nothing about how far " +
      "a page is to be believed: that is weighed for each page by the Steward of the node it is on.",
    note:
      "A publisher is an account that registered a deployment's signing key. Anyone can run a deployment and register one, so the registration says who " +
      "submits pages under the key and nothing about how far they are to be believed. Where the deployment runs is the publisher's own statement.",
  };
}
