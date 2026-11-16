import { describe, it, expect } from "vitest";
import { isReadingAddress, sourceHref } from "../../../web/lib/source-address";

// Where a source's address leads as a link (web/lib/source-address.ts). A web
// address is linked exactly as it was. A reading kept through a connection
// has an address no browser can open, so it leads to the source's own page.

describe("a source's address as a link", () => {
  it("leaves a web address exactly as it is, with or without the source's id", () => {
    for (const url of ["https://example.org/a?b=1#c", "http://intranet.example/x", "https://doi.org/10.1/reading:x"]) {
      expect(sourceHref(url)).toBe(url);
      expect(sourceHref(url, "3f1c9a2e-5b7d-4e8f-9a01-6c2d4b8e0f13")).toBe(url);
      expect(isReadingAddress(url)).toBe(false);
    }
  });

  it("has nothing to link where there is no address", () => {
    expect(sourceHref(null)).toBeNull();
    expect(sourceHref(undefined)).toBeNull();
    expect(sourceHref("")).toBeNull();
  });

  it("sends a kept reading to its source's page, and links nothing where the source is not known", () => {
    const address = "reading:warehouse/0b6f5b1e-8c1d-4c3e-9a57-2f0d6c1e9a10";
    expect(isReadingAddress(address)).toBe(true);
    expect(sourceHref(address, "3f1c9a2e-5b7d-4e8f-9a01-6c2d4b8e0f13")).toBe(
      "/sources/3f1c9a2e-5b7d-4e8f-9a01-6c2d4b8e0f13"
    );
    expect(sourceHref(address)).toBeNull();
    expect(sourceHref(address, "a/../b")).toBe("/sources/a%2F..%2Fb");
  });
});
