import { describe, expect, it } from "vitest";
import { pageOf, workSections } from "../../../web/components/inside/nav";

// The band names the sections, the column down the side lists the pages of one;
// both come from one list, so every page sits in exactly one section.
describe("the members' work pages", () => {
  const everything = { permissions: ["read", "direct", "release", "administer"], clearance: ["public", "finance"] };

  it("puts every page in one section", () => {
    const hrefs = workSections(everything).flatMap((s) => s.pages.map((p) => p.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("finds the section of a page from its address, the longest listed page first", () => {
    const sections = workSections(everything);
    const sectionOf = (path: string) => sections.find((s) => s.pages.some((p) => p.href === pageOf(sections, path)))?.name;
    expect(sectionOf("/admin/outside/requests")).toBe("The public graph");
    expect(sectionOf("/admin/connections/abc")).toBe("Administration");
    expect(sectionOf("/admin")).toBe("Administration");
    expect(sectionOf("/showings/abc/pages/def")).toBe("Showings");
    expect(sectionOf("/file-sets/abc")).toBe("Material");
    expect(sectionOf("/outbound")).toBe("The public graph");
    expect(sectionOf("/gatesx")).toBeUndefined();
    expect(sectionOf("/claims")).toBeUndefined();
  });
});
