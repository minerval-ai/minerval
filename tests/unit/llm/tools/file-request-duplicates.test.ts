import { describe, it, expect, vi } from "vitest";

// file_request's notice when other open requests already bear on the same
// nodes (#746): an administrator who keeps requests is told to close the
// duplicate; the researcher, which has no close_request, is told to name it
// in its report for the keeper.

vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async () => []),
  withTransaction: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("../../../../src/services/request-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/services/request-service.js")>();
  return {
    ...original,
    listRequests: vi.fn(async () => ({ items: [{ id: "req-old", ask: "Trace the figure." }], total: 1 })),
    fileRequest: vi.fn(async () => ({ id: "req-new" })),
  };
});

import { executeKindTool } from "../../../../src/llm/tools/kind-tools.js";

const CLAIM = "aaaaaaaa-0000-4000-8000-000000000001";
const INPUT = { ask: "Trace the figure to its origin.", why: "It decides the claim.", satisfied_by: "The origin.", claim_ids: [CLAIM] };

describe("file_request's duplicate notice", () => {
  it("tells a keeping administrator to close the duplicate as moot", async () => {
    const out = JSON.parse((await executeKindTool("file_request", INPUT, { role: "claim_steward", claimId: CLAIM }))!);
    expect(out.message).toContain("close this one as moot");
    expect(out.open_requests).toEqual([{ id: "req-old", ask: "Trace the figure." }]);
  });

  it("tells the researcher to name it in its report, leaving the closing to the keeper", async () => {
    const out = JSON.parse((await executeKindTool("file_request", INPUT, { role: "researcher" }))!);
    expect(out.message).not.toContain("close this one");
    expect(out.message).toContain("name it in your report");
    expect(out.message).toContain("keeper decides");
  });
});
