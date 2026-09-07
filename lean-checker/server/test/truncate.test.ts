import { describe, expect, it } from "vitest";
import { capList, capText, OutputCollector } from "../src/truncate.js";

describe("output caps", () => {
  it("caps text at 64 KB of UTF-8 without splitting a code point", () => {
    const text = "∀".repeat(40_000); // 3 bytes each: 120 KB
    const { text: out, truncated } = capText(text, 64 * 1024);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(out, "utf8") % 3).toBe(0);
    expect(out).not.toContain("�");
    expect(capText("short", 64 * 1024)).toEqual({ text: "short", truncated: false });
  });

  it("caps diagnostics at 200 with the flag", () => {
    const many = Array.from({ length: 250 }, (_, i) => i);
    const { items, truncated } = capList(many, 200);
    expect(items).toHaveLength(200);
    expect(truncated).toBe(true);
    expect(capList([1, 2], 200)).toEqual({ items: [1, 2], truncated: false });
  });

  it("collects streamed output up to the cap and counts the rest", () => {
    const c = new OutputCollector(10);
    c.append(Buffer.from("12345"));
    c.append(Buffer.from("67890abc"));
    c.append(Buffer.from("more"));
    expect(c.text()).toBe("1234567890");
    expect(c.truncated).toBe(true);
    expect(c.droppedBytes).toBe(7);
  });
});
