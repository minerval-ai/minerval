/**
 * A shown page leaves the deployment (docs/published-pages.md, "Inside the
 * deployment").
 *
 * showing-service.ts and release-gate-service.ts take a node's page through
 * redaction, Audit's check and the release gate. For a showing outside they
 * end with what was released recorded on the destination side, at `public`.
 * This file carries it the rest of the way out:
 *
 *  - It builds the signed package: one node under one showing as the
 *    outside is to read it, with the record of how it was made. A package
 *    is built whenever what the outside would read has changed: a page
 *    shown, more of it released, a hold placed or lifted, a later version
 *    opened or held, a node come under the showing or left it, the showing
 *    ended. A node's packages are numbered and each names the one before.
 *
 *  - It finds the node on the public graph. A mirrored node is that node.
 *    A node that exists only here has no page there to appear on, so it is
 *    first proposed to the public graph as any contributor would propose
 *    it, in words a person who holds `direct` writes or approves and the
 *    parties its wording rests on release.
 *
 *  - It sends. The deployment is a client of the public graph's ordinary
 *    routes, with the key of the organization's own account there, and
 *    holds no other standing. A send is a person's act, or follows from the
 *    choice a person made when they asked for a standing showing. Where the
 *    network does not reach the public graph, a person carries the package
 *    as a file. Every send and every handing over is a row with who and
 *    what.
 *
 * Nothing else crosses. The package is built by work at `public`
 * (runAtLabel), on a connection the database holds to `public` alone, from
 * the rows the gate wrote there. A row at any other label cannot be read
 * by that work, whatever this file asks for.
 *
 * On the public graph none of this runs: it has one label and shows no
 * page outside itself.
 */
import { createHash, createPublicKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { loadConfig } from "../config.js";
import { withSystemClearance } from "../db/clearance.js";
import { rawQuery } from "../db/client.js";
import { PUBLIC_LABEL } from "../labels.js";
import { runAtLabel } from "../llm/usage-context.js";
import { PUBLISHED_PAGE_FORMAT, packageHash, registrationStatement, type PublishedPagePackage } from "../published-page/verify.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { keyIdOf, parseSigningKey, publicKeyString } from "./mirror-batch.js";
import { canonicalContent } from "./run-log.js";
import { outsideRecord, type GateActor } from "./release-gate-service.js";
import { ownOrganizationParty } from "./showing-service.js";

export class OutboundError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

const REASON_OUTBOUND =
  "A person's act on what leaves the deployment is recorded at `public`, where the released record of a showing outside is kept, once the route has checked the person.";
const asOwner = <T>(fn: () => Promise<T>) => withSystemClearance(REASON_OUTBOUND, fn);

/** Work at `public`: it reads `public` rows alone, and what it writes is `public`. */
const atPublic = <T>(what: string, fn: () => Promise<T>) => runAtLabel(PUBLIC_LABEL, what, fn);

// ---- what the person who asks for a standing showing is told ---------------------

/**
 * How the packages of a showing outside are sent, as the person choosing is
 * told it. The choice is made when the showing is asked for, by the person
 * asking, and is recorded with the showing under their name.
 */
export const SEND_CHOICES = {
  by_a_person_each_time:
    "Each time a page under this showing is released, or more of one is, or a later version is held, a signed " +
    "package waits here until a person who directs the graph sends it. Until then the public graph has the last " +
    "one that was sent.",
  as_released:
    "Each package is sent to the public graph as soon as it is built, with nobody sending it: when a page is " +
    "released, when more of one is, and when a later version is held, in which case the public graph is told that " +
    "it is held, by whom and since when, and none of its text. Outside, this shows when your graph assessed the " +
    "node again and how long each version waited to be released. The choice is recorded with the showing under " +
    "your name, and ending the showing ends it.",
} as const;
export type SendChoice = keyof typeof SEND_CHOICES;

// ---- the key ------------------------------------------------------------------------

interface Signer {
  key: KeyObject;
  publicKey: string;
  keyId: string;
}

let cachedSigner: { pem: string; signer: Signer } | null = null;

/** The deployment's signing key, from PUBLISH_SIGNING_KEY. */
function signer(): Signer {
  const pem = loadConfig().publishSigningKey;
  if (!pem) {
    throw new OutboundError(
      "NO_SIGNING_KEY",
      "This deployment has no signing key for pages shown outside (PUBLISH_SIGNING_KEY), so no package can be built. " +
        "`npx tsx scripts/published-page.ts keygen` makes one."
    );
  }
  if (cachedSigner?.pem === pem) return cachedSigner.signer;
  let key: KeyObject;
  try {
    key = parseSigningKey(pem, "PUBLISH_SIGNING_KEY");
  } catch (err) {
    throw new OutboundError("NO_SIGNING_KEY", `${err instanceof Error ? err.message : String(err)}.`);
  }
  const publicKey = publicKeyString(createPublicKey(key));
  const made = { key, publicKey, keyId: keyIdOf(publicKey) };
  cachedSigner = { pem, signer: made };
  return made;
}

function hosting(): "own_machines" | "minerval" | "third_party" {
  const where = loadConfig().deploymentHosting;
  if (!where) {
    throw new OutboundError(
      "HOSTING_NOT_STATED",
      "This deployment has not said where it runs (DEPLOYMENT_HOSTING: own_machines, minerval or third_party). Every " +
        "package states it, because a reader weighs a page by who controlled the machine it was made on."
    );
  }
  return where;
}

/** The key's public half and where the deployment says it runs: what the organization registers on the public graph. */
export function publisherIdentity(): { public_key: string; key_id: string; hosting: string } {
  const s = signer();
  return { public_key: s.publicKey, key_id: s.keyId, hosting: hosting() };
}

/** The registration the organization's account presents on the public graph, signed with the deployment's key. */
export function signedRegistration(account: string): { public_key: string; hosting: string; account: string; signature: string } {
  const s = signer();
  const where = hosting();
  const statement = registrationStatement({ account, publicKey: s.publicKey, hosting: where });
  return {
    public_key: s.publicKey,
    hosting: where,
    account,
    signature: cryptoSign(null, Buffer.from(statement, "utf8"), s.key).toString("base64"),
  };
}

// ---- which node on the public graph ---------------------------------------------------

interface ProposalRow {
  id: string;
  showing_id: string;
  node_id: string;
  node_kind: string;
  text: string;
  written_at: Date;
  needs: string[];
  releases: Array<{ party_id: string; by: string | null; holding: string[]; at: string }>;
  state: "waiting_for_release" | "ready" | "sent" | "on_the_public_graph" | "not_admitted" | "replaced";
  public_contribution_id: string | null;
  public_node_id: string | null;
  sent_at: Date | null;
  settled_at: Date | null;
}

const PROPOSAL_COLUMNS = `id, showing_id, node_id, node_kind, text, written_at, needs, releases, state, public_contribution_id, public_node_id, sent_at, settled_at`;

async function latestProposal(showingId: string, nodeId: string): Promise<ProposalRow | null> {
  const [row] = await rawQuery<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM outbound_proposals
      WHERE showing_id = $1 AND node_id = $2 AND state <> 'replaced' ORDER BY written_at DESC LIMIT 1`,
    [showingId, nodeId]
  );
  return row ?? null;
}

/**
 * The node's id on the public graph, or null while it has none. A mirrored
 * node is the public graph's own. Any other node is on the public graph
 * once a proposal of it has been admitted there, at the node the proposal
 * became.
 */
async function publicNodeOf(showingId: string, nodeId: string): Promise<string | null> {
  const [mirrored] = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = $1 AND origin = 'mirror'`, [nodeId]);
  if (mirrored) return mirrored.id;
  const proposal = await latestProposal(showingId, nodeId);
  return proposal?.state === "on_the_public_graph" ? proposal.public_node_id : null;
}

/** What a member is told about a node that has no page on the public graph to appear on yet. */
export function waitingWords(proposal: ProposalRow | null, parties: Map<string, string>): string {
  const only =
    "This node exists only in this deployment, so the public graph has no node for its page to appear on.";
  if (!proposal) {
    return (
      `${only} It is first proposed to the public graph, as anyone may propose a node there, in words a person who ` +
      `directs this graph writes or approves. Nothing has been proposed yet, and nothing of this node is outside.`
    );
  }
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "a date not recorded");
  switch (proposal.state) {
    case "waiting_for_release": {
      const released = new Set(proposal.releases.map((r) => r.party_id));
      const waiting = proposal.needs.filter((p) => !released.has(p)).map((p) => parties.get(p) ?? "a party");
      return `${only} The words it is to be proposed in were written on ${day(proposal.written_at)} and wait to be released by ${waiting.join(" and ") || "the parties they rest on"}. Nothing of this node is outside.`;
    }
    case "ready":
      return `${only} The words it is to be proposed in are written and released, and wait for a person who directs this graph to send them.`;
    case "sent":
      return `${only} It was proposed to the public graph on ${day(proposal.sent_at)}, in the words below, and the review of the proposal there has not finished. The page is sent once the public graph holds the node.`;
    case "not_admitted":
      return `${only} It was proposed to the public graph on ${day(proposal.sent_at)} and the proposal was not admitted there (${day(proposal.settled_at)}). The proposal and the reasons given are public on the public graph. A person who directs this graph may propose it in other words.`;
    default:
      return "";
  }
}

/**
 * Write, or approve, the words a node is proposed to the public graph in.
 * The route has checked that the person holds `direct` and reads the node.
 * With no text given, the words are the node's own. They then wait for each
 * party the node's wording rests on, unless they are word for word a
 * wording those parties have already released at the gate.
 */
export async function writeProposal(input: { showingId: string; nodeId: string; text?: string; actor: GateActor }): Promise<{ proposal_id: string; state: string; in_words: string }> {
  // Read as the person: someone who cannot read the node is told it does not exist.
  const [node] = await rawQuery<{ text: string; kind: string; origin: string }>(`SELECT text, kind, origin FROM claims WHERE id = $1`, [input.nodeId]);
  if (!node) throw new OutboundError("NODE_NOT_FOUND", "No node with that id is one you read.");
  if (node.origin === "mirror") {
    throw new OutboundError("ALREADY_PUBLIC", "This node is the public graph's own, so there is nothing to propose: its page is sent to that node.");
  }
  const text = (input.text ?? node.text).trim();
  if (text.length === 0 || text.length > 2000) {
    throw new OutboundError("BAD_TEXT", "A proposal is the node's wording: between 1 and 2,000 characters, which is what the public graph takes.");
  }
  return asOwner(async () => {
    const [covered] = await rawQuery<{ id: string }>(
      `SELECT n.id FROM shown_nodes n JOIN shown_showings s ON s.id = n.showing_id
        WHERE n.showing_id = $1 AND n.node_id = $2 AND s.to_outside AND n.left_at IS NULL`,
      [input.showingId, input.nodeId]
    );
    if (!covered) throw new OutboundError("NOT_SHOWN_OUTSIDE", "No showing outside with that id covers this node.");
    const existing = await latestProposal(input.showingId, input.nodeId);
    if (existing && (existing.state === "sent" || existing.state === "on_the_public_graph")) {
      throw new OutboundError(
        "ALREADY_PROPOSED",
        existing.state === "sent"
          ? "This node has been proposed to the public graph and the review there has not finished. What was sent cannot be reworded here."
          : "The public graph already holds this node."
      );
    }
    // Whose words these are to release: the parties the node's wording rests on in its latest page.
    const [wording] = await rawQuery<{ needs: string[]; text: string | null }>(
      `SELECT sp.needs, sp.text FROM shown_parts sp JOIN shown_pages p ON p.id = sp.page_id
        WHERE p.showing_id = $1 AND p.node_id = $2 AND sp.kind = 'wording' AND p.stage <> 'overtaken'
        ORDER BY p.judged_at DESC LIMIT 1`,
      [input.showingId, input.nodeId]
    );
    const [page] = await rawQuery<{ needs: string[] }>(
      `SELECT needs FROM shown_pages WHERE showing_id = $1 AND node_id = $2 AND stage <> 'overtaken' ORDER BY judged_at DESC LIMIT 1`,
      [input.showingId, input.nodeId]
    );
    const own = await ownOrganizationParty();
    const needs = wording?.needs ?? page?.needs ?? (own ? [own.id] : []);
    const alreadyReleased = wording?.text !== null && wording?.text !== undefined && wording.text === text;
    const state = alreadyReleased || needs.length === 0 ? "ready" : "waiting_for_release";
    if (existing) await rawQuery(`UPDATE outbound_proposals SET state = 'replaced' WHERE id = $1`, [existing.id]);
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO outbound_proposals (showing_id, node_id, node_kind, text, written_by, written_holding, needs, state, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9) RETURNING id`,
      [input.showingId, input.nodeId, node.kind, text, input.actor.id, input.actor.holding, needs, state, PUBLIC_LABEL]
    );
    return {
      proposal_id: row!.id,
      state,
      in_words: alreadyReleased
        ? "These are the node's words as the parties they rest on released them at the gate, so they are ready to send."
        : state === "ready"
          ? "These words rest on no party's material, so they are ready to send."
          : "These words wait for each party the node's wording rests on to release them. Until then nothing of this node is proposed.",
    };
  });
}

/** A party's holder of `release` releases the words a node is to be proposed in. */
export async function releaseProposal(input: { proposalId: string; partyId: string; actor: GateActor }): Promise<{ state: string }> {
  if (!input.actor.releaseParties.includes(input.partyId)) {
    throw new OutboundError("NOT_YOUR_PARTY", "This release is for a party whose material you do not hold the permission to release.");
  }
  return asOwner(async () => {
    const [p] = await rawQuery<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM outbound_proposals WHERE id = $1`, [input.proposalId]);
    if (!p) throw new OutboundError("PROPOSAL_NOT_FOUND", "No proposal has that id.");
    if (p.state !== "waiting_for_release") throw new OutboundError("NOT_WAITING", "This proposal is not waiting for a release.");
    if (!p.needs.includes(input.partyId)) throw new OutboundError("NOT_YOUR_PARTY", "These words do not rest on that party's material.");
    if (p.releases.some((r) => r.party_id === input.partyId)) throw new OutboundError("ALREADY_RELEASED", "This party has already released these words.");
    const releases = [...p.releases, { party_id: input.partyId, by: input.actor.id, holding: input.actor.holding, at: new Date().toISOString() }];
    const state = p.needs.every((party) => releases.some((r) => r.party_id === party)) ? "ready" : "waiting_for_release";
    await rawQuery(`UPDATE outbound_proposals SET releases = $2::jsonb, state = $3 WHERE id = $1`, [p.id, JSON.stringify(releases), state]);
    return { state };
  });
}

// ---- building packages -------------------------------------------------------------------

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

interface BuiltPackage {
  id: string;
  showing_id: string;
  node_id: string;
  public_node_id: string;
  sequence: number;
  hash: string;
  package: PublishedPagePackage;
  built_at: Date;
}

const PACKAGE_COLUMNS = `id, showing_id, node_id, public_node_id, sequence, hash, package, built_at`;

/**
 * Bring the packages of the showings outside up to what the outside would
 * read now, and return how many were built. Runs as work at `public`.
 */
export async function buildOutboundPackages(opts: { showingId?: string } = {}): Promise<number> {
  if (oneLabelOnly()) return 0;
  const s = signer();
  const where = hosting();
  return atPublic("building the packages of pages shown outside", async () => {
    const nodes = await rawQuery<{ showing_id: string; node_id: string }>(
      `SELECT DISTINCT n.showing_id, n.node_id FROM shown_nodes n JOIN shown_showings s ON s.id = n.showing_id
        WHERE s.to_outside AND ($1::uuid IS NULL OR s.id = $1) ORDER BY n.showing_id, n.node_id`,
      [opts.showingId ?? null]
    );
    let built = 0;
    for (const n of nodes) {
      const publicNodeId = await publicNodeOf(n.showing_id, n.node_id);
      if (!publicNodeId) continue;
      const record = await outsideRecord(n.showing_id, n.node_id);
      if (!record) continue;
      const content = {
        format: PUBLISHED_PAGE_FORMAT,
        publisher: { key_id: s.keyId, public_key: s.publicKey },
        deployment: { hosting: where, attested_by: "nothing" as const },
        showing: record.showing,
        node: { public_id: publicNodeId, ...record.node },
        state: record.state,
        page: record.page,
        policy: record.policy,
        record: { made: record.made, acts: record.acts, versions: record.versions },
      };
      const contentHash = sha256(canonicalContent(JSON.parse(JSON.stringify(content))));
      const [last] = await rawQuery<{ sequence: number; hash: string; content_hash: string }>(
        `SELECT sequence, hash, content_hash FROM outbound_packages WHERE showing_id = $1 AND node_id = $2 ORDER BY sequence DESC LIMIT 1`,
        [n.showing_id, n.node_id]
      );
      if (last?.content_hash === contentHash) continue;
      const body = { ...content, sequence: (last?.sequence ?? 0) + 1, previous_hash: last?.hash ?? null, built_at: new Date().toISOString() };
      const hash = await packageHash(body as unknown as Record<string, unknown>);
      const signed = { ...body, hash, signature: cryptoSign(null, Buffer.from(hash, "hex"), s.key).toString("base64") };
      const size = Buffer.byteLength(JSON.stringify(signed), "utf8");
      if (size > loadConfig().publishedPageMaxBytes) {
        console.error(`[outbound] the package for node ${n.node_id} is ${size} bytes, more than a graph admits (${loadConfig().publishedPageMaxBytes}); it was not built.`);
        continue;
      }
      await rawQuery(
        `INSERT INTO outbound_packages (showing_id, node_id, public_node_id, sequence, content_hash, hash, package, sensitivity_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [n.showing_id, n.node_id, publicNodeId, body.sequence, contentHash, hash, JSON.stringify(signed), PUBLIC_LABEL]
      );
      built++;
    }
    return built;
  });
}

// ---- sending ---------------------------------------------------------------------------------

/** Who is sending: a person, or the standing choice a person made when they asked for the showing. */
export type Sender = { actor: GateActor } | { standing: true };

interface PublicGraph {
  url: string;
  key: string;
}

function publicGraph(): PublicGraph {
  const { publicGraphApiUrl, publicGraphApiKey } = loadConfig();
  if (!publicGraphApiUrl || !publicGraphApiKey) {
    throw new OutboundError(
      "NO_ROUTE_OUT",
      "This deployment has no address or key for the public graph (PUBLIC_GRAPH_API_URL, PUBLIC_GRAPH_API_KEY), so it " +
        "sends nothing itself. A person can take each package as a file and submit it on the public graph under the " +
        "organization's account."
    );
  }
  return { url: publicGraphApiUrl.replace(/\/+$/, ""), key: publicGraphApiKey };
}

async function call(graph: PublicGraph, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${graph.url}${path}`, {
    method,
    headers: { "x-api-key": graph.key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, any>) : {};
  } catch {
    json = { error: { message: text.slice(0, 500) } };
  }
  return { status: res.status, json };
}

/** What the public graph said, in one line. Its answers are public words about a public record; nothing of the deployment's is in them. */
function answerOf(json: Record<string, any>): string {
  const error = json.error;
  const said = typeof error === "string" ? error : (error?.message ?? json.message ?? json.status ?? "");
  return String(said).slice(0, 1000);
}

async function logSend(row: { packageId?: string; proposalId?: string; sender: Sender; how: "https" | "file"; result: string; detail: string | null }): Promise<void> {
  const actor = "actor" in row.sender ? row.sender.actor : null;
  await rawQuery(
    `INSERT INTO outbound_sends (package_id, proposal_id, sent_by, holding, under_standing_choice, how, result, detail, sensitivity_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [row.packageId ?? null, row.proposalId ?? null, actor?.id ?? null, actor?.holding ?? [], actor === null, row.how, row.result, row.detail, PUBLIC_LABEL]
  );
}

/** Send the proposals that are ready, and ask after the ones already sent. */
async function advanceProposals(graph: PublicGraph, showingId: string, sender: Sender): Promise<void> {
  const proposals = await rawQuery<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM outbound_proposals WHERE showing_id = $1 AND state IN ('ready', 'sent') ORDER BY written_at`,
    [showingId]
  );
  for (const p of proposals) {
    try {
      if (p.state === "ready") {
        const res = await call(graph, "POST", "/claims/propose", { claim: p.text, kind: p.node_kind });
        if (res.status === 202 && res.json.contribution?.id) {
          await rawQuery(`UPDATE outbound_proposals SET state = 'sent', public_contribution_id = $2, sent_at = now() WHERE id = $1`, [p.id, res.json.contribution.id]);
          await logSend({ proposalId: p.id, sender, how: "https", result: "admitted", detail: "The public graph took the proposal for review." });
        } else if (res.status === 201 && res.json.claim?.id) {
          await rawQuery(`UPDATE outbound_proposals SET state = 'on_the_public_graph', public_node_id = $2, sent_at = now(), settled_at = now() WHERE id = $1`, [p.id, res.json.claim.id]);
          await logSend({ proposalId: p.id, sender, how: "https", result: "admitted", detail: "The public graph holds the node." });
        } else {
          await logSend({ proposalId: p.id, sender, how: "https", result: "refused", detail: `${res.status}: ${answerOf(res.json)}` });
        }
        continue;
      }
      const res = await call(graph, "GET", `/contributions/${p.public_contribution_id}`);
      const c = (res.json.contribution ?? res.json) as { review_status?: string; claim_id?: string | null };
      if (res.status !== 200) continue;
      if (c.review_status === "accepted" && c.claim_id) {
        await rawQuery(`UPDATE outbound_proposals SET state = 'on_the_public_graph', public_node_id = $2, settled_at = now() WHERE id = $1`, [p.id, c.claim_id]);
      } else if (c.review_status === "rejected") {
        await rawQuery(`UPDATE outbound_proposals SET state = 'not_admitted', settled_at = now() WHERE id = $1`, [p.id]);
      }
    } catch (err) {
      await logSend({ proposalId: p.id, sender, how: "https", result: "failed", detail: err instanceof Error ? err.message.slice(0, 500) : "The public graph could not be reached." });
    }
  }
}

export interface SendReport {
  proposals: Array<{ node_id: string; state: string }>;
  built: number;
  sent: Array<{ package_id: string; node_id: string; sequence: number; result: string; detail: string | null }>;
}

/**
 * Send what waits under one showing outside: its proposals first, then each
 * node's packages in order. A node's packages stop at the first one the
 * public graph does not take, since each names the one before.
 */
export async function sendOutbound(input: { showingId: string; sender: Sender }): Promise<SendReport> {
  if (oneLabelOnly()) throw new OutboundError("ONE_LABEL", "This graph holds everything at one label and shows no page outside itself.");
  const graph = publicGraph();
  return asOwner(async () => {
    const [showing] = await rawQuery<{ id: string; send_as_released: boolean }>(`SELECT id, send_as_released FROM shown_showings WHERE id = $1 AND to_outside`, [input.showingId]);
    if (!showing) throw new OutboundError("SHOWING_NOT_FOUND", "No showing outside has that id.");
    if ("standing" in input.sender && !showing.send_as_released) {
      throw new OutboundError("NO_STANDING_CHOICE", "Nobody chose for this showing's packages to be sent as they are released, so a person sends each.");
    }
    await advanceProposals(graph, showing.id, input.sender);
    const built = await buildOutboundPackages({ showingId: showing.id });
    const waiting = await rawQuery<BuiltPackage>(
      `SELECT ${PACKAGE_COLUMNS} FROM outbound_packages p
        WHERE p.showing_id = $1
          AND NOT EXISTS (SELECT 1 FROM outbound_sends s WHERE s.package_id = p.id AND s.how = 'https' AND s.result = 'admitted')
        ORDER BY p.node_id, p.sequence`,
      [showing.id]
    );
    const sent: SendReport["sent"] = [];
    const stopped = new Set<string>();
    for (const p of waiting) {
      if (stopped.has(p.node_id)) continue;
      let result = "failed";
      let detail: string | null = null;
      try {
        const res = await call(graph, "POST", "/published-pages", { package: p.package });
        result = res.status === 200 || res.status === 201 ? "admitted" : "refused";
        detail = result === "admitted" ? String(res.json.in_words ?? "") : `${res.status}: ${answerOf(res.json)}`;
      } catch (err) {
        detail = err instanceof Error ? err.message.slice(0, 500) : "The public graph could not be reached.";
      }
      await logSend({ packageId: p.id, sender: input.sender, how: "https", result, detail });
      sent.push({ package_id: p.id, node_id: p.node_id, sequence: p.sequence, result, detail });
      if (result !== "admitted") stopped.add(p.node_id);
    }
    const proposals = await rawQuery<{ node_id: string; state: string }>(
      `SELECT node_id, state FROM outbound_proposals WHERE showing_id = $1 AND state <> 'replaced' ORDER BY written_at`,
      [showing.id]
    );
    return { proposals, built, sent };
  });
}

/**
 * The scheduler's work: build what has changed, and send for each showing
 * whose asker chose that its packages go as they are released. A deployment
 * with no key, or that has not said where it runs, builds nothing; one with
 * no route out sends nothing.
 */
export async function followOutbound(): Promise<{ built: number; sent: number }> {
  if (oneLabelOnly()) return { built: 0, sent: 0 };
  const config = loadConfig();
  if (!config.publishSigningKey || !config.deploymentHosting) return { built: 0, sent: 0 };
  const built = await buildOutboundPackages();
  if (!config.publicGraphApiUrl || !config.publicGraphApiKey) return { built, sent: 0 };
  const standing = await asOwner(() =>
    rawQuery<{ id: string }>(`SELECT id FROM shown_showings WHERE to_outside AND send_as_released ORDER BY asked_at`)
  );
  let sent = 0;
  for (const s of standing) {
    try {
      sent += (await sendOutbound({ showingId: s.id, sender: { standing: true } })).sent.filter((x) => x.result === "admitted").length;
    } catch (err) {
      console.error(`[outbound] could not send for showing ${s.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { built, sent };
}

/**
 * One package as a file, for a person to carry where the network does not
 * reach: the package exactly as signed. Handing it over is recorded with
 * who took it.
 */
export async function packageFile(input: { packageId: string; actor: GateActor }): Promise<{ file_name: string; package: PublishedPagePackage }> {
  return asOwner(async () => {
    const [p] = await rawQuery<BuiltPackage>(`SELECT ${PACKAGE_COLUMNS} FROM outbound_packages WHERE id = $1`, [input.packageId]);
    if (!p) throw new OutboundError("PACKAGE_NOT_FOUND", "No package has that id.");
    await logSend({ packageId: p.id, sender: { actor: input.actor }, how: "file", result: "handed_over", detail: null });
    return { file_name: `published-page-${p.public_node_id}-${String(p.sequence).padStart(6, "0")}.json`, package: p.package };
  });
}

// ---- what a member reads ------------------------------------------------------------------------

/**
 * Where each node under the showings outside stands on its way out: whether
 * the public graph holds the node, the proposal if it does not, each
 * package built and each time one was sent or handed over, with who did
 * it. Read with the caller's own clearance: every row is at `public`.
 */
export async function outboundOverview(opts: { showingId?: string } = {}): Promise<Record<string, unknown>> {
  const nodes = await rawQuery<{ showing_id: string; node_id: string; send_as_released: boolean; text: string | null; origin: string | null }>(
    `SELECT DISTINCT n.showing_id, n.node_id, s.send_as_released, c.text, c.origin, s.asked_at
       FROM shown_nodes n JOIN shown_showings s ON s.id = n.showing_id LEFT JOIN claims c ON c.id = n.node_id
      WHERE s.to_outside AND ($1::uuid IS NULL OR s.id = $1) ORDER BY s.asked_at DESC, n.node_id`,
    [opts.showingId ?? null]
  );
  const parties = new Map((await rawQuery<{ id: string; name: string }>(`SELECT id, name FROM parties`)).map((p) => [p.id, p.name]));
  const out: Array<Record<string, unknown>> = [];
  for (const n of nodes) {
    const proposal = n.origin === "mirror" ? null : await latestProposal(n.showing_id, n.node_id);
    const publicNodeId = n.origin === "mirror" ? n.node_id : proposal?.state === "on_the_public_graph" ? proposal.public_node_id : null;
    const packages = await rawQuery<{ id: string; sequence: number; state: string; built_at: Date }>(
      `SELECT id, sequence, package->>'state' AS state, built_at FROM outbound_packages WHERE showing_id = $1 AND node_id = $2 ORDER BY sequence`,
      [n.showing_id, n.node_id]
    );
    const sends = await rawQuery<{ package_id: string; how: string; result: string; detail: string | null; at: Date; by: string | null; holding: string[]; under_standing_choice: boolean }>(
      `SELECT s.package_id, s.how, s.result, s.detail, s.at, c.display_name AS by, s.holding, s.under_standing_choice
         FROM outbound_sends s LEFT JOIN contributors c ON c.id = s.sent_by
        WHERE s.package_id = ANY($1::uuid[]) ORDER BY s.at`,
      [packages.map((p) => p.id)]
    );
    out.push({
      showing_id: n.showing_id,
      node_id: n.node_id,
      node: n.text,
      public_node_id: publicNodeId,
      ...(publicNodeId
        ? {}
        : { waiting: waitingWords(proposal, parties) }),
      ...(proposal
        ? {
            proposal: {
              proposal_id: proposal.id,
              state: proposal.state,
              text: proposal.text,
              written_at: proposal.written_at.toISOString(),
              waits_on: proposal.needs.filter((p) => !proposal.releases.some((r) => r.party_id === p)).map((p) => ({ id: p, name: parties.get(p) ?? "" })),
              public_contribution_id: proposal.public_contribution_id,
            },
          }
        : {}),
      sent: n.send_as_released ? "as_released" : "by_a_person_each_time",
      packages: packages.map((p) => ({
        package_id: p.id,
        sequence: p.sequence,
        state: p.state,
        built_at: p.built_at.toISOString(),
        sends: sends
          .filter((s) => s.package_id === p.id)
          .map((s) => ({
            at: s.at.toISOString(),
            how: s.how === "file" ? "handed to a person as a file" : "sent to the public graph",
            result: s.result,
            ...(s.detail ? { the_public_graph_said: s.detail } : {}),
            by: s.under_standing_choice ? "the standing choice made when the showing was asked for" : s.by,
            holding: s.holding,
          })),
      })),
    });
  }
  return { nodes: out, how_sending_works: SEND_CHOICES };
}
