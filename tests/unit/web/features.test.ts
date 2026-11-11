import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_NAMES as API_FEATURE_NAMES, listFeatures } from "../../../src/features.js";
import {
  ALL_FEATURES_ON,
  FEATURE_NAMES,
  claimWithoutOffFeatures,
  featureOn,
  featuresFromResponse,
  listWithoutOffFeatures,
} from "../../../web/lib/features";
import type { ClaimDetail, SearchResultItem, TreeNode } from "../../../web/lib/types";

// The web app learns which optional parts of the product a deployment has
// from GET /setup/features (web/lib/features.ts, web/lib/api.ts). These
// tests hold it to three things: it reads the list the API really serves,
// it shows everything when it cannot read that list, and a feature that is
// off takes its fields and its pages with it.
//
// The API's answers below are built by the API's own listFeatures, so a
// change to what the route serves is felt here.

// api.ts imports server-only, which lives in web/node_modules; CI runs these
// with only the root install. Mocked under both specifiers, as in
// api-path-segments.test.ts.
vi.mock("server-only", () => ({}));
vi.mock("../../../web/node_modules/server-only/index.js", () => ({}));

const WEB = join(__dirname, "../../../web");

/** What GET /setup/features answers in a deployment with this FEATURES_OFF. */
function apiAnswer(featuresOff: string[]): unknown {
  // Through JSON, as it crosses the wire.
  return JSON.parse(JSON.stringify({ features: listFeatures({ featuresOff }) }));
}

describe("the feature list as the web app reads it", () => {
  it("knows the same features as the API", () => {
    expect([...FEATURE_NAMES].sort()).toEqual([...API_FEATURE_NAMES].sort());
  });

  it("has every feature on in a deployment that switches nothing off", () => {
    expect(featuresFromResponse(apiAnswer([]))).toEqual(ALL_FEATURES_ON);
    for (const name of FEATURE_NAMES) expect(featureOn(ALL_FEATURES_ON, name)).toBe(true);
  });

  it("has only the named feature off", () => {
    expect(featuresFromResponse(apiAnswer(["extension"]))).toEqual({
      extension: false, mathematics: true, prizes: true,
    });
    expect(featuresFromResponse(apiAnswer(["prizes"]))).toEqual({
      extension: true, mathematics: true, prizes: false,
    });
  });

  it("has prizes off when mathematics is off, because the API reports it so", () => {
    const features = featuresFromResponse(apiAnswer(["mathematics"]));
    expect(featureOn(features, "mathematics")).toBe(false);
    expect(featureOn(features, "prizes")).toBe(false);
    expect(featureOn(features, "extension")).toBe(true);
  });

  it("takes the list as given and applies no dependency rule of its own", () => {
    // The API never serves this. If it did, the web app would believe it:
    // which feature needs which is the API's to decide, in one place.
    const features = featuresFromResponse({
      features: [
        { name: "mathematics", on: false },
        { name: "prizes", on: true },
      ],
    });
    expect(features).toEqual({ extension: true, mathematics: false, prizes: true });
  });

  it("leaves a feature on unless the list says in so many words that it is off", () => {
    for (const body of [
      null,
      undefined,
      "not json",
      {},
      { features: "mathematics" },
      { features: [null, 7, { name: "prizes" }, { name: "mathematics", on: "false" }] },
      { features: [{ name: "not-a-feature", on: false }] },
    ]) {
      expect(featuresFromResponse(body), JSON.stringify(body)).toEqual(ALL_FEATURES_ON);
    }
  });
});

describe("reading the feature list from the API", () => {
  const BASE = "http://api.test";
  type Api = typeof import("../../../web/lib/api");
  let api: Api;
  const fetchMock = vi.fn();
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

  function answer(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  beforeAll(async () => {
    vi.stubEnv("MINERVAL_API_URL", BASE);
    vi.stubEnv("MINERVAL_API_KEY", "service-key");
    vi.stubGlobal("fetch", fetchMock);
    // api.ts reads its env at load time, so load it after stubbing.
    vi.resetModules();
    api = await import("../../../web/lib/api");
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    errorLog.mockRestore();
  });

  beforeEach(() => {
    fetchMock.mockReset();
    errorLog.mockClear();
  });

  it("asks GET /setup/features and returns what it says", async () => {
    fetchMock.mockResolvedValue(answer(apiAnswer(["mathematics"])));
    expect(await api.fetchFeatures()).toEqual({ extension: true, mathematics: false, prizes: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${BASE}/setup/features`);
  });

  it("is cached like the other reads, not fetched afresh on every render", async () => {
    fetchMock.mockResolvedValue(answer(apiAnswer([])));
    await api.fetchFeatures();
    const init = fetchMock.mock.calls[0]![1] as { next?: { revalidate?: number }; cache?: string };
    expect(init.next?.revalidate).toBeGreaterThan(0);
    expect(init.cache).toBeUndefined();
  });

  // A transient failure must never hide part of the site from a deployment
  // that has it, so every way the read can fail answers "all on".
  it.each([
    ["the API answers 500", () => fetchMock.mockResolvedValue(answer({ error: "boom" }, 500))],
    ["the API predates the route (404)", () => fetchMock.mockResolvedValue(answer({ error: "Not Found" }, 404))],
    ["the request never arrives", () => fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))],
    ["the body is not JSON", () => fetchMock.mockResolvedValue(new Response("<html>", { status: 200 }))],
  ])("treats every feature as on when %s", async (_what, arrange) => {
    arrange();
    expect(await api.fetchFeatures()).toEqual(ALL_FEATURES_ON);
    expect(errorLog).toHaveBeenCalled();
  });

  it("treats every feature as on, without asking, when no API is configured", async () => {
    vi.stubEnv("MINERVAL_API_URL", "");
    vi.resetModules();
    const offline = await import("../../../web/lib/api");
    expect(await offline.fetchFeatures()).toEqual(ALL_FEATURES_ON);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("MINERVAL_API_URL", BASE);
  });
});

describe("what a claim carries about a feature that is off", () => {
  const check = { kind: "proof", verdict: "accepted" } as unknown as NonNullable<TreeNode["argument_lean_check"]>;

  function node(id: string, children: TreeNode[] = []): TreeNode {
    return {
      id, text: id, bounty_micro_usd: 5_000_000, checked: "proof", formal: true,
      argument_lean_check: check, children,
    } as unknown as TreeNode;
  }

  const detail = {
    claim: { id: "root", text: "root" },
    assessment: null,
    subclaim_count: 2,
    tree: node("root", [node("a", [node("b")])]),
    arguments: [{ id: "arg", stance: "for", content: "", lean_check: check }],
    dependents: [{ id: "dep", text: "dep", bounty_micro_usd: 1_000_000, checked: "proof", formal: true }],
    formalization: { statement_source: "theorem t : True" },
    verification: { kind: "proof" },
    bounty: { amount_micro_usd: 5_000_000, status: "open" },
    attempts: [{ id: "attempt" }],
    prize_claims: [{ id: "prize-claim" }],
  } as unknown as ClaimDetail;

  function nodes(tree: TreeNode | undefined): TreeNode[] {
    return tree ? [tree, ...tree.children.flatMap((c) => nodes(c))] : [];
  }

  it("is untouched when every feature is on", () => {
    expect(claimWithoutOffFeatures(detail, ALL_FEATURES_ON)).toBe(detail);
  });

  it("loses the prize and keeps the mathematics when only prizes are off", () => {
    const out = claimWithoutOffFeatures(detail, { extension: true, mathematics: true, prizes: false });
    expect(out.bounty).toBeNull();
    expect(out.prize_claims).toEqual([]);
    expect(out.formalization).toEqual(detail.formalization);
    expect(out.verification).toEqual(detail.verification);
    expect(out.attempts).toEqual(detail.attempts);
    expect(out.arguments?.[0]?.lean_check).toEqual(check);
    for (const n of nodes(out.tree)) {
      expect(n.bounty_micro_usd).toBeNull();
      expect(n.checked).toBe("proof");
      expect(n.formal).toBe(true);
    }
    expect(out.dependents?.[0]).toMatchObject({ bounty_micro_usd: null, checked: "proof", formal: true });
  });

  it("loses the formal statement, the checks, the attempts and the prize when mathematics is off", () => {
    const out = claimWithoutOffFeatures(detail, featuresFromResponse(apiAnswer(["mathematics"])));
    expect(out.formalization).toBeNull();
    expect(out.verification).toBeNull();
    expect(out.attempts).toEqual([]);
    expect(out.bounty).toBeNull();
    expect(out.prize_claims).toEqual([]);
    expect(out.arguments?.[0]?.lean_check).toBeNull();
    expect(nodes(out.tree)).toHaveLength(3);
    for (const n of nodes(out.tree)) {
      expect(n.bounty_micro_usd).toBeNull();
      expect(n.checked).toBeNull();
      expect(n.formal).toBe(false);
      expect(n.argument_lean_check).toBeNull();
    }
    expect(out.dependents?.[0]).toMatchObject({ bounty_micro_usd: null, checked: null, formal: false });
    // The claim itself, and the caller's copy of it, are as they were.
    expect(out.claim).toEqual(detail.claim);
    expect(detail.bounty).not.toBeNull();
    expect(detail.tree?.checked).toBe("proof");
  });

  it("takes the prize chip and the machine-checked badge off the claim cards", () => {
    const items = [
      { id: "c", text: "c", prize_micro_usd: 5_000_000, checked: "proof" },
    ] as unknown as SearchResultItem[];
    expect(listWithoutOffFeatures(items, ALL_FEATURES_ON)).toBe(items);
    expect(
      listWithoutOffFeatures(items, { extension: true, mathematics: true, prizes: false })[0],
    ).toMatchObject({ id: "c", prize_micro_usd: null, checked: "proof" });
    expect(
      listWithoutOffFeatures(items, featuresFromResponse(apiAnswer(["mathematics"])))[0],
    ).toMatchObject({ id: "c", prize_micro_usd: null, checked: null });
  });
});

// A page that exists only for a feature answers "not found" where the
// feature is off, and decides that before it reads anything else: a page
// that read first could fall back to the design fixtures (web/lib/data.ts)
// and show a sample prize in a deployment with no prizes. The web app's
// pages are not rendered in this suite, so this reads their source, the way
// page-head.test.ts does.
describe("pages that exist only for a feature", () => {
  const PAGES: Array<{ file: string; feature: string }> = [
    { file: "app/prizes/page.tsx", feature: "prizes" },
    { file: "app/prizes/rules/page.tsx", feature: "prizes" },
    { file: "app/claims/[id]/prize/claim/page.tsx", feature: "prizes" },
    { file: "app/claims/[id]/attempts/[attemptId]/page.tsx", feature: "mathematics" },
  ];

  it.each(PAGES)("$file is not found where $feature is off, before any other read", ({ file, feature }) => {
    const text = readFileSync(join(WEB, file), "utf8");
    const guard = `if (!featureOn(await loadFeatures(), "${feature}")) notFound();`;
    // The page, and its generateMetadata where it has one, which Next runs
    // as well and which would otherwise read the claim first.
    const functions = text.split(/^export (?:default )?async function /m).slice(1);
    expect(functions.length).toBeGreaterThan(0);
    for (const fn of functions) {
      const name = fn.slice(0, fn.indexOf("("));
      const at = fn.indexOf(guard);
      expect(at, `${file}: ${name} does not check the feature`).toBeGreaterThan(-1);
      const firstRead = fn.search(/\bload(?!Features\b)[A-Z]\w*\(/);
      if (firstRead !== -1) {
        expect(at, `${file}: ${name} reads data before checking the feature`).toBeLessThan(firstRead);
      }
    }
  });
});
