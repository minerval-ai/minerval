import { describe, it, expect } from "vitest";

// The claim page's instances: the voices that assert, deny or pose the
// claim, and apart from them the sources that only mention it. A mention is
// provenance, never a vote, so it is never listed or counted with the voices.
import { instanceByline, splitInstances, stanceTag } from "../../../web/lib/instances";
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

// The line under each quotation on the claim page: whose words, where and
// when. The passage's own attribution leads; the source's record fills in.
describe("instanceByline", () => {
  it("cites a journal article from its source record", () => {
    expect(
      instanceByline({
        source_authors: ["Shakked Noy", "Whitney Zhang"],
        source_publisher: "Science",
        source_published_date: "2023-07-14",
      }),
    ).toBe("Shakked Noy, Whitney Zhang · Science · Jul 14, 2023");
  });

  it("prefers who said it, where and when, as recorded with the passage", () => {
    expect(
      instanceByline({
        speaker: "Jerome Powell",
        publication: "Reuters",
        source_date: "2022-06",
        source_authors: ["A Reporter"],
        source_publisher: "Thomson Reuters",
        source_published_date: "2022-06-15",
      }),
    ).toBe("Jerome Powell · Reuters · Jun 2022");
  });

  it("cites four or more authors by the first", () => {
    expect(instanceByline({ source_authors: ["Dell'Acqua", "McFowland", "Mollick", "Lifshitz"] })).toBe(
      "Dell'Acqua et al.",
    );
  });

  it("is empty when nothing is recorded, as from an API that predates the fields", () => {
    expect(instanceByline({})).toBe("");
  });
});
