import { describe, it, expect } from "vitest";

// The claim page's instances: the voices that assert, deny or pose the
// claim, and apart from them the sources that only mention it. A mention is
// provenance, never a vote, so it is never listed or counted with the voices.
import { splitInstances, stanceTag } from "../../../web/lib/instances";
import type { Instance } from "../../../web/lib/types";

const inst = (id: string, stance?: Instance["stance"]) => ({ id, stance });

describe("splitInstances", () => {
  it("puts mentions in their own group and keeps the served order within each", () => {
    const { voices, mentions } = splitInstances([
      inst("a", "affirms"),
      inst("m1", "mentions"),
      inst("d", "denies"),
      inst("p", "poses"),
      inst("m2", "mentions"),
      inst("legacy"),
    ]);
    expect(voices.map((i) => i.id)).toEqual(["a", "d", "p", "legacy"]);
    expect(mentions.map((i) => i.id)).toEqual(["m1", "m2"]);
  });

  it("leaves the voices empty when every source only mentions the claim", () => {
    const { voices, mentions } = splitInstances([inst("m1", "mentions"), inst("m2", "mentions")]);
    expect(voices).toEqual([]);
    expect(mentions).toHaveLength(2);
  });
});

describe("stanceTag", () => {
  it("tags a denial, an open question and a mention, and leaves an affirmation bare", () => {
    expect(stanceTag("affirms")).toBeNull();
    expect(stanceTag(undefined)).toBeNull();
    expect(stanceTag("denies")?.word).toBe("denies");
    expect(stanceTag("poses")?.word).toBe("poses it as a question");
    expect(stanceTag("mentions")?.word).toBe("mentions");
    expect(stanceTag("mentions")?.title).toMatch(/not counted as affirming or denying/);
  });
});
