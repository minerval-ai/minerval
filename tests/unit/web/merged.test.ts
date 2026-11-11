import { describe, it, expect } from "vitest";

// A merged claim's address leads to its survivor's page (#884): the API
// answers a read of the absorbed id with the survivor's record and
// `resolved_from`, and the page redirects, carrying the absorbed id so the
// survivor's page can say where the reader came from.
import { mergedFromParam, mergedFromRelation, mergedRedirectPath } from "../../../web/lib/merged";

const SURVIVOR = "5c25a52c-1a1a-4b2b-8c3c-0d0d0d0d0d0d";
const ALIAS = "edb65b17-29b2-4a3a-9064-7940bcaf287f";
const from = (stance_relation: "same" | "opposed" | null) => ({
  id: ALIAS,
  canonical_form: "The absorbed wording",
  stance_relation,
  merged_at: "2026-11-10T19:08:45.000Z",
});

describe("mergedRedirectPath", () => {
  it("sends a reader of an absorbed claim's address to the survivor, naming where they came from", () => {
    const detail = { claim: { id: SURVIVOR }, resolved_from: from("same") };
    expect(mergedRedirectPath(detail, ALIAS)).toBe(`/claims/${SURVIVOR}?merged_from=${ALIAS}`);
    expect(mergedRedirectPath(detail, ALIAS, "/history")).toBe(
      `/claims/${SURVIVOR}/history?merged_from=${ALIAS}`
    );
    expect(mergedRedirectPath(detail, ALIAS, "/map")).toBe(`/claims/${SURVIVOR}/map?merged_from=${ALIAS}`);
  });

  it("leaves a claim's own address alone", () => {
    expect(mergedRedirectPath({ claim: { id: SURVIVOR } }, SURVIVOR)).toBeNull();
    expect(mergedRedirectPath({ claim: { id: SURVIVOR }, resolved_from: null }, SURVIVOR)).toBeNull();
    expect(mergedRedirectPath(null, ALIAS)).toBeNull();
    // Never a redirect to the address already asked for, whatever its case.
    expect(
      mergedRedirectPath({ claim: { id: SURVIVOR }, resolved_from: from("same") }, SURVIVOR.toUpperCase())
    ).toBeNull();
  });
});

describe("mergedFromParam", () => {
  it("takes a claim id and nothing else", () => {
    expect(mergedFromParam(ALIAS)).toBe(ALIAS);
    expect(mergedFromParam(ALIAS.toUpperCase())).toBe(ALIAS);
    expect(mergedFromParam([ALIAS, SURVIVOR])).toBe(ALIAS);
    expect(mergedFromParam(undefined)).toBeNull();
    expect(mergedFromParam("")).toBeNull();
    expect(mergedFromParam("../../signin")).toBeNull();
    expect(mergedFromParam("<script>")).toBeNull();
  });
});

describe("mergedFromRelation", () => {
  it("tells the reader when the claim they followed stated the opposite", () => {
    expect(mergedFromRelation(from("opposed"))).toContain("stated the opposite of this claim");
    expect(mergedFromRelation(from("same"))).toBe("It stated the same proposition.");
    expect(mergedFromRelation(from(null))).toContain("does not say");
  });
});
