/**
 * Pages against real Postgres: a page records what the graph held for the
 * nodes it embeds, shows them as they stand when read, marks what moved,
 * keeps earlier text when replaced, and is another user's 404.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import {
  deletePage,
  getPage,
  listPages,
  pageEmbeds,
  PAGE_MAX_NODES,
  savePage,
  serializePage,
} from "../../src/services/page-service.js";
import { seedClaim, seedUser } from "./helpers.js";

const NOWHERE = "00000000-0000-4000-8000-00000000dead";

async function assess(claimId: string, status: string): Promise<void> {
  await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1`, [claimId]);
  await rawQuery(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current)
     VALUES ($1, $2, 0.8, 'dbtest', true)`,
    [claimId, status]
  );
}

describe("pageEmbeds", () => {
  it("finds inline citations and block embeds, each node once, in order", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const c = "33333333-3333-4333-8333-333333333333";
    const body = [
      `Eggs raise LDL [claim:${a}].`,
      `{{nodes ${a} ${b}, ${c}}}`,
      `  {{decomposition ${b.toUpperCase()}}}  `,
      `Not an embed mid-line: {{node ${c}}} here.`,
      "{{node not-an-id}}",
    ].join("\n\n");
    expect(pageEmbeds(body)).toEqual({ ids: [a, b, c], decompositions: [b] });
  });
});

describe("pages", () => {
  it("saves a page, reads its nodes live, and marks what moved since", async () => {
    const userId = await seedUser("page-live");
    const a = await seedClaim("page a");
    const b = await seedClaim("page b");
    await assess(a, "inconclusive");

    const saved = await savePage({
      userId,
      title: "  Eggs,   briefly ",
      body: `The headline claim [claim:${a}].\n\n{{nodes ${a} ${b} ${NOWHERE}}}`,
    });
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.page.title).toBe("Eggs, briefly");

    const first = await serializePage(saved.page);
    expect(Object.keys(first.nodes).sort()).toEqual([a, b].sort());
    expect(first.unresolved).toEqual([NOWHERE]);
    expect(first.nodes[a]).toMatchObject({ assessment_status: "inconclusive" });
    expect(first.nodes[a]!.saved).toBeUndefined();
    expect(first.page_url).toMatch(new RegExp(`/ask/pages/${saved.page.id}$`));

    // The graph moves; the page shows the new status and what it was.
    await assess(a, "doubtful");
    const later = await serializePage((await getPage(saved.page.id, userId))!);
    expect(later.nodes[a]).toMatchObject({
      assessment_status: "doubtful",
      saved: { status: "inconclusive" },
    });
    expect(later.nodes[b]!.saved).toBeUndefined();
  });

  it("keeps the earlier text when a page is replaced, and re-reads the graph", async () => {
    const userId = await seedUser("page-replace");
    const a = await seedClaim("page replaced");
    await assess(a, "inconclusive");
    const first = await savePage({ userId, title: "Draft", body: `One [claim:${a}].` });
    if (!first.ok) throw new Error(first.message);
    await assess(a, "supported");

    const second = await savePage({ userId, id: first.page.id, title: "Final", body: `Two [claim:${a}].` });
    if (!second.ok) throw new Error(second.message);
    expect(second.page.id).toBe(first.page.id);
    expect(second.page.versions).toMatchObject([{ title: "Draft", body: `One [claim:${a}].` }]);
    // Saving again is a fresh reading: nothing has moved since.
    const page = await serializePage(second.page);
    expect(page.nodes[a]!.saved).toBeUndefined();
    expect(page.versions).toMatchObject([{ title: "Draft" }]);
    expect((await listPages(userId)).map((p) => p.title)).toEqual(["Final"]);
  });

  it("shows a decomposition's parts", async () => {
    const userId = await seedUser("page-tree");
    const parent = await seedClaim("page parent");
    const child = await seedClaim("page child");
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
       VALUES ($1, $2, 'supports', 'dbtest')`,
      [parent, child]
    );
    const saved = await savePage({ userId, title: "Tree", body: `{{decomposition ${parent}}}` });
    if (!saved.ok) throw new Error(saved.message);
    const page = await serializePage(saved.page);
    expect(page.decompositions[parent]).toMatchObject([{ id: child, relation: "supports" }]);
    expect(Object.keys(page.nodes).sort()).toEqual([parent, child].sort());
  });

  it("refuses an empty page and one that names too many nodes, saying the limit", async () => {
    const userId = await seedUser("page-limits");
    const empty = await savePage({ userId, title: " ", body: "text" });
    expect(empty.ok).toBe(false);
    const ids = Array.from(
      { length: PAGE_MAX_NODES + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );
    const many = await savePage({ userId, title: "Many", body: `{{nodes ${ids.join(" ")}}}` });
    expect(many.ok).toBe(false);
    if (!many.ok) {
      expect(many.code).toBe("TOO_MANY_NODES");
      expect(many.message).toContain(String(PAGE_MAX_NODES));
    }
  });

  it("is another user's 404", async () => {
    const owner = await seedUser("page-owner");
    const other = await seedUser("page-other");
    const saved = await savePage({ userId: owner, title: "Mine", body: "Private." });
    if (!saved.ok) throw new Error(saved.message);
    expect(await getPage(saved.page.id, other)).toBeNull();
    const taken = await savePage({ userId: other, id: saved.page.id, title: "Theirs", body: "x" });
    expect(taken.ok).toBe(false);
    expect(await deletePage(saved.page.id, other)).toBe(false);
    expect(await deletePage(saved.page.id, owner)).toBe(true);
    expect(await getPage(saved.page.id, owner)).toBeNull();
  });
});
