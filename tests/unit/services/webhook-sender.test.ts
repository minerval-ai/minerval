/**
 * Where a webhook may send (src/services/webhook-sender.ts): https only, to
 * addresses that are public when resolved, unless the deployment names the
 * host. Nothing here reaches the network: names are resolved by a stand-in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
const allowed = vi.hoisted(() => ({ hosts: [] as string[] }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("../../../src/config.js", async (orig) => {
  const real = await orig<typeof import("../../../src/config.js")>();
  return { ...real, loadConfig: () => ({ ...real.loadConfig(), eventWebhookAllowedHosts: allowed.hosts }) };
});

import { callbackUrlProblem, resolveCallbackAddress, sendWebhook } from "../../../src/services/webhook-sender.js";

afterEach(() => {
  lookup.mockReset();
  allowed.hosts = [];
});

describe("a callback address as written", () => {
  it("is https, with no credentials and no fragment", () => {
    expect(callbackUrlProblem("https://hooks.example.com/in?x=1")).toBeNull();
    expect(callbackUrlProblem("http://hooks.example.com/in")).toMatch(/https/);
    expect(callbackUrlProblem("ftp://hooks.example.com/in")).toMatch(/https/);
    expect(callbackUrlProblem("https://user:pass@hooks.example.com/in")).toMatch(/credentials/);
    expect(callbackUrlProblem("https://hooks.example.com/in#x")).toMatch(/fragment/);
    expect(callbackUrlProblem("not an address")).toMatch(/valid/);
    expect(callbackUrlProblem(undefined)).not.toBeNull();
    expect(callbackUrlProblem(`https://hooks.example.com/${"a".repeat(2000)}`)).not.toBeNull();
  });
});

describe("the address a host is reached at", () => {
  it("is refused when it is not public, by name or by number", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "fd00::1"]) {
      expect(await resolveCallbackAddress(ip)).toBeNull();
    }
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    expect(await resolveCallbackAddress("internal.example.com")).toBeNull();
  });

  it("is refused when any of a name's addresses is not public", async () => {
    lookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(await resolveCallbackAddress("two-faced.example.com")).toBeNull();
  });

  it("is the checked address for a public host, and none for a name that does not resolve", async () => {
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    expect(await resolveCallbackAddress("hooks.example.com")).toEqual({ address: "93.184.216.34", family: 4 });
    expect(await resolveCallbackAddress("93.184.216.34")).toEqual({ address: "93.184.216.34", family: 4 });
    lookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    expect(await resolveCallbackAddress("nowhere.example.com")).toBeNull();
    lookup.mockResolvedValueOnce([]);
    expect(await resolveCallbackAddress("empty.example.com")).toBeNull();
  });

  it("may be private for a host the deployment names, and only for that host", async () => {
    allowed.hosts = ["receiver.internal", "10.0.0.9"];
    lookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    expect(await resolveCallbackAddress("Receiver.Internal")).toEqual({ address: "10.0.0.5", family: 4 });
    expect(await resolveCallbackAddress("10.0.0.9")).toEqual({ address: "10.0.0.9", family: 4 });
    lookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    expect(await resolveCallbackAddress("other.internal")).toBeNull();
    expect(await resolveCallbackAddress("10.0.0.10")).toBeNull();
  });
});

describe("sending", () => {
  it("sends nothing to an address that is not https or not public, and says only that it could not connect", async () => {
    expect(await sendWebhook("http://hooks.example.com/in", {}, "{}")).toEqual({ ok: false, failure: "connection_refused" });
    expect(await sendWebhook("https://127.0.0.1/in", {}, "{}")).toEqual({ ok: false, failure: "connection_refused" });
    lookup.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    expect(await sendWebhook("https://metadata.example.com/latest", {}, "{}")).toEqual({ ok: false, failure: "connection_refused" });
  });
});
