import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

// web/lib/api.ts is the BFF's client for the API: every request it makes
// carries the service key and no acting user. Ids reach it from route params
// that Next has already percent-decoded, so an id such as
// "../usage/system#" must stay one path segment of the route it was meant
// for, never walk the privileged GET onto another endpoint or add a query.
//
// api.ts imports server-only, which lives in web/node_modules; CI does not
// install that (it runs root `npm ci` then `npx vitest run`). The mock is
// registered under both the bare specifier (used when web/node_modules is
// absent) and the path it resolves to when web/node_modules is present.
vi.mock("server-only", () => ({}));
vi.mock("../../../web/node_modules/server-only/index.js", () => ({}));

const BASE = "http://api.test";
const KEY = "service-key";
const ID = "3f1c9a2e-5b7d-4e8f-9a01-6c2d4b8e0f13";
const OTHER = "0b6f5b1e-8c1d-4c3e-9a57-2f0d6c1e9a10";

type Api = typeof import("../../../web/lib/api");

let api: Api;
const fetchMock = vi.fn();

// The finding's exploit ids, as Next hands them to the handler, plus a few
// more shapes that would otherwise change the path or the query.
const CRAFTED = [
  "../usage/system#",
  `../attempts/${OTHER}?include=transcript#`,
  "../reports#",
  `../prize-claims/${OTHER}#`,
  `${ID}/../../usage/system`,
  `${ID}?include=transcript`,
  `${ID}#`,
  "%2e%2e",
  "..%2Fusage",
  "a/b",
];

// Ids that URL parsing resolves as dot segments however they are encoded.
const DOT_IDS = [".", ".."];

beforeAll(async () => {
  vi.stubEnv("MINERVAL_API_URL", BASE);
  vi.stubEnv("MINERVAL_API_KEY", KEY);
  vi.stubGlobal("fetch", fetchMock);
  // api.ts reads its env at load time, so load it after stubbing.
  api = await import("../../../web/lib/api");
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
  );
});

// Each request's URL parsed the way fetch parses it (dot segments resolved),
// reduced to its path, query and any fragment.
function requested(): string[] {
  return fetchMock.mock.calls.map(([url]) => {
    const u = new URL(String(url));
    return `${u.pathname}${u.search}${u.hash}`;
  });
}

// Every id-bearing fetcher, with the requests it makes for an id: `seg` is
// the id encoded as one path segment, `id` the raw value (fetchClaimDetail's
// findings lookup carries it as a query value, which URLSearchParams encodes).
const FETCHERS: Array<{
  name: string;
  call: (a: Api, id: string) => Promise<unknown>;
  paths: (seg: string, id: string) => string[];
}> = [
  {
    name: "fetchClaimCitation",
    call: (a, id) => a.fetchClaimCitation(id),
    paths: (s) => [`/claims/${s}/citation`],
  },
  {
    name: "fetchClaimDetail",
    call: (a, id) => a.fetchClaimDetail(id),
    paths: (s, id) => [
      `/claims/${s}?information_depth=deep`,
      `/claims/${s}/assessments/trajectory`,
      `/claims/${s}/record`,
      `/findings?${new URLSearchParams({ limit: "10", claim_id: id })}`,
      `/claims/${s}/provenance`,
    ],
  },
  {
    name: "fetchClaimEvents",
    call: (a, id) => a.fetchClaimEvents(id),
    paths: (s) => [`/claims/${s}/events?limit=200`],
  },
  {
    name: "fetchClaimTree",
    call: (a, id) => a.fetchClaimTree(id),
    paths: (s) => [`/claims/${s}?information_depth=standard&depth=8`],
  },
  {
    name: "fetchSourcePage",
    call: (a, id) => a.fetchSourcePage(id),
    paths: (s) => [
      `/sources/${s}`,
      `/sources/${s}/document`,
      `/sources/${s}/examinations`,
      `/sources/${s}/context`,
    ],
  },
  {
    name: "fetchAttempt",
    call: (a, id) => a.fetchAttempt(id),
    paths: (s) => [`/attempts/${s}`],
  },
  {
    name: "fetchContribution",
    call: (a, id) => a.fetchContribution(id),
    paths: (s) => [`/contributions/${s}`],
  },
  {
    name: "fetchContributorProfile",
    call: (a, id) => a.fetchContributorProfile(id),
    paths: (s) => [`/contributors/${s}`],
  },
  {
    name: "fetchMandateAllocation",
    call: (a, id) => a.fetchMandateAllocation(id),
    paths: (s) => [`/mandates/${s}/allocation`],
  },
];

function expectedPaths(f: (typeof FETCHERS)[number], id: string): string[] {
  return f.paths(encodeURIComponent(id), id);
}

describe("fetchClaimCitation", () => {
  it("requests a UUID's citation with the service key, URL unchanged", async () => {
    await api.fetchClaimCitation(ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/claims/${ID}/citation`);
    expect(init.headers).toEqual({ "x-api-key": KEY });
  });

  it("keeps the finding's exploit id inside /claims/:id/citation", async () => {
    await api.fetchClaimCitation("../usage/system#");
    expect(requested()).toEqual(["/claims/..%2Fusage%2Fsystem%23/citation"]);
  });
});

describe.each(FETCHERS)("$name", (f) => {
  it("requests the same URLs as before for a UUID", async () => {
    await f.call(api, ID);
    expect(requested().sort()).toEqual(expectedPaths(f, ID).sort());
  });

  it.each(CRAFTED)("keeps %j one segment of its own route", async (id) => {
    await f.call(api, id).catch(() => undefined);
    const got = requested();
    expect(got.sort()).toEqual(expectedPaths(f, id).sort());
    for (const p of got) expect(p).not.toContain("#");
  });

  it.each(DOT_IDS)("refuses %j as unknown without a request", async (id) => {
    const out = await f.call(api, id).then(
      (value) => ({ value }),
      (err: unknown) => ({ err }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    if ("err" in out) {
      expect((out.err as { status?: number }).status).toBe(404);
    } else {
      // The fetchers that map an unknown id to null do so here too.
      expect(out.value).toBeNull();
    }
  });
});
