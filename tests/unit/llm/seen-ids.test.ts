import { describe, it, expect } from "vitest";

/**
 * The run's record of the ids it has been shown, and the one rule for
 * reading a mistyped id against it (llm/seen-ids.ts, #934). The ids in the
 * repair cases are the shapes the agents' own reports quoted: one hex digit
 * too many (#934), one too few (#952), one changed (#935 and the sightings
 * on #934), and #470's splice of one id's head onto another's tail.
 */

import {
  SeenIds,
  describeIdShape,
  editDistance,
  observeRun,
  resolveId,
  seenIdsInRun,
  withinOneEdit,
} from "../../../src/llm/seen-ids.js";

const A = "1ea1a55c-1361-4685-991b-3c303c74c323";
const B = "e15a36f4-edf3-45c5-92d9-85fceae51900";
const C = "27bd8b54-6c1c-49e7-8600-3bfc2e811801";
const D = "f02c5d2d-bc3e-43ab-9dba-f9546f1a856e";

describe("SeenIds: what a run has been shown", () => {
  it("collects every id in a tool result, with the wording beside it", () => {
    const record = new SeenIds();
    record.addToolOutput(
      JSON.stringify({
        count: 1,
        results: [{ id: A, canonical_form: "Scheming evaluations are contrived.", page_url: `https://x/claims/${A}` }],
      })
    );
    record.addToolOutput(
      JSON.stringify({
        claim: { id: B, canonical_form: "B's wording" },
        assessment: { id: C, status: "supported" },
        subclaims: [{ id: D, edge_id: "99999999-9999-4999-8999-999999999999", text: "D's wording" }],
      })
    );
    expect(record.get(A)).toMatchObject({ text: "Scheming evaluations are contrived.", seenAs: ["results.id"] });
    expect(record.get(B)).toMatchObject({ text: "B's wording", seenAs: ["claim.id"] });
    // An assessment's id is recorded, with no wording, as what it is.
    expect(record.get(C)).toMatchObject({ text: null, seenAs: ["assessment.id"] });
    expect(record.get(D)!.text).toBe("D's wording");
    expect(record.get("99999999-9999-4999-8999-999999999999")!.seenAs).toEqual(["subclaims.edge_id"]);
    expect(record.size).toBe(5);
  });

  it("takes a claim_id row's text, a parent_id's parent_text, and ids in prose", () => {
    const record = new SeenIds();
    record.addToolOutput(JSON.stringify({ claims: [{ claim_id: A, text: "listed" }] }));
    record.addToolOutput(JSON.stringify({ parents: [{ parent_id: B, parent_text: "the parent" }] }));
    record.addToolOutput(`Linked ${C} <-> ${D}.`);
    expect(record.get(A)!.text).toBe("listed");
    expect(record.get(B)!.text).toBe("the parent");
    expect(record.has(C) && record.has(D)).toBe(true);
  });

  it("records nothing from a miss, nor the id a correction echoes", () => {
    const record = new SeenIds();
    record.addToolOutput(JSON.stringify({ code: "CLAIM_NOT_FOUND", error: `No node has the id "${A}".`, requested_id: A }));
    record.addToolOutput(
      JSON.stringify({ id_corrected: { requested_id: `0${B.slice(1)}`, resolved_id: B }, claim: { id: B } })
    );
    expect(record.has(A)).toBe(false);
    expect(record.has(`0${B.slice(1)}`)).toBe(false);
    expect(record.has(B)).toBe(true);
  });

  it("reads the opening messages: the prompt's text and a resumed transcript's tool results", () => {
    const record = new SeenIds();
    record.addMessages([
      { role: "user", content: `Steward claim ${A}.` },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search_claims", input: { query: "q" } }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ results: [{ id: B, canonical_form: "b" }] }) }],
      },
    ]);
    expect(record.has(A)).toBe(true);
    expect(record.get(B)!.text).toBe("b");
  });

  it("ignores case and surrounding space", () => {
    const record = new SeenIds();
    record.add(A.toUpperCase());
    expect(record.has(` ${A} `)).toBe(true);
  });

  it("ranks the nearest ids by edit distance", () => {
    const record = new SeenIds();
    for (const id of [A, B, C, D]) record.add(id);
    const typo = `${C.slice(0, 35)}0`;
    expect(record.nearest(typo, 2)[0]!.id).toBe(C);
  });
});

describe("resolveId: the one rule", () => {
  const known = [A, B, C, D];

  it("hits an id as given", () => {
    expect(resolveId(known, A)).toEqual({ kind: "exact", id: A });
    expect(resolveId(known, A.toUpperCase())).toEqual({ kind: "exact", id: A });
  });

  it("repairs one hex digit too many (#934)", () => {
    expect(resolveId(known, `${A}6`)).toEqual({ kind: "repaired", id: A, rule: "one_character" });
  });

  it("repairs one hex digit too few (#952)", () => {
    expect(resolveId(known, B.slice(0, -1))).toMatchObject({ kind: "repaired", id: B });
  });

  it("repairs one hex digit changed (#935)", () => {
    const changed = `${C.slice(0, 35)}0`;
    expect(resolveId(known, changed)).toEqual({ kind: "repaired", id: C, rule: "one_character" });
    // Changed inside the first group: only the one-character rule finds it.
    const early = `0${C.slice(1)}`;
    expect(resolveId(known, early)).toEqual({ kind: "repaired", id: C, rule: "one_character" });
  });

  it("repairs a splice and a bare first group by the first group (#470)", () => {
    expect(resolveId(known, `${D.slice(0, 8)}${A.slice(8)}`)).toMatchObject({ kind: "repaired", id: D, rule: "first_group" });
    expect(resolveId(known, D.slice(0, 8))).toMatchObject({ kind: "repaired", id: D });
  });

  it("does not guess between two candidates", () => {
    const twinA = "5b6a73ad-ba15-47ca-b86f-8a401fcb0848";
    const twinB = "5b6a73ad-1111-4222-8333-444444444444";
    const r = resolveId([...known, twinA, twinB], "5b6a73ad-9999-4999-8999-999999999999");
    expect(r).toEqual({ kind: "ambiguous", candidates: [twinA, twinB] });
    // Two ids one character from the typo, under different rules, are two candidates too.
    const x = "aaaaaaaa-0000-4000-8000-000000000001";
    const y = "baaaaaaa-0000-4000-8000-000000000000";
    expect(resolveId([x, y], "aaaaaaaa-0000-4000-8000-000000000000").kind).toBe("ambiguous");
  });

  it("finds nothing for an id like none of them", () => {
    expect(resolveId(known, "deadbeef-0000-4000-8000-000000000000")).toEqual({ kind: "none" });
    expect(resolveId(known, "")).toEqual({ kind: "none" });
    expect(resolveId(known, undefined)).toEqual({ kind: "none" });
    // Two characters off is not one.
    expect(resolveId(known, `${A}66`)).toMatchObject({ kind: "repaired", rule: "first_group" });
    expect(resolveId([A], `0${A.slice(1)}6`)).toEqual({ kind: "none" });
  });

  it("leaves the id itself out when asked, for a read that already missed", () => {
    expect(resolveId([A, `${A.slice(0, 35)}0`], A, { excludeExact: true })).toMatchObject({
      kind: "repaired",
      id: `${A.slice(0, 35)}0`,
    });
  });
});

describe("the helpers", () => {
  it("withinOneEdit and editDistance agree on the cases", () => {
    expect(withinOneEdit("abc", "abc")).toBe(true);
    expect(withinOneEdit("abc", "abxc")).toBe(true);
    expect(withinOneEdit("abc", "ab")).toBe(true);
    expect(withinOneEdit("abc", "axc")).toBe(true);
    expect(withinOneEdit("abc", "bac")).toBe(false);
    expect(editDistance("abc", "bac")).toBe(2);
    expect(editDistance(A, `${A}6`)).toBe(1);
  });

  it("describes what is wrong with an id's shape", () => {
    expect(describeIdShape(A)).toBeNull();
    expect(describeIdShape("1ea1a55c-1361-4685-991b-3c303c74c3236")).toBe(
      "its last group has 13 hex digits, where a uuid has 12"
    );
    expect(describeIdShape("e15a36f4-edf3-45c5-92d9-85fceae5190")).toBe(
      "its last group has 11 hex digits, where a uuid has 12"
    );
    expect(describeIdShape("edb65b17")).toContain("1 hyphen-separated group");
    expect(describeIdShape("zzzzzzzz-1361-4685-991b-3c303c74c323")).toContain('first group "zzzzzzzz" is not all hex digits');
  });

  it("observeRun runs each tool inside the record and then records its result", async () => {
    const { record, call } = observeRun([{ role: "user", content: `about ${A}` }]);
    expect(record.has(A)).toBe(true);
    let inScope: unknown = null;
    await call(async () => {
      inScope = seenIdsInRun();
      return JSON.stringify({ id: B, canonical_form: "b" });
    });
    expect(inScope).toBe(record);
    expect(record.get(B)!.text).toBe("b");
    expect(seenIdsInRun()).toBeNull();
  });
});
