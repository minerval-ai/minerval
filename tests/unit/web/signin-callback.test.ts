import { describe, it, expect, vi, beforeEach } from "vitest";

// F45: a signed-in visitor to /signin?callbackUrl=/%5Cevil.example/login was
// redirected to "/\evil.example/login", which browsers resolve off-site. The
// page must fall back to /account for anything that is not a same-site
// relative path, both for the immediate redirect and for the redirectTo it
// hands to signIn(), while honest callbacks pass through unchanged.
//
// CI installs only the root node_modules, so everything the page pulls from
// web/node_modules is mocked under both its bare name and its web/node_modules
// path. web/auth is mocked whole, so next-auth itself is never loaded.

const h = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  const Fragment = Symbol.for("test.fragment");
  const el = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  return {
    RedirectSignal,
    session: null as null | { externalId: string },
    redirect: vi.fn((url: string): never => {
      throw new RedirectSignal(url);
    }),
    signIn: vi.fn(async (..._args: unknown[]) => undefined),
    jsxRuntime: { jsx: el, jsxs: el, Fragment },
    jsxDevRuntime: { jsxDEV: el, Fragment },
  };
});

vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("../../../web/node_modules/next/navigation.js", () => ({ redirect: h.redirect }));
vi.mock("react/jsx-runtime", () => h.jsxRuntime);
vi.mock("../../../web/node_modules/react/jsx-runtime.js", () => h.jsxRuntime);
vi.mock("react/jsx-dev-runtime", () => h.jsxDevRuntime);
vi.mock("../../../web/node_modules/react/jsx-dev-runtime.js", () => h.jsxDevRuntime);
vi.mock("../../../web/auth", () => ({
  auth: async () => h.session,
  signIn: h.signIn,
  githubEnabled: () => true,
  googleEnabled: () => true,
  devLoginEnabled: () => true,
}));

import SignInPage from "../../../web/app/signin/page";
import {
  OFF_SITE_BYPASSES,
  ALWAYS_REJECTED,
  SAME_SITE_CONTROL_CHAR_PATHS,
  HONEST_PATHS,
  viaSigninLink,
} from "./fixtures/callback-urls";

type Node = { type: unknown; props: Record<string, unknown> };

function render(callbackUrl: unknown) {
  return SignInPage({
    searchParams: Promise.resolve({ callbackUrl } as { callbackUrl?: string }),
  });
}

/** Where a signed-in visitor is sent straight away. */
async function signedInRedirect(callbackUrl: unknown): Promise<string> {
  h.session = { externalId: "github:1" };
  try {
    await render(callbackUrl);
  } catch (err) {
    if (err instanceof h.RedirectSignal) return err.url;
    throw err;
  }
  throw new Error("signed-in visitor was not redirected");
}

function formActions(node: unknown, out: Array<(fd: FormData) => Promise<void>> = []) {
  if (Array.isArray(node)) {
    for (const n of node) formActions(n, out);
  } else if (node && typeof node === "object" && "props" in node) {
    const { type, props } = node as Node;
    if (type === "form" && typeof props.action === "function") {
      out.push(props.action as (fd: FormData) => Promise<void>);
    }
    formActions(props.children, out);
  }
  return out;
}

/** The redirectTo every provider button hands to signIn() for a signed-out visitor. */
async function signInRedirectTos(callbackUrl: unknown): Promise<unknown[]> {
  h.session = null;
  const tree = await render(callbackUrl);
  const actions = formActions(tree);
  expect(actions).toHaveLength(3); // github, google, dev
  const fd = new FormData();
  fd.set("username", "alice");
  for (const action of actions) await action(fd);
  return h.signIn.mock.calls.map((call) => (call[1] as { redirectTo?: unknown }).redirectTo);
}

beforeEach(() => {
  h.redirect.mockClear();
  h.signIn.mockClear();
  h.session = null;
});

describe("/signin callbackUrl (F45)", () => {
  it("does not send a signed-in visitor off-site for the finding's payload", async () => {
    const payload = new URLSearchParams("callbackUrl=/%5Cevil.example/login").get("callbackUrl");
    expect(payload).toBe("/\\evil.example/login");
    expect(await signedInRedirect(payload)).toBe("/account");
  });

  it.each(OFF_SITE_BYPASSES)("falls back to /account for %s (signed in)", async (_label, value) => {
    expect(await signedInRedirect(value)).toBe("/account");
  });

  it.each(OFF_SITE_BYPASSES)("passes /account to signIn() for %s (signed out)", async (_label, value) => {
    expect(await signInRedirectTos(value)).toEqual(["/account", "/account", "/account"]);
  });

  it.each(ALWAYS_REJECTED)("still falls back to /account for %s", async (_label, value) => {
    expect(await signedInRedirect(value)).toBe("/account");
  });

  it.each(SAME_SITE_CONTROL_CHAR_PATHS)("passes %s through unchanged, as before", async (_label, value) => {
    expect(await signedInRedirect(value)).toBe(value);
  });

  it("falls back to /account when callbackUrl is absent", async () => {
    expect(await signedInRedirect(undefined)).toBe("/account");
    expect(await signInRedirectTos(undefined)).toEqual(["/account", "/account", "/account"]);
  });

  it.each(HONEST_PATHS)("keeps the %s callback unchanged (signed in)", async (_src, path) => {
    expect(await signedInRedirect(viaSigninLink(path))).toBe(path);
  });

  it.each(HONEST_PATHS)("keeps the %s callback unchanged (signed out)", async (_src, path) => {
    expect(await signInRedirectTos(viaSigninLink(path))).toEqual([path, path, path]);
  });
});
