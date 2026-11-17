import { describe, it, expect } from "vitest";
import type { SetupChecklist } from "../../../web/lib/admin-api";
import { logActor, logType } from "../../../web/lib/admin-words";
import { areaTiles, attentionItems, checkCounts, firstLine, labelsWithoutMandate } from "../../../web/lib/health";

// The Health page's short rows (web/lib/health.ts): what needs someone, each
// with a title short enough to scan, who puts it right, and where; and each
// area of the setup as a tile. Everything follows from GET /setup/checklist.

const check = (name: string, status: "pass" | "fail" | "to_do" | "not_applicable" = "pass", blocking = false, message = `${name}.`) => ({
  name,
  status,
  blocking,
  message,
});

/** A deployment with everything in place, at two labels. */
function healthy(): SetupChecklist {
  const own = { id: "p1", name: "Northwind", is_own_organization: true };
  const general = { id: "m1", status: "active", budget_owls: 400, daily_owls: 30, running: true };
  return {
    preflight: {
      holds_private_material: true,
      ready: true,
      agent_work: "allowed",
      checks: [check("database", "pass", true), check("run_log", "pass", true), check("payments", "not_applicable")],
    },
    permissions: [
      { permission: "direct", scope: "none", accounts: 1, groups: 0 },
      { permission: "fund", scope: "none", accounts: 1, groups: 0 },
      { permission: "administer", scope: "none", accounts: 1, groups: 0 },
      { permission: "read", scope: "label", accounts: 1, groups: 0, by_label: [{ label: "board", accounts: 1, groups: 0 }] },
    ],
    labels: [
      { name: "board", reads: [], model_providers_cleared: ["anthropic"], outside_services_cleared: ["embeddings"], roles_not_served: [] },
    ],
    undefined_labels_in_provider_setting: [],
    clearance_fixed_by_settings: false,
    standing_mandates: [
      {
        name: "general",
        title: "General maintenance",
        objective: "Keep the graph sound.",
        mandate: general,
        by_label: [
          { label: "public", mandate: general },
          { label: "board", mandate: general },
        ],
      },
    ],
    owls: { created_here: true, created_total_owls: 1250, spent_total_owls: 312.5, unpriced_models: [] },
    usage_report: { price: "metered", reporting: true, destination: "file", destination_ready: true, prepared: 16, unsent: 0, last_error: null },
    public_graph: {
      account_set: true,
      keep_public_current: { setting: "on", sends: true, in_words: "On." },
      last_not_taken: null,
    },
    connections: { total: 1, on: 1, offering_tools: 1, failing: [], tools_withdrawn: [], credential_missing: [], not_shown: 0 },
    material: { sources: 412, sources_with_no_party: 0, sources_by_party: [{ party: own, sources: 412 }], sources_waiting_for_review: 2, nodes: 3180 },
  };
}

describe("what needs attention", () => {
  it("is nothing when everything is in place", () => {
    expect(attentionItems(healthy())).toEqual([]);
  });

  it("gives each thing a short title, who fixes it, and where, the ones stopping work first", () => {
    const c = healthy();
    c.preflight!.agent_work = "refused";
    c.preflight!.checks.push(
      check("model_prices", "fail", true, "1 configured model has none: MODELS_RESEARCHER (claude-x)."),
      check("web_search", "fail", false, "Open-web search for researcher goes through OpenRouter, and OPENROUTER_API_KEY is not set, so those searches fail."),
      check("standing_mandates", "to_do", false, 'A General mandate is set up at "public", "board". None is set up at "legal", which holds nothing yet.'),
    );
    c.owls.unpriced_models = [{ setting: "MODELS_RESEARCHER", model: "claude-x" }];
    c.labels[0].outside_services_cleared = [];
    c.connections.failing = [{ id: "c1", name: "Acme CRM" }];

    const items = attentionItems(c);
    expect(items.map((i) => [i.title, i.owner, i.tone, i.blocks])).toEqual([
      ["No price for claude-x (MODELS_RESEARCHER)", "operator", "bad", true],
      ["Acme CRM not answering", "admin", "bad", false],
      ["Open-web search fails", "operator", "bad", false],
      ["Embeddings not cleared for board", "admin", "warn", false],
      ["No General mandate at legal", "admin", "warn", false],
    ]);
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    expect(byTitle["Embeddings not cleared for board"].href).toBe("/admin/labels");
    expect(byTitle["No General mandate at legal"].href).toBe("/admin/budget");
    expect(byTitle["Acme CRM not answering"].href).toBe("/admin/connections/c1");
    expect(byTitle["Open-web search fails"].href).toBe("/admin#check-web_search");
    // A check a row already speaks for is not listed twice.
    expect(items.filter((i) => i.key.startsWith("check-")).map((i) => i.key)).toEqual(["check-web_search"]);
    for (const i of items) expect(i.consequence).not.toMatch(/\n/);
  });

  it("says clearance is the operator's where the settings fix it", () => {
    const c = healthy();
    c.clearance_fixed_by_settings = true;
    c.labels[0].outside_services_cleared = [];
    const [item] = attentionItems(c);
    expect(item).toMatchObject({ title: "Embeddings not cleared for board", owner: "operator" });
  });

  it("names a permission nobody holds and a label nobody reads", () => {
    const c = healthy();
    c.permissions[1] = { permission: "fund", scope: "none", accounts: 0, groups: 0 };
    c.permissions[3].by_label = [{ label: "board", accounts: 0, groups: 0 }];
    expect(attentionItems(c).map((i) => [i.title, i.href])).toEqual([
      ["Nobody may fund work", "/admin/people?drawer=grant"],
      ["Nobody reads at board", "/admin/people?drawer=grant"],
    ]);
  });
});

describe("the areas", () => {
  it("are one tile each, the checks left to their own table, each linked to where it is worked on", () => {
    const tiles = areaTiles(healthy());
    expect(tiles.map((t) => [t.name, t.state, t.href])).toEqual([
      ["People", "done", "/admin/people"],
      ["Labels & providers", "done", "/admin/labels"],
      ["Parties", "done", "/admin/parties"],
      ["General mandates", "done", "/admin/budget"],
      ["Owls", "done", "/admin/budget"],
      ["Usage report", "done", "/admin/budget"],
      ["Public graph", "done", "/gates"],
      ["Connections", "done", "/admin/connections"],
      ["Material", "done", "/sources"],
    ]);
    expect(Object.fromEntries(tiles.map((t) => [t.key, t.fact]))).toMatchObject({
      people: "Every permission held",
      parties: "1 party · Northwind is this organisation",
      standing_mandates: "Running at 2 of 2 labels",
      owls: "937.5 unspent of 1,250",
      usage_report: "16 reports prepared, all sent",
      material: "412 sources · 3,180 nodes · 2 waiting for review",
    });
  });
});

describe("small pieces", () => {
  it("reads the labels the mandate check names as having none", () => {
    expect(labelsWithoutMandate('A General mandate is set up at "public". None is set up at "board", "legal", which holds nothing yet.')).toEqual([
      "board",
      "legal",
    ]);
    expect(labelsWithoutMandate("Every label has one.")).toEqual([]);
  });

  it("cuts a message to its first sentence on one line", () => {
    expect(firstLine("First part; second part.")).toBe("First part.");
    expect(firstLine("x".repeat(200)).length).toBe(110);
  });

  it("counts checks by status", () => {
    expect(checkCounts(healthy().preflight!.checks)).toEqual({ pass: 2, fail: 0, to_do: 0, not_applicable: 1 });
  });

  it("sorts the log's acts into kinds, and says who acted where no person did", () => {
    expect(logType({ event: "granted" })).toBe("Access");
    expect(logType({ event: "label_read_added" })).toBe("Labels");
    expect(logType({ event: "provider_clearance_set" })).toBe("Providers");
    expect(logType({ event: "connection_tool_withdrawn" })).toBe("Connections");
    expect(logType({ event: "something_new" })).toBe("Other");
    expect(logActor({ by: "Priya", via: undefined })).toEqual({ key: "by:Priya", name: "Priya", person: true });
    expect(logActor({ by: null, via: "operator" }).name).toBe("Operator key");
    expect(logActor({ by: null }).name).toBe("The deployment");
  });
});
