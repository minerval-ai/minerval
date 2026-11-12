/**
 * The parts of holding reads to a clearance that need no database
 * (src/db/clearance.ts): how a session is keyed and written into a
 * connection's settings, what is refused before any connection is opened,
 * and how a script says its label. What the database then does with a
 * session is in tests/db/enforcement.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  ClearanceError,
  leaveSystemClearance,
  normalizeClearance,
  sessionKey,
  sessionOptions,
  startedHere,
  systemClearanceReason,
  withSystemClearance,
} from "../../../src/db/clearance.js";
import { scriptLabel } from "../../../src/script-label.js";

describe("a session", () => {
  it("always reads public, each label once, in one order", () => {
    expect(normalizeClearance([])).toEqual(["public"]);
    expect(normalizeClearance(["internal", "public", "internal", "a"])).toEqual(["a", "internal", "public"]);
  });

  it("is one key and one set of settings however its clearance was listed", () => {
    const one = { role: "cleared" as const, clearance: ["internal", "public"], label: "internal" };
    const other = { role: "cleared" as const, clearance: ["public", "internal", "internal"], label: "internal" };
    expect(sessionKey(one)).toBe(sessionKey(other));
    expect(sessionOptions(one)).toBe("-c minerval.clearance={internal,public} -c minerval.label=internal");
    expect(sessionOptions({ role: "cleared", clearance: [] })).toBe("-c minerval.clearance={public}");
    // The owner's connection carries no clearance: the policies do not bind it.
    expect(sessionOptions({ role: "owner" })).toBe("");
    expect(sessionKey({ role: "owner" })).not.toBe(sessionKey({ role: "cleared", clearance: [] }));
    expect(sessionKey({ role: "cleared", clearance: ["a"] })).not.toBe(sessionKey({ role: "cleared", clearance: ["a"], label: "a" }));
  });

  it("is refused for a label whose name could end the setting it is written in", () => {
    for (const name of ["a b", "a}", "{a", "a,b", "a'", 'a"', "a\\", "A", "", "1a", "a -c role=postgres", "a\n", "é"]) {
      expect(() => sessionOptions({ role: "cleared", clearance: [name] }), name).toThrow(ClearanceError);
      expect(() => sessionOptions({ role: "cleared", clearance: ["public"], label: name }), name).toThrow(ClearanceError);
      expect(() => sessionKey({ role: "cleared", clearance: [name] }), name).toThrow(ClearanceError);
    }
    // What the administrator's route allows is allowed here.
    expect(sessionOptions({ role: "cleared", clearance: ["partner-a", "team_2"] })).toBe(
      "-c minerval.clearance={partner-a,public,team_2}"
    );
  });
});

describe("system clearance", () => {
  it("needs a reason, holds inside the call, and ends where it is left", async () => {
    expect(() => withSystemClearance("  ", () => 1)).toThrow(ClearanceError);
    expect(systemClearanceReason()).toBeNull();
    await withSystemClearance("A test must see every label.", async () => {
      expect(systemClearanceReason()).toBe("A test must see every label.");
      await Promise.resolve();
      expect(systemClearanceReason()).toBe("A test must see every label.");
      await leaveSystemClearance(async () => {
        expect(systemClearanceReason()).toBeNull();
      });
      expect(systemClearanceReason()).toBe("A test must see every label.");
    });
    expect(systemClearanceReason()).toBeNull();
  });

  it("starts what it hands back before it returns, so a query built inside runs inside", async () => {
    // A query builder runs when it is awaited: this one records where.
    const lazy = () => ({
      then(resolve: (reason: string | null) => void) {
        resolve(systemClearanceReason());
      },
    });
    expect(await withSystemClearance("Inside.", () => lazy())).toBe("Inside.");
    expect(await withSystemClearance("Inside.", () => leaveSystemClearance(() => lazy()))).toBeNull();
    // What is not awaitable comes back as it is.
    expect(startedHere(3)).toBe(3);
    expect(startedHere(null)).toBeNull();
    const promise = Promise.resolve(1);
    expect(startedHere(promise)).toBe(promise);
  });
});

describe("a script's label", () => {
  it("is the one named on its command line, or in MINERVAL_LABEL, and otherwise none", () => {
    expect(scriptLabel(["node", "seed.ts"], {})).toBeNull();
    expect(scriptLabel(["node", "seed.ts", "--label", "internal"], {})).toBe("internal");
    expect(scriptLabel(["node", "seed.ts"], { MINERVAL_LABEL: " internal " })).toBe("internal");
    expect(scriptLabel(["node", "seed.ts", "--label", "restricted"], { MINERVAL_LABEL: "internal" })).toBe("restricted");
    expect(scriptLabel(["node", "seed.ts", "--label"], {})).toBeNull();
    expect(scriptLabel(["node", "seed.ts"], { MINERVAL_LABEL: "" })).toBeNull();
  });
});
