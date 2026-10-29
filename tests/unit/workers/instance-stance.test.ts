import { describe, it, expect } from "vitest";
import { instanceStanceFor } from "../../../src/workers/url-extraction.js";

// The stance an ingested instance takes from what the source proposed and
// the kind of node it matched (§4, §7a).

describe("instanceStanceFor", () => {
  it("records a figure as a statement of its quantity's value", () => {
    expect(instanceStanceFor("quantity", "quantity", "affirms")).toBe("states");
    expect(instanceStanceFor("claim", "quantity", "affirms")).toBe("states");
  });

  it("records a question asked as asked, and a question about a claim or value as posed", () => {
    expect(instanceStanceFor("question", "question", "affirms")).toBe("asks");
    expect(instanceStanceFor("question", "claim", "affirms")).toBe("poses");
    expect(instanceStanceFor("question", "quantity", "affirms")).toBe("poses");
  });

  it("records a claim matched to a question as answering it, and keeps the Matcher's stance on a claim", () => {
    expect(instanceStanceFor("claim", "question", "affirms")).toBe("answers");
    expect(instanceStanceFor("claim", "claim", "denies")).toBe("denies");
    expect(instanceStanceFor("claim", "claim", undefined)).toBe("affirms");
  });
});
