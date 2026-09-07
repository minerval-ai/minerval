import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The tag service (#272): the mechanics under the tagger and the routes.
 * The SQL runs live; here the DB layer is a recording mock and the tests
 * check the decisions the service makes around it — slug identity, the
 * semantic dedup guard, source-scoped replacement of taggings, and merges.
 */

const TAG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLAIM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const { state } = vi.hoisted(() => ({
  state: {
    // Rows the next select().from().where().limit() calls resolve to, in order.
    selects: [] as Array<Record<string, unknown>[]>,
    inserted: [] as Array<{ table: string; rows: Record<string, unknown>[] }>,
    updated: [] as Array<Record<string, unknown>>,
    deleted: 0,
    deleteReturn: [] as Array<{ id: string }>,
    insertReturn: [] as Record<string, unknown>[],
    raw: [] as Array<{ q: string; params: unknown[] }>,
    rawReturn: [] as unknown[][],
  },
}));

vi.mock("../../../src/db/client.js", () => {
  const select = () => ({
    from: () => ({
      where: () => ({ limit: async () => state.selects.shift() ?? [] }),
    }),
  });
  const insert = (table: { name?: string } & Record<string, unknown>) => ({
    values: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
      const list = Array.isArray(rows) ? rows : [rows];
      state.inserted.push({ table: String((table as any)[Symbol.for("drizzle:Name")] ?? "?"), rows: list });
      const chain = {
        onConflictDoNothing: () => ({
          returning: async () => state.insertReturn,
          then: (res: (v: unknown) => void) => res(undefined),
        }),
        returning: async () => state.insertReturn,
      };
      return chain;
    },
  });
  const update = () => ({
    set: (row: Record<string, unknown>) => {
      state.updated.push(row);
      return {
        where: () => ({
          returning: async () => [{ id: CLAIM }],
          then: (res: (v: unknown) => void) => res(undefined),
        }),
      };
    },
  });
  const del = () => ({
    where: () => ({
      returning: async () => {
        state.deleted++;
        return state.deleteReturn;
      },
    }),
  });
  return {
    getDb: () => ({ select, insert, update, delete: del }),
    rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
      state.raw.push({ q, params });
      return state.rawReturn.shift() ?? [];
    }),
  };
});

vi.mock("../../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}));

import {
  findOrCreateTag,
  mergeTags,
  normalizeTagName,
  resolveTagBySlug,
  setSubjectTags,
  slugifyTag,
  tagEmbeddingText,
  TAG_DEDUP_SIMILARITY,
} from "../../../src/services/tag-service.js";

const tagRow = (over: Record<string, unknown> = {}) => ({
  id: TAG_A,
  slug: "vaccine-safety",
  name: "Vaccine safety",
  description: "Adverse effects and risk of vaccines.",
  status: "active",
  mergedInto: null,
  createdBy: "tagger",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  embedding: null,
  ...over,
});

beforeEach(() => {
  state.selects = [];
  state.inserted = [];
  state.updated = [];
  state.deleted = 0;
  state.deleteReturn = [];
  state.insertReturn = [];
  state.raw = [];
  state.rawReturn = [];
});

describe("slugifyTag / normalizeTagName", () => {
  it("folds case, diacritics, punctuation and spacing into one identity", () => {
    expect(slugifyTag("Vaccine Safety")).toBe("vaccine-safety");
    expect(slugifyTag("  vaccine   safety ")).toBe("vaccine-safety");
    expect(slugifyTag("Gödel's theorems")).toBe("godel-s-theorems");
    expect(slugifyTag("R&D policy")).toBe("r-and-d-policy");
    expect(slugifyTag("---")).toBe("");
  });

  it("caps the slug without leaving a trailing hyphen", () => {
    const long = "a ".repeat(60).trim();
    const slug = slugifyTag(long);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("normalizes a name and embeds name plus description", () => {
    expect(normalizeTagName("  Monetary\n policy ")).toBe("Monetary policy");
    expect(tagEmbeddingText("Prime numbers", "Primes and their distribution.")).toBe(
      "Prime numbers: Primes and their distribution."
    );
    expect(tagEmbeddingText("Prime numbers", "")).toBe("Prime numbers");
  });
});

describe("resolveTagBySlug", () => {
  it("follows a merged tag to its survivor", async () => {
    state.selects.push(
      [tagRow({ id: TAG_B, slug: "vaccines-safety", status: "merged", mergedInto: TAG_A })],
      [tagRow()]
    );
    const tag = await resolveTagBySlug("Vaccines Safety");
    expect(tag?.id).toBe(TAG_A);
    expect(tag?.slug).toBe("vaccine-safety");
  });

  it("returns null for an unknown slug", async () => {
    expect(await resolveTagBySlug("nothing-here")).toBeNull();
  });
});

describe("findOrCreateTag", () => {
  it("resolves by slug before anything else, without embedding", async () => {
    state.selects.push([tagRow()], [tagRow()]);
    const r = await findOrCreateTag({ name: "VACCINE safety", createdBy: "tagger" });
    expect(r.resolution).toBe("slug");
    expect(r.tag.id).toBe(TAG_A);
    expect(state.inserted).toHaveLength(0);
  });

  it("reuses a semantically near-identical tag instead of minting", async () => {
    state.selects.push([]); // no slug match
    state.rawReturn.push([
      { id: TAG_A, slug: "vaccine-safety", name: "Vaccine safety", description: "", similarity: 0.95, claim_count: 12 },
    ]);
    state.selects.push([tagRow()]); // getTagById
    const r = await findOrCreateTag({
      name: "Safety of vaccines",
      description: "Whether vaccines are safe.",
      createdBy: "tagger",
    });
    expect(r.resolution).toBe("semantic");
    expect(r.similarity).toBeCloseTo(0.95);
    expect(r.tag.id).toBe(TAG_A);
    expect(state.inserted).toHaveLength(0);
    // The guard searched at the dedup threshold, not the retrieval floor.
    const search = state.raw.find((c) => c.q.includes("<=>"));
    expect(search?.params[1]).toBe(TAG_DEDUP_SIMILARITY);
  });

  it("mints when nothing matches by slug or by meaning", async () => {
    state.selects.push([]);
    state.rawReturn.push([]);
    state.insertReturn = [tagRow({ id: TAG_B, slug: "prime-numbers", name: "Prime numbers" })];
    const r = await findOrCreateTag({
      name: "Prime numbers",
      description: "Primes and their distribution.",
      createdBy: "cluster_seed",
    });
    expect(r.resolution).toBe("created");
    expect(state.inserted[0]!.rows[0]).toMatchObject({
      slug: "prime-numbers",
      name: "Prime numbers",
      createdBy: "cluster_seed",
      embedding: [0.1, 0.2, 0.3],
    });
  });

  it("refuses a name with nothing slug-able", async () => {
    await expect(findOrCreateTag({ name: "!!!", createdBy: "tagger" })).rejects.toThrow(/slug/);
  });
});

describe("setSubjectTags", () => {
  it("replaces only its own source's rows and writes provenance", async () => {
    // Two assignments: one by id (existing), one by name (slug-resolved).
    state.selects.push([tagRow()]); // getTagById(TAG_A)
    state.selects.push([tagRow({ id: TAG_B, slug: "epidemiology", name: "Epidemiology" })]); // bySlug
    state.selects.push([tagRow({ id: TAG_B, slug: "epidemiology", name: "Epidemiology" })]); // resolve
    state.deleteReturn = [{ id: "old-1" }];
    const r = await setSubjectTags({
      kind: "claim",
      subjectId: CLAIM,
      source: "tagger",
      runId: "run-1",
      assignments: [
        { tagId: TAG_A, confidence: 0.9, reasoning: "broad field" },
        { name: "Epidemiology", confidence: 0.7 },
      ],
    });
    expect(r.attached.map((t) => t.slug)).toEqual(["vaccine-safety", "epidemiology"]);
    expect(r.removed).toBe(1);
    expect(r.resolutions).toEqual([{ name: "Epidemiology", slug: "epidemiology", resolution: "slug" }]);
    const written = state.inserted.find((i) => i.rows[0]?.subjectKind === "claim");
    expect(written?.rows).toHaveLength(2);
    expect(written?.rows[0]).toMatchObject({
      tagId: TAG_A,
      subjectId: CLAIM,
      source: "tagger",
      confidence: 0.9,
      reasoning: "broad field",
      runId: "run-1",
    });
  });

  it("keeps one row per tag, highest confidence wins", async () => {
    state.selects.push([tagRow()], [tagRow()]);
    const r = await setSubjectTags({
      kind: "claim",
      subjectId: CLAIM,
      source: "tagger",
      assignments: [
        { tagId: TAG_A, confidence: 0.4 },
        { tagId: TAG_A, confidence: 0.8 },
      ],
    });
    expect(r.attached).toHaveLength(1);
    const written = state.inserted.find((i) => i.rows[0]?.subjectKind === "claim");
    expect(written?.rows[0]).toMatchObject({ confidence: 0.8 });
  });

  it("an empty list clears the source's rows and writes nothing", async () => {
    state.deleteReturn = [{ id: "old-1" }, { id: "old-2" }];
    const r = await setSubjectTags({ kind: "claim", subjectId: CLAIM, source: "tagger", assignments: [] });
    expect(r.attached).toEqual([]);
    expect(r.removed).toBe(2);
    expect(state.inserted).toHaveLength(0);
  });
});

describe("mergeTags", () => {
  it("moves taggings to the winner, drops collisions, retires the loser", async () => {
    state.selects.push([tagRow()]); // winner
    state.selects.push([tagRow({ id: TAG_B, slug: "vaccines-safety" })]); // loser
    state.rawReturn.push([{ id: "t1" }, { id: "t2" }]); // moved
    state.deleteReturn = [{ id: "t3" }]; // collided
    const r = await mergeTags({ loserId: TAG_B, winnerId: TAG_A });
    expect(r).toEqual({ moved: 2, dropped: 1 });
    expect(state.updated[0]).toMatchObject({ status: "merged", mergedInto: TAG_A });
    // Chains stay one hop: anything merged into the loser is re-pointed.
    expect(state.updated[1]).toMatchObject({ mergedInto: TAG_A });
    const move = state.raw.find((c) => c.q.includes("UPDATE taggings"));
    expect(move?.params).toEqual([TAG_B, TAG_A]);
  });

  it("refuses a self-merge and a merged winner", async () => {
    await expect(mergeTags({ loserId: TAG_A, winnerId: TAG_A })).rejects.toThrow(/itself/);
    state.selects.push([tagRow({ status: "merged", mergedInto: TAG_B })], [tagRow({ id: TAG_B })]);
    await expect(mergeTags({ loserId: TAG_B, winnerId: TAG_A })).rejects.toThrow(/survivor/);
  });
});
