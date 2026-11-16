/**
 * Which questions the claim pipeline's worker asks of the labels table for
 * each shape of message (workers/claim-pipeline.ts). What it then does with
 * the answers is tested against Postgres in tests/db/label-carried.test.ts;
 * this file holds the part that only a count of the questions can show: a
 * message that carries its label is never asked whether public is the only
 * label, and a message from before the field is asked nothing else.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  publicIsTheOnlyLabel: vi.fn(async () => true),
  labelIsDefined: vi.fn(async () => true),
  enqueueSteward: vi.fn(async () => {}),
  ranAt: [] as string[],
  /** The label of the work in progress, set once the module that knows it is loaded. */
  labelNow: (): string => "public",
}));

vi.mock("../../../src/services/label-service.js", () => ({
  publicIsTheOnlyLabel: mocks.publicIsTheOnlyLabel,
  labelIsDefined: mocks.labelIsDefined,
}));
vi.mock("../../../src/services/queue-service.js", () => ({ enqueueSteward: mocks.enqueueSteward }));
vi.mock("../../../src/db/client.js", () => {
  // The node is at the label of the work that reads it: onboarding is the
  // node's own label's work, and a message at another label does not do it.
  const row = {
    id: "c-1",
    decompositionStatus: "pending",
    get label() {
      return mocks.labelNow();
    },
  };
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  };
  return { getDb: () => db, rawQuery: vi.fn(async () => []) };
});

import { MissingLabelError, UndefinedLabelError } from "../../../src/labels.js";
import { currentLabel } from "../../../src/llm/usage-context.js";
import type { ClaimPipelineMessage } from "../../../src/services/queue-service.js";
import { handleClaimPipeline } from "../../../src/workers/claim-pipeline.js";

beforeEach(() => {
  mocks.labelNow = currentLabel;
  mocks.publicIsTheOnlyLabel.mockReset().mockResolvedValue(true);
  mocks.labelIsDefined.mockReset().mockResolvedValue(true);
  mocks.ranAt = [];
  mocks.enqueueSteward.mockReset().mockImplementation(async () => {
    mocks.ranAt.push(currentLabel());
  });
});

describe("handleClaimPipeline", () => {
  it("runs a message at the label it carries without asking whether public is the only label", async () => {
    await handleClaimPipeline({ claimId: "c-1", jobId: "j-1", label: "internal" });
    expect(mocks.ranAt).toEqual(["internal"]);
    expect(mocks.labelIsDefined).toHaveBeenCalledExactlyOnceWith("internal");
    expect(mocks.publicIsTheOnlyLabel).not.toHaveBeenCalled();
  });

  it("refuses a label that is not defined, in a deployment of one label too", async () => {
    mocks.labelIsDefined.mockResolvedValue(false);
    await expect(handleClaimPipeline({ claimId: "c-1", jobId: "j-1", label: "gone" })).rejects.toBeInstanceOf(
      UndefinedLabelError
    );
    expect(mocks.ranAt).toEqual([]);
    expect(mocks.publicIsTheOnlyLabel).not.toHaveBeenCalled();
  });

  it("refuses an empty or null label without asking anything", async () => {
    for (const label of ["", null, undefined]) {
      const message = { claimId: "c-1", jobId: "j-1", label } as ClaimPipelineMessage;
      await expect(handleClaimPipeline(message)).rejects.toBeInstanceOf(MissingLabelError);
    }
    expect(mocks.ranAt).toEqual([]);
    expect(mocks.publicIsTheOnlyLabel).not.toHaveBeenCalled();
    expect(mocks.labelIsDefined).not.toHaveBeenCalled();
  });

  it("asks once for a message with no label key, and runs it at public where public is the only label", async () => {
    await handleClaimPipeline({ claimId: "c-1", jobId: "j-1" });
    expect(mocks.ranAt).toEqual(["public"]);
    expect(mocks.publicIsTheOnlyLabel).toHaveBeenCalledTimes(1);
    expect(mocks.labelIsDefined).not.toHaveBeenCalled();
  });

  it("refuses a message with no label key where the deployment has another label", async () => {
    mocks.publicIsTheOnlyLabel.mockResolvedValue(false);
    await expect(handleClaimPipeline({ claimId: "c-1", jobId: "j-1" })).rejects.toBeInstanceOf(MissingLabelError);
    expect(mocks.ranAt).toEqual([]);
  });
});
