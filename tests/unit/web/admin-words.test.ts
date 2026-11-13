import { describe, it, expect } from "vitest";
import type { SetupChecklist } from "../../../web/lib/admin-api";
import {
  checklistItems,
  grantText,
  itemsNeedingSomeone,
  labelClearanceFacts,
  logSentence,
  needsPermission,
  preflightTitle,
  preflightTodo,
  toolMarking,
} from "../../../web/lib/admin-words";

// The words of the administration pages (web/lib/admin-words.ts): what the
// setup checklist says for a deployment in a given state, and how an entry of
// the log reads. The checklist decides nothing a person could have ticked: its
// states follow from what GET /setup/checklist answered.

const passing = (name: string) => ({ name, status: "pass" as const, blocking: false, message: `${name} is fine.` });

/** A deployment on its first day: one administrator, and nothing else set up. */
function dayOne(): SetupChecklist {
  return {
    preflight: {
      holds_private_material: false,
      ready: true,
      agent_work: "allowed",
      checks: [passing("database"), passing("run_log"), { ...passing("page_reading"), status: "not_applicable" }],
    },
    permissions: [
      { permission: "direct", scope: "none", accounts: 1, groups: 0 },
      { permission: "release", scope: "party", accounts: 0, groups: 0, by_party: [] },
      { permission: "fund", scope: "none", accounts: 1, groups: 0 },
      { permission: "read", scope: "label", accounts: 0, groups: 0, by_label: [] },
      { permission: "read_sources", scope: "label", accounts: 0, groups: 0, by_label: [] },
      { permission: "administer", scope: "none", accounts: 1, groups: 0 },
    ],
    labels: [],
    undefined_labels_in_provider_setting: [],
    standing_mandates: [
      { name: "general", title: "General maintenance", objective: "Keep the graph sound.", mandate: null },
      { name: "governance", title: "Governance", objective: "Pay for the audits.", mandate: null },
    ],
    owls: { created_here: true, created_total_owls: 0, spent_total_owls: 0, unpriced_models: [] },
    usage_report: {
      price: "metered",
      reporting: true,
      destination: "none",
      destination_ready: false,
      prepared: 0,
      unsent: 0,
      last_error: null,
    },
    connections: { total: 0, on: 0, offering_tools: 0, failing: [], tools_withdrawn: [], credential_missing: [], not_shown: 0 },
    material: { sources: 0, sources_with_no_party: 0, sources_by_party: [], sources_waiting_for_review: 0, nodes: 0 },
  };
}

/** The same deployment once everything is in place. */
function setUp(): SetupChecklist {
  const c = dayOne();
  const halden = { id: "p1", name: "Halden Evaluations", is_own_organization: true };
  return {
    ...c,
    preflight: { ...c.preflight!, holds_private_material: true },
    permissions: [
      { permission: "direct", scope: "none", accounts: 2, groups: 0 },
      { permission: "release", scope: "party", accounts: 1, groups: 0, by_party: [{ party: halden, accounts: 1, groups: 0 }] },
      { permission: "fund", scope: "none", accounts: 1, groups: 1 },
      { permission: "read", scope: "label", accounts: 2, groups: 1, by_label: [{ label: "internal", accounts: 2, groups: 1 }] },
      { permission: "read_sources", scope: "label", accounts: 0, groups: 0, by_label: [{ label: "internal", accounts: 0, groups: 0 }] },
      { permission: "administer", scope: "none", accounts: 1, groups: 0 },
    ],
    labels: [
      {
        name: "internal",
        reads: [],
        model_providers_cleared: ["anthropic"],
        outside_services_cleared: ["embeddings"],
        roles_not_served: [],
      },
    ],
    standing_mandates: c.standing_mandates.map((m) => ({
      ...m,
      mandate: { id: `m-${m.name}`, status: "active", budget_owls: 400, daily_owls: 30, running: true },
    })),
    owls: { created_here: true, created_total_owls: 560, spent_total_owls: 16.45, unpriced_models: [] },
    usage_report: { ...c.usage_report, destination: "file", destination_ready: true, prepared: 3, unsent: 0 },
    connections: { total: 1, on: 1, offering_tools: 1, failing: [], tools_withdrawn: [], credential_missing: [], not_shown: 0 },
    material: {
      sources: 2,
      sources_with_no_party: 0,
      sources_by_party: [{ party: halden, sources: 2 }],
      sources_waiting_for_review: 1,
      nodes: 7,
    },
  };
}

const states = (c: SetupChecklist) => Object.fromEntries(checklistItems(c).map((i) => [i.key, i.state]));

describe("the setup checklist", () => {
  it("on day one says what is to do, in the order a deployment is set up, and who can do it", () => {
    const items = checklistItems(dayOne());
    expect(items.map((i) => i.key)).toEqual([
      "checks",
      "people",
      "labels",
      "parties",
      "standing_mandates",
      "owls",
      "usage_report",
      "connections",
      "material",
    ]);
    expect(states(dayOne())).toEqual({
      checks: "done",
      people: "done",
      labels: "to_do",
      parties: "to_do",
      standing_mandates: "to_do",
      owls: "to_do",
      usage_report: "to_do",
      // Nothing is connected, and nothing has to be.
      connections: "optional",
      material: "to_do",
    });
    const material = items.find((i) => i.key === "material")!;
    expect(material.facts).toEqual(["Nothing has been read yet."]);
    expect(material.next).toBe(
      "Anyone who holds the permission to direct the graph can add a document or an address. An administrator can connect a system."
    );
    // Every item that is not in place names a next act.
    for (const item of items.filter((i) => i.state !== "done")) expect(item.next, item.key).toBeTruthy();
    // An optional item is not among what needs someone.
    expect(itemsNeedingSomeone(items).map((i) => i.key)).not.toContain("connections");
  });

  it("is all in place once the deployment can see that it is", () => {
    expect(new Set(Object.values(states(setUp())))).toEqual(new Set(["done"]));
    expect(itemsNeedingSomeone(checklistItems(setUp()))).toEqual([]);
    const material = checklistItems(setUp()).find((i) => i.key === "material")!;
    expect(material.facts).toEqual([
      "2 sources and 7 claims, quantities and questions.",
      "1 submitted source is waiting for review before anything is read from it.",
    ]);
  });

  it("puts what is stopping work first: a failed check that agent work waits on", () => {
    const c = setUp();
    c.preflight = {
      ...c.preflight!,
      ready: false,
      agent_work: "refused",
      checks: [{ name: "run_log", status: "fail", blocking: true, message: "The run log is in best-effort mode." }],
    };
    c.owls.created_total_owls = 0;
    const needing = itemsNeedingSomeone(checklistItems(c));
    expect(needing.map((i) => [i.key, i.state])).toEqual([
      ["checks", "attention"],
      ["owls", "to_do"],
    ]);
    expect(needing[0]!.facts).toContain("Agent work is not started: a check that must pass first has failed.");
  });

  it("says which permission nobody holds, and what follows from that", () => {
    const c = setUp();
    c.permissions.find((p) => p.permission === "fund")!.accounts = 0;
    c.permissions.find((p) => p.permission === "fund")!.groups = 0;
    const people = checklistItems(c).find((i) => i.key === "people")!;
    expect(people.state).toBe("to_do");
    expect(people.facts).toContain("Fund work: nobody.");
    expect(people.next).toBe(
      "Nobody holds the permission to fund work, so no work can be funded. An administrator grants permissions."
    );
    // Release and raw sources held by nobody are said, and are not counted as to do.
    const c2 = setUp();
    expect(checklistItems(c2).find((i) => i.key === "people")!.facts).toContain("Open raw sources at internal: nobody.");
    expect(states(c2).people).toBe("done");
  });

  it("names what a label is not cleared for, and a setting that names a label nobody defined", () => {
    const label = {
      name: "restricted",
      reads: ["internal"],
      model_providers_cleared: ["anthropic", "endpoint:local"],
      outside_services_cleared: [],
      roles_not_served: [
        { role: "matcher", model: "gpt-5", provider: "openai" },
        { role: "program_officer", model: "gpt-5", provider: "openai" },
      ],
    };
    expect(labelClearanceFacts(label)).toEqual([
      'restricted: cleared for Anthropic and the deployment\'s own endpoint "local".',
      "At restricted, the work of these roles is refused, because the provider their model runs on is not cleared for it: matcher and program officer (OpenAI).",
      "Embeddings are not cleared for restricted, so what is written at this label cannot be matched against the graph or searched by meaning.",
    ]);
    expect(labelClearanceFacts({ ...label, model_providers_cleared: [] })).toEqual([
      "restricted: no model provider is cleared for it, so no agent can work at this label yet.",
    ]);

    const c = setUp();
    c.undefined_labels_in_provider_setting = ["intenal"];
    const labels = checklistItems(c).find((i) => i.key === "labels")!;
    expect(labels.state).toBe("attention");
    expect(labels.facts[1]).toBe("Until that is put right, every call to a model provider is refused, at every label.");
  });

  it("never calls created owls bought, and says so where they are bought", () => {
    const created = checklistItems(setUp()).find((i) => i.key === "owls")!;
    expect(created.facts[0]).toBe(
      "This deployment creates its own owls: 560 owls created so far, 16.45 owls spent by its agents' runs."
    );
    const c = setUp();
    c.owls = { created_here: false, created_total_owls: null, spent_total_owls: null, unpriced_models: [] };
    expect(checklistItems(c).find((i) => i.key === "owls")!.facts).toEqual([
      "Owls here are bought, as on the public graph. Nobody creates them.",
    ]);
    const unpriced = setUp();
    unpriced.owls.unpriced_models = [{ setting: "MATCHER_MODEL", model: "gpt-oss-120b" }];
    const item = checklistItems(unpriced).find((i) => i.key === "owls")!;
    expect(item.state).toBe("attention");
    expect(item.facts[1]).toContain("gpt-oss-120b (MATCHER_MODEL)");
  });
});

describe("a build with no preflight, and a deployment that holds material at more than one label", () => {
  it("says the build does not check its own configuration, and marks nothing as passed", () => {
    const c = dayOne();
    c.preflight = null;
    const checks = checklistItems(c).find((item) => item.key === "checks")!;
    expect(checks.state).toBe("not_reported");
    expect(checks.facts).toEqual([
      "This build does not check its own configuration, so nothing is reported here. The lines below are read from the deployment as it runs.",
    ]);
    expect(checks.next).toBeUndefined();
  });

  it("says of each standing mandate at which labels it is set up, and what a label with none goes without", () => {
    const c = dayOne();
    const state = { id: "m1", status: "active", budget_owls: 40, daily_owls: 0, running: true };
    c.standing_mandates = [
      { name: "general", title: "General maintenance", objective: "", mandate: state, by_label: [{ label: "internal", mandate: state }, { label: "public", mandate: null }] },
      { name: "governance", title: "Governance", objective: "", mandate: null, by_label: [{ label: "internal", mandate: null }, { label: "public", mandate: null }] },
    ];
    const item = checklistItems(c).find((i) => i.key === "standing_mandates")!;
    expect(item.state).toBe("to_do");
    expect(item.facts).toEqual([
      "General maintenance at internal: set up with a budget of 40 owls.",
      "General maintenance at public: not set up. Until it is, upkeep has no mandate to pay for it at the label public.",
      "Governance at internal: not set up. Until it is, audits have no mandate to pay for it at the label internal.",
      "Governance at public: not set up. Until it is, audits have no mandate to pay for it at the label public.",
    ]);
  });

  it("says how many connections an administrator is not shown", () => {
    const c = dayOne();
    c.connections = { ...c.connections, not_shown: 2 };
    const item = checklistItems(c).find((i) => i.key === "connections")!;
    expect(item.facts).toEqual([
      "No system is connected at a label you read.",
      "2 more connections are at labels you do not read, and are not counted here. An administrator who reads those labels sees them.",
    ]);
  });
});

describe("the preflight's checks, in the page's words", () => {
  it("names each check plainly and adds what to do only where the check's own sentence does not say", () => {
    expect(preflightTitle({ name: "work_outside_the_run_log" })).toBe("Work that leaves no log");
    expect(preflightTitle({ name: "a_check_added_later" })).toBe("A check added later");
    expect(preflightTodo({ name: "embeddings", status: "fail" })).toBe(
      "Set OPENAI_API_KEY in the environment the API runs in."
    );
    expect(preflightTodo({ name: "embeddings", status: "pass" })).toBeNull();
    expect(preflightTodo({ name: "run_log", status: "fail" })).toBeNull();
  });
});

describe("the log, as sentences", () => {
  const at = "2026-11-12T04:14:00.000Z";

  it("says who granted what to whom, at which label or for which party", () => {
    expect(logSentence({ event: "granted", at, by: "Alice", permission: "read", account: "Bob", label: "internal" })).toBe(
      "Alice granted Bob the permission to read at internal."
    );
    expect(
      logSentence({ event: "removed", at, by: "Alice", permission: "release", group: "reviewers", party: "Orrin Labs" })
    ).toBe("Alice removed from the group reviewers the permission to release the material of Orrin Labs.");
    expect(
      logSentence({ event: "granted", at, by: null, via: "first_administrator", permission: "administer", account: "Alice" })
    ).toBe("The deployment's first-administrator setting granted Alice the permission to administer the deployment.");
  });

  it("shows a withheld name as withheld, and still says that the act happened", () => {
    const withheld = { withheld: true as const };
    expect(logSentence({ event: "granted", at, by: "Alice", permission: "read", account: "Alice", label: withheld })).toBe(
      "Alice granted Alice the permission to read at a label whose name is withheld from you."
    );
    expect(logSentence({ event: "label_defined", at, by: "Alice", label: withheld })).toBe(
      "Alice defined a label whose name is withheld from you."
    );
    expect(logSentence({ event: "party_added", at, by: "Alice", party: withheld })).toBe(
      "Alice added a party whose name is withheld from you."
    );
    expect(logSentence({ event: "connection_added", at, by: "Alice", connection: withheld })).toBe(
      "Alice added a connection whose name is withheld from you."
    );
  });

  it("covers labels, parties, connections, owls and the standing mandates", () => {
    expect(logSentence({ event: "label_read_added", at, by: "Alice", label: "restricted", reads: "internal" })).toBe(
      "Alice recorded that restricted reads internal."
    );
    expect(
      logSentence({ event: "source_party_set", at, by: "Alice", party: "Halden Evaluations", previous_party: null })
    ).toBe("Alice recorded a source as the material of Halden Evaluations; before, it was that of no party.");
    expect(
      logSentence({ event: "connection_tool_withdrawn", at, by: null, connection: "Finance warehouse", tool: "report", reason: "changed" })
    ).toBe('The tool report on the connection "Finance warehouse" was withdrawn from agents, because it changed at the system.');
    expect(
      logSentence({ event: "owls_created", at, by: "Alice", amount_owls: 100, account: "Dave", note: "For the first mandates" })
    ).toBe("Alice created 100 owls into Dave's balance. Note: For the first mandates");
    expect(
      logSentence({ event: "standing_mandate_created", at, by: "Alice", amount_owls: 60, mandate: { id: "m", title: "Governance" } })
    ).toBe("Alice set up the mandate Governance, creating 60 owls as its budget.");
    // An act added to the API later still reads as something that happened.
    expect(logSentence({ event: "something_new", at, by: "Alice" })).toBe("Alice: something new.");
  });
});

describe("small words", () => {
  it("says which permission a page needs and who grants it", () => {
    expect(needsPermission("direct")).toBe(
      "This page needs the permission to direct the graph, which you do not hold. An administrator of this deployment grants it."
    );
    expect(grantText({ permission: "read_sources", label: "internal" })).toBe("open raw sources at internal");
    expect(grantText({ permission: "release", party: { name: "Orrin Labs" } })).toBe("release for Orrin Labs");
  });

  it("gives a server's marking of a tool as the hint it is", () => {
    expect(toolMarking({ read_only_hint: true, marked_as_writing: false })).toMatch(/a hint\.$/);
    expect(toolMarking({ read_only_hint: null, marked_as_writing: false })).toMatch(/your judgment of the system\.$/);
    expect(toolMarking({ read_only_hint: false, marked_as_writing: true })).toMatch(/cannot be picked\.$/);
  });
});
