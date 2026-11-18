import { describe, expect, it } from "vitest";
import { actWords, holdingWords, storedWords } from "../../../web/lib/stored-words";
import { END_REASONS, LEFT_REASONS } from "../../../src/services/release-service.js";
import { GATE_MODES, HOLD_REASONS } from "../../../src/services/gate-kinds.js";

// A record kept as it was said keeps the words it was said in: a package
// signed before a showing became a release, the permissions a person held
// when they acted, a gate's setting stamped on what it let through. The
// pages say those in the new words (docs/releasing-a-page.md, "Old names in
// the code"), and leave the API's own words as they are.
describe("old words in a kept record, as people now read them", () => {
  it("says an old act's words in the new ones", () => {
    expect(actWords("asked for the showing")).toBe("asked for the release");
    expect(actWords("ended the showing")).toBe("ended the release");
    expect(actWords("released")).toBe("consented");
    expect(actWords("the Redactor found that the page cannot be shown under the policy")).toBe(
      "the Redactor found that the page cannot be released under the policy"
    );
  });

  it("leaves the words the API says now as they are", () => {
    for (const words of ["asked for the release", "ended the release", "consented", "held", "lifted a hold"]) expect(actWords(words)).toBe(words);
    const all = [...Object.values(END_REASONS), ...Object.values(LEFT_REASONS), ...Object.values(HOLD_REASONS), ...Object.values(GATE_MODES)];
    for (const words of all) {
      expect(words, words).not.toMatch(/\bshowing\b|\bshown node\b|to be shown yet|hold release for/);
      expect(storedWords(words)).toBe(words);
    }
  });

  it("says old reasons and why a version was held, inside a longer sentence, and leaves other text alone", () => {
    expect(storedWords("another showing replaces it")).toBe(END_REASONS.replaced);
    expect(storedWords("the showing ended")).toBe(LEFT_REASONS.release_ended);
    expect(storedWords("the link that placed it under the shown node was removed")).toBe(LEFT_REASONS.link_removed);
    expect(storedWords("held by a person who directs the graph (not to be shown yet)")).toBe(
      "held by a person who directs the graph (not to be released yet)"
    );
    expect(storedWords("waiting on the people who decide what is released")).toBe("waiting on the people who consent for its parties");
    expect(storedWords("waiting for the Redactor's run")).toBe("waiting for the Redactor's run");
    expect(storedWords(null)).toBeNull();
  });

  it("says the permission to consent as it is now called, in a holding kept as the person held it", () => {
    expect(holdingWords(["direct", "release for Acme", "read"])).toEqual(["direct", "consent for Acme", "read"]);
    expect(holdingWords(["consent for Acme"])).toEqual(["consent for Acme"]);
  });
});
