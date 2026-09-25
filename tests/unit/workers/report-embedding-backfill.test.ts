/**
 * Report embedding backfill (#432): embeds a bounded batch of reports that
 * have no vector per tick, counts the outcome, and does nothing when
 * disabled.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  backfillReportEmbeddings: vi.fn(
    async (_limit: number) => ({ pending: 0, embedded: 0, failed: 0 })
  ),
  config: {
    reportEmbeddingBackfillPerTick: 20,
    reportEmbeddingBackfillIntervalSeconds: 300,
  },
}));

vi.mock("../../../src/services/report-service.js", () => ({
  backfillReportEmbeddings: mocks.backfillReportEmbeddings,
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => mocks.config,
}));

import {
  reportEmbeddingBackfillTick,
  startReportEmbeddingBackfill,
} from "../../../src/workers/report-embedding-backfill.js";

beforeEach(() => {
  mocks.backfillReportEmbeddings
    .mockReset()
    .mockResolvedValue({ pending: 0, embedded: 0, failed: 0 });
  mocks.config.reportEmbeddingBackfillPerTick = 20;
});

describe("reportEmbeddingBackfillTick", () => {
  it("embeds up to the per-tick cap and reports the outcome", async () => {
    mocks.backfillReportEmbeddings.mockResolvedValue({ pending: 3, embedded: 2, failed: 1 });
    mocks.config.reportEmbeddingBackfillPerTick = 5;
    const result = await reportEmbeddingBackfillTick();
    expect(result).toEqual({ pending: 3, embedded: 2, failed: 1 });
    expect(mocks.backfillReportEmbeddings).toHaveBeenCalledWith(5);
  });

  it("does nothing when disabled", async () => {
    mocks.config.reportEmbeddingBackfillPerTick = 0;
    const result = await reportEmbeddingBackfillTick();
    expect(result).toEqual({ pending: 0, embedded: 0, failed: 0 });
    expect(mocks.backfillReportEmbeddings).not.toHaveBeenCalled();
  });
});

describe("startReportEmbeddingBackfill", () => {
  it("ticks at once, logs only when something was pending, and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const logger = { info: vi.fn(), error: vi.fn() };
      mocks.backfillReportEmbeddings
        .mockResolvedValueOnce({ pending: 2, embedded: 2, failed: 0 })
        .mockResolvedValueOnce({ pending: 0, embedded: 0, failed: 0 });
      const worker = startReportEmbeddingBackfill({ intervalMs: 1000, logger });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.backfillReportEmbeddings).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("2 embedded, 0 failed of 2 pending")
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.backfillReportEmbeddings).toHaveBeenCalledTimes(2);
      const infoCalls = logger.info.mock.calls.length;
      worker.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(mocks.backfillReportEmbeddings).toHaveBeenCalledTimes(2);
      expect(logger.info.mock.calls.length).toBe(infoCalls);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs and keeps going when a tick throws", async () => {
    vi.useFakeTimers();
    try {
      const logger = { info: vi.fn(), error: vi.fn() };
      mocks.backfillReportEmbeddings.mockRejectedValueOnce(new Error("db down"));
      const worker = startReportEmbeddingBackfill({ intervalMs: 1000, logger });
      await vi.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith("Report embedding backfill error", "db down");
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.backfillReportEmbeddings).toHaveBeenCalledTimes(2);
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op when disabled", () => {
    mocks.config.reportEmbeddingBackfillPerTick = 0;
    const logger = { info: vi.fn(), error: vi.fn() };
    const worker = startReportEmbeddingBackfill({ logger });
    worker.stop();
    expect(mocks.backfillReportEmbeddings).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });
});
