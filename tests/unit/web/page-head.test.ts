import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Every page's heading comes from web/components/PageHead.tsx, so the line
// above a heading, the heading and the lede look the same on every page. A
// page that writes its own <h1>, or reaches for one of the head's classes
// directly, is how the pages drifted apart before; this fails when one does.

const WEB = join(__dirname, "../../../web");

// Files allowed their own <h1>, each with its reason.
const OWN_H1: Record<string, string> = {
  "components/PageHead.tsx": "the one place the page <h1> is written",
  "app/page.tsx": "the landing page's hero is a composition of its own",
  "app/logo-preview/page.tsx": "a design scratch page for logo candidates, set at its own small scale",
};

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === ".next") return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? tsxFiles(p) : e.name.endsWith(".tsx") ? [p] : [];
  });
}

const files = [...tsxFiles(join(WEB, "app")), ...tsxFiles(join(WEB, "components"))].map((p) => ({
  rel: relative(WEB, p),
  text: readFileSync(p, "utf8"),
}));

describe("page heads", () => {
  it("finds the web app's pages", () => {
    expect(files.length).toBeGreaterThan(50);
    for (const rel of Object.keys(OWN_H1)) {
      expect(files.some((f) => f.rel === rel), `${rel} is listed but does not exist`).toBe(true);
    }
  });

  it("no page writes its own <h1>", () => {
    const offenders = files
      .filter((f) => !(f.rel in OWN_H1))
      .filter((f) => /<h1[\s>]/.test(f.text.replace(/\/\/.*$/gm, "")))
      .map((f) => f.rel);
    expect(offenders, "use <PageHead> from web/components/PageHead.tsx").toEqual([]);
  });

  it("the head's classes are used only by PageHead", () => {
    const offenders = files
      .filter((f) => f.rel !== "components/PageHead.tsx")
      .filter((f) => /\bpage-(back|kicker|title|meta|lede)\b/.test(f.text))
      .map((f) => f.rel);
    expect(offenders, "pass the slot to <PageHead> instead of using its class").toEqual([]);
  });

  it("no page overrides the head with an inline style", () => {
    const offenders = files
      .filter((f) => /<Page(Head|Back)\b[^>]*?\bstyle=/s.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
