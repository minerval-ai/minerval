/**
 * What the public graph said back arrives with the mirror, and is taken in
 * when a batch is applied (mirror-upkeep.ts), not at the scheduler's next
 * sweep. In the first run with real models a challenge admitted on the
 * public graph reached the Steward inside eleven minutes later, on a sweep
 * shortened for the run; with the default it would have been up to six hours.
 */
import { describe, expect, it, vi } from "vitest";

const taken = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));
vi.mock("../../../src/services/version-upkeep.js", () => ({
  openReassessmentsForVersionsMadeBesideEarlier: vi.fn(async () => 0),
  openReassessmentsForJudgmentsLeftStanding: vi.fn(async () => 0),
}));
vi.mock("../../../src/services/curation-service.js", () => ({ scanArrivedPublicNodes: vi.fn(async () => 0) }));
vi.mock("../../../src/services/outward-follow.js", () => ({
  takeInFromOutside: vi.fn(async () => {
    taken.calls++;
    return { taken_in: 1, given_to_stewards: { delivered: 1, moved: 0 }, asked_of_published_mandates: 2 };
  }),
}));

import { afterMirrorApplied } from "../../../src/services/mirror-upkeep.js";
import type { ApplyResult } from "../../../src/services/mirror-apply-service.js";

const batch = (status: "applied" | "already_applied") =>
  ({ status, nodes: { judged: [], merged: [], withdrawn: [], arrived: [] } }) as unknown as ApplyResult;

describe("a mirror batch applied", () => {
  it("takes in what the public graph said back and asked, at once", async () => {
    expect(await afterMirrorApplied([batch("applied")])).toMatchObject({ fromOutside: 3 });
    expect(taken.calls).toBe(1);
  });

  it("does nothing more when no batch was applied", async () => {
    expect(await afterMirrorApplied([batch("already_applied")])).toMatchObject({ fromOutside: 0 });
    expect(taken.calls).toBe(1);
  });
});
