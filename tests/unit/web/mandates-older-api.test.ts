import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../../../web/node_modules/server-only/index.js", () => ({}));

// The web app and the API deploy separately. For a while after a release the
// Mandates list can be reading an API from before the list had counts, which
// answers with the mandates alone; the page must show them, not fall over.
describe("a list of mandates from an older API", () => {
  it("is counted from its rows", async () => {
    const { normalizeMandatesPage } = await import("../../../web/lib/account-api");
    const page = normalizeMandatesPage({
      mandates: [
        { id: "a", is_platform: true, status: "active" },
        { id: "b", is_platform: false, status: "active" },
      ] as never,
    });
    expect(page.total).toBe(2);
    expect(page.states).toMatchObject({ any: 2, active: 2, paused: 0, finished: 0 });
    expect(page.scopes).toEqual({ all: 2, platform: 1, mine: null });
    expect(page.mandates[0]).toMatchObject({ budget_status: "running", assessments: 0, updated_at: null });
  });

  it("leaves a whole answer as it came", async () => {
    const { normalizeMandatesPage } = await import("../../../web/lib/account-api");
    const whole = {
      mandates: [],
      total: 40,
      states: { live: 30, any: 40, active: 28, paused: 2, finished: 10, needs_you: 1 },
      scopes: { all: 40, platform: 6, mine: 3 },
    };
    expect(normalizeMandatesPage(whole)).toEqual(whole);
  });
});
