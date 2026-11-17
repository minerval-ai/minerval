/**
 * Where a source stands in the list of sources (services/source-list-service.ts):
 * read from its latest submission's review and its latest reading, never guessed.
 * The list itself, against real tables and labels, is tests/db/source-list.test.ts.
 */
import { describe, it, expect } from "vitest";
import { SOURCE_LIST_STATUSES, statusOf } from "../../../src/services/source-list-service.js";

describe("statusOf", () => {
  it("is waiting for review while a submission is, whatever a reading says", () => {
    for (const review of ["pending", "escalated", "human_review", "checking"]) {
      expect(statusOf(review, null)).toBe("pending_review");
      expect(statusOf(review, "completed")).toBe("pending_review");
    }
  });

  it("is not admitted when the latest submission was rejected", () => {
    expect(statusOf("rejected", null)).toBe("not_admitted");
  });

  it("follows the reading once admitted, or with no submission at all", () => {
    expect(statusOf("accepted", null)).toBe("queued");
    expect(statusOf("accepted", "pending")).toBe("queued");
    expect(statusOf("accepted", "processing")).toBe("reading");
    expect(statusOf(null, "running")).toBe("reading");
    expect(statusOf(null, "completed")).toBe("extracted");
    expect(statusOf("accepted", "failed")).toBe("failed");
    expect(statusOf(null, "cancelled")).toBe("failed");
  });

  it("is recorded where nothing was submitted or read: an agent kept it", () => {
    expect(statusOf(null, null)).toBe("recorded");
  });

  it("only ever answers one of the statuses the route declares", () => {
    const reviews = [null, "pending", "accepted", "rejected", "escalated", "human_review", "checking"];
    const jobs = [null, "pending", "processing", "running", "completed", "failed", "cancelled"];
    for (const r of reviews) for (const j of jobs) expect(SOURCE_LIST_STATUSES).toContain(statusOf(r, j));
  });
});
