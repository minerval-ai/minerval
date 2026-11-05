import { describe, it, expect } from "vitest";

// Mock the db client so importing the service never touches a real pool.
import { vi } from "vitest";
vi.mock("../../../src/db/client.js", () => ({
  getDb: vi.fn(),
  rawQuery: vi.fn(),
}));

import {
  parseClaimLinks,
  hasWrittenForm,
} from "../../../src/services/argument-service.js";

const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("parseClaimLinks", () => {
  it("extracts bare [[claim:<uuid>]] references in order", () => {
    const links = parseClaimLinks(
      `Because [[claim:${A}]] and [[claim:${B}]], the claim follows.`
    );
    expect(links).toEqual([
      { claimId: A, display: null },
      { claimId: B, display: null },
    ]);
  });

  it("extracts the display text of [[claim:<uuid>|inline phrasing]]", () => {
    const links = parseClaimLinks(
      `Given [[claim:${A}|the CMB measurements]], the claim follows.`
    );
    expect(links).toEqual([{ claimId: A, display: "the CMB measurements" }]);
  });

  it("lowercases ids so links match claim uuids regardless of case", () => {
    const links = parseClaimLinks(`[[claim:${A.toUpperCase()}]]`);
    expect(links).toEqual([{ claimId: A, display: null }]);
  });

  it("ignores malformed references", () => {
    expect(parseClaimLinks("[[claim:not-a-uuid]]")).toEqual([]);
    expect(parseClaimLinks(`[claim:${A}]`)).toEqual([]);
    expect(parseClaimLinks("plain prose without links")).toEqual([]);
  });

  it("returns duplicates as written (mutual-checkability counts references)", () => {
    const links = parseClaimLinks(`[[claim:${A}]] and again [[claim:${A}]]`);
    expect(links).toHaveLength(2);
  });
});

describe("hasWrittenForm", () => {
  const label = "The poverty-reduction argument";

  it("is false while the content is still the creation-time label", () => {
    expect(hasWrittenForm({ content: label, description: label })).toBe(false);
    expect(hasWrittenForm({ content: ` ${label}\n`, description: label })).toBe(false);
  });

  it("is true once the content references a subclaim inline", () => {
    expect(
      hasWrittenForm({ content: `Because [[claim:${A}]], the claim follows.`, description: label })
    ).toBe(true);
  });

  // #747: settled premises may live in the prose (§6, §7), so a form with no
  // links is still a form once it is no longer the label.
  it("is true for prose that differs from the label, with no links", () => {
    expect(
      hasWrittenForm({
        content: "Every finite group of prime order is cyclic, so the claim follows by Lagrange's theorem.",
        description: label,
      })
    ).toBe(true);
  });

  it("treats an argument with no label as its own written form", () => {
    expect(hasWrittenForm({ content: "Posted through the API.", description: null })).toBe(true);
    expect(hasWrittenForm({ content: "  ", description: null })).toBe(false);
  });
});
