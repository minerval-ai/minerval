import { describe, it, expect } from "vitest";

// The extension computes the shared cache's key on its side, so its copy of
// the normalizer must agree with the server's on every input.
import * as server from "../../../src/services/page-url.js";
import * as client from "../../../extension/lib/page-url.js";

const VECTORS: Array<[string, string | null]> = [
  ["https://example.com/a", "https://example.com/a"],
  ["http://www.Example.com/a/", "https://example.com/a"],
  ["https://example.com/", "https://example.com/"],
  ["https://example.com", "https://example.com/"],
  ["https://example.com/a#section-2", "https://example.com/a"],
  [
    "https://foo.substack.com/p/bar?utm_source=x&utm_medium=email&triedRedirect=true",
    "https://foo.substack.com/p/bar",
  ],
  // A comment permalink keeps the parameter that names the comment.
  [
    "https://www.lesswrong.com/posts/abc/title?commentId=xyz&fbclid=1",
    "https://lesswrong.com/posts/abc/title?commentId=xyz",
  ],
  ["https://example.com/a?b=2&a=1", "https://example.com/a?a=1&b=2"],
  ["https://example.com:8443/a", "https://example.com:8443/a"],
  ["https://example.com:443/a", "https://example.com/a"],
  ["ftp://example.com/a", null],
  ["chrome://extensions", null],
  ["not a url", null],
];

describe("page URL normalization", () => {
  it.each(VECTORS)("%s → %s (server)", (raw, expected) => {
    expect(server.normalizePageUrl(raw)).toBe(expected);
  });

  it.each(VECTORS)("%s → %s (extension agrees)", (raw, expected) => {
    expect(client.normalizePageUrl(raw)).toBe(expected);
  });

  it("hashes identically on both sides", async () => {
    for (const [raw] of VECTORS) {
      const url = server.normalizePageUrl(raw);
      if (!url) continue;
      expect(await client.pageUrlHash(url)).toBe(server.pageUrlHash(url));
    }
    expect(client.PAGE_HASH_PREFIX_CHARS).toBe(server.PAGE_HASH_PREFIX_CHARS);
  });
});
