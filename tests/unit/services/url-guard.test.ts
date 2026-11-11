import { afterEach, describe, it, expect, vi } from "vitest";
import { assertPublicHttpUrl, fetchPublicBytes, fetchPublicUrl, UnsafeUrlError } from "../../../src/services/url-guard.js";

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

// The fetch path, with `fetch` stubbed and IP-literal hosts (no DNS, no
// network): what the bytes form returns, its size cap, and that a redirect
// into the VPC is refused at the hop. Images and source archives are read
// through it (#912).
describe("fetchPublicBytes", () => {
  const respond = (body: Uint8Array | string, init: ResponseInit = {}) => new Response(body, init);
  afterEach(() => vi.unstubAllGlobals());

  it("returns the bytes, what the server called them, and the final URL", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond("", { status: 302, headers: { location: "http://8.8.4.4/fig.png" } }))
      .mockResolvedValueOnce(respond(bytes, { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const body = await fetchPublicBytes("http://8.8.8.8/a");
    expect([...body.bytes]).toEqual([...bytes]);
    expect(body).toMatchObject({ contentType: "image/png", url: "http://8.8.4.4/fig.png" });
    // Redirects are followed by hand, so every hop is validated.
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses a redirect to a non-public address without fetching it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(respond("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchPublicBytes("http://8.8.8.8/fig.png")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at the caller's size cap, and at the page cap when none is given", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(new Uint8Array(2048))));
    await expect(fetchPublicBytes("http://8.8.8.8/big", { maxBytes: 1024 })).rejects.toThrow(/exceeds 1024 bytes/);
    expect((await fetchPublicBytes("http://8.8.8.8/big", { maxBytes: 4096 })).bytes).toHaveLength(2048);
    vi.stubGlobal("fetch", vi.fn(async () => respond(new Uint8Array(10 * 1024 * 1024 + 1))));
    await expect(fetchPublicBytes("http://8.8.8.8/big")).rejects.toThrow(/exceeds 10485760 bytes/);
  });

  it("is what the text form reads through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond("plain\u0000 text", { headers: { "content-type": "text/plain" } })));
    expect(await fetchPublicUrl("http://8.8.8.8/t")).toBe("plain text");
  });
});
