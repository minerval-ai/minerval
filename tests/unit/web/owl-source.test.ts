import { describe, it, expect } from "vitest";
import { gettingOwlsSentence, owlSourceOf } from "../../../web/lib/owl-source";

// Where a person gets more owls (web/lib/owl-source.ts, #1095): "buy owls"
// only where owls are sold; where a deployment creates its own, who creates
// them and where.

const sold = { credits_enabled: true };
const pack = [{ id: "p" }];

describe("owlSourceOf", () => {
  it("is sold where purchases are on and there are packs", () => {
    expect(owlSourceOf(sold, pack, false)).toEqual({ kind: "sold" });
  });

  it("is created where the deployment creates its own owls, whatever else it says", () => {
    expect(owlSourceOf({ ...sold, owls_created_here: true }, pack, false)).toEqual({
      kind: "created",
      administers: false,
    });
    expect(owlSourceOf({ credits_enabled: false, owls_created_here: true }, [], true)).toEqual({
      kind: "created",
      administers: true,
    });
  });

  it("is none where nothing is sold and nothing created", () => {
    expect(owlSourceOf({ credits_enabled: false }, pack, false)).toEqual({ kind: "none" });
    expect(owlSourceOf(sold, [], false)).toEqual({ kind: "none" });
  });
});

describe("gettingOwlsSentence", () => {
  it("says buy only where owls are sold", () => {
    expect(gettingOwlsSentence({ kind: "sold" })).toMatch(/buy owls/i);
    for (const s of [
      gettingOwlsSentence({ kind: "created", administers: false }),
      gettingOwlsSentence({ kind: "created", administers: true }),
      gettingOwlsSentence({ kind: "none" }),
    ]) {
      expect(s).not.toMatch(/\bbuy\b/i);
    }
  });

  it("names the permission that creates owls, and where", () => {
    const s = gettingOwlsSentence({ kind: "created", administers: false });
    expect(s).toContain("permission to administer the deployment");
    expect(s).toContain("Administration → Owls");
  });
});
