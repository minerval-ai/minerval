import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_PATH, gateDecision, wantsPage } from "../../../web/lib/gate";

// What a members-only build of the web app adds, and that a build for the
// public graph has none of it (web/next.config.mjs, web/proxy.members.ts,
// web/lib/gate.ts). The pages of a private deployment and the proxy that
// keeps anyone who is not a member from them are files named *.members.ts(x),
// which Next sees only when the build is made with READS=members.

const WEB = join(__dirname, "../../../web");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === ".next") return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? files(path) : [path];
  });
}

async function configUnder(reads: string | undefined) {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (reads !== undefined) vi.stubEnv("READS", reads);
  else vi.stubEnv("READS", "");
  return (await import("../../../web/next.config.mjs")).default as {
    pageExtensions: string[];
    env: Record<string, string>;
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the gate's decision", () => {
  const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

  it("lets a signed-in member through, whatever they ask for", () => {
    expect(gateDecision({ member: true, wantsPage: true })).toBe("through");
    expect(gateDecision({ member: true, wantsPage: false })).toBe("through");
  });

  it("answers anyone else with the gate page in place of a page, and refuses anything else", () => {
    expect(gateDecision({ member: false, wantsPage: true })).toBe("gate_page");
    expect(gateDecision({ member: false, wantsPage: false })).toBe("refuse");
  });

  it("takes a navigation and a form's action for a page, and a script's request for something else", () => {
    expect(wantsPage(headers({ accept: "text/html,application/xhtml+xml" }))).toBe(true);
    expect(wantsPage(headers({ "next-action": "abc", accept: "text/x-component" }))).toBe(true);
    expect(wantsPage(headers({ rsc: "1" }))).toBe(true);
    expect(wantsPage(headers({ accept: "*/*" }))).toBe(false);
    expect(wantsPage(headers({}))).toBe(false);
  });
});

describe("a build for the public graph", () => {
  it("does not see files named for a members-only build", async () => {
    for (const reads of [undefined, "open", "anything-else"]) {
      const config = await configUnder(reads);
      expect(config.pageExtensions, String(reads)).toEqual(["tsx", "ts", "jsx", "js"]);
      expect(config.env.MINERVAL_BUILT_READS).toBe("open");
    }
  });

  it("has no proxy: the only proxy file is the members-only one", () => {
    for (const name of ["proxy.ts", "proxy.js", "middleware.ts", "middleware.js"]) {
      expect(existsSync(join(WEB, name)), name).toBe(false);
    }
    expect(existsSync(join(WEB, "proxy.members.ts"))).toBe(true);
  });

  it("has none of a private deployment's pages: each is a .members.tsx file", () => {
    const under = (dir: string) => files(join(WEB, "app", dir)).map((f) => f.slice(WEB.length + 1));
    const routeFiles = [...under("admin"), ...under("members-gate"), ...under("sources/new")].filter((f) =>
      /\/(page|layout|route|template|default|loading|error|not-found)\.[^/]+$/.test(f)
    );
    expect(routeFiles.length).toBeGreaterThan(7);
    for (const file of routeFiles) expect(file, file).toMatch(/\.members\.tsx?$/);
  });
});

describe("a members-only build", () => {
  it("sees those files, ahead of the ordinary ones", async () => {
    const config = await configUnder("members");
    expect(config.pageExtensions).toEqual(["members.tsx", "members.ts", "tsx", "ts", "jsx", "js"]);
    expect(config.env.MINERVAL_BUILT_READS).toBe("members");
  });

  it("puts the proxy in front of everything but what signing in needs", () => {
    const proxy = readFileSync(join(WEB, "proxy.members.ts"), "utf8");
    const matcher = proxy.match(/matcher: \["(.+)"\]/)?.[1];
    expect(matcher).toBeDefined();
    // The matcher as Next reads it: a path pattern whose parentheses are a regular expression.
    const pattern = new RegExp(`^${matcher!.replace(/\\\\/g, "\\")}$`);
    for (const path of ["/", "/claims", "/admin/people", "/api/claims/x", "/embed/claims/x", "/members-gate", "/evals/replays/a.json"]) {
      expect(pattern.test(path), path).toBe(true);
    }
    for (const path of ["/api/auth/callback/oidc", "/api/auth/session", "/_next/static/chunks/a.css", "/icon.svg", "/apple-icon"]) {
      expect(pattern.test(path), path).toBe(false);
    }
  });

  it("answers with a page that exists", () => {
    expect(existsSync(join(WEB, "app", `${GATE_PATH.slice(1)}/page.members.tsx`))).toBe(true);
  });
});
