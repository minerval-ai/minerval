/**
 * The settings for a deployment that creates its own owls and reports its
 * usage (src/config.ts): what each starts as, which cannot hold together,
 * and that the free grants are the public graph's and not a members-only
 * deployment's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV = [
  "OWLS",
  "READS",
  "STRIPE_SECRET_KEY",
  "SIGNUP_GRANT_OWLS",
  "MONTHLY_GRANT_OWLS",
  "PUBLIC_GRAPH_PRICE",
  "USAGE_REPORT_URL",
  "USAGE_REPORT_API_KEY",
  "USAGE_REPORT_DIR",
  "USAGE_REPORT_FROM",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  vi.resetModules();
});

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const load = async () => (await import("../../src/config.js")).loadConfig();

describe("where owls come from", () => {
  it("starts as on the public graph: owls are sold, and the free grants are given", async () => {
    const config = await load();
    expect(config.owls).toBe("sold");
    expect(config.signupGrantOwls).toBe(10);
    expect(config.monthlyGrantOwls).toBe(1);
    const { owlsCreatedHere } = await import("../../src/services/owl.js");
    expect(owlsCreatedHere()).toBe(false);
    const { usageReporting } = await import("../../src/services/usage-report-service.js");
    expect(usageReporting()).toBe(false);
  });

  it("creates them where the deployment says so", async () => {
    process.env.READS = "members";
    process.env.OWLS = "created";
    expect((await load()).owls).toBe("created");
    const { owlsCreatedHere } = await import("../../src/services/owl.js");
    expect(owlsCreatedHere()).toBe(true);
  });

  it("refuses OWLS=created without READS=members, and says why", async () => {
    process.env.OWLS = "created";
    await expect(load()).rejects.toThrow(
      "OWLS=created needs READS=members. Owls are created by an administrator, and only a " +
        "members-only deployment has administrators. Set READS=members, or leave OWLS unset."
    );
  });

  it("refuses OWLS=created beside a Stripe key, and ignores a placeholder", async () => {
    process.env.READS = "members";
    process.env.OWLS = "created";
    process.env.STRIPE_SECRET_KEY = "placeholder";
    expect((await load()).owls).toBe("created");
    vi.resetModules();
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    await expect(load()).rejects.toThrow(/A deployment either creates its own owls or sells them, never both/);
  });

  it("sells nothing where owls are created", async () => {
    process.env.READS = "members";
    process.env.OWLS = "created";
    const billing = await import("../../src/services/billing-service.js");
    expect(billing.stripeConfigured()).toBe(false);
    expect(billing.serializeOwlPacks()).toEqual([]);
  });
});

describe("the free grants in a members-only deployment", () => {
  it("are not given unless the deployment sets them", async () => {
    process.env.READS = "members";
    const config = await load();
    expect(config.signupGrantOwls).toBe(0);
    expect(config.monthlyGrantOwls).toBe(0);
  });

  it("are given at the figure the deployment sets, each on its own", async () => {
    process.env.READS = "members";
    process.env.SIGNUP_GRANT_OWLS = "3";
    const config = await load();
    expect(config.signupGrantOwls).toBe(3);
    expect(config.monthlyGrantOwls).toBe(0);
  });
});

describe("the free grants in a deployment that creates its own owls", () => {
  it("are refused, since every owl there is created by an administrator's logged act", async () => {
    process.env.READS = "members";
    process.env.OWLS = "created";
    process.env.SIGNUP_GRANT_OWLS = "3";
    await expect(load()).rejects.toThrow(
      "OWLS=created and SIGNUP_GRANT_OWLS are both set. Where a deployment creates its own owls, an owl enters a " +
        "balance by an administrator's act, which is logged where every member can read it. A grant by " +
        "setting would create owls that no act records. Remove SIGNUP_GRANT_OWLS; an administrator creates owls " +
        "into the accounts that are to have them."
    );
    vi.resetModules();
    process.env.MONTHLY_GRANT_OWLS = "1";
    await expect(load()).rejects.toThrow(/OWLS=created and SIGNUP_GRANT_OWLS and MONTHLY_GRANT_OWLS are both set/);
    // Set to nothing, or to zero, they ask for no grant.
    vi.resetModules();
    process.env.SIGNUP_GRANT_OWLS = "0";
    delete process.env.MONTHLY_GRANT_OWLS;
    const config = await load();
    expect(config.signupGrantOwls).toBe(0);
    expect(config.monthlyGrantOwls).toBe(0);
  });
});

describe("the price of reading the public graph", () => {
  it("is metered unless the deployment says flat, and only a members-only deployment reports", async () => {
    process.env.READS = "members";
    expect((await load()).publicGraphPrice).toBe("metered");
    const { usageReporting } = await import("../../src/services/usage-report-service.js");
    expect(usageReporting()).toBe(true);
    expect(usageReporting({ reads: "members", publicGraphPrice: "flat" })).toBe(false);
    expect(usageReporting({ reads: "open", publicGraphPrice: "metered" })).toBe(false);
  });

  it("refuses a destination that is both online and a file", async () => {
    process.env.READS = "members";
    process.env.USAGE_REPORT_URL = "https://api.example.org/usage-reports";
    process.env.USAGE_REPORT_DIR = "/var/lib/minerval/reports";
    await expect(load()).rejects.toThrow(/USAGE_REPORT_URL and USAGE_REPORT_DIR are both set/);
  });

  it("refuses an address that is not one and a first day that is not a day", async () => {
    process.env.USAGE_REPORT_URL = "api.example.org";
    await expect(load()).rejects.toThrow(/USAGE_REPORT_URL must be the http or https address/);
    vi.resetModules();
    delete process.env.USAGE_REPORT_URL;
    process.env.USAGE_REPORT_FROM = "1 November";
    await expect(load()).rejects.toThrow(/USAGE_REPORT_FROM must be a day written as YYYY-MM-DD/);
  });
});
