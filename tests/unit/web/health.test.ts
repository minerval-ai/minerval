import { describe, it, expect } from "vitest";
import type { SetupChecklist } from "../../../web/lib/admin-api";
import { LOG_TYPES, LOG_TYPE_WORDS, logActor, logType } from "../../../web/lib/admin-words";
import { LOG_TYPES as API_LOG_TYPES } from "../../../src/services/permission-service";
import { areaTiles, attentionItems, checkCounts, firstLine, labelsWithoutMandate, partiesReleasedByNobody, roleOfSetting } from "../../../web/lib/health";

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
      check("model_prices", "fail", false, "1 configured model has none: MODELS_RESEARCHER (claude-x)."),
      check("web_search", "fail", false, "Open-web search for researcher goes through OpenRouter, and OPENROUTER_API_KEY is not set, so those searches fail."),
      check("standing_mandates", "to_do", false, 'A General mandate is set up at "public", "board". None is set up at "legal", which holds nothing yet.'),
    );
    c.owls.unpriced_models = [{ setting: "MODELS_RESEARCHER", model: "claude-x" }];
    c.labels[0].outside_services_cleared = [];
    c.connections.failing = [{ id: "c1", name: "Acme CRM" }];

    const items = attentionItems(c);
    expect(items.map((i) => [i.title, i.owner, i.tone, i.blocks])).toEqual([
      ["No price for claude-x (MODELS_RESEARCHER)", "operator", "bad", false],
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

  it("says when pages are released outside and the key they are signed with was never registered from here", () => {
    const c = healthy();
    c.public_graph!.signing_key = { shown_outside: 2, fingerprint: "ab12", registered_from_here_at: null };
    expect(attentionItems(c).map((i) => [i.title, i.owner, i.href])).toEqual([["Signing key not registered", "admin", "/admin/outside?drawer=key"]]);
    // Registered from here, nothing released outside, no key, or no route to the public graph: nothing to say.
    for (const change of [
      () => (c.public_graph!.signing_key!.registered_from_here_at = "2026-11-01T00:00:00Z"),
      () => (c.public_graph!.signing_key = { shown_outside: 0, fingerprint: "ab12", registered_from_here_at: null }),
      () => (c.public_graph!.signing_key = { shown_outside: 2, fingerprint: null, registered_from_here_at: null }),
      () => {
        c.public_graph!.signing_key = { shown_outside: 2, fingerprint: "ab12", registered_from_here_at: null };
        c.public_graph!.account_set = false;
      },
    ]) {
      change();
      expect(attentionItems(c)).toEqual([]);
      c.public_graph!.account_set = true;
      c.public_graph!.signing_key = { shown_outside: 2, fingerprint: "ab12", registered_from_here_at: null };
    }
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

  it("names the log's kinds as the API gives them, and says who acted, by the key the API filters by", () => {
    expect(logType({ type: "access" })).toBe("Access");
    expect(logType({ type: "file_sets" })).toBe("File sets");
    expect(logType({ type: "something_new" })).toBe("Other");
    // Every kind the API gives an entry has a word here.
    for (const kind of API_LOG_TYPES) expect(LOG_TYPE_WORDS[kind], kind).toBeDefined();
    expect([...LOG_TYPES].sort()).toEqual([...API_LOG_TYPES].sort());
    const id = "11111111-1111-4111-8111-111111111111";
    expect(logActor({ by: "Priya", by_id: id, via: undefined })).toEqual({ key: id, name: "Priya", person: true });
    expect(logActor({ by: null, via: "operator" })).toMatchObject({ key: "operator", name: "Operator key" });
    expect(logActor({ by: null, via: "first_administrator" }).key).toBe("first_administrator");
    expect(logActor({ by: null })).toMatchObject({ key: "deployment", name: "The deployment" });
  });
});

describe("a model setting's role", () => {
  it("names the role a model setting sets", () => {
    expect(roleOfSetting("MODELS_RESEARCHER")).toBe("The researcher role");
    expect(roleOfSetting("STEWARD_MODEL")).toBe("The steward role");
    expect(roleOfSetting("MODELS_PROGRAM_OFFICER")).toBe("The program officer role");
  });
});

describe("parties nobody can consent for", () => {
  const gate = (settings: Array<{ mode: string; party: { id: string } | null }>, starting: Record<string, string> = { page: "redactor" }) => ({
    from: "board",
    to: "public",
    to_outside: false,
    starting_positions: starting,
    settings,
  });
  /** Consent is held for the own organisation; nobody holds it for Halvorsen. */
  function withParties(): SetupChecklist {
    const c = healthy();
    c.permissions.push({
      permission: "release",
      scope: "party",
      accounts: 1,
      groups: 0,
      by_party: [
        { party: { id: "p1", name: "Northwind" }, accounts: 1, groups: 0 },
        { party: { id: "p2", name: "Halvorsen" }, accounts: 0, groups: 0 },
      ],
    });
    return c;
  }

  it("names a party nobody can consent for where a person decides for it", () => {
    const found = partiesReleasedByNobody(withParties(), [gate([{ mode: "person", party: { id: "p2" } }])]);
    expect(found).toEqual([{ party: { id: "p2", name: "Halvorsen" }, boundaries: ["board → public"] }]);
    const rows = attentionItems(withParties(), [gate([{ mode: "person", party: null }])]);
    expect(rows.find((r) => r.key === "release-nobody-p2")).toMatchObject({ title: "Nobody can consent for Halvorsen", owner: "admin", action: "Grant" });
  });

  it("says nothing where the Redactor decides, or where somebody consents", () => {
    expect(partiesReleasedByNobody(withParties(), [gate([{ mode: "redactor", party: { id: "p2" } }])])).toEqual([]);
    expect(partiesReleasedByNobody(withParties(), [gate([{ mode: "person", party: { id: "p1" } }])])).toEqual([]);
  });
});
