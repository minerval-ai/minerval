import { describe, expect, it } from "vitest";
import { pageOf, workSections } from "../../../web/lib/work-sections";

// The workspace's sidebar lists every page a member works in, in sections, from
// one list (web/lib/work-sections.ts), so every page sits in exactly one section
// and the page being read is marked from its address.
describe("the members' work pages", () => {
  const everything = { permissions: ["read", "direct", "consent", "administer"], clearance: ["public", "finance"] };
  const names = (m: { permissions: string[]; clearance: string[] }) =>
    workSections(m).map((s) => `${s.name ?? "-"}: ${s.pages.map((p) => p.name).join(", ")}`);

  it("puts every page in one section", () => {
    const hrefs = workSections(everything).flatMap((s) => s.pages.map((p) => p.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("finds the section of a page from its address, the longest listed page first", () => {
    const sections = workSections(everything);
    const sectionOf = (path: string) => sections.find((s) => s.pages.some((p) => p.href === pageOf(sections, path)))?.name;
    expect(sectionOf("/admin/outside/requests")).toBe("Public graph");
    expect(sectionOf("/admin/connections/abc")).toBe("Material");
    expect(sectionOf("/admin")).toBe("Admin");
    expect(sectionOf("/admin/owls")).toBe("Admin");
    expect(sectionOf("/releases/abc/pages/def")).toBe("Sharing");
    // The old address, which redirects there.
    expect(sectionOf("/showings/abc/pages/def")).toBe("Sharing");
    expect(sectionOf("/redaction-policies/abc")).toBe("Sharing");
    expect(sectionOf("/file-sets/abc")).toBe("Material");
    expect(sectionOf("/outbound")).toBe("Public graph");
    expect(sectionOf("/admin/outside/reports")).toBe("Public graph");
    expect(sectionOf("/claims/abc")).toBe("Graph");
    expect(sectionOf("/gatesx")).toBeUndefined();
  });

  it("marks the page a path is under, by the longest address", () => {
    const sections = workSections(everything);
    expect(pageOf(sections, "/admin/outside/said-back")).toBe("/admin/outside/said-back");
    expect(pageOf(sections, "/admin/outside")).toBe("/admin/outside");
    expect(pageOf(sections, "/admin/usage-report")).toBe("/admin/budget");
    expect(pageOf(sections, "/gate")).toBe("/gate");
    expect(pageOf(sections, "/gates/abc")).toBe("/gates");
  });

  it("shows a person the pages they can use", () => {
    // Every member has the inbox, the graph, and who holds what with the log of every administrative act.
    expect(names({ permissions: ["read"], clearance: ["public"] })).toEqual([
      "-: Inbox",
      "Graph: Ask, Claims, Mandates, Findings, Requests, Docs",
      "Admin: People, Activity log",
    ]);
    // A reader at a label besides public sees the releases that reach it.
    expect(names({ permissions: ["read"], clearance: ["public", "finance"] })[2]).toBe("Sharing: Releases, Boundaries");
    // Someone who consents for a party reviews, and follows the public graph, since an agent's report goes out through the gate.
    expect(names({ permissions: ["consent"], clearance: ["public"] })).toEqual([
      "-: Inbox, Review",
      "Graph: Ask, Claims, Mandates, Findings, Requests, Docs",
      "Sharing: Releases, Boundaries",
      "Public graph: Overview, Requests, Replies, Outbox",
      "Admin: People, Activity log",
    ]);
    // An administrator has the admin section and the organisation's connections.
    const admin = names({ permissions: ["administer"], clearance: ["public"] });
    expect(admin).toContain("Material: Sources, File sets, Connections");
    expect(admin).toContain("Admin: Health, People, Labels, Parties, Budget, Activity log");
  });
});
