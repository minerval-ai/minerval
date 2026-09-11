/**
 * GitHub issue sync (#366): files the backlog a bounded batch per tick,
 * counts what it filed and what it could not, and does nothing at all
 * when the sync is not configured.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listReportsAwaitingIssue: vi.fn(async (): Promise<unknown[]> => []),
  fileIssueForReport: vi.fn(async (): Promise<unknown> => null),
  githubIssuesConfigured: vi.fn(() => true),
  config: {
    githubIssuesBackfillPerTick: 20,
    githubIssuesIncludeExternal: false,
    githubIssuesSyncIntervalSeconds: 300,
    githubIssuesRepo: "minerval-ai/minerval",
  },
}));

vi.mock("../../../src/services/report-service.js", () => ({
  listReportsAwaitingIssue: mocks.listReportsAwaitingIssue,
}));
vi.mock("../../../src/services/github-issue-service.js", () => ({
  fileIssueForReport: mocks.fileIssueForReport,
  githubIssuesConfigured: mocks.githubIssuesConfigured,
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

import {
  githubIssueSyncTick,
  startGithubIssueSync,
} from "../../../src/workers/github-issue-sync.js";

beforeEach(() => {
  mocks.listReportsAwaitingIssue.mockReset().mockResolvedValue([]);
  mocks.fileIssueForReport.mockReset().mockResolvedValue(null);
  mocks.githubIssuesConfigured.mockReset().mockReturnValue(true);
  mocks.config.githubIssuesBackfillPerTick = 20;
  mocks.config.githubIssuesIncludeExternal = false;
});

describe("githubIssueSyncTick", () => {
  it("files each pending report, up to the per-tick cap, and counts the outcome", async () => {
    mocks.listReportsAwaitingIssue.mockResolvedValue([{ id: "r1" }, { id: "r2" }, { id: "r3" }]);
    mocks.fileIssueForReport
      .mockResolvedValueOnce({ number: 1, url: "u1" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ number: 3, url: "u3" });
    const result = await githubIssueSyncTick();
    expect(result).toEqual({ pending: 3, filed: 2, failed: 1 });
    expect(mocks.listReportsAwaitingIssue).toHaveBeenCalledWith(20, { includeExternal: false });
    expect(mocks.fileIssueForReport).toHaveBeenCalledTimes(3);
  });

  it("passes the external opt-in through", async () => {
    mocks.config.githubIssuesIncludeExternal = true;
    mocks.config.githubIssuesBackfillPerTick = 5;
    await githubIssueSyncTick();
    expect(mocks.listReportsAwaitingIssue).toHaveBeenCalledWith(5, { includeExternal: true });
  });

  it("does nothing when unconfigured or when the per-tick cap is 0", async () => {
    mocks.githubIssuesConfigured.mockReturnValue(false);
    expect(await githubIssueSyncTick()).toEqual({ pending: 0, filed: 0, failed: 0 });
    mocks.githubIssuesConfigured.mockReturnValue(true);
    mocks.config.githubIssuesBackfillPerTick = 0;
    expect(await githubIssueSyncTick()).toEqual({ pending: 0, filed: 0, failed: 0 });
    expect(mocks.listReportsAwaitingIssue).not.toHaveBeenCalled();
  });
});

describe("startGithubIssueSync", () => {
  it("ticks once on start and reports what it filed", async () => {
    vi.useFakeTimers();
    try {
      mocks.listReportsAwaitingIssue.mockResolvedValue([{ id: "r1" }]);
      mocks.fileIssueForReport.mockResolvedValue({ number: 1, url: "u1" });
      const logger = { info: vi.fn(), error: vi.fn() };
      const handle = startGithubIssueSync({ intervalMs: 60_000, logger });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.fileIssueForReport).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/1 filed, 0 failed of 1/));
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so and never ticks when unconfigured", async () => {
    mocks.githubIssuesConfigured.mockReturnValue(false);
    const logger = { info: vi.fn(), error: vi.fn() };
    const handle = startGithubIssueSync({ logger });
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/not configured/));
    expect(mocks.listReportsAwaitingIssue).not.toHaveBeenCalled();
    handle.stop();
  });
});
