/**
 * The split of `public` into its three bottom layers (#1203,
 * src/services/label-split.ts), on a members-only deployment that had
 * labels of its own and rows of the public graph before it.
 *
 * The file has a database to itself (tests/db/urls.ts, OWN_DATABASES): a
 * split is made once and never undone, so it cannot run on the copy the
 * rest of a worker's files share. Before the split the deployment holds, at
 * `public`, a row of each of the three kinds the label stood for:
 *
 *  - the public graph's own (origin 'mirror', and what a batch changed on a
 *    mirrored node);
 *  - what was released outside (the outside boundary's policy and gate, a
 *    release received there with its act, an outward act, the face a label
 *    shows where it is released outside);
 *  - the organization's own that every member reads (a node, a source, a
 *    judgment of a mirrored node, an internal release to every member, a
 *    grant, a key).
 *
 * It also has `ls-sens`, which reads `public`, with a node and a judgment
 * of its own, and `ls-other`, which shows a face to the members and has no
 * gate to outside.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.hoisted(() => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `${url.pathname}_own_split`;
  process.env.DATABASE_URL = url.toString();
  process.env.READS = "members";
  process.env.LOG_LEVEL = "fatal";
  delete process.env.PROVIDER_LABELS;
  delete process.env.MEMBERS_LABEL;
  delete process.env.PUBLISHED_LABEL;
});

import { currentReadClearance, rawQuery, withTransaction } from "../../src/db/client.js";
import { setNoContextSessionForTests, withSystemClearance } from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { loadConfig } from "../../src/config.js";
import {
  PUBLIC_LABEL,
  baseLabel,
  isWorkableLabel,
  layersAreSplit,
  memberLabels,
  openLabels,
  publishedLabel,
} from "../../src/labels.js";
import { currentLabel, runAtLabel, runWithUsageContext } from "../../src/llm/usage-context.js";
import { PUBLIC_STANDING } from "../../src/permissions.js";
import { knownProviderNames } from "../../src/provider-labels.js";
import { chooseLabel, decideRequestLabel } from "../../src/server/plugins/request-label.js";
import { publicGraphJudges } from "../../src/services/mirrored-node-service.js";
import { gateOf } from "../../src/services/gate-settings-service.js";
import { groupAtLabel } from "../../src/services/ingest-focus-service.js";
import { defineLabel, addLabelRead } from "../../src/services/label-admin-service.js";
import { choosableLabels, everyLabel, keyAtLabel } from "../../src/services/label-service.js";
import { LabelSplitError, ensureLabelSplit, splitLabelNames } from "../../src/services/label-split.js";
import { logOutwardAct } from "../../src/services/outward-acts-service.js";
import { labelsReadableFrom, resolveStanding } from "../../src/services/permission-service.js";
import { destinationLabel, destinationProblem, ensureBoundaryPolicy } from "../../src/services/redaction-policy.js";
import { ReleaseError, askRelease } from "../../src/services/release-service.js";

const SENS = "ls-sens";
const OTHER = "ls-other";
const tag = randomUUID().slice(0, 8);
const id: Record<string, string> = {};

const system = <T>(fn: () => Promise<T>) => withSystemClearance("The split's test seeds and checks rows at every label.", fn);
const every = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => system(() => rawQuery<T>(sql, params));
const labelOf = async (table: string, rowId: string, key = "id") =>
  (await every<{ l: string }>(`SELECT sensitivity_label AS l FROM ${table} WHERE ${key} = $1`, [rowId]))[0]?.l;
const caught = (fn: () => Promise<unknown>): Promise<unknown> => fn().then(() => null, (e: unknown) => e);

async function one(sql: string, params: unknown[] = []): Promise<string> {
  const [row] = await every<{ id: string }>(sql, params);
  return row!.id;
}

beforeAll(async () => {
  expect(new URL(loadConfig().databaseUrl).pathname.endsWith("_own_split"), "the file runs on its own database").toBe(true);
  await system(async () => {
    await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'One team.'), ($2, 'Another team.')`, [SENS, OTHER]);
    await rawQuery(`INSERT INTO label_reads (label, reads) VALUES ($1, 'public')`, [SENS]);
  });
  await ensureEnforcement();

  // People, grants and a key.
  id.admin = await one(`INSERT INTO contributors (display_name, external_id) VALUES ('The first administrator', $1) RETURNING id`, [`oidc:split-admin-${tag}`]);
  id.member = await one(`INSERT INTO contributors (display_name, external_id) VALUES ('A member', $1) RETURNING id`, [`oidc:split-member-${tag}`]);
  await every(
    `INSERT INTO permission_grants (permission, account_id, label, granted_via) VALUES
       ('administer', $1, NULL, 'first_administrator'), ('read', $1, $3, 'first_administrator'),
       ('read', $2, 'public', 'operator'), ('read_sources', $2, 'public', 'operator')`,
    [id.admin, id.member, SENS]
  );
  id.key = await one(`INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'a key', 'epk_split', $2) RETURNING id`, [id.member, `hash-${randomUUID()}`]);

  // The public graph's own, written as the mirror's applier writes it.
  const asApplier = async (sql: string, params: unknown[]): Promise<string> =>
    system(() =>
      withTransaction(async (tx) => {
        await tx.query(`SELECT set_config('minerval.mirror_applier', 'on', true)`);
        return (await tx.query<{ id: string }>(sql, params))[0]!.id;
      })
    );
  id.mirrored = await asApplier(
    `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at, origin, sensitivity_label)
     VALUES ($1, 'claim', 'done', 'complete', now(), 'mirror', 'public') RETURNING id`,
    [`A mirrored node (${tag})`]
  );
  id.mirroredJudgment = await asApplier(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, model, is_current, origin, sensitivity_label)
     VALUES ($1, 'supported', 0.8, 'The public graph''s.', 'a-model', true, 'mirror', 'public') RETURNING id`,
    [id.mirrored]
  );
  id.mirroredChange = await one(
    `INSERT INTO node_changes (claim_id, sequence, cut_at, change, sensitivity_label) VALUES ($1, 7, now(), 'reworded', 'public') RETURNING id`,
    [id.mirrored]
  );

  // The organization's own that every member reads.
  id.own = await one(
    `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at, sensitivity_label)
     VALUES ($1, 'claim', 'done', 'complete', now(), 'public') RETURNING id`,
    [`The organization's own node (${tag})`]
  );
  id.ownChange = await one(`INSERT INTO node_changes (claim_id, change, sensitivity_label) VALUES ($1, 'reworded', 'public') RETURNING id`, [id.own]);
  id.ownSource = await one(`INSERT INTO sources (title, url, sensitivity_label) VALUES ('A source of the members''', $1, 'public') RETURNING id`, [`https://example.test/${tag}`]);
  id.ownJudgment = await one(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, model, is_current, sensitivity_label)
     VALUES ($1, 'supported', 0.7, 'The members'' own.', 'a-model', true, 'public') RETURNING id`,
    [id.own]
  );

  // What a label of the deployment's own holds.
  id.sens = await one(
    `INSERT INTO claims (text, kind, steward_state, decomposition_status, tagged_at, sensitivity_label)
     VALUES ($1, 'claim', 'done', 'complete', now(), $2) RETURNING id`,
    [`A node only one team reads (${tag})`, SENS]
  );
  id.sensOnMirrored = await one(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, model, is_current, sensitivity_label)
     VALUES ($1, 'doubtful', 0.6, 'With what the team holds.', 'a-model', true, $2) RETURNING id`,
    [id.mirrored, SENS]
  );
  id.sensOnOwn = await one(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, model, is_current, sensitivity_label)
     VALUES ($1, 'doubtful', 0.6, 'With what the team holds.', 'a-model', true, $2) RETURNING id`,
    [id.own, SENS]
  );
  id.besideMirrored = await one(
    `INSERT INTO judgment_inputs (judgment_kind, judgment_id, input_kind, input_judgment_id, input_label, sensitivity_label)
     VALUES ('assessment', $1, 'beside', $2, 'public', $3) RETURNING id`,
    [id.sensOnMirrored, id.mirroredJudgment, SENS]
  );
  id.besideOwn = await one(
    `INSERT INTO judgment_inputs (judgment_kind, judgment_id, input_kind, input_judgment_id, input_label, sensitivity_label)
     VALUES ('assessment', $1, 'beside', $2, 'public', $3) RETURNING id`,
    [id.sensOnOwn, id.ownJudgment, SENS]
  );

  // What was released: outside, and to every member.
  const outside = await ensureBoundaryPolicy({ from: SENS, to: null });
  const inside = await ensureBoundaryPolicy({ from: SENS, to: PUBLIC_LABEL });
  id.outsideBoundary = outside.boundary_id;
  id.insideBoundary = inside.boundary_id;
  await gateOf(outside.boundary_id);
  await gateOf(inside.boundary_id);
  id.outsideRelease = await one(
    `INSERT INTO releases (node_id, to_label, to_outside, boundary_id, form, scope, sensitivity_label)
     VALUES ($1, NULL, true, $2, 'standing', 'node', $3) RETURNING id`,
    [id.sens, id.outsideBoundary, SENS]
  );
  id.insideRelease = await one(
    `INSERT INTO releases (node_id, to_label, to_outside, boundary_id, form, scope, sensitivity_label)
     VALUES ($1, 'public', false, $2, 'standing', 'node', $3) RETURNING id`,
    [id.sens, id.insideBoundary, SENS]
  );
  for (const [release, boundary, toOutside] of [
    [id.outsideRelease, id.outsideBoundary, true],
    [id.insideRelease, id.insideBoundary, false],
  ] as const) {
    await every(
      `INSERT INTO received_releases (id, node_id, to_outside, boundary_id, form, scope, asked_at, sensitivity_label)
       VALUES ($1, $2, $3, $4, 'standing', 'node', now(), 'public')`,
      [release, id.sens, toOutside, boundary]
    );
    await every(`INSERT INTO release_acts (release_id, act, sensitivity_label) VALUES ($1, 'asked', 'public')`, [release]);
  }
  id.outwardAct = await logOutwardAct({ kind: "send_report", by: { gate: true }, sent: { what: "a report" }, result: "done" });
  id.faceOutside = await one(
    `INSERT INTO label_faces (for_label, name, can_be_asked, sensitivity_label) VALUES ($1, 'The team', 'Ask it about its ledger.', 'public') RETURNING id`,
    [SENS]
  );
  id.faceInside = await one(
    `INSERT INTO label_faces (for_label, name, can_be_asked, sensitivity_label) VALUES ($1, 'The other team', 'Ask it about its plans.', 'public') RETURNING id`,
    [OTHER]
  );
});

describe("before the split", () => {
  it("every name answers public, and nothing is at another bottom layer", async () => {
    await currentReadClearance();
    expect(layersAreSplit()).toBe(false);
    expect([baseLabel(), publishedLabel(), openLabels(), memberLabels()]).toEqual(["public", "public", ["public"], ["public"]]);
    expect(isWorkableLabel("public")).toBe(true);
    expect(destinationLabel({ from: SENS, to: null })).toBe("public");
    const [db] = await every<{ base: string; published: string; open: string[] }>(
      `SELECT minerval_base_label() AS base, minerval_published_label() AS published, minerval_open_labels() AS open`
    );
    expect(db).toEqual({ base: "public", published: "public", open: ["public"] });
  });
});

describe("a deployment that already defines one of the names", () => {
  it("is told which setting to use, and nothing is changed", async () => {
    const taken = (await caught(() => ensureLabelSplit({ ...loadConfig(), membersLabel: SENS }))) as LabelSplitError;
    expect(taken).toBeInstanceOf(LabelSplitError);
    expect(taken.message).toContain(`already defines a label named "${SENS}"`);
    expect(taken.message).toContain("Set MEMBERS_LABEL to another name");
    const same = (await caught(() => ensureLabelSplit({ ...loadConfig(), membersLabel: "both", publishedLabel: "both" }))) as LabelSplitError;
    expect(same).toBeInstanceOf(LabelSplitError);
    expect(await every(`SELECT name FROM labels WHERE layer IS NOT NULL OR name NOT IN ('public', $1, $2)`, [SENS, OTHER])).toEqual([]);
    expect(splitLabelNames({ membersLabel: "staff", publishedLabel: "" })).toEqual({ base: "staff", published: "published" });
  });

  it("is not split at all where it is not members-only", async () => {
    expect(await ensureLabelSplit({ ...loadConfig(), reads: "open" })).toMatchObject({ split: false, base: "public", published: "public" });
    expect(await every(`SELECT count(*)::int AS n FROM labels WHERE layer IS NOT NULL`)).toEqual([{ n: 0 }]);
  });
});

describe("the split", () => {
  let result: Awaited<ReturnType<typeof ensureLabelSplit>>;

  beforeAll(async () => {
    result = await ensureLabelSplit();
    // From here the suite's own out-of-context work is the owner's at the base label.
    setNoContextSessionForTests({ role: "owner", label: baseLabel() });
  });

  it("defines the two labels, marks the public graph's, and tells the process", async () => {
    expect(result.split).toBe(true);
    expect(splitLabelNames()).toEqual({ base: "members", published: "published" });
    expect([result.base, result.published]).toEqual(["members", "published"]);
    expect([baseLabel(), publishedLabel(), openLabels(), memberLabels()]).toEqual([
      "members",
      "published",
      ["public", "published"],
      ["public", "published", "members"],
    ]);
    const layers = await every<{ name: string; layer: string | null }>(`SELECT name, layer FROM labels ORDER BY name`);
    expect(layers).toEqual([
      { name: OTHER, layer: null },
      { name: SENS, layer: null },
      { name: "members", layer: "base" },
      { name: "public", layer: "public_graph" },
      { name: "published", layer: "published" },
    ]);
    const [db] = await every<{ base: string; published: string; open: string[] }>(
      `SELECT minerval_base_label() AS base, minerval_published_label() AS published, minerval_open_labels() AS open`
    );
    expect(db).toEqual({ base: "members", published: "published", open: ["public", "published"] });
  });

  it("leaves the public graph's rows at public", async () => {
    expect(await labelOf("claims", id.mirrored!)).toBe("public");
    expect(await labelOf("assessments", id.mirroredJudgment!)).toBe("public");
    expect(await labelOf("node_changes", id.mirroredChange!)).toBe("public");
  });

  it("moves the organization's own material to the base label, and leaves its other labels alone", async () => {
    expect(await labelOf("claims", id.own!)).toBe("members");
    expect(await labelOf("node_changes", id.ownChange!)).toBe("members");
    expect(await labelOf("sources", id.ownSource!)).toBe("members");
    expect(await labelOf("assessments", id.ownJudgment!)).toBe("members");
    expect(await labelOf("claims", id.sens!)).toBe(SENS);
    expect(await labelOf("assessments", id.sensOnMirrored!)).toBe(SENS);
    // No local row is left at the public graph's label in any labelled table.
    const tables = await every<{ name: string; mirrors: boolean }>(
      `SELECT c.relname::text AS name,
              EXISTS (SELECT 1 FROM pg_attribute o WHERE o.attrelid = c.oid AND o.attname = 'origin' AND NOT o.attisdropped)
                AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'c' AND pg_get_constraintdef(k.oid) LIKE '%''mirror''%') AS mirrors
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)`
    );
    expect(tables.length).toBeGreaterThan(140);
    for (const t of tables) {
      const where = t.mirrors ? ` AND origin <> 'mirror'` : t.name === "node_changes" ? ` AND sequence IS NULL` : "";
      const [left] = await every<{ n: number }>(`SELECT count(*)::int AS n FROM "${t.name}" WHERE sensitivity_label = 'public'${where}`);
      expect(left!.n, t.name).toBe(0);
    }
  });

  it("moves what was released outside to the published label, and an internal release to the base label", async () => {
    // A policy has a row on each side: the page's, at the label the page is written at, and the destination's.
    const policy = (boundary: string) =>
      every<{ side: string; l: string; to_label: string | null; to_outside: boolean }>(
        `SELECT side, sensitivity_label AS l, to_label, to_outside FROM redaction_policies WHERE boundary_id = $1 ORDER BY side`,
        [boundary]
      );
    expect(await policy(id.outsideBoundary!)).toEqual([
      { side: "destination", l: "published", to_label: null, to_outside: true },
      { side: "page", l: SENS, to_label: null, to_outside: true },
    ]);
    expect(await policy(id.insideBoundary!)).toEqual([
      { side: "destination", l: "members", to_label: "members", to_outside: false },
      { side: "page", l: SENS, to_label: "members", to_outside: false },
    ]);
    expect(await labelOf("gates", id.outsideBoundary!, "boundary_id")).toBe("published");
    expect(await labelOf("gates", id.insideBoundary!, "boundary_id")).toBe("members");
    expect(await labelOf("received_releases", id.outsideRelease!)).toBe("published");
    expect(await labelOf("received_releases", id.insideRelease!)).toBe("members");
    expect(await labelOf("release_acts", id.outsideRelease!, "release_id")).toBe("published");
    expect(await labelOf("release_acts", id.insideRelease!, "release_id")).toBe("members");
    expect(await labelOf("outward_acts", id.outwardAct!)).toBe("published");
    // The source side of both stays where the page was written; the internal one names its new destination.
    expect(await every(`SELECT sensitivity_label AS l, to_label FROM releases WHERE id = ANY($1::uuid[]) ORDER BY to_outside`, [[id.outsideRelease, id.insideRelease]])).toEqual([
      { l: SENS, to_label: "members" },
      { l: SENS, to_label: null },
    ]);
    // A face is shown outside where its label has a gate to outside, and to the members otherwise.
    expect(await labelOf("label_faces", id.faceOutside!)).toBe("published");
    expect(await labelOf("label_faces", id.faceInside!)).toBe("members");
    // The gate's settings are found where the gate's own code looks for them.
    expect(destinationLabel({ from: SENS, to: null })).toBe("published");
    expect((await gateOf(id.outsideBoundary!))?.to_outside).toBe(true);
    expect(await every(`SELECT count(*)::int AS n FROM gates WHERE boundary_id = $1`, [id.outsideBoundary])).toEqual([{ n: 1 }]);
  });

  it("keeps a version beside the public graph's beside it, and one beside the members' beside that", async () => {
    expect(await every(`SELECT input_label FROM judgment_inputs WHERE id = $1`, [id.besideMirrored])).toEqual([{ input_label: "public" }]);
    expect(await every(`SELECT input_label FROM judgment_inputs WHERE id = $1`, [id.besideOwn])).toEqual([{ input_label: "members" }]);
  });

  it("records that each label of the deployment's own reads the base label, as it read public", async () => {
    const pairs = await every<{ label: string; reads: string }>(`SELECT label, reads FROM label_reads ORDER BY label, reads`);
    expect(pairs).toEqual([
      { label: OTHER, reads: "members" },
      { label: SENS, reads: "members" },
      { label: SENS, reads: "public" },
    ]);
    const reads = async (label: string) =>
      (await every<{ r: string[] }>(`SELECT minerval_labels_readable_from(ARRAY[$1::text]) AS r`, [label]))[0]!.r.sort();
    expect(await reads(SENS)).toEqual([SENS, "members", "public", "published"]);
    expect(await reads("members")).toEqual(["members", "public", "published"]);
    expect(await reads("published")).toEqual(["public", "published"]);
    // The public graph's label reads nothing.
    expect(await reads("public")).toEqual(["public"]);
  });

  it("moves grants and keys at public to the base label, and gives it to whoever set the deployment up", async () => {
    const grants = await every<{ who: string; permission: string; label: string | null }>(
      `SELECT c.display_name AS who, g.permission, g.label FROM permission_grants g JOIN contributors c ON c.id = g.account_id
        WHERE g.label IS NOT NULL ORDER BY who, permission, label`
    );
    expect(grants).toEqual([
      { who: "A member", permission: "read", label: "members" },
      { who: "A member", permission: "read_sources", label: "members" },
      { who: "The first administrator", permission: "read", label: SENS },
      { who: "The first administrator", permission: "read", label: "members" },
      { who: "The first administrator", permission: "read_sources", label: "members" },
    ]);
    expect(await every(`SELECT work_label FROM api_keys WHERE id = $1`, [id.key])).toEqual([{ work_label: "members" }]);
    const [fresh] = await every<{ work_label: string }>(
      `INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'a later key', 'epk_later', $2) RETURNING work_label`,
      [id.member, `hash-${randomUUID()}`]
    );
    expect(fresh!.work_label).toBe("members");
  });

  it("clears each provider set up here for both new labels, as it was for public", async () => {
    const stored = await every<{ label: string; providers: string[] }>(
      `SELECT label, array_agg(provider ORDER BY provider) AS providers FROM provider_clearances GROUP BY label ORDER BY label`
    );
    const known = [...knownProviderNames()].sort();
    expect(stored).toEqual([
      { label: "members", providers: known },
      { label: "published", providers: known },
    ]);
  });

  it("is logged, and is not made twice", async () => {
    const log = await every<{ action: string; actor_id: string | null; detail: Record<string, string> }>(
      `SELECT action, actor_id, detail FROM administrative_events WHERE action = 'labels_split'`
    );
    expect(log).toHaveLength(1);
    expect(log[0]!.actor_id).toBeNull();
    expect(log[0]!.detail).toMatchObject({ base: "members", published: "published" });
    expect(Number(log[0]!.detail.rows_to_base)).toBeGreaterThan(5);
    expect(Number(log[0]!.detail.rows_to_published)).toBeGreaterThan(4);
    const again = await ensureLabelSplit();
    expect(again).toMatchObject({ split: false, base: "members", published: "published", lines: [] });
    expect(await every(`SELECT count(*)::int AS n FROM administrative_events WHERE action = 'labels_split'`)).toEqual([{ n: 1 }]);
  });
});

describe("after the split", () => {
  it("work that names no label is done at the base label, with the bare ledger key", async () => {
    expect(currentLabel()).toBe("members");
    expect(keyAtLabel("audit:1", "members")).toBe("audit:1");
    expect(groupAtLabel("assess:1", "members")).toBe("assess:1");
    expect(groupAtLabel("assess:1", SENS)).toBe(`assess:1 @${SENS}`);
    expect(groupAtLabel("assess:1", "published")).toBe("assess:1 @published");
    const [db] = await every<{ base: string; other: string }>(
      `SELECT minerval_group_at('assess:1', 'members') AS base, minerval_group_at('assess:1', $1) AS other`,
      [SENS]
    );
    expect(db).toEqual({ base: "assess:1", other: `assess:1 @${SENS}` });
  });

  it("nothing works at the public graph's label: work that starts from one of its rows is done at the base label", async () => {
    expect(isWorkableLabel("public")).toBe(false);
    expect(isWorkableLabel("published")).toBe(false);
    expect(isWorkableLabel("members")).toBe(true);
    // A message queued before the split that names public, or work that starts from a mirrored node.
    const at = await runAtLabel("public", "work queued before the split", async () => ({
      label: currentLabel(),
      reads: await currentReadClearance(),
      written: (await rawQuery<{ l: string }>(`INSERT INTO node_changes (claim_id, change) VALUES ($1, 'reworded') RETURNING sensitivity_label AS l`, [id.own]))[0]!.l,
    }));
    expect(at).toEqual({ label: "members", reads: ["members", "public", "published"], written: "members" });
    expect(await everyLabel()).toEqual(["members", "published", OTHER, SENS]);
  });

  it("a run at the base label reads the public graph and what was published, and not a label above", async () => {
    const seen = await runAtLabel("members", "a members' run", async () => ({
      nodes: (await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = ANY($1::uuid[])`, [[id.mirrored, id.own, id.sens]])).map((r) => r.id).sort(),
      outsideGate: (await rawQuery(`SELECT 1 FROM gates WHERE boundary_id = $1`, [id.outsideBoundary])).length,
    }));
    expect(seen.nodes).toEqual([id.mirrored, id.own].sort());
    expect(seen.outsideGate).toBe(1);
    // And changes neither: the public graph's row is the mirror's, and what was published is at another label than its own.
    const mirrored = (await caught(() =>
      runAtLabel("members", "a members' run", () => rawQuery(`UPDATE claims SET importance = 0.9 WHERE id = $1`, [id.mirrored]))
    )) as { code?: string } | null;
    expect(mirrored?.code).toBe("MIR01");
    const published = (await caught(() =>
      runAtLabel("members", "a members' run", () => rawQuery(`UPDATE gates SET backlog_visible = NOT backlog_visible WHERE boundary_id = $1`, [id.outsideBoundary]))
    )) as { code?: string } | null;
    expect(published?.code).toBe("MVL06");
    // Nor adds a row at either.
    for (const open of ["public", "published"]) {
      const added = await caught(() =>
        runAtLabel("members", "a members' run", () => rawQuery(`INSERT INTO node_changes (claim_id, change, sensitivity_label) VALUES ($1, 'reworded', $2)`, [id.own, open]))
      );
      expect(added, open).not.toBeNull();
    }
  });

  it("work with nothing in context reads what anyone may read, and none of the organization's own", async () => {
    setNoContextSessionForTests(null);
    try {
      const nodes = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = ANY($1::uuid[])`, [[id.mirrored, id.own, id.sens]]);
      expect(nodes.map((r) => r.id)).toEqual([id.mirrored]);
      expect(await currentReadClearance()).toEqual(["public", "published"]);
      expect((await rawQuery(`SELECT 1 FROM gates WHERE boundary_id = $1`, [id.outsideBoundary])).length).toBe(1);
      expect((await rawQuery(`SELECT 1 FROM gates WHERE boundary_id = $1`, [id.insideBoundary])).length).toBe(0);
    } finally {
      setNoContextSessionForTests({ role: "owner", label: baseLabel() });
    }
  });

  it("every member reads the base label and opens its sources, with or without a grant", async () => {
    expect(PUBLIC_STANDING.clearance).toEqual(["public", "published", "members"]);
    const member = await system(() => resolveStanding(id.member!));
    expect(member.clearance).toEqual(["members", "public", "published"]);
    expect(member.rawSourceLabels).toEqual(["members", "public", "published"]);
    const admin = await system(() => resolveStanding(id.admin!));
    expect(admin.clearance).toEqual([SENS, "members", "public", "published"]);
    // A label reads what anyone may read without a pair, and the base label only by one.
    expect(await system(() => labelsReadableFrom(["published"]))).toEqual(["public", "published"]);
    await runWithUsageContext({ clearance: member.clearance }, async () => {
      const nodes = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = ANY($1::uuid[])`, [[id.mirrored, id.own, id.sens]]);
      expect(nodes.map((r) => r.id).sort()).toEqual([id.mirrored, id.own].sort());
    });
  });

  it("a person files new material at a label work is done at, and is told why not at the other two", async () => {
    const auth = { standing: await system(() => resolveStanding(id.admin!)) } as never;
    expect(chooseLabel(auth, "members", true)).toEqual({ label: "members" });
    expect(chooseLabel(auth, SENS, true)).toEqual({ label: SENS });
    for (const open of ["public", "published"]) {
      const refused = chooseLabel(auth, open, true) as { refusal: { status: number; code: string; error: string; labels: string[] } };
      expect(refused.refusal.code).toBe("LABEL_NOT_FILED_AT");
      expect(refused.refusal.status).toBe(400);
      expect(refused.refusal.labels).toEqual([SENS, "members"]);
      expect(refused.refusal.error).toContain(`Nothing is filed at "${open}" here`);
    }
    const named = await runWithUsageContext({ clearance: [SENS, "members", "public", "published"] }, () => choosableLabels());
    expect(named.map((l) => l.name)).toEqual(["members", SENS]);
    expect(named[0]).toMatchObject({ read_by_everyone: true, reads: ["public", "published"] });
    expect(named[1]).toMatchObject({ read_by_everyone: false, reads: ["members", "public", "published"] });
  });

  it("a request about a node of the public graph is the deployment's own work, at the base label", async () => {
    const admin = { standing: await system(() => resolveStanding(id.admin!)) } as never;
    const about = (body: Record<string, unknown>, rule: Record<string, unknown> = {}) =>
      runWithUsageContext({ clearance: [SENS, "members", "public", "published"] }, () =>
        decideRequestLabel({ rule: "from", carrier: "claim", in: "body", field: "claim_id", why: "a test", ...rule } as never, {
          auth: admin,
          params: {},
          body: { claim_id: id.mirrored, ...body },
        } as never)
      );
    // What is filed about it carries the base label, not the public graph's.
    expect(await about({})).toEqual({ label: "members" });
    // Work on it may be at the base label or at one that reads it, and at neither label anyone reads.
    expect(await about({}, { orReader: true })).toEqual({ label: "members" });
    expect(await about({ label: SENS }, { orReader: true })).toEqual({ label: SENS });
    expect(await about({ label: "public" }, { orReader: true })).toMatchObject({ refusal: { code: "LABEL_NOT_FILED_AT", labels: [SENS, "members"] } });
  });

  it("a judgment made here on a node of the public graph is a version beside the public graph's", async () => {
    // At the base label the node's judgment is no longer the public graph's to make alone.
    expect(await runAtLabel("members", "a members' run", () => publicGraphJudges(id.mirrored!))).toBe(false);
    const made = await runAtLabel("members", "a members' run", () =>
      rawQuery<{ id: string; l: string }>(
        `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, model, is_current)
         VALUES ($1, 'supported', 0.7, 'With what every member reads.', 'a-model', true) RETURNING id, sensitivity_label AS l`,
        [id.mirrored]
      )
    );
    expect(made[0]!.l).toBe("members");
    // A member goes by the members' version; someone who reads only what anyone may read goes by the public graph's.
    const inForce = (clearance: string[]) =>
      runWithUsageContext({ clearance }, async () =>
        (await rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM assessments_in_force WHERE claim_id = $1`, [id.mirrored])).map((r) => r.l)
      );
    expect(await inForce(["members", "public", "published"])).toEqual(["members"]);
    expect(await inForce(["public", "published"])).toEqual(["public"]);
    expect(await every(`SELECT is_current FROM assessments WHERE id = $1`, [id.mirroredJudgment])).toEqual([{ is_current: true }]);
  });

  it("a release names the base label for every member, and neither of the other two", async () => {
    expect(destinationProblem("members")).toBeNull();
    expect(destinationProblem(null)).toBeNull();
    expect(destinationProblem(SENS)).toBeNull();
    for (const open of ["public", "published"]) {
      expect(destinationProblem(open)).toContain(`To release to every member, name "members". To release outside the deployment, say \`outside\`.`);
      const refused = (await caught(() =>
        askRelease({ nodeId: id.sens!, pageLabel: SENS, toLabel: open, form: "standing", scope: "node", actor: { id: id.admin!, holding: ["direct"] } } as never)
      )) as ReleaseError;
      expect(refused).toBeInstanceOf(ReleaseError);
      expect(refused.code).toBe("NOT_A_DESTINATION");
    }
  });

  it("neither label anyone reads can be made to read another, and a new label reads the base only by a pair", async () => {
    expect(await addLabelRead({ label: "published", reads: SENS, actorId: id.admin! })).toMatchObject({ ok: false, code: "PUBLIC_READS_NOTHING" });
    expect(await addLabelRead({ label: "public", reads: "members", actorId: id.admin! })).toMatchObject({ ok: false, code: "PUBLIC_READS_NOTHING" });
    const refused = (await caught(() => every(`INSERT INTO label_reads (label, reads) VALUES ('published', $1)`, [SENS]))) as { code?: string } | null;
    expect(refused?.code).toBe("23514");
    expect(await defineLabel({ name: "ls-apart", description: "Reads nothing of the members'.", actorId: id.admin! })).toEqual({ ok: true });
    const [apart] = await every<{ r: string[] }>(`SELECT minerval_labels_readable_from(ARRAY['ls-apart']) AS r`);
    expect(apart!.r.sort()).toEqual(["ls-apart", "public", "published"]);
  });

  it("an outward act is recorded at the published label", async () => {
    const act = await logOutwardAct({ kind: "send_report", by: { gate: true }, sent: { what: "another report" }, result: "done" });
    expect(await labelOf("outward_acts", act)).toBe("published");
  });
});
