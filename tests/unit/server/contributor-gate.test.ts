/**
 * The shared contributor gate: free contribution surfaces carry the hourly
 * count; priced intake (claim proposals, sources) is bounded by its owl
 * charge instead and skips it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrCreateContributor: vi.fn(),
  checkContributionRateLimit: vi.fn(),
}));

vi.mock("../../../src/services/contributor-service.js", () => ({
  getOrCreateContributor: mocks.getOrCreateContributor,
}));
vi.mock("../../../src/services/reputation-service.js", () => ({
  checkContributionRateLimit: mocks.checkContributionRateLimit,
}));

const { gateContributor } = await import("../../../src/server/contributor-gate.js");

const CONTRIBUTOR = {
  id: "c-1",
  isSuspended: false,
  contributionStanding: "good",
  reputationScore: 50,
  createdAt: new Date(0),
};

function fakeReply() {
  const reply = {
    statusCode: 200,
    body: undefined as unknown,
    code(n: number) {
      reply.statusCode = n;
      return reply;
    },
    async send(b: unknown) {
      reply.body = b;
      return reply;
    },
  };
  return reply;
}

const request = { contributorExternalId: "user:u-1" } as never;

describe("gateContributor rate limit", () => {
  beforeEach(() => {
    mocks.getOrCreateContributor.mockReset().mockResolvedValue(CONTRIBUTOR);
    mocks.checkContributionRateLimit
      .mockReset()
      .mockReturnValue({ limited: true, limitPerHour: 10, sandboxed: false });
  });

  it("applies the hourly cap to free contributions", async () => {
    const reply = fakeReply();
    const result = await gateContributor(request, reply as never);
    expect(result).toBeNull();
    expect(reply.statusCode).toBe(429);
    expect(reply.body).toMatchObject({ error: { code: "CONTRIBUTION_RATE_LIMITED" } });
  });

  it("skips the cap for priced submissions, without counting them", async () => {
    const reply = fakeReply();
    const result = await gateContributor(request, reply as never, { priced: true });
    expect(result).toBe(CONTRIBUTOR);
    expect(mocks.checkContributionRateLimit).not.toHaveBeenCalled();
  });

  it("still blocks a suspended contributor on a priced submission", async () => {
    mocks.getOrCreateContributor.mockResolvedValue({
      ...CONTRIBUTOR,
      isSuspended: true,
      suspensionReason: "test",
    });
    const reply = fakeReply();
    const result = await gateContributor(request, reply as never, { priced: true });
    expect(result).toBeNull();
    expect(reply.statusCode).toBe(403);
  });
});
