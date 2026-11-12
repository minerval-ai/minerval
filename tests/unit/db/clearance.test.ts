/**
 * The parts of holding reads to a clearance that need no database
 * (src/db/clearance.ts): how a session is keyed and written into a
 * connection's settings, what is refused before any connection is opened,
 * and how a script says its label. What the database then does with a
 * session is in tests/db/enforcement.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ClearanceError,
  ENFORCEMENT_OFF_RECHECK_MS,
  enforcementKnownOff,
  enforcementOn,
  isUnseenCollision,
  leaveSystemClearance,
  normalizeClearance,
  noteStatement,
  refusalForCaller,
  resetClearanceState,
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

describe("knowing that enforcement is off", () => {
  // The client sends a query straight to the owner's pool, as it did before
  // there were labels, only while this holds. Each way it stops holding is
  // a way a process could otherwise keep reading as the owner after a
  // second label exists.
  afterEach(() => {
    vi.useRealTimers();
    resetClearanceState();
  });
  const answering = (on: boolean) => vi.fn(async () => [{ on }]) as never;

  it("is not known before the database has been asked", () => {
    resetClearanceState();
    expect(enforcementKnownOff()).toBe(false);
  });

  it("is known once the database has said so, and only for the interval", async () => {
    vi.useFakeTimers();
    resetClearanceState();
    expect(await enforcementOn(answering(false))).toBe(false);
    expect(enforcementKnownOff()).toBe(true);
    vi.advanceTimersByTime(ENFORCEMENT_OFF_RECHECK_MS - 1);
    expect(enforcementKnownOff()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(enforcementKnownOff()).toBe(false);
  });

  // A review found the belief was timed from when the answer arrived. A
  // check in flight while enforcement was turned on could then come back
  // "off" and keep the process on the owner's pool for a whole interval
  // after the switch, past the wait that armEnforcement makes.
  it("is as old as the question, not as the answer's arrival", async () => {
    vi.useFakeTimers();
    resetClearanceState();
    const slow = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return [{ on: false }];
    }) as never;
    const asked = enforcementOn(slow);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await asked).toBe(false);
    // Three seconds of the interval are already gone.
    expect(enforcementKnownOff()).toBe(true);
    await vi.advanceTimersByTimeAsync(ENFORCEMENT_OFF_RECHECK_MS - 3_000 - 1);
    expect(enforcementKnownOff()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    // Ten seconds after the question was sent, whenever its answer came.
    expect(enforcementKnownOff()).toBe(false);
  });

  it("is never known where enforcement is on", async () => {
    resetClearanceState();
    expect(await enforcementOn(answering(true))).toBe(true);
    expect(enforcementKnownOff()).toBe(false);
  });

  it("stops being known the moment this process writes a label, until it has asked again", async () => {
    vi.useFakeTimers();
    resetClearanceState();
    await enforcementOn(answering(false));
    expect(enforcementKnownOff()).toBe(true);
    noteStatement(`insert into "labels" ("name") values ($1)`);
    expect(enforcementKnownOff()).toBe(false);
    // While unsettled every statement asks, and the answer may now be yes.
    const ask = answering(true);
    expect(await enforcementOn(ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(enforcementKnownOff()).toBe(false);
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

describe("a refusal by the wall", () => {
  it("is told to the caller with its reason, and nothing else is", () => {
    expect(refusalForCaller(new ClearanceError("The write was refused: reasons."))).toBe("The write was refused: reasons.");
    const collision = Object.assign(new Error("this was not written: a row with the same identity already exists at a label this work does not read"), {
      code: "MVL03",
      hint: "A table holds one row for each identity whatever the labels, and each label keeping its own is not built yet. Nothing was changed.",
    });
    expect(refusalForCaller(collision)).toBe(
      "This was not written: a row with the same identity already exists at a label this work does not read. " +
        "A table holds one row for each identity whatever the labels, and each label keeping its own is not built yet. Nothing was changed."
    );
    expect(isUnseenCollision(collision)).toBe(true);
    expect(refusalForCaller(Object.assign(new Error("the judgment in force on this node was recorded at another label, and this work may not retire it"), { code: "MVL02" }))).toBe(
      "The judgment in force on this node was recorded at another label, and this work may not retire it."
    );
    // A forgotten stamp with no label to give is a fault of the code, not an answer to a caller.
    expect(refusalForCaller(Object.assign(new Error("a row was written without a label"), { code: "MVL01" }))).toBeNull();
    expect(refusalForCaller(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBeNull();
    expect(refusalForCaller(new Error("anything"))).toBeNull();
    expect(refusalForCaller(null)).toBeNull();
    expect(isUnseenCollision(new Error("anything"))).toBe(false);
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
