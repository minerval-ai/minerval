import { describe, it, expect } from "vitest";
import { assertPublicHttpUrl, UnsafeUrlError } from "../../../src/services/url-guard.js";

// The SSRF guard's classification logic, via IP-literal hosts (no DNS
// involved). Hostname resolution and redirect-hop re-validation are
// exercised by the fetch path in integration.

const refuse = (url: string) =>
  expect(assertPublicHttpUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);

describe("assertPublicHttpUrl", () => {
  it("refuses non-HTTP(S) schemes", async () => {
    await refuse("file:///etc/passwd");
    await refuse("ftp://example.com/x");
    await refuse("gopher://example.com/x");
  });

  it("refuses embedded credentials", async () => {
    await refuse("https://user:pass@example.com/");
  });

  it("refuses loopback, private, link-local, CGNAT, and metadata addresses", async () => {
    await refuse("http://127.0.0.1/");
    await refuse("http://127.8.9.1/");
    await refuse("http://10.0.0.5/");
    await refuse("http://172.16.0.1/");
    await refuse("http://172.31.255.255/");
    await refuse("http://192.168.1.1/");
    await refuse("http://169.254.169.254/latest/meta-data/"); // cloud metadata
    await refuse("http://100.64.0.1/"); // CGNAT
    await refuse("http://0.0.0.0/");
    await refuse("http://224.0.0.1/"); // multicast
    await refuse("http://255.255.255.255/"); // broadcast
  });

  it("refuses IPv6 loopback, ULA, link-local, and v4-mapped private", async () => {
    await refuse("http://[::1]/");
    await refuse("http://[::]/");
    await refuse("http://[fc00::1]/");
    await refuse("http://[fd12:3456::1]/");
    await refuse("http://[fe80::1]/");
    await refuse("http://[::ffff:127.0.0.1]/");
    await refuse("http://[::ffff:10.0.0.1]/");
  });

  it("allows public IP literals and returns the parsed URL", async () => {
    const url = await assertPublicHttpUrl("https://93.184.216.34/page");
    expect(url.hostname).toBe("93.184.216.34");
    await expect(
      assertPublicHttpUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/")
    ).resolves.toBeTruthy();
    // Just-outside-the-fence neighbours of refused ranges.
    await expect(assertPublicHttpUrl("http://172.32.0.1/")).resolves.toBeTruthy();
    await expect(assertPublicHttpUrl("http://11.0.0.1/")).resolves.toBeTruthy();
    await expect(assertPublicHttpUrl("http://100.128.0.1/")).resolves.toBeTruthy();
  });

  it("refuses garbage", async () => {
    await refuse("not a url");
  });
});
