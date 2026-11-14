/**
 * A shown page leaves the deployment and is read on the public graph
 * (docs/published-pages.md).
 *
 * Two databases and two processes. The public graph is the real app on a
 * database of its own (tests/db/helpers/public-graph-server.ts), reached
 * over HTTP as any account reaches it. The private deployment is this
 * process and the suite's database, with the labels of the review tests
 * (`r3-a`, `r3-b`, `r3-c`; `r3-a` reads `public`), and it mirrors the public
 * graph through the signed feed.
 *
 * No model runs. The Redactor's and Audit's tools are driven at the page's
 * label as in showing-a-page.test.ts; on the public graph the Contribution
 * Reviewer's decision and the Steward's detaching of a source are driven
 * through those agents' own tools; and the Reviewer's and Matcher's work on
 * a proposed node is stood in for by writing its outcome.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { loadConfig } from "../../src/config.js";
import { rawQuery, withTransaction } from "../../src/db/client.js";
import { setNoContextSessionForTests } from "../../src/db/clearance.js";
import { runAtLabel, withAgent } from "../../src/llm/usage-context.js";
import { executeAuditTool } from "../../src/llm/tools/audit-tools.js";
import { executeRedactorTool } from "../../src/llm/tools/redactor-tools.js";
import { shapeOfPublishedPage } from "../../src/published-page/shape.js";
import { packageHash, verifyPublishedPage, type PublishedPagePackage } from "../../src/published-page/verify.js";
import { generateSigningKey, keyIdOf, parseSigningKey } from "../../src/services/mirror-batch.js";
import { syncMirror, type BatchSource } from "../../src/services/mirror-apply-service.js";
import { poolDb, type MirrorDb } from "../../src/services/mirror-db.js";
import { cutBatches, getBatchText, listBatches } from "../../src/services/mirror-feed-service.js";
import { replicatedTables } from "../../src/services/mirror-manifest.js";
import {
  OutboundError,
  buildOutboundPackages,
  followOutbound,
  outboundOverview,
  packageFile,
  sendOutbound,
  signedRegistration,
  writeProposal,
} from "../../src/services/outbound-service.js";
import { decideAtGate, gateQueue, shownShowing, type GateActor } from "../../src/services/release-gate-service.js";
import { askShowing, endShowing, followShowings } from "../../src/services/showing-service.js";
import { A, B, C, asPerson, attachSource, seedNode, seedUser, system, tag, unwall, wall, personDecidesAt, sendAsReleasedAt } from "./review-3-common.js";
import { mirrorDatabaseUrl } from "./urls.js";

const SECRET = "4711 units";
const NOTE = "A figure a counterparty could use to price against the plant.";
const HELD_TEXT = "Unread night logs could hide a shortfall.";
const OTHER_LABEL_TEXT = "Something written at another label that nobody released.";
const DIM = 1536;

const id: Record<string, string> = {};
const actor: Record<string, GateActor> = {};
const feedKey = generateKeyPairSync("ed25519");
const publishKey = generateSigningKey();
const orgKey = `epk_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;
const orgAccount = `test-org:${tag}`;

let pubPool: pg.Pool;
let pub: MirrorDb;
let server: ChildProcess;
let api = "";
let agents = "";

const redactorAt = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "a redactor's run", () => withAgent("redactor", fn));
const auditAt = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "an audit run", () => withAgent("audit", fn));
const tool = async (pageId: string, name: string, input: Record<string, unknown> = {}) =>
  JSON.parse(await redactorAt(A, () => executeRedactorTool(name, input, { pageId }))) as Record<string, any>;
const audit = async (name: string, input: Record<string, unknown>) =>
  JSON.parse(await auditAt(A, () => executeAuditTool(name, input, {}))) as Record<string, any>;
const everyone = <T>(fn: () => Promise<T>) => asPerson(["public"], fn);

function vec(axis: number): string {
  const v = Array.from({ length: DIM }, () => 0);
  v[axis] = 1;
  return `[${v.join(",")}]`;
}

/** The public graph's API, as an account calls it. */
async function pubApi(method: "GET" | "POST", path: string, body?: unknown, key: string | null = orgKey): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { ...(key ? { "x-api-key": key } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

/** One of the public graph's agents, through its own tool. */
async function pubAgent(agent: "reviewer" | "steward", toolName: string, input: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(agents, { method: "POST", body: JSON.stringify({ agent, tool: toolName, input }) });
  return (await res.json()) as Record<string, any>;
}

const pubRows = <T>(text: string, params: unknown[] = []) => pub.query<T>(text, params);

async function forgetTheMirror(): Promise<void> {
  await system(() =>
    withTransaction(async (tx) => {
      await tx.query(`SELECT set_config('minerval.mirror_applier', 'on', true)`);
      for (const table of [...replicatedTables()].reverse()) await tx.query(`DELETE FROM "${table.name}" WHERE origin = 'mirror'`);
      await tx.query(`TRUNCATE mirror_applied_batches, mirror_snapshot_rows, mirror_refusals, node_changes`);
    })
  );
}

const feed = (): BatchSource => ({
  name: "the public graph's database",
  head: async () => (await listBatches({}, pub)).head,
  latestSnapshot: async () => (await listBatches({}, pub)).latest_snapshot,
  fetch: (sequence) => getBatchText(sequence, pub),
});

/** Bring the deployment's mirror up to the public graph as it stands. */
async function mirror(): Promise<void> {
  await cutBatches({ db: pub, signingKey: feedKey.privateKey, webBaseUrl: "https://public.example" });
  const result = await syncMirror(feed(), { trustedKeys: [feedKey.publicKey] });
  expect(result.refusal?.message ?? null).toBeNull();
}

async function publicClaim(key: string, words: string, axis: number): Promise<string> {
  id[key] = randomUUID();
  await pubRows(
    `INSERT INTO claims (id, text, embedding, importance, steward_state, tagged_at) VALUES ($1, $2, $3, 0.6, 'done', now())`,
    [id[key], `${words} (${tag})`, vec(axis)]
  );
  await pubRows(
    `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace) VALUES ($1, 'inconclusive', 0.5, 'Public evidence leaves it open.', 'Public evidence leaves it open.')`,
    [id[key]]
  );
  return id[key]!;
}

/** A version at `a` of a node, resting on a source Acme supplied, with an argument each way. */
async function assessAtA(node: string, words: { summary: string; reasoning: string }, status = "supported"): Promise<void> {
  await system(async () => {
    await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1 AND sensitivity_label = $2`, [node, A]);
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, claim_credence, summary, reasoning_trace, model, is_current, sensitivity_label)
       VALUES ($1, $2, 0.8, 0.85, $3, $4, 'a-model', true, $5)`,
      [node, status, words.summary, words.reasoning, A]
    );
  });
}

async function seedPrivateWork(node: string): Promise<void> {
  const acme = await attachSource(node, A, "Acme's meter export shows what the plant produced.");
  await system(async () => {
    await rawQuery(`UPDATE sources SET party_id = $2, content_hash = 'aaaa1111' WHERE id = $1`, [acme.source, id.acme]);
    await rawQuery(
      `INSERT INTO source_interests (source_id, claim_id, party, stake, recorded_by, sensitivity_label) VALUES ($1, $2, 'Acme', 'Acme is paid by output.', 'steward', $3)`,
      [acme.source, node, A]
    );
    const arg = (stance: string, name: string, content: string) =>
      rawQuery(`INSERT INTO arguments (claim_id, stance, name, content, created_by, sensitivity_label) VALUES ($1, $2, $3, $4, 'steward', $5)`, [node, stance, name, content, A]);
    await arg("for", "From the meters", "The meters record more than the target.");
    await arg("against", "From the missing logs", HELD_TEXT);
  });
  await assessAtA(node, {
    summary: "The target was met, on meter data.\n\nOne caveat remains.",
    reasoning: `The meter data shows ${SECRET} against a target of 4500.\n\nThe meters were calibrated in March.`,
  });
}

/** The latest page of a node under a showing, by its id on the destination side. */
async function latestPageOf(showingId: string, node: string): Promise<string> {
  const record = (await everyone(() => shownShowing(showingId)))!;
  return (record.nodes as any[]).find((n) => n.node_id === node).versions[0].page_id as string;
}

/** Redact the secret figure where it stands, finish, and pass the check. */
async function redactAndCheck(pageId: string): Promise<void> {
  const page = await tool(pageId, "get_page_to_redact");
  const withSecret = (page.parts as any[]).find((p) => String(p.text).includes(SECRET));
  if (withSecret) {
    expect((await tool(pageId, "redact", { part: withSecret.part, passage: SECRET, category: "commercial figures", note: NOTE })).success).toBe(true);
  }
  expect((await tool(pageId, "finish_redaction", { least_sure: [] })).success).toBe(true);
  expect((await audit("record_fidelity_outcome", { page_id: pageId, outcome: "pass", answer: "supports_in_part", reasons: "Each removal is covered by the category cited." })).success).toBe(true);
}

/** Release everything on a page for every party, except the parts of the kinds named, which are held. */
async function releaseAllBut(pageId: string, holdKinds: string[] = []): Promise<void> {
  for (const [who, party] of [[actor.acme!, id.acme!], [actor.org!, id.org!]] as const) {
    const queue = (await gateQueue(who, { limit: 200 })) as { items: any[] };
    const mine = queue.items.filter((i) => i.page_id === pageId);
    const hold = mine.filter((i) => holdKinds.includes(i.kind));
    const release = mine.filter((i) => !holdKinds.includes(i.kind));
    if (release.length > 0) await decideAtGate({ actor: who, partyId: party, items: release.map((i) => ({ page_id: pageId, part: i.part })), decision: "release" });
    if (hold.length > 0) await decideAtGate({ actor: who, partyId: party, items: hold.map((i) => ({ page_id: pageId, part: i.part })), decision: "hold", reason: "confidentiality" });
  }
}

const packagesOf = (showingId: string, node: string) =>
  system(() =>
    rawQuery<{ id: string; sequence: number; package: PublishedPagePackage }>(
      `SELECT id, sequence, package FROM outbound_packages WHERE showing_id = $1 AND node_id = $2 ORDER BY sequence`,
      [showingId, node]
    )
  );

const sendAs = (showingId: string, who: GateActor = actor.director!) => sendOutbound({ showingId, sender: { actor: who } });

beforeAll(async () => {
  setNoContextSessionForTests(null);
  pubPool = new pg.Pool({ connectionString: mirrorDatabaseUrl("d"), max: 4 });
  pub = poolDb(pubPool);

  // The public graph, as a process of its own.
  const helper = join(dirname(fileURLToPath(import.meta.url)), "helpers", "public-graph-server.ts");
  server = spawn(join(process.cwd(), "node_modules", ".bin", "tsx"), [helper], {
    env: { ...process.env, PUBLIC_GRAPH_DATABASE_URL: mirrorDatabaseUrl("d"), ENFORCEMENT_SUITE: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = await new Promise<string>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`the public graph did not start: ${out}`)), 90_000);
    server.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const m = /PUBLIC_GRAPH_READY (\d+) (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(`${m[1]} ${m[2]}`);
      }
    });
    server.on("exit", (code) => reject(new Error(`the public graph exited (${code}): ${out}`)));
  });
  const [apiPort, agentPort] = ready.split(" ");
  api = `http://127.0.0.1:${apiPort}`;
  agents = `http://127.0.0.1:${agentPort}`;

  // The organization's own account on the public graph, with a key and some owls.
  const [account] = await pubRows<{ id: string }>(`INSERT INTO contributors (display_name, external_id) VALUES ($1, $2) RETURNING id`, [`Halden Works ${tag}`, orgAccount]);
  id.orgAccount = account!.id;
  await pubRows(`INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'deployment', $2, $3)`, [
    id.orgAccount,
    orgKey.slice(0, 12),
    createHash("sha256").update(orgKey, "utf8").digest("hex"),
  ]);
  await pubRows(`INSERT INTO owl_ledger (user_id, amount_micro_usd, reason) VALUES ($1, 500000000, 'purchase')`, [id.orgAccount]);
  await publicClaim("p", "The plant met its output target for the year", 310);
  await publicClaim("q", "The plant's meters were calibrated within the year", 311);

  // The deployment: mirrors the public graph, and holds material at `a`.
  await forgetTheMirror();
  await wall();
  await mirror();
  await system(async () => {
    const party = async (name: string, own = false) =>
      (await rawQuery<{ id: string }>(`INSERT INTO parties (name, is_own_organization) VALUES ($1, $2) RETURNING id`, [`${name} ${tag}`, own]))[0]!.id;
    const [existing] = await rawQuery<{ id: string; name: string }>(`SELECT id, name FROM parties WHERE is_own_organization`);
    id.org = existing?.id ?? (await party("Halden Works", true));
    id.orgName = existing?.name ?? `Halden Works ${tag}`;
    if (!existing) id.orgMadeHere = "yes";
    id.acme = await party("Acme");
  });
  for (const who of ["director", "acmeReviewer", "orgReviewer"]) id[who] = await seedUser();
  actor.director = { id: id.director!, holding: ["direct"], clearance: [A, "public"], releaseParties: [], direct: true };
  actor.acme = { id: id.acmeReviewer!, holding: [`release for Acme ${tag}`], clearance: [A, "public"], releaseParties: [id.acme!], direct: false };
  actor.org = { id: id.orgReviewer!, holding: ["release for the organization"], clearance: [A, "public"], releaseParties: [id.org!], direct: false };
  await seedPrivateWork(id.p!);

  Object.assign(loadConfig(), {
    publishSigningKey: publishKey.privateKeyPem,
    deploymentHosting: "own_machines",
    publicGraphApiUrl: api,
    publicGraphApiKey: orgKey,
  });
}, 240_000);

afterAll(async () => {
  server?.kill("SIGTERM");
  Object.assign(loadConfig(), { publishSigningKey: "", deploymentHosting: "", publicGraphApiUrl: "", publicGraphApiKey: "" });
  await system(async () => {
    // The words a node was proposed in went through the gate to outside as an item of their own.
    const proposals = await rawQuery<{ id: string }>(`SELECT id FROM showings WHERE kind = 'proposal'`);
    const showings = [id.showing, id.privateShowing, id.standingChoice, ...proposals.map((p) => p.id)].filter(Boolean);
    for (const showingId of showings) {
      const [showing] = await rawQuery<{ boundary_id: string }>(`SELECT boundary_id FROM shown_showings WHERE id = $1`, [showingId]);
      await rawQuery(`DELETE FROM outbound_sends WHERE package_id IN (SELECT id FROM outbound_packages WHERE showing_id = $1) OR proposal_id IN (SELECT id FROM outbound_proposals WHERE showing_id = $1)`, [showingId]);
      for (const table of ["outbound_packages", "outbound_proposals"]) await rawQuery(`DELETE FROM ${table} WHERE showing_id = $1`, [showingId]);
      await rawQuery(`DELETE FROM shown_parts WHERE page_id IN (SELECT id FROM shown_pages WHERE showing_id = $1)`, [showingId]);
      for (const table of ["showing_acts", "shown_pages", "shown_nodes"]) await rawQuery(`DELETE FROM ${table} WHERE showing_id = $1`, [showingId]);
      await rawQuery(`DELETE FROM shown_showings WHERE id = $1`, [showingId]);
      await rawQuery(`DELETE FROM redaction_policies WHERE boundary_id = $1`, [showing?.boundary_id ?? null]);
    }
  }).catch((err: unknown) => console.warn("[published-pages] cleanup:", err instanceof Error ? err.message : err));
  await unwall();
  await forgetTheMirror().catch((err: unknown) => console.warn("[published-pages] cleanup:", err instanceof Error ? err.message : err));
  await system(async () => {
    await rawQuery(`DELETE FROM parties WHERE id = ANY($1::uuid[])`, [[id.acme, ...(id.orgMadeHere ? [id.org] : [])]]);
  }).catch(() => undefined);
  await pubPool?.end();
}, 120_000);

describe("a mirrored node's page, shown outside and standing", () => {
  let pageId = "";
  let first: PublishedPagePackage;
  let publishedPageId = "";

  it("is built into one signed package once it settles at the gate, and the package checks out with no database", async () => {
    // The gate to outside, set to a person's decision at the gate and to a person sending each package.
    id.gate = await personDecidesAt(A, null);
    await sendAsReleasedAt(id.gate, false);
    const asked = await askShowing({ nodeId: id.p!, pageLabel: A, toLabel: null, form: "standing", scope: "node", actor: actor.director! });
    id.showing = asked.showing_id;
    // Before anything is released: the outside is told the page is held, and none of its text.
    expect(await buildOutboundPackages({ showingId: id.showing })).toBe(1);
    const [waiting] = await packagesOf(id.showing!, id.p!);
    expect(waiting!.package.state).toBe("held");
    expect(waiting!.package.page!.parts).toEqual([]);
    expect(waiting!.package.page!.held!.because).toBe("waiting for funds: none of the budgets that pay for its redaction could pay for it");
    expect((await verifyPublishedPage(waiting!.package)).ok).toBe(true);

    pageId = await latestPageOf(id.showing!, id.p!);
    await redactAndCheck(pageId);
    // The organization holds an argument against; Acme holds its own name and the words of its interest.
    await releaseAllBut(pageId, ["an argument against", "a source's supplier and recorded interest, by name"]);
    expect(await buildOutboundPackages({ showingId: id.showing })).toBe(1);
    // Nothing changed since: nothing is built.
    expect(await buildOutboundPackages({ showingId: id.showing })).toBe(0);

    const packages = await packagesOf(id.showing!, id.p!);
    expect(packages.map((p) => p.sequence)).toEqual([1, 2]);
    first = packages[1]!.package;
    expect(first.previous_hash).toBe(packages[0]!.package.hash);
    expect(first.node.public_id).toBe(id.p);
    expect(first.state).toBe("released_in_part");
    // The gate to outside names no public mandate to keep public versions current, so it asks nothing, which the package says.
    expect(first.deployment).toEqual({
      hosting: "own_machines",
      attested_by: "nothing",
      keeps_public_versions_current: { setting: "off", a_public_mandate_pays_for_it: false },
    });
    expect(first.showing).toMatchObject({ form: "standing", scope: "node", send: "by_a_person_each_time", ended: null });
    expect(first.node.showing_began).toBe("after the node was first assessed");
    expect(first.policy!.text).toContain("## Categories");
    expect(first.record.made).toMatchObject({ assessed_by_model: "a-model", role_additions: [], paid_for: { by: "not recorded", stake: "not recorded" }, run_log: null });
    expect(first.record.made!.prompt_set).toMatch(/^[0-9a-f]{64}$/);
    // Who acted, by the permissions they held and with no name.
    expect(first.record.acts.map((a) => a.by)).toContain("person 1");
    expect(first.record.acts.find((a) => a.what === "asked for the showing")).toMatchObject({ by: "person 1", holding: ["direct"] });
    expect(first.record.acts.some((a) => a.what === "held" && a.reason === "confidential to the party" && a.for_party === id.orgName)).toBe(true);
    expect(first.record.versions).toHaveLength(1);

    const check = await verifyPublishedPage(first, { publisherKey: publishKey.publicKey });
    expect(check.failed).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.held_parts).toBe(2);
    expect(check.cannot_show.join(" ")).toContain("That the assessment in the log was the only one made.");
    expect(check.cannot_show.join(" ")).toContain("the organization's own machines");

    const shape = shapeOfPublishedPage(first)!;
    expect(shape.verdict).toMatchObject({ status: "supported", confidence: 0.8, credence: 0.85 });
    expect(shape.reasoning.map((b) => b.text)).toEqual(["The meter data shows [redacted: commercial figures] against a target of 4500.", "The meters were calibrated in March."]);
    expect(shape.arguments.map((a) => [a.stance, a.name, a.held?.what ?? null])).toEqual([
      ["for", "From the meters", null],
      ["against", null, "An argument against"],
    ]);
    expect(shape.arguments[1]!.held).toMatchObject({ by: [id.orgName], reasons: ["confidential to the party"] });
    expect(shape.removals).toEqual({ "commercial figures": 1 });
    // That an outside party supplied the source and has a recorded interest is always shown; its name and the words are held.
    expect(shape.sources[0]).toMatchObject({ supplied_by: "an_outside_party", interest_recorded: true });
    expect(shape.sources[0]!.supplier!.held).toMatchObject({ what: "A source's supplier and recorded interest, by name" });
  });

  it("carries nothing but what the gate released: each attempt to make other content cross fails", async () => {
    // Rows that look like the destination side's, written at another label under the same showing and page.
    await system(async () => {
      await rawQuery(
        `INSERT INTO shown_parts (id, page_id, position, kind, descriptor, commitment, text, marks, salt, released_at, sensitivity_label)
         VALUES (gen_random_uuid(), $1, 99, 'reasoning', 'reasoning', repeat('0', 64), $2, '[]'::jsonb, 'salt', now(), $3)`,
        [pageId, OTHER_LABEL_TEXT, B]
      );
      await rawQuery(`INSERT INTO showing_acts (showing_id, page_id, act, reason, sensitivity_label) VALUES ($1, $2, 'held', $3, $4)`, [id.showing, pageId, OTHER_LABEL_TEXT, B]);
    });
    // The other label's rows change nothing the builder reads, so it builds nothing new.
    expect(await buildOutboundPackages({ showingId: id.showing })).toBe(0);
    const all = JSON.stringify((await packagesOf(id.showing!, id.p!)).map((p) => p.package));
    for (const [what, text] of [
      ["a removed passage", SECRET],
      ["a removal's note", NOTE],
      ["a held part's text", HELD_TEXT],
      ["another label's row", OTHER_LABEL_TEXT],
      ["a label's name", A],
      ["a label's name", B],
      ["a label's name", C],
      ["a supplier's interest in words nobody released", "Acme is paid by output."],
      ["the name of a person who acted", "review3 member"],
    ] as const) {
      expect(all.includes(text), `${what} is in a package`).toBe(false);
    }
    // The work that builds a package is held to `public` by the database: asked directly for the page's side, it gets nothing.
    const asBuilder = <T>(fn: () => Promise<T>) => runAtLabel("public", "what the builder may read", fn);
    expect(await asBuilder(() => rawQuery(`SELECT original FROM showing_parts WHERE page_id = $1`, [pageId]))).toEqual([]);
    expect(await asBuilder(() => rawQuery(`SELECT note FROM showing_removals`))).toEqual([]);
    expect(await asBuilder(() => rawQuery(`SELECT text FROM shown_parts WHERE page_id = $1 AND position = 99`, [pageId]))).toEqual([]);
    expect(await asBuilder(() => rawQuery(`SELECT summary FROM assessments WHERE claim_id = $1 AND sensitivity_label = $2`, [id.p, A]))).toEqual([]);
    // And it cannot write anywhere but `public`.
    await expect(asBuilder(() => rawQuery(`INSERT INTO outbound_packages (showing_id, node_id, public_node_id, sequence, content_hash, hash, package, sensitivity_label) VALUES ($1, $2, $2, 999, 'x', 'x', '{}'::jsonb, $3)`, [id.showing, id.p, A]))).rejects.toThrow();
    // A refusal names no row and no label.
    const refusal = await sendOutbound({ showingId: randomUUID(), sender: { actor: actor.director! } }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(OutboundError);
    expect((refusal as Error).message).toBe("No showing outside has that id.");
    await system(async () => {
      await rawQuery(`DELETE FROM shown_parts WHERE page_id = $1 AND position = 99`, [pageId]);
      await rawQuery(`DELETE FROM showing_acts WHERE showing_id = $1 AND sensitivity_label = $2`, [id.showing, B]);
    });
  });

  it("is refused by the public graph while its key is registered to no account, and nothing of it is kept", async () => {
    const sent = await sendAs(id.showing!);
    expect(sent.sent).toHaveLength(1);
    expect(sent.sent[0]).toMatchObject({ sequence: 1, result: "refused" });
    expect(sent.sent[0]!.detail).toContain("which no account has registered on this graph");
    expect(await pubRows(`SELECT 1 FROM published_pages WHERE node_id = $1`, [id.p])).toEqual([]);
    expect(await pubRows(`SELECT 1 FROM sources WHERE source_type = 'published_page'`)).toEqual([]);
    // The send is on the deployment's record, with who sent it.
    const overview = (await everyone(() => outboundOverview({ showingId: id.showing }))) as { nodes: any[] };
    expect(overview.nodes[0].packages[0].sends[0]).toMatchObject({ how: "sent to the public graph", result: "refused", by: "review3 member", holding: ["direct"] });
  });

  it("registers its key to the organization's account, by a statement only the key's holder can sign", async () => {
    const forged = { ...signedRegistration("someone-else:1") };
    expect((await pubApi("POST", "/publishers", { public_key: forged.public_key, hosting: forged.hosting, signature: forged.signature })).status).toBe(400);
    const mine = signedRegistration(orgAccount);
    const registered = await pubApi("POST", "/publishers", { public_key: mine.public_key, hosting: mine.hosting, signature: mine.signature, declared_interest: "Halden Works runs the plant the claims are about." });
    expect(registered.status).toBe(201);
    expect(registered.json.key_id).toBe(publishKey.keyId);
    const record = await pubApi("GET", `/publishers/${id.orgAccount}`, undefined, null);
    expect(record.json.registrations[0]).toMatchObject({ key_id: publishKey.keyId, runs_on: "the organization's own machines", attested_by: "nothing outside the publisher's control attests to the run", retired_at: null });
  });

  it("is admitted once the package verifies: kept as signed, a source, and an ordinary contribution on the node; nothing is attached and nothing runs", async () => {
    const sent = await sendAs(id.showing!);
    expect(sent.sent.map((s) => [s.sequence, s.result])).toEqual([[1, "admitted"], [2, "admitted"]]);
    const [publication] = await pubRows<{ id: string; contribution_id: string; latest_sequence: number }>(`SELECT id, contribution_id, latest_sequence FROM published_pages WHERE node_id = $1`, [id.p]);
    publishedPageId = publication!.id;
    id.publishedP = publishedPageId;
    expect(publication!.latest_sequence).toBe(2);
    const [contribution] = await pubRows<{ contribution_type: string; review_status: string; content: string; claim_id: string }>(`SELECT contribution_type, review_status, content, claim_id FROM contributions WHERE id = $1`, [publication!.contribution_id]);
    expect(contribution).toMatchObject({ contribution_type: "add_instance", review_status: "pending", claim_id: id.p });
    expect(contribution!.content).toContain("A published page, submitted by its publisher.");
    // One source, for the package that carries a page. The first package carried none.
    const sources = await pubRows<{ url: string; source_type: string; raw_content: string }>(`SELECT url, source_type, raw_content FROM sources WHERE source_type = 'published_page'`);
    expect(sources.map((s) => s.url)).toEqual([`minerval:published-page/${publishedPageId}/2`]);
    expect(sources[0]!.raw_content).toContain("[redacted: commercial figures]");
    expect(sources[0]!.raw_content).toContain(`[An argument against, held by ${id.orgName}. Reason given: confidential to the party]`);
    expect(sources[0]!.raw_content).toContain("What that check cannot show:");
    // Nothing attaches itself: no instance on the node, no message to its Steward, no work opened.
    expect(await pubRows(`SELECT 1 FROM claim_instances WHERE claim_id = $1`, [id.p])).toEqual([]);
    expect(await pubRows(`SELECT 1 FROM node_messages WHERE node_id = $1`, [id.p])).toEqual([]);
    // The first package of a publication is charged as a source submission; the second is not.
    const charges = await pubRows<{ n: number }>(`SELECT count(*)::int AS n FROM owl_ledger WHERE user_id = $1 AND amount_micro_usd < 0`, [id.orgAccount]);
    expect(charges[0]!.n).toBe(1);
    // The same package again changes nothing.
    const again = await pubApi("POST", "/published-pages", { package: first });
    expect(again.status).toBe(200);
    expect(again.json.status).toBe("already_received");
    const listed = await pubApi("GET", `/published-pages?node_id=${id.p}`, undefined, null);
    expect(listed.json.published_pages[0]).toMatchObject({ state: "released_in_part", parts_held: 2, held_kinds: "an argument against, a source's supplier and recorded interest, by name" });
    expect(listed.json.published_pages[0].on_the_node).toMatchObject({ review: "waiting for review", on_the_nodes_page: false, weighed_in_the_nodes_assessment: null });
  });

  it("is attached to the node when the Contribution Reviewer admits the submission, and a reassessment is opened that nothing has funded", async () => {
    const [publication] = await pubRows<{ contribution_id: string }>(`SELECT contribution_id FROM published_pages WHERE id = $1`, [publishedPageId]);
    const decided = await pubAgent("reviewer", "record_review_decision", {
      contribution_id: publication!.contribution_id,
      decision: "accept",
      reasoning: "The package is the publisher's own, signed with its registered key, and is a page of this node.",
      confidence: 0.9,
      policy_citations: [],
    });
    expect(decided.success).toBe(true);
    expect(decided.message).toContain("do not call notify_claim_steward");
    const instances = await pubRows<{ created_by: string; stance: string; verbatim_text: string; url: string }>(
      `SELECT i.created_by, i.stance, i.verbatim_text, s.url FROM claim_instances i JOIN sources s ON s.id = i.source_id WHERE i.claim_id = $1 AND i.detached_at IS NULL`,
      [id.p]
    );
    expect(instances).toEqual([{ created_by: "published_page", stance: "mentions", verbatim_text: "Status: supported. Confidence: 0.8. Credence: 0.85.", url: `minerval:published-page/${publishedPageId}/2` }]);
    // The publisher's interest in the node is on the source, as for any source.
    const interests = await pubRows<{ party: string; stake: string }>(`SELECT si.party, si.stake FROM source_interests si JOIN sources s ON s.id = si.source_id WHERE s.url = $1`, [instances[0]!.url]);
    expect(interests[0]!.stake).toContain("it chose to show this node's page");
    expect(interests[0]!.stake).toContain("Halden Works runs the plant the claims are about.");
    // The Steward is told, and the reassessment waits on the ledger for someone to fund it.
    const messages = await pubRows<{ trigger: string; sender_kind: string; body: string }>(`SELECT trigger, sender_kind, body FROM node_messages WHERE node_id = $1`, [id.p]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ trigger: "contribution_accepted", sender_kind: "contribution_reviewer" });
    expect(messages[0]!.body).toContain("It does not replace this node's assessment, which is yours to reach.");
    const [node] = await pubRows<{ steward_state: string }>(`SELECT steward_state FROM claims WHERE id = $1`, [id.p]);
    expect(node!.steward_state).toBe("pending");
    const actions = await pubRows<{ kind: string; status: string }>(`SELECT kind, status FROM actions WHERE claim_id = $1 AND kind IN ('assess', 'reassess')`, [id.p]);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.status === "open")).toBe(true);
    expect(await pubRows(`SELECT 1 FROM action_allocations WHERE claim_id = $1`, [id.p])).toEqual([]);
    // Nothing ran: the public assessment is the one that was there, and no agent's run is recorded on the node.
    const assessments = await pubRows<{ summary: string }>(`SELECT summary FROM assessments WHERE claim_id = $1`, [id.p]);
    expect(assessments).toEqual([{ summary: "Public evidence leaves it open." }]);
    // A handoff by the Reviewer would be a second message: it is told there is nothing to hand over.
    const handoff = await pubAgent("reviewer", "notify_claim_steward", { contribution_id: publication!.contribution_id });
    expect(handoff.success).toBe(false);
  });

  it("is read through the public API in the shape of a node's page, with marks and holds in place, and its package verifies there", async () => {
    const read = await pubApi("GET", `/published-pages/${publishedPageId}`, undefined, null);
    expect(read.status).toBe(200);
    const page = read.json;
    expect(page.state).toBe("released_in_part");
    expect(page.on_the_node).toMatchObject({ review: "admitted", on_the_nodes_page: true, attached_package: 2, weighed_in_the_nodes_assessment: null });
    expect(page.publisher).toMatchObject({ runs_on: "the organization's own machines", declared_interest: "Halden Works runs the plant the claims are about." });
    expect(page.page.verdict).toMatchObject({ status: "supported", confidence: 0.8 });
    expect(page.page.summary.map((b: any) => b.text)).toEqual(["The target was met, on meter data.", "One caveat remains."]);
    expect(page.page.reasoning[0]).toMatchObject({ text: "The meter data shows [redacted: commercial figures] against a target of 4500.", marks: [{ at: 21, category: "commercial figures" }] });
    expect(page.page.arguments[1].held).toMatchObject({ what: "An argument against", by: [id.orgName], reasons: ["confidential to the party"] });
    expect(page.page.sources[0]).toMatchObject({ kind: "unknown", supplied_by: "an_outside_party", interest_recorded: true, fingerprint: "aaaa1111" });
    expect(page.audit).toBe("The reasoning shown supports the verdict in part.");
    expect(page.record.prompt_set_is_this_graphs).toBe(true);
    expect(page.record.sent).toBe("by a person each time");
    expect(page.check.ok).toBe(true);
    expect(page.versions).toHaveLength(1);
    expect(page.packages.map((p: any) => [p.package, p.state])).toEqual([[2, "released_in_part"], [1, "held"]]);
    // The package as signed, with the publisher's key as the public graph holds it: anyone can redo the check.
    const signed = await pubApi("GET", `/published-pages/${publishedPageId}/package`, undefined, null);
    expect(signed.json.publisher_key).toBe(publishKey.publicKey);
    const check = await verifyPublishedPage(signed.json.package, { publisherKey: signed.json.publisher_key });
    expect(check.ok).toBe(true);
    expect(check.confirmed.join(" ")).toContain("is the one given to this check as the publisher's");
    // No route of the public graph serves the held part's text or the removed passage.
    const everything = JSON.stringify([read.json, signed.json, (await pubApi("GET", `/published-pages?node_id=${id.p}`, undefined, null)).json]);
    expect(everything.includes(HELD_TEXT)).toBe(false);
    expect(everything.includes(SECRET)).toBe(false);
  });

  it("fails the check on each tampering, and the public graph keeps none of them", async () => {
    const resign = async (pkg: PublishedPagePackage, pem = publishKey.privateKeyPem, publicKey = publishKey.publicKey): Promise<PublishedPagePackage> => {
      const body = { ...pkg, publisher: { key_id: keyIdOf(publicKey), public_key: publicKey } };
      const hash = await packageHash(body as unknown as Record<string, unknown>);
      return { ...body, hash, signature: cryptoSign(null, Buffer.from(hash, "hex"), parseSigningKey(pem)).toString("base64") };
    };
    const copy = () => JSON.parse(JSON.stringify(first)) as PublishedPagePackage;
    const tampered: Array<[string, PublishedPagePackage, RegExp, boolean]> = [];
    // Changed after signing: the hash no longer matches.
    let p = copy();
    p.page!.parts[0]!.text = "The target was missed.";
    tampered.push(["a released part's text changed", p, /do not match its hash/, false]);
    p = copy();
    p.record.made!.prompt_set = "0".repeat(64);
    tampered.push(["a stamped field changed", p, /do not match its hash/, false]);
    p = copy();
    p.deployment.hosting = "third_party";
    tampered.push(["where the deployment runs changed", p, /do not match its hash/, false]);
    // Changed and signed again by the publisher's own key: the page no longer rebuilds its fingerprint.
    p = copy();
    p.page!.parts[0]!.text = "The target was missed.";
    tampered.push(["a part's text changed, signed again", await resign(p), /does not match its hash/, true]);
    p = copy();
    [p.page!.parts[0], p.page!.parts[1]] = [p.page!.parts[1]!, p.page!.parts[0]!];
    tampered.push(["two parts swapped", await resign(p), /out of order/, true]);
    p = copy();
    p.page!.parts.splice(2, 1);
    tampered.push(["a part dropped", await resign(p), /out of order|rebuild/, true]);
    p = copy();
    const heldPart = p.page!.parts.find((x) => x.held)!;
    heldPart.descriptor = "argument:for";
    tampered.push(["a held part said to be of another kind", await resign(p), /do not rebuild the page's fingerprint/, true]);
    p = copy();
    const marked = p.page!.parts.find((x) => (x.marks ?? []).length > 0)!;
    marked.text = marked.text!.replace("[redacted: commercial figures]", "4,000 units");
    marked.marks = [];
    tampered.push(["a removal filled in", await resign(p), /does not match its hash/, true]);
    p = copy();
    p.page!.always_shown!.text = p.page!.always_shown!.text.replace('"supported"', '"verified"');
    tampered.push(["the verdict changed", await resign(p), /verdict and what is shown with it do not match/, true]);
    p = copy();
    p.state = "released_whole";
    tampered.push(["the state misstated", await resign(p), /node's state/, true]);
    p = copy();
    p.policy!.text = p.policy!.text.replace("commercial figures", "anything");
    tampered.push(["the policy reworded", await resign(p), /policy's text does not match its hash/, true]);
    for (const [what, pkg, why] of tampered) {
      const check = await verifyPublishedPage(pkg, { publisherKey: publishKey.publicKey });
      expect(check.ok, what).toBe(false);
      expect(check.failed.join(" "), what).toMatch(why);
      const refused = await pubApi("POST", "/published-pages", { package: pkg });
      expect(refused.status, what).toBe(422);
      expect(refused.json.error.code).toBe("DOES_NOT_VERIFY");
    }
    // Signed whole by a key nobody registered: it is consistent with itself, and is refused for whose key it is.
    const stranger = generateSigningKey();
    const theirs = await resign(copy(), stranger.privateKeyPem, stranger.publicKey);
    expect((await verifyPublishedPage(theirs)).ok).toBe(true);
    expect((await verifyPublishedPage(theirs, { publisherKey: publishKey.publicKey })).ok).toBe(false);
    const unregistered = await pubApi("POST", "/published-pages", { package: theirs });
    expect(unregistered.status).toBe(403);
    expect(unregistered.json.error.code).toBe("UNREGISTERED_KEY");
    // Submitted by another account than the one that registered the key.
    const [other] = await pubRows<{ id: string }>(`INSERT INTO contributors (display_name, external_id) VALUES ('Someone else', $1) RETURNING id`, [`other:${tag}`]);
    const otherKey = `epk_${randomUUID().replace(/-/g, "")}`;
    await pubRows(`INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'k', $2, $3)`, [other!.id, otherKey.slice(0, 12), createHash("sha256").update(otherKey, "utf8").digest("hex")]);
    const notTheirs = await pubApi("POST", "/published-pages", { package: first }, otherKey);
    expect(notTheirs.status).toBe(403);
    expect(notTheirs.json.error.code).toBe("NOT_YOUR_KEY");
    // Out of order.
    const skipped = await resign({ ...copy(), sequence: 7 });
    expect((await pubApi("POST", "/published-pages", { package: skipped })).json.error.code).toBe("OUT_OF_ORDER");
    const kept = await pubRows<{ n: number }>(`SELECT count(*)::int AS n FROM published_page_packages`);
    expect(kept[0]!.n).toBe(2);
  });

  it("publishes a later version as held, with no text, and the page last shown stays", async () => {
    await assessAtA(id.p!, { summary: "The target was met, and the night logs agree.", reasoning: "The night logs were read in full and match the meters." }, "verified");
    expect(await followShowings()).toBeGreaterThan(0);
    const sent = await sendAs(id.showing!);
    expect(sent.built).toBe(1);
    expect(sent.sent.map((s) => [s.sequence, s.result])).toEqual([[3, "admitted"]]);
    const [third] = (await packagesOf(id.showing!, id.p!)).slice(-1);
    expect(third!.package.state).toBe("held");
    expect(third!.package.page!.id).toBe(pageId);
    expect(JSON.stringify(third!.package).includes("night logs agree")).toBe(false);
    const read = (await pubApi("GET", `/published-pages/${publishedPageId}`, undefined, null)).json;
    expect(read.state).toBe("held");
    expect(read.held.because).toBe("waiting for funds: none of the budgets that pay for its redaction could pay for it");
    expect(read.shown_state).toBe("released_in_part");
    expect(read.page.verdict.status).toBe("supported");
    expect(read.versions.map((v: any) => v.state)).toEqual(["held", "released_in_part"]);
    // The node's Steward is told that a version exists and is not shown.
    const messages = await pubRows<{ trigger: string; body: string }>(`SELECT trigger, body FROM node_messages WHERE node_id = $1 ORDER BY created_at`, [id.p]);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.trigger).toBe("page_shown");
    expect(messages[1]!.body).toContain("A later version exists and is not shown.");

    // The earlier package is still served.
    const earlier = (await pubApi("GET", `/published-pages/${publishedPageId}?package=2`, undefined, null)).json;
    expect(earlier.state).toBe("released_in_part");
  });

  it("publishes a part when its hold is lifted, and the later version when it is released", async () => {
    const queue = (await gateQueue(actor.org!, { limit: 200 })) as { items: any[] };
    const held = queue.items.find((i) => i.page_id === pageId && i.kind === "an argument against");
    await decideAtGate({ actor: actor.org!, partyId: id.org!, items: [{ page_id: pageId, part: held.part }], decision: "lift" });
    await decideAtGate({ actor: actor.org!, partyId: id.org!, items: [{ page_id: pageId, part: held.part }], decision: "release" });
    let sent = await sendAs(id.showing!);
    expect(sent.sent.map((s) => [s.sequence, s.result])).toEqual([[4, "admitted"]]);
    let read = (await pubApi("GET", `/published-pages/${publishedPageId}`, undefined, null)).json;
    // The argument is out; Acme's name is still held.
    expect(read.shown_state).toBe("released_in_part");
    expect(read.parts_held).toBe(1);
    expect(read.page.arguments[1]).toMatchObject({ stance: "against", name: "From the missing logs", content: HELD_TEXT });
    // The hold stays on the record after it is lifted.
    expect(read.record.acts.map((a: any) => a.what)).toEqual(expect.arrayContaining(["held", "lifted a hold", "released"]));
    // The page on the node is now the later package; the earlier source is kept, detached.
    const attached = await pubRows<{ url: string; detached: boolean }>(
      `SELECT s.url, i.detached_at IS NOT NULL AS detached FROM claim_instances i JOIN sources s ON s.id = i.source_id WHERE i.claim_id = $1 ORDER BY s.url`,
      [id.p]
    );
    expect(attached).toEqual([
      { url: `minerval:published-page/${publishedPageId}/2`, detached: true },
      { url: `minerval:published-page/${publishedPageId}/3`, detached: true },
      { url: `minerval:published-page/${publishedPageId}/4`, detached: false },
    ]);

    const later = await latestPageOf(id.showing!, id.p!);
    expect(later).not.toBe(pageId);
    await redactAndCheck(later);
    await releaseAllBut(later);
    sent = await sendAs(id.showing!);
    expect(sent.sent.map((s) => [s.sequence, s.result])).toEqual([[5, "admitted"]]);
    read = (await pubApi("GET", `/published-pages/${publishedPageId}`, undefined, null)).json;
    expect(read.state).toBe("released_whole");
    expect(read.page.verdict.status).toBe("verified");
    expect(read.versions.map((v: any) => v.state)).toEqual(["released_whole", "released_in_part"]);
    expect(read.packages).toHaveLength(5);
    // One waiting message for the publication at a time: a later package's takes the place of an earlier one nobody has read.
    expect(await pubRows(`SELECT 1 FROM node_messages WHERE node_id = $1 AND trigger = 'page_shown'`, [id.p])).toHaveLength(1);
  });

  it("can be carried as a file where the network does not reach, and the handing over is recorded", async () => {
    const [last] = (await packagesOf(id.showing!, id.p!)).slice(-1);
    const file = await packageFile({ packageId: last!.id, actor: actor.director! });
    expect(file.file_name).toBe(`published-page-${id.p}-000005.json`);
    expect((await verifyPublishedPage(JSON.stringify(file.package))).ok).toBe(true);
    const overview = (await everyone(() => outboundOverview({ showingId: id.showing }))) as { nodes: any[] };
    expect(overview.nodes[0].packages[4].sends.map((s: any) => s.how)).toEqual(["sent to the public graph", "handed to a person as a file"]);
  });

  it("stays off the node's page once its Steward has taken it off, whatever arrives later, and publishes its ending", async () => {
    const [instance] = await pubRows<{ id: string }>(`SELECT id FROM claim_instances WHERE claim_id = $1 AND detached_at IS NULL`, [id.p]);
    const detached = await pubAgent("steward", "detach_claim_instance", { claim_id: id.p, instance_id: instance!.id, reason: "The page is of a different year than this claim is about." });
    expect(detached.success).toBe(true);
    await endShowing({ showingId: id.showing!, reason: "no_longer_needed", actor: actor.director! });
    const sent = await sendAs(id.showing!);
    expect(sent.sent.map((s) => [s.sequence, s.result])).toEqual([[6, "admitted"]]);
    const read = (await pubApi("GET", `/published-pages/${publishedPageId}`, undefined, null)).json;
    expect(read.ended.because).toBe("it is no longer needed");
    expect(typeof read.ended.at).toBe("string");
    expect(read.on_the_node.on_the_nodes_page).toBe(false);
    expect(read.on_the_node.taken_off_by_the_nodes_steward).toBe("The page is of a different year than this claim is about.");
    expect(await pubRows(`SELECT 1 FROM claim_instances WHERE claim_id = $1 AND detached_at IS NULL`, [id.p])).toEqual([]);
    // What was sent stays: every package is kept, and the page is still read from its own address.
    expect(read.packages).toHaveLength(6);
    expect(read.page.verdict.status).toBe("verified");
  });
});

describe("a node that exists only in the deployment", () => {
  it("has nowhere to appear until it is proposed, in words a person who directs writes and the parties release, and its page follows once the public graph holds it", async () => {
    id.n = await seedNode(A, "The plant's third line ran at full speed in March");
    await personDecidesAt(A, null);
    const asked = await askShowing({ nodeId: id.n!, pageLabel: A, toLabel: null, form: "standing", scope: "node", actor: actor.director! });
    id.privateShowing = asked.showing_id;
    expect(await buildOutboundPackages({ showingId: id.privateShowing })).toBe(0);
    let overview = (await everyone(() => outboundOverview({ showingId: id.privateShowing }))) as { nodes: any[] };
    expect(overview.nodes[0].public_node_id).toBeNull();
    expect(overview.nodes[0].waiting).toContain("Nothing has been proposed yet, and nothing of this node is outside.");
    // A member who does not read `a` is not shown the node's wording.
    expect(overview.nodes[0].node).toBeNull();

    // The director writes words of their own. They rest on the organization, whose holder of release releases them.
    const directorAtA = { ...actor.director! };
    const written = await asPerson([A, "public"], () => writeProposal({ showingId: id.privateShowing!, nodeId: id.n!, text: `A production line at the plant ran at its rated speed for a month (${tag})`, actor: directorAtA }));
    expect(written.state).toBe("waiting_for_release");
    await expect(sendAs(id.privateShowing!)).resolves.toMatchObject({ sent: [], built: 0 });
    expect(await pubRows(`SELECT 1 FROM contributions WHERE contribution_type = 'propose_claim'`)).toEqual([]);
    // The words are an item at the gate to outside, of the kind proposal: redacted, checked, and, since this gate is set for a person,
    // approved by a holder of release for the party they rest on. Nobody else can.
    const [item] = await system(() =>
      rawQuery<{ id: string }>(`SELECT p.id FROM showings s JOIN showing_pages p ON p.showing_id = s.id WHERE s.kind = 'proposal' AND s.subject_ref = $1`, [written.proposal_id])
    );
    await redactAndCheck(item!.id);
    await expect(decideAtGate({ actor: actor.acme!, partyId: id.org!, items: [{ page_id: item!.id }], decision: "approve" })).rejects.toThrow(/do not hold the permission/);
    expect((await decideAtGate({ actor: actor.org!, partyId: id.org!, items: [{ page_id: item!.id }], decision: "approve" })).decided).toBeGreaterThan(0);
    const [ready] = await system(() => rawQuery<{ state: string }>(`SELECT state FROM outbound_proposals WHERE id = $1`, [written.proposal_id]));
    expect(ready!.state).toBe("ready");

    // Sent: an ordinary proposal on the public graph, under the organization's account.
    await sendAs(id.privateShowing!);
    const [proposal] = await pubRows<{ id: string; proposed_canonical_form: string; contributor_id: string; review_status: string }>(
      `SELECT id, proposed_canonical_form, contributor_id, review_status FROM contributions WHERE contribution_type = 'propose_claim'`
    );
    expect(proposal).toMatchObject({ contributor_id: id.orgAccount, review_status: "pending" });
    expect(proposal!.proposed_canonical_form).toContain("ran at its rated speed for a month");
    overview = (await everyone(() => outboundOverview({ showingId: id.privateShowing }))) as { nodes: any[] };
    expect(overview.nodes[0].waiting).toContain("the review of the proposal there has not finished");
    expect(overview.nodes[0].proposal.state).toBe("sent");
    expect(await buildOutboundPackages({ showingId: id.privateShowing })).toBe(0);

    // The public graph's Reviewer admits it and its Matcher mints the node: stood in for here by their outcome.
    const publicNode = await publicClaim("nPublic", "A production line at the plant ran at its rated speed for a month", 312);
    await pubRows(`UPDATE contributions SET review_status = 'accepted', claim_id = $2 WHERE id = $1`, [proposal!.id, publicNode]);

    // The next send finds the node, and the node's state goes out: not yet assessed, since the showing began first.
    let sent = await sendAs(id.privateShowing!);
    expect(sent.proposals).toEqual([{ node_id: id.n, state: "on_the_public_graph" }]);
    expect(sent.sent.map((s) => [s.sequence, s.result])).toEqual([[1, "admitted"]]);
    let [pkg] = (await packagesOf(id.privateShowing!, id.n!)).slice(-1);
    expect(pkg!.package.state).toBe("not_yet_assessed");
    expect(pkg!.package.page).toBeNull();
    expect(pkg!.package.node.public_id).toBe(publicNode);
    const [publication] = await pubRows<{ id: string; contribution_id: string }>(`SELECT id, contribution_id FROM published_pages WHERE node_id = $1`, [publicNode]);
    expect((await pubRows(`SELECT 1 FROM sources WHERE url LIKE $1`, [`minerval:published-page/${publication!.id}/%`]))).toEqual([]);
    // Admitted with nothing to attach: the publication is on the node's record, and its Steward is told.
    const decided = await pubAgent("reviewer", "record_review_decision", { contribution_id: publication!.contribution_id, decision: "accept", reasoning: "A standing showing by the publisher, begun before any verdict.", confidence: 0.9, policy_citations: [] });
    expect(decided.message).toContain("no page has been released yet");
    expect(await pubRows(`SELECT 1 FROM claim_instances WHERE claim_id = $1`, [publicNode])).toEqual([]);
    let listed = (await pubApi("GET", `/published-pages?node_id=${publicNode}`, undefined, null)).json.published_pages[0];
    expect(listed).toMatchObject({ state: "not_yet_assessed", showing_began: "before the node was first assessed" });

    // Then it is assessed at `a`, redacted, checked and released, and the page follows.
    await seedPrivateWork(id.n!);
    await followShowings();
    const page = await latestPageOf(id.privateShowing!, id.n!);
    await redactAndCheck(page);
    await releaseAllBut(page);
    sent = await sendAs(id.privateShowing!);
    expect(sent.sent.every((s) => s.result === "admitted")).toBe(true);
    [pkg] = (await packagesOf(id.privateShowing!, id.n!)).slice(-1);
    expect(pkg!.package.state).toBe("released_whole");
    expect(pkg!.package.node.showing_began).toBe("before the node was first assessed");
    // The node's own wording is a part of its page, and the deployment's id for the node is nowhere in what left.
    const shape = shapeOfPublishedPage(pkg!.package)!;
    expect(shape.wording!.text).toContain("third line ran at full speed in March");
    const left = JSON.stringify((await packagesOf(id.privateShowing!, id.n!)).map((p) => p.package));
    expect(left.includes(id.n!)).toBe(false);
    // Already admitted, so it is attached as it arrives and the Steward is told.
    const instances = await pubRows<{ created_by: string }>(`SELECT created_by FROM claim_instances WHERE claim_id = $1 AND detached_at IS NULL`, [publicNode]);
    expect(instances).toEqual([{ created_by: "published_page" }]);
    const messages = await pubRows<{ body: string }>(`SELECT body FROM node_messages WHERE node_id = $1 ORDER BY created_at`, [publicNode]);
    expect(messages[messages.length - 1]!.body).toContain("The page gives the node's wording as it was assessed there.");
    listed = (await pubApi("GET", `/published-pages?node_id=${publicNode}`, undefined, null)).json.published_pages[0];
    expect(listed.on_the_node.on_the_nodes_page).toBe(true);
  });
});

describe("a gate to outside set to send what is released", () => {
  it("goes out with nobody sending it, recorded as the gate's setting, and nothing goes that way while the setting is off", async () => {
    await seedPrivateWork(id.q!);
    await expect(sendOutbound({ showingId: id.showing!, sender: { standing: true } })).rejects.toThrow(/set for a person to send each package/);
    await sendAsReleasedAt(id.gate!, true);
    // The gate to outside is the same gate, with the same settings. Set to the Redactor's decision, a page is
    // redacted, checked, released, packaged and sent with no person's act, and its package verifies.
    await personDecidesAt(A, null, "redactor");
    const asked = await askShowing({ nodeId: id.q!, pageLabel: A, toLabel: null, form: "standing", scope: "node", actor: actor.director! });
    id.standingChoice = asked.showing_id;
    const page = await latestPageOf(id.standingChoice!, id.q!);
    await redactAndCheck(page);
    expect(await system(() => rawQuery(`SELECT 1 FROM showing_acts WHERE page_id = $1 AND by = 'person'`, [page]))).toEqual([]);
    // Sent when the gate let it through, not at the scheduler's next look (the first run with real models waited for that).
    const sentAtOnce = await system(() =>
      rawQuery<{ result: string }>(`SELECT s.result FROM outbound_sends s JOIN outbound_packages p ON p.id = s.package_id WHERE p.showing_id = $1`, [id.standingChoice])
    );
    expect(sentAtOnce.map((r) => r.result)).toEqual(["admitted"]);
    const followed = await followOutbound();
    // This showing's package, and those of the earlier showings across the same gate that were waiting for a person.
    expect(followed.sent).toBeGreaterThanOrEqual(1);
    const [pkg] = await packagesOf(id.standingChoice!, id.q!);
    expect(pkg!.package.showing.send).toBe("as_released");
    expect((await verifyPublishedPage(pkg!.package)).ok).toBe(true);
    // The package says who let each part through: the gate's setting, and no person.
    const acts = JSON.stringify(pkg!.package);
    expect(acts).toContain("the gate's setting");
    const overview = (await everyone(() => outboundOverview({ showingId: id.standingChoice }))) as { nodes: any[] };
    expect(overview.nodes[0].packages[0].sends[0]).toMatchObject({ result: "admitted", by: "the gate's setting to send what is released", holding: [] });
    const read = (await pubApi("GET", `/published-pages?node_id=${id.q}`, undefined, null)).json.published_pages[0];
    expect(read.state).toBe("released_whole");
    const one = (await pubApi("GET", `/published-pages/${read.published_page_id}`, undefined, null)).json;
    expect(one.record.sent).toBe("as each package was built, by the publisher's standing setting");
  });
});
