/**
 * How connections to the database are encrypted (src/db/client.ts,
 * databaseSsl): unchanged with nothing set, and a deployment on its own
 * Postgres says which of two things holds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV = ["ENVIRONMENT", "DATABASE_TLS", "DATABASE_CA_FILE"];
const saved: Record<string, string | undefined> = {};
let dir = "";

beforeEach(() => {
  for (const name of ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  dir = mkdtempSync(join(tmpdir(), "database-tls-"));
  vi.resetModules();
});

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

const ssl = async () => (await import("../../../src/db/client.js")).databaseSsl();

describe("TLS to the database", () => {
  it("is off outside production with nothing set, as it always was", async () => {
    expect(await ssl()).toBeUndefined();
  });

  it("is off where the deployment says its database is on its own network", async () => {
    process.env.DATABASE_TLS = "off";
    expect(await ssl()).toBeUndefined();
  });

  it("verifies against the authority the deployment names, in any environment", async () => {
    const ca = join(dir, "ca.pem");
    writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nnot a real one\n-----END CERTIFICATE-----\n");
    process.env.DATABASE_CA_FILE = ca;
    expect(await ssl()).toEqual({ ca: expect.stringContaining("not a real one"), rejectUnauthorized: true });
  });

  it("refuses the two together, and any other value of DATABASE_TLS", async () => {
    process.env.DATABASE_TLS = "off";
    process.env.DATABASE_CA_FILE = join(dir, "ca.pem");
    await expect(ssl()).rejects.toThrow(
      "DATABASE_TLS=off and DATABASE_CA_FILE are both set. One says connections to the database are not encrypted and the other names the authority to verify its certificate against. Set one of them."
    );
    vi.resetModules();
    delete process.env.DATABASE_CA_FILE;
    process.env.DATABASE_TLS = "unverified";
    await expect(ssl()).rejects.toThrow();
  });
});
