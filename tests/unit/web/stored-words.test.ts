import { describe, expect, it } from "vitest";
import { actWords, storedList, storedWords } from "../../../web/lib/stored-words";
import { END_REASONS, LEFT_REASONS } from "../../../src/services/showing-service.js";
import { HOLD_REASONS } from "../../../src/services/gate-kinds.js";

// The fixed words a release's record is stored and sent in keep the old
// names until they change with the stored values (docs/releasing-a-page.md,
// "Old names in the code"). The pages say them in the new words.
describe("stored words, as people now read them", () => {
  it("says an act's stored words in the new ones", () => {
    expect(actWords("asked for the showing")).toBe("asked for the release");
    expect(actWords("ended the showing")).toBe("ended the release");
    expect(actWords("released")).toBe("consented");
    expect(actWords("held")).toBe("held");
    expect(actWords("lifted a hold")).toBe("lifted a hold");
  });

  it("says the API's fixed reasons with no old word left in them", () => {
    const all = [...Object.values(END_REASONS), ...Object.values(LEFT_REASONS), ...Object.values(HOLD_REASONS)];
    for (const words of all) expect(storedWords(words), words).not.toMatch(/\bshow(ing|n)\b/);
    expect(storedList(HOLD_REASONS).timing).toBe("not to be released yet");
    expect(storedList(END_REASONS).replaced).toBe("another release replaces it");
    expect(storedWords(LEFT_REASONS.showing_ended)).toBe("the release ended");
  });

  it("says why a version is held, inside a longer sentence, and leaves other text alone", () => {
    expect(storedWords("held by a person who directs the graph (not to be shown yet)")).toBe(
      "held by a person who directs the graph (not to be released yet)"
    );
    expect(storedWords("waiting on the people who decide what is released")).toBe("waiting on the people who consent for its parties");
    expect(storedWords("waiting for the Redactor's run")).toBe("waiting for the Redactor's run");
    expect(storedWords(null)).toBeNull();
  });
});
