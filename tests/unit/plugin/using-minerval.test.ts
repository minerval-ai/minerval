import { readdirSync, statSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import { getCallerSkill } from "../../../src/mcp/caller-skills.js";

/**
 * The using-minerval skill describes the site page by page, to every agent
 * that helps someone use Minerval. A page added, moved or removed without
 * the skill following would leave those agents sending people to the wrong
 * place, so this checks the skill's route table against web/app both ways.
 * When it fails, edit plugin/skills/using-minerval/SKILL.md.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const appDir = join(root, "web/app");

/** Pages a person is not sent to: plumbing, or a redirect. */
const NOT_DESCRIBED: Record<string, string> = {
  "/logo-preview": "An internal preview of the logo.",
  "/oauth/consent": "Reached only from an OAuth client's sign-in, never navigated to.",
  "/queue": "A redirect kept for old links.",
  "/account/grants": "A redirect kept for old links: the Mandates list's own tab.",
  "/account/grants/new": "A redirect kept for old links: starting a mandate is in Ask.",
  "/account/grants/:id": "A redirect kept for old links: a grant and its mandate have one page.",
};

function pageRoutes(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) continue;
    if (name === "api") continue;
    // A route group "(name)" adds no path segment.
    const segment = /^\(.*\)$/.test(name) ? "" : `/${name.replace(/^\[(.+)\]$/, ":$1")}`;
    out.push(...pageRoutes(path, prefix + segment));
  }
  if (existsSync(join(dir, "page.tsx"))) out.push(prefix || "/");
  return out;
}

/** Parameter names differ between the skill and the folders; compare shapes. */
const shape = (route: string) => route.replace(/:[A-Za-z_]+/g, ":x").replace(/\/$/, "") || "/";

describe("using-minerval", () => {
  const skill = getCallerSkill("using-minerval")!.text;
  const table = skill.slice(skill.indexOf("## The site, page by page"), skill.indexOf("## Owls"));
  const described = new Set(
    [...table.matchAll(/`(\/[^`\s]*)`/g)].map((m) => shape(m[1]!))
  );
  const pages = pageRoutes(appDir);

  it("sees the site", () => {
    expect(pages.length).toBeGreaterThan(30);
    expect(described.size).toBeGreaterThan(20);
  });

  it("describes every page of the site", () => {
    const missing = pages
      .filter((route) => !(route in NOT_DESCRIBED))
      // The docs hub's subpages are described as "/docs and under it".
      .filter((route) => !route.startsWith("/docs/"))
      .filter((route) => !described.has(shape(route)));
    expect(missing).toEqual([]);
  });

  it("describes no page that does not exist", () => {
    const real = new Set(pages.map(shape));
    expect([...described].filter((route) => !real.has(route))).toEqual([]);
    expect(Object.keys(NOT_DESCRIBED).filter((route) => !real.has(shape(route)))).toEqual([]);
  });
});
