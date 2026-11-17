/**
 * The pools find connections whose server went away, and a transaction's
 * connection that cannot roll back is discarded, not handed on (#1088).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const made: Array<{ config: Record<string, unknown>; listeners: string[] }> = [];
const released: unknown[] = [];
let rollbackFails = false;

vi.mock("pg", () => {
  class Pool {
    config: Record<string, unknown>;
    entry: { config: Record<string, unknown>; listeners: string[] };
    constructor(config: Record<string, unknown>) {
      this.config = config;
      this.entry = { config, listeners: [] };
      made.push(this.entry);
    }
    on(event: string) {
      this.entry.listeners.push(event);
      return this;
    }
    async query() {
      return { rows: [] };
    }
    async connect() {
      return {
        query: async (text: string) => {
          if (text === "ROLLBACK" && rollbackFails) throw new Error("Connection terminated");
          return { rows: [] };
        },
        release: (arg?: unknown) => released.push(arg),
      };
    }
    async end() {}
  }
  return { default: { Pool } };
});

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ databaseUrl: "postgres://x/y", databaseTls: "off", env: "test" }),
}));

vi.mock("../../../src/db/clearance.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enforcementKnownOff: () => true,
}));

const { withTransaction, rawQuery, closeDb } = await import("../../../src/db/client.js");

describe("pool recovery", () => {
  beforeEach(async () => {
    await closeDb();
    made.length = 0;
    released.length = 0;
    rollbackFails = false;
  });

  it("opens the owner pool with TCP keepalive and an error listener", async () => {
    await rawQuery("select 1");
    expect(made).toHaveLength(1);
    expect(made[0].config.keepAlive).toBe(true);
    expect(made[0].config.keepAliveInitialDelayMillis).toBeGreaterThan(0);
    expect(made[0].listeners).toContain("error");
  });

  it("returns a healthy transaction's connection to the pool", async () => {
    await withTransaction(async () => "ok");
    expect(released).toEqual([false]);
  });

  it("returns a connection whose transaction failed but rolled back", async () => {
    await expect(
      withTransaction(async () => {
        throw new Error("the work failed");
      })
    ).rejects.toThrow("the work failed");
    expect(released).toEqual([false]);
  });

  it("discards a connection that cannot roll back", async () => {
    rollbackFails = true;
    await expect(
      withTransaction(async () => {
        throw new Error("the work failed");
      })
    ).rejects.toThrow("the work failed");
    expect(released).toEqual([true]);
  });
});
