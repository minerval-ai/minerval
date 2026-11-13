import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The web app's part in a members-only deployment (web/lib/members.ts):
// every read names its reader and is kept for no one, no read is ever
// answered from the design fixtures, and a visitor is asked to sign in
// before a page is shown. And its part in the public graph, which is to do
// none of that: a read is for anybody, shared for a short window, and the
// session is never looked at.
//
// CI installs only the root node_modules, so what these modules pull from
// web/node_modules is mocked under both its bare name and its
// web/node_modules path, as the other web tests do. web/auth is mocked
// whole, so next-auth is never loaded.

const h = vi.hoisted(() => {
  const Fragment = Symbol.for("test.fragment");
  const el = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  return {
    session: null as null | { externalId: string },
    auth: vi.fn(),
    signIn: vi.fn(async (..._args: unknown[]) => undefined),
    signOut: vi.fn(async (..._args: unknown[]) => undefined),
    jsxRuntime: { jsx: el, jsxs: el, Fragment },
    jsxDevRuntime: { jsxDEV: el, Fragment },
  };
});
h.auth.mockImplementation(async () => h.session);

vi.mock("server-only", () => ({}));
vi.mock("../../../web/node_modules/server-only/index.js", () => ({}));
vi.mock("react", () => ({ cache: <T>(fn: T) => fn }));
vi.mock("../../../web/node_modules/react/index.js", () => ({ cache: <T>(fn: T) => fn }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("../../../web/node_modules/next/link.js", () => ({ default: "a" }));
vi.mock("react/jsx-runtime", () => h.jsxRuntime);
vi.mock("../../../web/node_modules/react/jsx-runtime.js", () => h.jsxRuntime);
vi.mock("react/jsx-dev-runtime", () => h.jsxDevRuntime);
vi.mock("../../../web/node_modules/react/jsx-dev-runtime.js", () => h.jsxDevRuntime);
vi.mock("../../../web/auth", () => ({
  auth: h.auth,
  signIn: h.signIn,
  signOut: h.signOut,
  githubEnabled: () => false,
  googleEnabled: () => false,
  devLoginEnabled: () => false,
  oidcEnabled: () => true,
  oidcName: () => "Halden single sign-on",
}));

const BASE = "http://api.test";
const KEY = "service-key";
const ID = "3f1c9a2e-5b7d-4e8f-9a01-6c2d4b8e0f13";
const fetchMock = vi.fn();

type Init = RequestInit & { next?: { revalidate?: number } };
const lastCall = () => fetchMock.mock.calls.at(-1) as [string, Init];
const headersOf = (init: Init) => init.headers as Record<string, string>;

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, statusText: "x", json: async () => body };
}

/** Load the web modules fresh under one setting; they read their env when loaded. */
async function load(reads: "open" | "members" | undefined, api = true) {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (api) {
    vi.stubEnv("MINERVAL_API_URL", BASE);
    vi.stubEnv("MINERVAL_API_KEY", KEY);
  } else {
    vi.stubEnv("MINERVAL_API_URL", "");
  }
  if (reads) vi.stubEnv("READS", reads);
  vi.stubGlobal("fetch", fetchMock);
  return {
    api: await import("../../../web/lib/api"),
    account: await import("../../../web/lib/account-api"),
    data: await import("../../../web/lib/data"),
    members: await import("../../../web/lib/members"),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  h.auth.mockClear();
  h.session = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("on the public graph", () => {
  it("a read is for anybody: the service key alone, shared for a short window, the session never read", async () => {
    const { api, members } = await load(undefined);
    expect(members.membersOnly()).toBe(false);
    h.session = { externalId: "github:1" };
    fetchMock.mockResolvedValue(answer(200, { events: [] }));
    await api.fetchClaimEvents(ID);
    const [url, init] = lastCall();
    expect(url).toBe(`${BASE}/claims/${ID}/events?limit=200`);
    expect(init).toEqual({ headers: { "x-api-key": KEY }, next: { revalidate: 30 } });
    expect(h.auth).not.toHaveBeenCalled();
  });

  it("an account call that names nobody stays that way", async () => {
    const { account } = await load("open");
    h.session = { externalId: "github:1" };
    fetchMock.mockResolvedValue(answer(200, { user: {} }));
    await account.provisionUser({ externalId: "github:1", displayName: "A" });
    expect(headersOf(lastCall()[1])["x-acting-user"]).toBeUndefined();
    expect(h.auth).not.toHaveBeenCalled();
  });

  it("falls back to the design fixtures when a read fails, as before", async () => {
    const { data } = await load(undefined);
    fetchMock.mockResolvedValue(answer(500, {}));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const claim = await data.loadClaim("inflation-2022");
    expect(claim.source).toBe("fixture");
    expect(claim.detail?.claim.id).toBe("inflation-2022");
    const offline = await (await load(undefined, false)).data.loadClaim("inflation-2022");
    expect(offline.source).toBe("fixture");
    expect(offline.detail).not.toBeNull();
  });

  it("but never for a read the API refused as members-only, whatever this app was told", async () => {
    const { data } = await load(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const code of ["SIGN_IN_REQUIRED", "NOT_A_MEMBER", "PERMISSION_REQUIRED"]) {
      fetchMock.mockResolvedValue(answer(code === "SIGN_IN_REQUIRED" ? 401 : 403, { error: "no", code }));
      expect(await data.loadClaim("inflation-2022"), code).toEqual({ detail: null, source: "live" });
      expect((await data.loadClaims()).results, code).toEqual([]);
      expect((await data.loadSourcePage("anything")).page, code).toBeNull();
      expect((await data.loadArgument("anything")).page, code).toBeNull();
      expect((await data.loadClaimEvents("inflation-2022")).events, code).toBeNull();
    }
  });
});

describe("in a members-only deployment", () => {
  it("a read names the signed-in reader and is kept for no one", async () => {
    const { api, members } = await load("members");
    expect(members.membersOnly()).toBe(true);
    h.session = { externalId: "oidc:alice" };
    fetchMock.mockResolvedValue(answer(200, { events: [] }));
    await api.fetchClaimEvents(ID);
    const [, init] = lastCall();
    expect(init).toEqual({
      headers: { "x-api-key": KEY, "x-acting-user": "oidc:alice" },
      cache: "no-store",
    });
    expect(init.next).toBeUndefined();

    // The one read that was already fresh names the reader too.
    fetchMock.mockResolvedValue(answer(200, { contribution: { review_status: "pending" } }));
    await api.fetchContributionStatus(ID);
    expect(headersOf(lastCall()[1])["x-acting-user"]).toBe("oidc:alice");
    expect(lastCall()[1].cache).toBe("no-store");
  });

  it("a visitor who is not signed in is named as nobody, and still nothing is kept", async () => {
    const { api } = await load("members");
    fetchMock.mockResolvedValue(answer(401, { error: "no", code: "SIGN_IN_REQUIRED" }));
    await expect(api.fetchClaimEvents(ID)).rejects.toMatchObject({ status: 401, code: "SIGN_IN_REQUIRED" });
    const [, init] = lastCall();
    expect(headersOf(init)).toEqual({ "x-api-key": KEY });
    expect(init.cache).toBe("no-store");
  });

  it("an account call that names nobody is made for the reader, except the sign-in's own", async () => {
    const { account } = await load("members");
    h.session = { externalId: "oidc:alice" };
    fetchMock.mockResolvedValue(answer(200, { redirect_to: "/" }));
    await account.denyOAuthRequest(ID);
    expect(headersOf(lastCall()[1])["x-acting-user"]).toBe("oidc:alice");

    h.auth.mockClear();
    fetchMock.mockResolvedValue(answer(200, { user: {} }));
    await account.provisionUser({ externalId: "oidc:bob", displayName: "Bob", groups: ["staff", "analysts"] });
    const [url, init] = lastCall();
    expect(url).toBe(`${BASE}/users/provision`);
    expect(headersOf(init)["x-acting-user"]).toBeUndefined();
    // Provisioning runs inside the sign-in: it must not ask for the session it is making.
    expect(h.auth).not.toHaveBeenCalled();
    expect(JSON.parse(init.body as string)).toEqual({
      external_id: "oidc:bob",
      display_name: "Bob",
      groups: ["staff", "analysts"],
    });
    // An empty list is sent as one: the person is in no group now.
    await account.provisionUser({ externalId: "oidc:bob", displayName: "Bob", groups: [] });
    expect(JSON.parse(lastCall()[1].body as string).groups).toEqual([]);
  });

  it("never shows a fixture: a refused read, a failed one and a missing API all show nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const status of [401, 403, 404, 500]) {
      const { data } = await load("members");
      fetchMock.mockResolvedValue(answer(status, { error: "no" }));
      expect(await data.loadClaim("inflation-2022"), String(status)).toEqual({ detail: null, source: "live" });
      expect((await data.loadClaims()).results, String(status)).toEqual([]);
      expect((await data.loadSourcePage("anything")).page, String(status)).toBeNull();
      expect((await data.loadArgument("anything")).page, String(status)).toBeNull();
      expect((await data.loadClaimEvents("inflation-2022")).events, String(status)).toBeNull();
    }
    const { data } = await load("members", false);
    expect(await data.loadClaim("inflation-2022")).toEqual({ detail: null, source: "live" });
    expect((await data.loadClaims()).results).toEqual([]);
    expect((await data.loadRequests()).requests).toEqual([]);
    expect((await data.loadRequest("anything")).request).toBeNull();
    expect((await data.loadOpenPrizes()).prizes).toEqual([]);
    expect((await data.loadAttempt("inflation-2022", "a")).attempt).toBeNull();
    expect((await data.loadSourcePage("anything")).page).toBeNull();
    expect((await data.loadArgument("anything")).page).toBeNull();
    expect((await data.loadClaimEvents("inflation-2022")).events).toBeNull();
  });
});

describe("the gate", () => {
  type Node = { type: unknown; props: Record<string, unknown> };
  const PAGE = { type: "page", props: { children: "the page" } };

  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node && typeof node === "object" && "props" in node) {
      const { props } = node as Node;
      return [props.title, props.lede, props.children].map(textOf).join("");
    }
    return "";
  }
  function forms(node: unknown, out: Node[] = []): Node[] {
    if (Array.isArray(node)) for (const n of node) forms(n, out);
    else if (node && typeof node === "object" && "props" in node) {
      const n = node as Node;
      if (n.type === "form") out.push(n);
      forms(n.props.children, out);
      forms(n.props.lede, out);
    }
    return out;
  }
  /** Render the gate round a page: its outer element, then the async one inside it. */
  async function gate(reads: "open" | "members" | undefined): Promise<unknown> {
    await load(reads);
    const { MembersGate } = await import("../../../web/components/MembersGate");
    const outer = MembersGate({ children: PAGE as never }) as unknown as Node;
    if (typeof outer.type !== "function") return outer;
    return (outer.type as (props: unknown) => Promise<unknown>)(outer.props);
  }

  it("is the page itself on the public graph, without reading the session", async () => {
    const tree = (await gate(undefined)) as Node;
    expect(tree.props.children).toBe(PAGE);
    expect(h.auth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks a visitor who is not signed in to sign in, and shows nothing of the page", async () => {
    const tree = await gate("members");
    const text = textOf(tree);
    expect(text).toContain("Sign in");
    expect(text).toContain(
      "This is a private deployment of Minerval. Nothing in it is shown to anyone who is not signed in."
    );
    expect(text).toContain("Continue with Halden single sign-on");
    expect(text).not.toContain("the page");
    expect(fetchMock).not.toHaveBeenCalled();
    // The button signs in and comes back to the page that was asked for.
    const [form] = forms(tree);
    await (form!.props.action as () => Promise<void>)();
    expect(h.signIn).toHaveBeenCalledWith("oidc", {});
  });

  it("tells a signed-in person with no permission who they are, and what an administrator needs", async () => {
    h.session = { externalId: "oidc:carol-0003" };
    fetchMock.mockResolvedValue(
      answer(200, {
        account: { id: "a", display_name: "Carol Newcomer", external_id: "oidc:carol-0003" },
        member: false,
        permissions: [],
      })
    );
    const tree = await gate("members");
    const [url, init] = lastCall();
    expect(url).toBe(`${BASE}/permissions/mine`);
    expect(headersOf(init)["x-acting-user"]).toBe("oidc:carol-0003");
    const text = textOf(tree);
    expect(text).toContain("No access yet");
    expect(text).toContain("You are signed in as Carol Newcomer, and hold no permission in this deployment");
    expect(text).toContain("oidc:carol-0003");
    expect(text).toContain("FIRST_ADMINISTRATOR");
    expect(text).not.toContain("the page");
    expect(text).toContain("Sign out");
  });

  it("shows a member the page", async () => {
    h.session = { externalId: "oidc:alice" };
    fetchMock.mockResolvedValue(
      answer(200, { account: { id: "a", display_name: "Alice", external_id: "oidc:alice" }, member: true, permissions: ["read"] })
    );
    const tree = (await gate("members")) as Node;
    // The page, under the line of links a member's permissions open
    // (components/MembersBand.tsx).
    const [band, page] = tree.props.children as [Node, unknown];
    expect(page).toBe(PAGE);
    const links = (who: string[]) => {
      const rendered = (band.type as (props: unknown) => Node | null)({
        mine: { account: {}, member: true, permissions: who, grants: [], clearance: [], raw_source_labels: [], groups: [] },
      });
      return rendered === null ? null : textOf(rendered.props.children);
    };
    // A member who can neither direct nor administer is shown no line at all.
    expect(links(["read"])).toBeNull();
    // The pages about the public graph are linked for those who can act there: whoever directs, and whoever
    // releases, since sending an agent's report on takes release.
    expect(links(["read", "direct"])).toBe("Add a sourceThe public graph");
    expect(links(["read", "release"])).toBe("The public graph");
    expect(links(["administer"])).toBe("Administration");
    expect(links(["direct", "fund", "administer"])).toBe("Add a sourceThe public graphAdministration");
  });

  it("shows nothing when it cannot find out what the person may see", async () => {
    h.session = { externalId: "oidc:alice" };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockRejectedValue(new Error("connection refused"));
    const text = textOf(await gate("members"));
    expect(text).toContain("Not available");
    expect(text).not.toContain("the page");
  });
});

describe("what else the setting decides", () => {
  it("reads the groups a sign-in carried, from the claim the provider uses", async () => {
    const { members } = await load("members");
    expect(members.groupsFromClaims({ groups: ["staff", " analysts ", "", "staff", 7] })).toEqual(["staff", "analysts"]);
    expect(members.groupsFromClaims({ groups: "staff" })).toEqual(["staff"]);
    expect(members.groupsFromClaims({ roles: ["x"] })).toEqual([]);
    expect(members.groupsFromClaims(undefined)).toEqual([]);
    vi.stubEnv("AUTH_OIDC_GROUPS_CLAIM", "roles");
    expect(members.groupsFromClaims({ roles: ["x"], groups: ["y"] })).toEqual(["x"]);
  });

  it("ends a sign-in at the age the API stops counting its groups", async () => {
    const { members } = await load("members");
    expect(members.signInValidSeconds()).toBe(12 * 3600);
    vi.stubEnv("SIGN_IN_VALID_HOURS", "8");
    expect(members.signInValidSeconds()).toBe(8 * 3600);
    vi.stubEnv("SIGN_IN_VALID_HOURS", "nonsense");
    expect(members.signInValidSeconds()).toBe(12 * 3600);
  });

  it("refuses to start a members-only deployment on a build made for the public graph", async () => {
    const { register } = await import("../../../web/instrumentation");
    vi.unstubAllEnvs();
    expect(() => register()).not.toThrow();
    vi.stubEnv("READS", "members");
    expect(() => register()).toThrow(/Build it again with READS=members/);
    vi.stubEnv("MINERVAL_BUILT_READS", "members");
    expect(() => register()).not.toThrow();
    // A members-only build run as an open deployment is slower and safe.
    vi.stubEnv("READS", "open");
    expect(() => register()).not.toThrow();
  });
});
