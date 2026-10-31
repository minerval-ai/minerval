import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

// web/lib/account-api.ts is the BFF's client for the account half of the
// API: every request carries the service key, most also x-acting-user. Ids
// reach it from route params that Next has already percent-decoded and from
// form fields, so an id such as "../../admin/attempts/<id>/cancel?" must stay
// one path segment of the route it was meant for, never walk the request onto
// another endpoint or add a query.
//
// account-api.ts imports server-only, which lives in web/node_modules; CI
// does not install that (it runs root `npm ci` then `npx vitest run`). The
// mock is registered under both the bare specifier (used when web/node_modules
// is absent) and the path it resolves to when web/node_modules is present.
vi.mock("server-only", () => ({}));
vi.mock("../../../web/node_modules/server-only/index.js", () => ({}));

const BASE = "http://api.test";
const KEY = "service-key";
const EXT = "user-ext-1";
const ID = "3f1c9a2e-5b7d-4e8f-9a01-6c2d4b8e0f13";
const OTHER = "0b6f5b1e-8c1d-4c3e-9a57-2f0d6c1e9a10";

type Api = typeof import("../../../web/lib/account-api");

let api: Api;
const fetchMock = vi.fn();

// The finding's exploit ids, as Next hands them to the handler ("%2F" and
// "%3F" already decoded), plus a few more shapes that would otherwise change
// the path or the query.
const CRAFTED = [
  `../../admin/attempts/${OTHER}/cancel`,
  `../../admin/attempts/${OTHER}/cancel?`,
  `../../admin/attempts/${OTHER}/cancel#`,
  `${ID}/../../../admin/attempts/${OTHER}/cancel#`,
  `..\\..\\admin\\attempts\\${OTHER}\\cancel?`,
  `${ID}?claim_id=${OTHER}`,
  `${ID}#`,
  "%2e%2e",
  "..%2Fadmin",
  "a/b",
];

// Ids that URL parsing resolves as dot segments however they are encoded.
const DOT_IDS = [".", ".."];

beforeAll(async () => {
  vi.stubEnv("MINERVAL_API_URL", BASE);
  vi.stubEnv("MINERVAL_API_KEY", KEY);
  vi.stubGlobal("fetch", fetchMock);
  // account-api.ts reads its env at load time, so load it after stubbing.
  api = await import("../../../web/lib/account-api");
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// One body that satisfies every caller's unwrapping (r.order, r.orders[0],
// r.mandate.prizes, ...), fresh per request.
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      order: {},
      orders: [],
      job: {},
      grant: {},
      redirect_to: "https://client.test/cb",
      conversation: {},
      mandate: { attempts: [] },
      prize_claim: null,
    }),
  }));
});

// Each request as fetch sees it: the raw URL, and the URL parsed the way fetch
// parses it (dot segments resolved).
function requests() {
  return fetchMock.mock.calls.map(([url, init]) => {
    const raw = String(url);
    const u = new URL(raw);
    return {
      raw,
      path: u.pathname,
      search: u.search,
      hash: u.hash,
      method: (init as RequestInit).method,
      headers: (init as RequestInit).headers as Record<string, string>,
    };
  });
}

// Every function that puts an id into a backend path, with the path it is
// meant to reach for an id encoded as one segment (`seg`).
const PATH_FNS: Array<{
  name: string;
  call: (a: Api, id: string) => Promise<unknown>;
  path: (seg: string) => string;
  method: string;
  acting: boolean;
}> = [
  { name: "revokeApiKey", call: (a, id) => a.revokeApiKey(EXT, id), path: (s) => `/api-keys/${s}`, method: "DELETE", acting: true },
  { name: "createAssessmentOrder", call: (a, id) => a.createAssessmentOrder(EXT, id), path: (s) => `/claims/${s}/order`, method: "POST", acting: true },
  { name: "cancelAssessmentOrder", call: (a, id) => a.cancelAssessmentOrder(EXT, id), path: (s) => `/orders/${s}`, method: "DELETE", acting: true },
  { name: "createDecomposition", call: (a, id) => a.createDecomposition(EXT, id, 5), path: (s) => `/claims/${s}/decompose`, method: "POST", acting: true },
  { name: "getBudgetJob", call: (a, id) => a.getBudgetJob(EXT, id), path: (s) => `/budget-jobs/${s}`, method: "GET", acting: true },
  { name: "topUpBudgetJob", call: (a, id) => a.topUpBudgetJob(EXT, id, 3), path: (s) => `/budget-jobs/${s}/topup`, method: "POST", acting: true },
  { name: "cancelBudgetJob", call: (a, id) => a.cancelBudgetJob(EXT, id), path: (s) => `/budget-jobs/${s}/cancel`, method: "POST", acting: true },
  { name: "getGrant", call: (a, id) => a.getGrant(EXT, id), path: (s) => `/grants/${s}`, method: "GET", acting: true },
  { name: "approveGrant", call: (a, id) => a.approveGrant(EXT, id), path: (s) => `/grants/${s}/approve`, method: "POST", acting: true },
  { name: "topUpGrant", call: (a, id) => a.topUpGrant(EXT, id, 3), path: (s) => `/grants/${s}/topup`, method: "POST", acting: true },
  { name: "cancelGrant", call: (a, id) => a.cancelGrant(EXT, id), path: (s) => `/grants/${s}/cancel`, method: "POST", acting: true },
  { name: "fetchOAuthRequest", call: (a, id) => a.fetchOAuthRequest(id), path: (s) => `/oauth/requests/${s}`, method: "GET", acting: false },
  { name: "approveOAuthRequest", call: (a, id) => a.approveOAuthRequest(EXT, id), path: (s) => `/oauth/requests/${s}/approve`, method: "POST", acting: true },
  { name: "denyOAuthRequest", call: (a, id) => a.denyOAuthRequest(id), path: (s) => `/oauth/requests/${s}/deny`, method: "POST", acting: false },
  { name: "continueGrantConversation", call: (a, id) => a.continueGrantConversation(EXT, id, "hello"), path: (s) => `/grant-conversations/${s}/messages`, method: "POST", acting: true },
  { name: "fundGrantConversation", call: (a, id) => a.fundGrantConversation(EXT, id, 5), path: (s) => `/grant-conversations/${s}/fund`, method: "POST", acting: true },
  { name: "getGrantConversation", call: (a, id) => a.getGrantConversation(EXT, id), path: (s) => `/grant-conversations/${s}`, method: "GET", acting: true },
  { name: "fetchMandateView", call: (a, id) => a.fetchMandateView(id, EXT), path: (s) => `/mandates/${s}`, method: "GET", acting: true },
  { name: "contributeToMandateApi", call: (a, id) => a.contributeToMandateApi(EXT, id, 2), path: (s) => `/mandates/${s}/contribute`, method: "POST", acting: true },
  { name: "allocateToClaim", call: (a, id) => a.allocateToClaim(EXT, id, 2), path: (s) => `/claims/${s}/contribute`, method: "POST", acting: true },
  { name: "submitPrizeClaim", call: (a, id) => a.submitPrizeClaim(EXT, id, new FormData()), path: (s) => `/claims/${s}/prize-claims`, method: "POST", acting: true },
  {
    name: "submitPrizePayee",
    call: (a, id) =>
      a.submitPrizePayee(EXT, id, {
        legal_name: "A",
        country: "GB",
        us_person: false,
        has_tin: false,
        treaty_position: false,
        code: "123456",
      }),
    path: (s) => `/prize-claims/${s}/payee`,
    method: "POST",
    acting: true,
  },
  { name: "uploadPrizeTaxForm", call: (a, id) => a.uploadPrizeTaxForm(EXT, id, new FormData()), path: (s) => `/prize-claims/${s}/attachments`, method: "POST", acting: true },
  { name: "requestPrizeClaimCode", call: (a, id) => a.requestPrizeClaimCode(EXT, id, "payee"), path: (s) => `/prize-claims/${s}/code`, method: "POST", acting: true },
];

describe("createAssessmentOrder (the finding's example)", () => {
  it("keeps the exploit id inside /claims/:id/order", async () => {
    await api.createAssessmentOrder(EXT, `../../admin/attempts/${OTHER}/cancel?`);
    const [req] = requests();
    expect(req!.path).toBe(
      `/claims/..%2F..%2Fadmin%2Fattempts%2F${OTHER}%2Fcancel%3F/order`,
    );
    expect(req!.search).toBe("");
    expect(req!.path.startsWith("/admin")).toBe(false);
  });
});

describe.each(PATH_FNS)("$name", (f) => {
  it("requests the same URL as before for a UUID", async () => {
    await f.call(api, ID);
    expect(requests()).toEqual([
      {
        raw: `${BASE}${f.path(ID)}`,
        path: f.path(ID),
        search: "",
        hash: "",
        method: f.method,
        headers: expect.objectContaining({
          "x-api-key": KEY,
          ...(f.acting ? { "x-acting-user": EXT } : {}),
        }),
      },
    ]);
  });

  it("requests an upper-case UUID unchanged", async () => {
    const id = ID.toUpperCase();
    await f.call(api, id);
    expect(requests().map((r) => r.raw)).toEqual([`${BASE}${f.path(id)}`]);
  });

  it.each(CRAFTED)("keeps %j one segment of its own route", async (id) => {
    await f.call(api, id);
    const got = requests();
    expect(got).toHaveLength(1);
    expect(got[0]!.path).toBe(f.path(encodeURIComponent(id)));
    expect(got[0]!.search).toBe("");
    expect(got[0]!.hash).toBe("");
    expect(got[0]!.method).toBe(f.method);
  });

  it.each(DOT_IDS)("refuses %j as unknown (404) without a request", async (id) => {
    const err = await f.call(api, id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(api.AccountApiError);
    expect((err as InstanceType<Api["AccountApiError"]>).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// The claim page's order poll carries the claim id as a query value.
describe("getOpenOrderForClaim", () => {
  it("requests the same URL as before for a UUID", async () => {
    await api.getOpenOrderForClaim(EXT, ID);
    const [req] = requests();
    expect(req!.raw).toBe(`${BASE}/orders?claim_id=${ID}`);
    expect(req!.method).toBe("GET");
    expect(req!.headers).toEqual({ "x-api-key": KEY, "x-acting-user": EXT });
  });

  it.each([...CRAFTED, ...DOT_IDS, `${ID}&limit=1000`])(
    "keeps %j the sole claim_id value of /orders",
    async (id) => {
      await api.getOpenOrderForClaim(EXT, id);
      const got = requests();
      expect(got).toHaveLength(1);
      const u = new URL(got[0]!.raw);
      expect(u.pathname).toBe("/orders");
      expect(u.hash).toBe("");
      expect([...u.searchParams.keys()]).toEqual(["claim_id"]);
      expect(u.searchParams.get("claim_id")).toBe(id);
    },
  );
});
