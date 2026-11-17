import { describe, expect, it } from "vitest";
import { pageOf, workSections } from "../../../web/lib/work-sections";

// The workspace's sidebar lists every page a member works in, in sections, from
// one list (web/lib/work-sections.ts), so every page sits in exactly one section
// and the page being read is marked from its address.
describe("the members' work pages", () => {
  const everything = { permissions: ["read", "direct", "release", "administer"], clearance: ["public", "finance"] };
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
    // Every member has the inbox and the graph; nothing else for one who only reads public.
    expect(names({ permissions: ["read"], clearance: ["public"] })).toEqual([
      "-: Inbox",
      "Graph: Ask, Claims, Mandates, Findings, Requests, Docs",
    ]);
    // A reader at a label besides public sees the showings that reach it.
    expect(names({ permissions: ["read"], clearance: ["public", "finance"] })[2]).toBe("Sharing: Showings, Boundaries");
    // A release holder reviews, and follows the public graph, since an agent's report goes out through the gate.
    expect(names({ permissions: ["release"], clearance: ["public"] })).toEqual([
      "-: Inbox, Review",
      "Graph: Ask, Claims, Mandates, Findings, Requests, Docs",
      "Sharing: Showings, Boundaries",
      "Public graph: Overview, Requests, Replies, Outbox",
    ]);
    // An administrator has the admin section and the organisation's connections.
    const admin = names({ permissions: ["administer"], clearance: ["public"] });
    expect(admin).toContain("Material: Sources, File sets, Connections");
    expect(admin).toContain("Admin: Health, People, Labels, Parties, Budget, Activity log");
  });
});
