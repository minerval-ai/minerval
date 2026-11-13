/**
 * Each layer keeps its own identity (src/services/layer-service.ts;
 * docs/architecture.md, "Each layer keeps its own identity").
 *
 * The labels are review-3-common's: `r3-a` and `r3-b` read `public` and not
 * each other, and `r3-c` reads `r3-a` and `public`. For each kind of row
 * with a key besides its id:
 *
 *  - Higher first, then lower. Work at a label records the thing, and work
 *    at a label it reads then records the same thing. The lower work
 *    succeeds, and what it is given (its results, and any error, word for
 *    word) is what it is given where the higher row was never there.
 *  - Lower first, then higher. The higher work is handed the lower row, or
 *    refused where it would revise it, and records no second row.
 *  - Two labels that do not read each other each record the thing, and a
 *    reader of both is given both.
 *
 * The mirror's cases are tests/db/private-on-mirror.test.ts, unchanged. A
 * graph with one label is every other file of this suite.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));

import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { addArgument, getArgumentSubclaims } from "../../src/services/argument-service.js";
import { getArgumentView } from "../../src/services/argument-view-service.js";
import { linkClaims } from "../../src/services/claim-link-service.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { requestCuration, scanReconcileCandidates } from "../../src/services/curation-service.js";
import { heldAtALabelBelowMessage, oneReadingForInstanceSql, sourceHeldAtALabelBelow } from "../../src/services/layer-service.js";
import { addAnswer, markQuestion, setAnswerRelation } from "../../src/services/question-service.js";
import { defineQuantity, getQuantityDefinition, getThresholdOf, recordCut } from "../../src/services/quantity-service.js";
import { attachEdgeToArgument, insertRelationshipEdge } from "../../src/services/relationship-service.js";
import { getClaimSourceMap, recordInstanceReading, recordSourceRelationship } from "../../src/services/source-map-service.js";
import { getOrCreateSource } from "../../src/services/source-service.js";
import { findOrCreateTag, resolveTagBySlug, setSubjectTags } from "../../src/services/tag-service.js";
import { A, B, C, asPerson, at, attachSource, seedNode, system, tag, unwall, wall } from "./review-3-common.js";

const DEFINITION = { measures: "Outages in a year", population: "One grid", unit: { kind: "count", noun: "outages", min: 0 } };

beforeAll(async () => {
  await wall();
}, 120_000);
afterAll(async () => {
  await system(async () => {
    await rawQuery(`DELETE FROM taggings WHERE tag_id IN (SELECT id FROM tags WHERE slug LIKE $1)`, [`%${tag}%`]);
    await rawQuery(`DELETE FROM tags WHERE slug LIKE $1`, [`%${tag}%`]);
    await rawQuery(`DELETE FROM sources WHERE url LIKE $1`, [`https://layers.example/${tag}/%`]);
  }).catch(() => undefined);
  await unwall();
}, 120_000);

/**
 * What a piece of work was given, as text: its result, or the error it
 * met, with every id it could not have known beforehand (anything minted
 * during the call) replaced by its position. Two runs given the same thing
 * produce the same text, byte for byte.
 */
async function given(known: readonly string[], fn: () => Promise<unknown>): Promise<string> {
  const outcome = await fn().then(
    (result) => ({ result: result ?? null }),
    (err: unknown) => ({
      error: {
        name: (err as Error).name,
        message: (err as Error).message,
        code: (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code ?? null,
        hint: (err as { hint?: string }).hint ?? null,
        detail: (err as { detail?: string }).detail ?? null,
      },
    })
  );
  const minted = new Map<string, string>();
  const text = JSON.stringify(outcome, (_key, value) => (value instanceof Date ? "<time>" : value));
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
      const at = known.indexOf(id);
      if (at >= 0) return `<known ${at}>`;
      if (!minted.has(id)) minted.set(id, `<minted ${minted.size}>`);
      return minted.get(id)!;
    })
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>");
}

const labelsOf = (table: string, where: string, params: unknown[]) =>
  system(async () =>
    (await rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM ${table} WHERE ${where} ORDER BY 1`, params)).map((r) => r.l)
  );

/**
 * One kind of row. `world` makes what the row hangs from, at `public`
 * unless it says otherwise, and returns the ids the work knows beforehand.
 * `write` records the thing as work at the label in context. `rows` says
 * where to count them.
 */
interface Kind {
  name: string;
  world: () => Promise<Record<string, string>>;
  write: (w: Record<string, string>, words: string) => Promise<unknown>;
  rows: (w: Record<string, string>) => { table: string; where: string; params: unknown[] };
  /** What the higher work is given where the lower layer already holds the thing: the same row, or a refusal. */
  onLower: "handed the lower row" | "refused";
}

const pair = async () => ({ parent: await seedNode("public", "A parent"), child: await seedNode("public", "A child") });

const kinds: Kind[] = [
  {
    name: "an edge",
    world: pair,
    write: (w, words) =>
      insertRelationshipEdge({ parentId: w.parent!, childId: w.child!, relationType: "requires", reasoning: words, createdBy: "claim_steward" }),
    rows: (w) => ({ table: "claim_relationships", where: "parent_claim_id = $1 AND child_claim_id = $2", params: [w.parent, w.child] }),
    onLower: "handed the lower row",
  },
  {
    name: "a link",
    world: pair,
    write: (w, words) => linkClaims({ claimId: w.parent!, otherClaimId: w.child!, kind: "related", reasoning: words, createdBy: "curator" }),
    rows: (w) => ({ table: "claim_links", where: "$1 IN (claim_a_id, claim_b_id) AND $2 IN (claim_a_id, claim_b_id)", params: [w.parent, w.child] }),
    onLower: "handed the lower row",
  },
  {
    name: "an edge grouped under an argument",
    world: async () => {
      const w = await pair();
      const argument = await at("public", () => addArgument({ claimId: w.parent, stance: "for", name: `Grouping ${randomUUID()}`, content: "c", createdBy: "user" }));
      const edge = await at("public", () =>
        insertRelationshipEdge({ parentId: w.parent, childId: w.child, relationType: "requires", reasoning: "r", createdBy: "claim_steward" })
      );
      return { ...w, argument: argument.id, edge: edge.id };
    },
    write: (w) => attachEdgeToArgument(w.argument!, w.edge!),
    rows: (w) => ({ table: "argument_subclaims", where: "argument_id = $1 AND relationship_id = $2", params: [w.argument, w.edge] }),
    onLower: "handed the lower row",
  },
  {
    name: "an answer to a question",
    world: async () => {
      const question = await seedNode("public", "A question", "question");
      return { question, answer: await seedNode("public", "An answer") };
    },
    write: (w, words) => addAnswer({ questionId: w.question!, answerId: w.answer!, basis: "quality", reasoning: words, createdBy: "question_steward" }),
    rows: (w) => ({ table: "claim_relationships", where: "parent_claim_id = $1 AND child_claim_id = $2", params: [w.question, w.answer] }),
    onLower: "refused",
  },
  {
    name: "how two answers stand to each other",
    world: async () => {
      const question = await seedNode("public", "A question", "question");
      const [a, b] = [await seedNode("public", "An answer"), await seedNode("public", "Another answer")];
      await at("public", async () => {
        await addAnswer({ questionId: question, answerId: a, basis: "quality", reasoning: "r", createdBy: "question_steward" });
        await addAnswer({ questionId: question, answerId: b, basis: "quality", reasoning: "r", createdBy: "question_steward" });
      });
      return { question, a, b };
    },
    write: (w, words) =>
      setAnswerRelation({ questionId: w.question!, answerA: w.a!, answerB: w.b!, relation: "compatible", reasoning: words, createdBy: "question_steward" }),
    rows: (w) => ({ table: "answer_relations", where: "question_id = $1", params: [w.question] }),
    onLower: "refused",
  },
  {
    name: "a source at an address",
    world: async () => ({ url: `https://layers.example/${tag}/${randomUUID()}` }),
    write: async (w) => {
      const source = await getOrCreateSource({ url: w.url!, title: "A document" });
      return { id: source.id, url: source.url, title: source.title };
    },
    rows: (w) => ({ table: "sources", where: "url = $1", params: [w.url] }),
    onLower: "handed the lower row",
  },
  {
    name: "a tag",
    world: async () => ({ name: `Layered vocabulary ${tag} ${randomUUID().slice(0, 8)}` }),
    write: async (w) => {
      const made = await findOrCreateTag({ name: w.name!, description: "What it gathers.", createdBy: "tagger" });
      return { id: made.tag.id, slug: made.tag.slug, resolution: made.resolution };
    },
    rows: (w) => ({ table: "tags", where: "name = $1", params: [w.name] }),
    onLower: "handed the lower row",
  },
  {
    name: "a tagging",
    world: async () => {
      const name = `Layered tagging ${tag} ${randomUUID().slice(0, 8)}`;
      const made = await at("public", () => findOrCreateTag({ name, description: "What it gathers.", createdBy: "tagger" }));
      return { node: await seedNode("public", "A tagged node"), name, tagId: made.tag.id };
    },
    write: (w) => setSubjectTags({ kind: "claim", subjectId: w.node!, source: "steward", assignments: [{ name: w.name! }] }),
    rows: (w) => ({ table: "taggings", where: "subject_id = $1 AND tag_id = $2", params: [w.node, w.tagId] }),
    onLower: "handed the lower row",
  },
  {
    name: "a claim's cut of a quantity",
    world: async () => {
      const quantity = await seedNode("public", "A quantity");
      await at("public", () => defineQuantity({ claimId: quantity, definition: DEFINITION, createdBy: "claim_steward" }));
      return { claim: await seedNode("public", "A claim that cuts it"), quantity };
    },
    write: (w) => recordCut({ claimId: w.claim!, quantityId: w.quantity!, direction: "above", value: 10, createdBy: "claim_steward" }),
    rows: (w) => ({ table: "quantity_cuts", where: "claim_id = $1", params: [w.claim] }),
    onLower: "refused",
  },
  {
    name: "a quantity's definition",
    world: async () => ({ quantity: await seedNode("public", "A quantity nobody has defined", "quantity") }),
    write: (w, words) => defineQuantity({ claimId: w.quantity!, definition: { ...DEFINITION, measures: words }, createdBy: "claim_steward" }),
    rows: (w) => ({ table: "quantity_definitions", where: "claim_id = $1", params: [w.quantity] }),
    onLower: "refused",
  },
  {
    name: "a reading of a passage",
    world: async () => {
      const node = await seedNode("public", "A node with a passage");
      const { source, instance } = await attachSource(node, "public");
      return { node, source, instance };
    },
    write: (w, words) =>
      recordInstanceReading({ claimId: w.node!, instanceId: w.instance!, support: "supports", note: words, createdBy: "claim_steward" }),
    rows: (w) => ({ table: "claim_instance_readings", where: "instance_id = $1", params: [w.instance] }),
    onLower: "refused",
  },
  {
    name: "what one source draws on",
    world: async () => {
      const node = await seedNode("public", "A node with two documents");
      const one = await attachSource(node, "public");
      const two = await attachSource(node, "public");
      return { parent: one.source, child: two.source };
    },
    write: (w, words) =>
      recordSourceRelationship({ parentSourceId: w.parent!, childSourceId: w.child!, relationType: "republishes", reasoning: words, createdBy: "claim_steward" }),
    rows: (w) => ({ table: "source_relationships", where: "parent_source_id = $1 AND child_source_id = $2", params: [w.parent, w.child] }),
    onLower: "refused",
  },
  {
    name: "a concern put to the Curator",
    world: pair,
    write: (w, words) =>
      requestCuration({ anchorClaimId: w.parent!, otherClaimId: w.child!, source: "steward_escalation", defect: "duplicate", concern: words }),
    rows: (w) => ({ table: "curation_requests", where: "anchor_claim_id = $1", params: [w.parent] }),
    // A concern is the requesting run's own words: each label that raises one has its own.
    onLower: "handed the lower row",
  },
];

describe("higher first, then lower: the lower work succeeds and is given nothing that depends on the higher row", () => {
  for (const kind of kinds) {
    it(`${kind.name}: work at ${A} with the same thing already at ${C}, and work at public with it already at ${A}`, async () => {
      for (const [higher, lower] of [
        [C, A],
        [A, "public"],
      ] as const) {
        const withHigher = await kind.world();
        const without = await kind.world();
        // Ids the two worlds do not share are compared by position.
        const known = (w: Record<string, string>) => Object.values(w).filter((v) => /^[0-9a-f-]{36}$/.test(v));
        const strip = (text: string, w: Record<string, string>) =>
          Object.values(w)
            .filter((v) => !/^[0-9a-f-]{36}$/.test(v))
            .reduce((t, v) => t.split(v).join("<given>").split(encodeURI(v)).join("<given>"), text)
            // A slug is made from a name.
            .replace(/layered-(vocabulary|tagging)-[0-9a-f-]+/g, "<slug>");

        const first = await given(known(withHigher), () => at(higher, () => kind.write(withHigher, "The higher label's own words.")));
        expect(first, `${kind.name} at ${higher}`).not.toContain('"error"');
        const { table, where, params } = kind.rows(withHigher);
        expect(await labelsOf(table, where, params), `${kind.name}: the higher row`).toContain(higher);

        const lowerWith = strip(await given(known(withHigher), () => at(lower, () => kind.write(withHigher, "The lower label's words."))), withHigher);
        const lowerWithout = strip(await given(known(without), () => at(lower, () => kind.write(without, "The lower label's words."))), without);
        expect(lowerWith, `${kind.name}: what work at ${lower} is given`).toBe(lowerWithout);
        expect(lowerWith).not.toContain('"error"');

        // Each label holds its own row, and the higher one is untouched.
        const labels = await labelsOf(table, where, params);
        expect(labels.filter((l) => l === higher), `${kind.name} at ${higher}`).toHaveLength(1);
        expect(labels.filter((l) => l === lower), `${kind.name} at ${lower}`).toHaveLength(1);
        const other = kind.rows(without);
        expect((await labelsOf(other.table, other.where, other.params)).filter((l) => l === lower)).toHaveLength(1);
        // A second write by the lower work is as it would be anywhere.
        const againWith = strip(await given(known(withHigher), () => at(lower, () => kind.write(withHigher, "The lower label's words."))), withHigher);
        const againWithout = strip(await given(known(without), () => at(lower, () => kind.write(without, "The lower label's words."))), without);
        expect(againWith).toBe(againWithout);
      }
    });
  }
});

describe("lower first, then higher: the lower layer's row is the row", () => {
  for (const kind of kinds) {
    it(`${kind.name}: work at ${A} where public already holds it, and at ${C} where ${A} does`, async () => {
      for (const [lower, higher] of [
        ["public", A],
        [A, C],
      ] as const) {
        const w = await kind.world();
        const made = await at(lower, () => kind.write(w, "The lower label's words."));
        const { table, where, params } = kind.rows(w);
        const before = await labelsOf(table, where, params);
        const outcome = await at(higher, () => kind.write(w, `${higher.toUpperCase()}-ONLY words.`)).then(
          (result) => ({ result }),
          (error: Error) => ({ error })
        );
        if (kind.name === "a concern put to the Curator") {
          // The one exception: a concern is the run's own words, so each label's is its own row.
          expect(await labelsOf(table, where, params)).toEqual([...before, higher].sort());
          continue;
        }
        // No second row, and nothing of the higher label's words anywhere in the lower one.
        expect(await labelsOf(table, where, params), kind.name).toEqual(before);
        if (kind.onLower === "refused") {
          expect("error" in outcome, kind.name).toBe(true);
          expect((outcome as { error: Error }).error.message).toMatch(/already exists at another label than this work's, one this work reads/);
        } else {
          expect("result" in outcome, `${kind.name}: ${(outcome as { error?: Error }).error?.message}`).toBe(true);
          const id = (r: unknown) => (r as { id?: string } | null)?.id;
          if (id(made)) expect(id((outcome as { result: unknown }).result)).toBe(id(made));
        }
        const all = await system(() => rawQuery<{ row: string }>(`SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE ${where}`, params));
        expect(all.map((r) => r.row).join("\n")).not.toContain("-ONLY words");
      }
    });
  }

  it("says what was refused, and why, in one sentence a run can act on", () => {
    expect(heldAtALabelBelowMessage("this claim's cut of the quantity")).toBe(
      "This was not written: this claim's cut of the quantity already exists at another label than this work's, one this work reads, " +
        "and that row is the one this work goes by. Work at one label does not write its words into a row at another, " +
        "where that label's readers would read them. Nothing was changed."
    );
  });
});

describe("two labels that do not read each other", () => {
  it("each hold the same edge, link, source and tag, and a reader of both is given both", async () => {
    const w = await pair();
    const url = `https://layers.example/${tag}/${randomUUID()}`;
    const name = `Layered vocabulary ${tag} ${randomUUID().slice(0, 8)}`;
    const write = async () => {
      const edge = await insertRelationshipEdge({ parentId: w.parent, childId: w.child, relationType: "requires", reasoning: "r", createdBy: "claim_steward" });
      const link = await linkClaims({ claimId: w.parent, otherClaimId: w.child, kind: "related", reasoning: "r", createdBy: "curator" });
      const source = await getOrCreateSource({ url });
      const made = await findOrCreateTag({ name, createdBy: "tagger" });
      return { edge, link: link.created, source: source.sensitivityLabel, tag: made.resolution };
    };
    const a = await at(A, write);
    const b = await at(B, write);
    expect(a).toMatchObject({ edge: { created: true }, link: true, source: A, tag: "created" });
    expect(b).toMatchObject({ edge: { created: true }, link: true, source: B, tag: "created" });
    for (const [table, where, params] of [
      ["claim_relationships", "parent_claim_id = $1 AND child_claim_id = $2", [w.parent, w.child]],
      ["claim_links", "$1 IN (claim_a_id, claim_b_id) AND $2 IN (claim_a_id, claim_b_id)", [w.parent, w.child]],
      ["sources", "url = $1", [url]],
      ["tags", "name = $1", [name]],
    ] as const) {
      expect(await labelsOf(table, where, [...params]), table).toEqual([A, B]);
      // A reader of one sees one; a reader of both sees both.
      expect(await asPerson([A], () => rawQuery(`SELECT 1 FROM ${table} WHERE ${where}`, [...params]))).toHaveLength(1);
      expect(await asPerson([A, B], () => rawQuery(`SELECT 1 FROM ${table} WHERE ${where}`, [...params]))).toHaveLength(2);
    }
    // Neither edge is below the other, so the node's read lists both.
    const view = await asPerson([A, B], () => getClaimView(w.parent, { include: ["subclaims"] }));
    const listed = (view!.subclaims as Array<{ id: string; also_recorded_here?: unknown }>).filter((s) => s.id === w.child);
    expect(listed).toHaveLength(2);
    expect(listed.every((s) => s.also_recorded_here === undefined)).toBe(true);
  });
});

describe("a row a lower layer records after a higher one did", () => {
  it("an edge is listed once, by the lower row, with what the higher label wrote beside it", async () => {
    const w = await pair();
    const argument = await at(C, () => addArgument({ claimId: w.parent, stance: "for", name: `C's argument ${randomUUID()}`, content: "c", createdBy: "user" }));
    const mine = await at(C, () =>
      insertRelationshipEdge({ parentId: w.parent, childId: w.child, relationType: "requires", reasoning: "Why c thinks it bears.", createdBy: "claim_steward" })
    );
    const theirs = await at(A, () =>
      insertRelationshipEdge({ parentId: w.parent, childId: w.child, relationType: "requires", reasoning: "Why a thinks it bears.", createdBy: "claim_steward" })
    );
    expect(theirs.created).toBe(true);
    const subclaims = async (label: string) =>
      ((await at(label, () => getClaimView(w.parent, { include: ["subclaims"] })))!.subclaims as Array<{
        id: string;
        edge_id: string;
        reasoning: string;
        argument_id: string | null;
        also_recorded_here?: { edge_id: string; reasoning: string };
      }>).filter((s) => s.id === w.child);
    // A reader at c: the lower row, once, with c's own beside it.
    const forC = await subclaims(C);
    expect(forC).toHaveLength(1);
    expect(forC[0]).toMatchObject({
      edge_id: theirs.id,
      reasoning: "Why a thinks it bears.",
      also_recorded_here: { edge_id: mine.id, reasoning: "Why c thinks it bears." },
    });
    // A reader at a: its own row and no sign of c's.
    const forA = await subclaims(A);
    expect(forA).toHaveLength(1);
    expect(forA[0]!.edge_id).toBe(theirs.id);
    expect(forA[0]!.also_recorded_here).toBeUndefined();
    // Nothing c recorded is lost: its row is where it was, and still groups under its argument.
    await at(C, () => attachEdgeToArgument(argument.id, mine.id));
    expect(await at(C, () => getArgumentSubclaims(argument.id))).toEqual([expect.objectContaining({ id: w.child })]);
    // Work at c that records the edge again is handed the lower row.
    expect(await at(C, () => insertRelationshipEdge({ parentId: w.parent, childId: w.child, relationType: "requires", reasoning: "r", createdBy: "claim_steward" }))).toEqual({
      id: theirs.id,
      created: false,
    });
    // The same premise grouped by both rows is one premise.
    await at(C, () => attachEdgeToArgument(argument.id, theirs.id));
    expect(await at(C, () => getArgumentSubclaims(argument.id))).toHaveLength(1);
  });

  it("a source: work at the higher label keeps the row it wrote, and a read of it names the lower one", async () => {
    const url = `https://layers.example/${tag}/${randomUUID()}`;
    const mine = await at(C, () => getOrCreateSource({ url, content: "C-ONLY text handed over with a submission." }));
    const theirs = await at(A, () => getOrCreateSource({ url }));
    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.rawContent).toBeNull();
    // Each label's work goes on with its own row; work at a label that wrote neither takes the lowest.
    expect((await at(C, () => getOrCreateSource({ url }))).id).toBe(mine.id);
    expect((await at(A, () => getOrCreateSource({ url }))).id).toBe(theirs.id);
    expect(await at(C, () => sourceHeldAtALabelBelow(rawQuery, mine.id))).toEqual({ same_address_source_id: theirs.id });
    expect(await at(A, () => sourceHeldAtALabelBelow(rawQuery, theirs.id))).toBeNull();
    expect(await asPerson([A], () => sourceHeldAtALabelBelow(rawQuery, mine.id))).toBeNull();
  });

  it("a cut and a definition: a read takes the reader's own label's, else the lowest, and each stays as written", async () => {
    const quantity = await seedNode("public", "A quantity", "quantity");
    const claim = await seedNode("public", "A claim that cuts it");
    // c defines a public quantity that has no definition yet, and cuts a public claim.
    await at(C, () => defineQuantity({ claimId: quantity, definition: { ...DEFINITION, measures: "C's wording" }, createdBy: "claim_steward" }));
    await at(C, () => recordCut({ claimId: claim, quantityId: quantity, direction: "above", value: 30, createdBy: "claim_steward" }));
    await at("public", () => defineQuantity({ claimId: quantity, definition: DEFINITION, createdBy: "claim_steward" }));
    await at("public", () => recordCut({ claimId: claim, quantityId: quantity, direction: "above", value: 10, createdBy: "claim_steward" }));
    expect(await labelsOf("quantity_definitions", "claim_id = $1", [quantity])).toEqual(["public", C]);
    expect(await labelsOf("quantity_cuts", "claim_id = $1", [claim])).toEqual(["public", C]);
    // Work at c reads its own; a reader at a, who wrote neither, reads the public one.
    expect((await at(C, () => getQuantityDefinition(quantity)))!.measures).toBe("C's wording");
    expect((await at(A, () => getQuantityDefinition(quantity)))!.measures).toBe(DEFINITION.measures);
    expect((await at(C, () => getThresholdOf(claim)))!.value).toBe(30);
    expect((await at(A, () => getThresholdOf(claim)))!.value).toBe(10);
    expect((await at("public", () => getThresholdOf(claim)))!.value).toBe(10);
    // Once a layer below holds the claim's cut, no label above writes one beside it or revises its own,
    // as against the public graph's cut in the mirror.
    for (const label of [C, A]) {
      await expect(at(label, () => recordCut({ claimId: claim, quantityId: quantity, direction: "above", value: 5, createdBy: "claim_steward" }))).rejects.toThrow(
        /already exists at another label than this work's, one this work reads/
      );
    }
    expect((await at(C, () => getThresholdOf(claim)))!.value).toBe(30);
  });

  it("a reading of a passage: a read takes one, the reader's own label's where it has one", async () => {
    const node = await seedNode("public", "A node with a passage");
    const { instance } = await attachSource(node, "public");
    const read = (label: string, note: string) =>
      at(label, () => recordInstanceReading({ claimId: node, instanceId: instance, support: "supports", note, createdBy: "claim_steward" }));
    await read(C, "C-ONLY: how c reads it.");
    await read("public", "How the public label reads it.");
    const taken = (label: string) =>
      at(label, () =>
        rawQuery<{ note: string }>(`SELECT r.note FROM claim_instance_readings r WHERE r.instance_id = $1${oneReadingForInstanceSql("r")}`, [instance])
      );
    expect(await taken(C)).toEqual([{ note: "C-ONLY: how c reads it." }]);
    expect(await taken(A)).toEqual([{ note: "How the public label reads it." }]);
    expect(await taken("public")).toEqual([{ note: "How the public label reads it." }]);
    // The node's source map, read at c, has the passage once, with c's reading.
    const map = await at(C, () => getClaimSourceMap(node));
    expect(JSON.stringify(map)).toContain("C-ONLY: how c reads it.");
    expect(JSON.stringify(map)).not.toContain("How the public label reads it.");
  });

  it("a tag: the slug names the lower label's tag, and the higher label's stays with what was tagged with it", async () => {
    const name = `Layered vocabulary ${tag} ${randomUUID().slice(0, 8)}`;
    const node = await seedNode(C, "C-ONLY: a tagged node");
    await at(C, () => setSubjectTags({ kind: "claim", subjectId: node, source: "steward", assignments: [{ name }] }));
    const [mine] = await system(() => rawQuery<{ id: string; slug: string }>(`SELECT id, slug FROM tags WHERE name = $1`, [name]));
    const theirs = await at(A, () => findOrCreateTag({ name, createdBy: "tagger" }));
    expect(theirs.resolution).toBe("created");
    expect(theirs.tag.id).not.toBe(mine!.id);
    // New work at c uses the lower tag; c's earlier tagging is where it was.
    expect((await at(C, () => resolveTagBySlug(mine!.slug)))!.id).toBe(theirs.tag.id);
    expect((await at(C, () => findOrCreateTag({ name, createdBy: "tagger" }))).tag.id).toBe(theirs.tag.id);
    expect(await labelsOf("taggings", "subject_id = $1 AND tag_id = $2", [node, mine!.id])).toEqual([C]);
  });
});

describe("an argument's evaluation in get_argument", () => {
  it("is the one in force for the reader, not the most recently made", async () => {
    const node = await seedNode("public", "A node with an argument");
    const argument = await at("public", () => addArgument({ claimId: node, stance: "for", name: `Evaluated ${randomUUID()}`, content: "c", createdBy: "user" }));
    await system(async () => {
      await rawQuery(
        `INSERT INTO argument_evaluations (argument_id, verdict, content, is_current, sensitivity_label, created_at)
         VALUES ($1, 'fails', 'A-ONLY: what a concluded.', true, $2, now() - interval '2 hours')`,
        [argument.id, A]
      );
      // The public evaluation is made again afterwards.
      await rawQuery(
        `INSERT INTO argument_evaluations (argument_id, verdict, content, is_current, sensitivity_label, created_at)
         VALUES ($1, 'succeeds', 'What the public label concluded.', true, 'public', now() - interval '1 hour')`,
        [argument.id]
      );
    });
    const evaluation = async (clearance: string[]) =>
      ((await asPerson(clearance, () => getArgumentView(argument.id, { include: ["evaluation"] })))!.evaluation as { verdict: string; content: string } | null);
    // For a reader at a, a's version is in force: it was made at a label that reads the other's.
    expect(await evaluation([A])).toMatchObject({ verdict: "fails", content: "A-ONLY: what a concluded." });
    expect(await evaluation(["public"])).toMatchObject({ verdict: "succeeds" });
    expect(await evaluation([B])).toMatchObject({ verdict: "succeeds" });
  });
});

describe("the reconcile-candidate scan between labels", () => {
  const vector = (axis: number) => `[${Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const twin = async (label: string, axis: number, words: string) => {
    const id = await seedNode(label, words);
    await system(() => rawQuery(`UPDATE claims SET embedding = $2::vector WHERE id = $1`, [id, vector(axis)]));
    return id;
  };
  const asked = (nodes: string[]) =>
    system(() =>
      rawQuery<{ anchor_claim_id: string; other_claim_id: string; l: string; concern: string }>(
        `SELECT anchor_claim_id, other_claim_id, sensitivity_label AS l, concern FROM curation_requests
          WHERE anchor_claim_id = ANY($1::uuid[]) ORDER BY created_at`,
        [nodes]
      )
    );
  const policy = { reconcile_candidates_max_per_sweep: 50, reconcile_candidate_min_similarity: 0.92 };
  // The scheduler runs the scan seeing every label (tests/unit/db/system-clearance.test.ts).
  const scan = () => system(() => scanReconcileCandidates(policy));

  it("raises a pair at the label that reads both, on its own node, whichever of the two the scan started from", async () => {
    await system(() => rawQuery(`UPDATE claims SET embedding = NULL`));
    // The lower node is the newer: the scan meets it first, and its own label cannot read the other.
    const upper = await twin(A, 300, "A-ONLY: a node a holds");
    const lower = await twin("public", 300, "The node the public label later records");
    await scan();
    const requests = await asked([upper, lower]);
    expect(requests.map((r) => [r.anchor_claim_id, r.other_claim_id, r.l])).toEqual([[upper, lower, A]]);
    expect(requests[0]!.concern).toContain("A label this one reads now holds a node unusually like this one");
    expect(requests[0]!.concern).toContain(`merge_claims with ${lower} as the survivor`);
    // Nothing is raised where the lower label's readers could see it, and not twice.
    expect(await asPerson(["public"], () => rawQuery(`SELECT 1 FROM curation_requests WHERE anchor_claim_id = ANY($1::uuid[])`, [[upper, lower]]))).toEqual([]);
    await scan();
    expect(await asked([upper, lower])).toHaveLength(1);
    await system(() => rawQuery(`UPDATE claims SET embedding = NULL`));
  });

  it("raises the pair when the lower node's row of it comes first in the scan", async () => {
    await system(() => rawQuery(`UPDATE claims SET embedding = NULL`));
    // Both nodes are recent, so the scan holds a row of the pair from each side, equally alike.
    // The lower node's own label cannot read the other; that row must not use the pair up.
    for (let round = 0; round < 3; round++) {
      const lower = await twin("public", 320 + round, "The node the public label holds");
      const upper = await twin(A, 320 + round, "A-ONLY: the node a records");
      await scan();
      expect((await asked([upper, lower])).map((r) => [r.anchor_claim_id, r.l]), `round ${round}`).toEqual([[upper, A]]);
    }
    await system(() => rawQuery(`UPDATE claims SET embedding = NULL`));
  });

  it("raises nothing for two nodes at labels that do not read each other", async () => {
    await system(() => rawQuery(`UPDATE claims SET embedding = NULL`));
    const one = await twin(A, 310, "A-ONLY: a node a holds");
    const other = await twin(B, 310, "B-ONLY: the same thing, as b holds it");
    expect(await scan()).toBe(0);
    expect(await asked([one, other])).toEqual([]);
    await system(() => rawQuery(`UPDATE claims SET embedding = NULL`));
  });
});
