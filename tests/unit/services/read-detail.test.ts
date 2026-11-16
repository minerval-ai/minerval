import { describe, expect, it } from "vitest";
import { countStates, cutList, pagePlanItems, shapeMandateDetail } from "../../../src/services/read-detail.js";
import { compactMandateRow, excerpt, type MandateListRow } from "../../../src/services/mandate-service.js";
import type { PlanItemState } from "../../../src/services/plan-state.js";

const items = (n: number, state: PlanItemState = "queued") =>
  Array.from({ length: n }, (_, index) => ({ index, state, action: "assess", rationale: "r" }));

describe("a summarized read", () => {
  it("pages the plan's items, filters them by state, and says how many there are", () => {
    const plan = [...items(3, "done"), ...items(30)].map((it, index) => ({ ...it, index }));
    expect(pagePlanItems(plan, {}).size).toEqual({ total: 33, returned: 20, offset: 0 });
    const queued = pagePlanItems(plan, { items_state: "queued", items_offset: 25, items_limit: 10 });
    expect(queued.size).toEqual({ total: 30, returned: 5, offset: 25 });
    expect(queued.items[0]!.index).toBe(28);
    expect(pagePlanItems(plan, { detail: "full", items_limit: 1 }).items).toHaveLength(33);
    expect(countStates(plan)).toMatchObject({ total: 33, done: 3, queued: 30, blocked: 0 });
  });

  it("cuts every other list, the route's own included, and leaves them whole in full", () => {
    const mandate = {
      plan_items: items(2),
      contributors: Array.from({ length: 30 }, (_, i) => ({ name: `c${i}` })),
      pipeline: [],
      attempts: Array.from({ length: 12 }, (_, i) => ({ id: `a${i}` })),
      prizes: { bounties: Array.from({ length: 15 }, (_, i) => ({ id: `b${i}` })), bounties_posted: 15 },
    } as never;
    const summary = shapeMandateDetail(mandate, { list_limit: 5 }) as unknown as Record<string, unknown> & {
      collections: Record<string, { total: number; returned: number }>;
    };
    expect((summary.contributors as unknown[]).length).toBe(5);
    expect((summary.attempts as unknown[]).length).toBe(5);
    expect(((summary.prizes as { bounties: unknown[] }).bounties).length).toBe(5);
    expect(summary.collections).toMatchObject({
      contributors: { total: 30, returned: 5 },
      attempts: { total: 12, returned: 5 },
      bounties: { total: 15, returned: 5 },
      pipeline: { total: 0, returned: 0 },
    });
    expect(summary.detail_note).toEqual(expect.any(String));
    const full = shapeMandateDetail(mandate, { detail: "full", list_limit: 1 }) as unknown as Record<string, unknown[]>;
    expect(full.contributors).toHaveLength(30);
    expect(cutList([1, 2, 3], {}).list).toEqual([1, 2, 3]);
  });
});

describe("a compact mandate row", () => {
  it("cuts a long objective at a word, and says it did", () => {
    const long = "word ".repeat(80);
    const cut = excerpt(long)!;
    expect(cut.length).toBeLessThanOrEqual(201);
    expect(cut.endsWith("…")).toBe(true);
    expect(excerpt("Short and\n  sweet.")).toBe("Short and sweet.");
    expect(excerpt(null)).toBeNull();
  });

  it("keeps what choosing a mandate needs, and its links", () => {
    const row = {
      id: "m-1",
      title: "T",
      objective: "word ".repeat(80),
      is_platform: false,
      status: "active",
      manager: "an anonymous funder",
      funder: { shown_as: "an anonymous funder", named: false, declared: true, stake: "s" },
      budget_owls: 10,
      spent_owls: 2,
      held_owls: 1,
      contributor_count: 1,
      action_mix: { assess: 3 },
      created_at: null,
      page_url: "https://minerval.test/mandates/m-1",
      budget_status: "running",
      updated_at: null,
      assessments: 4,
    } satisfies MandateListRow;
    const compact = compactMandateRow(row, true);
    expect(compact).toMatchObject({ id: "m-1", objective_cut: true, page_url: row.page_url, assessments: 4 });
    expect(compact.funder_url).toMatch(/\/ask\/mandates\/m-1$/);
    expect(compact).not.toHaveProperty("action_mix");
    expect(compactMandateRow(row, false)).not.toHaveProperty("funder_url");
  });
});
