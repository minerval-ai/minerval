import { describe, expect, it } from "vitest";
import {
  holdersCount,
  holdersInWords,
  readersOf,
  readsIndirectly,
  readsThrough,
  wideningOf,
} from "../../../web/lib/label-chain";

// A label reads what the labels it reads read, followed to the end, as the
// database does (src/db/clearance.ts). The labels page counts and warns from
// this (web/lib/label-chain.ts).

const labels = [
  { name: "public", reads: [] },
  { name: "board", reads: ["finance"] },
  { name: "finance", reads: ["staff"] },
  { name: "staff", reads: [] },
  { name: "legal", reads: [] },
];
const person = (id: string, label: string) => ({ label, account: { id, display_name: id }, group: null });
const grants = [
  person("Mei", "board"),
  person("Tomás", "finance"),
  { label: "finance", account: null, group: "finance-leads" },
  person("Jonas", "staff"),
  person("Ana", "legal"),
];

describe("what a label reads", () => {
  it("follows the pairs to the end, never to itself or public", () => {
    const through = readsThrough(labels);
    expect([...through.get("board")!].sort()).toEqual(["finance", "staff"]);
    expect([...through.get("finance")!]).toEqual(["staff"]);
    expect([...through.get("staff")!]).toEqual([]);
  });

  it("stops at a cycle", () => {
    const cyclic = [
      { name: "a", reads: ["b"] },
      { name: "b", reads: ["a"] },
    ];
    expect([...readsThrough(cyclic).get("a")!]).toEqual(["b"]);
  });

  it("names what a label reads only through another, with the label on the way", () => {
    expect(readsIndirectly("board", labels)).toEqual([{ label: "staff", via: "finance" }]);
    expect(readsIndirectly("finance", labels)).toEqual([]);
  });
});

describe("who reads at a label", () => {
  it("counts those granted at it and at every label that reads it, each once", () => {
    const staff = readersOf("staff", labels, grants);
    expect(holdersCount(staff.direct)).toBe(1);
    expect(holdersCount(staff.all)).toBe(4);
    expect(staff.through.map((t) => t.label).sort()).toEqual(["board", "finance"]);
  });
});

describe("adding a pair", () => {
  it("names each label newly read and who newly reads it", () => {
    // legal reads staff: Ana newly reads staff.
    const w = wideningOf("legal", "staff", labels, grants);
    expect(w.map((x) => x.label)).toEqual(["staff"]);
    expect(holdersInWords(w[0].holders)).toBe("Ana");
  });

  it("follows the chain: staff reading legal widens finance and board too", () => {
    const w = wideningOf("staff", "legal", labels, grants);
    expect(w.map((x) => x.label)).toEqual(["legal"]);
    expect(holdersInWords(w[0].holders)).toBe("Mei, Tomás, Jonas and the group finance-leads");
  });

  it("adds nothing when the label is already read through another", () => {
    expect(wideningOf("board", "staff", labels, grants)).toEqual([]);
  });
});
