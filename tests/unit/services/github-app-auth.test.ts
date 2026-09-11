/**
 * GitHub App auth for issue filing (#366): the JWT is the App's, signed
 * with its key; the installation token is minted once, shared by
 * concurrent callers, kept until its refresh margin, and dropped on
 * demand; and a plain token passes straight through when no App is set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  config: {
    githubToken: "",
    githubAppId: "",
    githubAppInstallationId: "",
    githubAppPrivateKey: "",
    githubApiBaseUrl: "https://api.github.test/",
  },
}));

vi.mock("../../../src/config.js", () => ({ loadConfig: () => mocks.config }));

import {
  getGithubBearer,
  githubAppConfigured,
  githubAuthConfigured,
  resetGithubAppTokenCache,
  signAppJwt,
} from "../../../src/services/github-app-auth.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs1", format: "pem" }) as string;

function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, number | string>; valid: boolean } {
  const [h, p, s] = jwt.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p!, "base64url").toString()),
    valid: verifier.verify(publicKey, Buffer.from(s!, "base64url")),
  };
}

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function tokenResponse(token: string, ttlMs = 60 * 60_000) {
  return response(201, { token, expires_at: new Date(Date.now() + ttlMs).toISOString() });
}

function exchanges(): number {
  return mocks.fetch.mock.calls.filter(([url]) => String(url).endsWith("/access_tokens")).length;
}

beforeEach(() => {
  resetGithubAppTokenCache();
  mocks.fetch.mockReset().mockImplementation(async () => tokenResponse("ghs_first"));
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.config.githubToken = "";
  mocks.config.githubAppId = "4911585";
  mocks.config.githubAppInstallationId = "160924398";
  mocks.config.githubAppPrivateKey = PRIVATE_PEM;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("signAppJwt", () => {
  it("is an RS256 JWT for the app id, backdated a minute, under ten minutes long, signed by the key", () => {
    const now = Date.parse("2026-09-11T12:00:00Z");
    const { header, payload, valid } = decodeJwt(signAppJwt("4911585", PRIVATE_PEM, now));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("4911585");
    expect(payload.iat).toBe(now / 1000 - 60);
    expect(Number(payload.exp) - Number(payload.iat)).toBe(600);
    expect(valid).toBe(true);
  });
});

describe("configuration", () => {
  it("needs all three App values, and either the App or a plain token", () => {
    expect(githubAppConfigured()).toBe(true);
    expect(githubAuthConfigured()).toBe(true);
    mocks.config.githubAppPrivateKey = "";
    expect(githubAppConfigured()).toBe(false);
    expect(githubAuthConfigured()).toBe(false);
    mocks.config.githubToken = "ghp_test";
    expect(githubAuthConfigured()).toBe(true);
  });
});

describe("getGithubBearer", () => {
  it("passes a plain token through untouched when no App is configured", async () => {
    mocks.config.githubAppId = "";
    mocks.config.githubToken = "ghp_test";
    expect(await getGithubBearer()).toBe("ghp_test");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("exchanges the App JWT for an installation token and keeps it", async () => {
    expect(await getGithubBearer()).toBe("ghs_first");
    expect(await getGithubBearer()).toBe("ghs_first");
    expect(exchanges()).toBe(1);

    const [url, init] = mocks.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.github.test/app/installations/160924398/access_tokens");
    expect(init.method).toBe("POST");
    const auth = (init.headers as Record<string, string>).Authorization;
    const { payload, valid } = decodeJwt(auth.replace(/^Bearer /, ""));
    expect(valid).toBe(true);
    expect(payload.iss).toBe("4911585");
  });

  it("shares one exchange between concurrent callers", async () => {
    const [a, b, c] = await Promise.all([getGithubBearer(), getGithubBearer(), getGithubBearer()]);
    expect([a, b, c]).toEqual(["ghs_first", "ghs_first", "ghs_first"]);
    expect(exchanges()).toBe(1);
  });

  it("mints again inside the five-minute margin before expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-11T12:00:00Z"));
    expect(await getGithubBearer()).toBe("ghs_first");

    mocks.fetch.mockImplementation(async () => tokenResponse("ghs_second"));
    vi.setSystemTime(Date.parse("2026-09-11T12:54:00Z"));
    expect(await getGithubBearer()).toBe("ghs_first");
    vi.setSystemTime(Date.parse("2026-09-11T12:56:00Z"));
    expect(await getGithubBearer()).toBe("ghs_second");
    expect(exchanges()).toBe(2);
  });

  it("mints again after the cache is dropped", async () => {
    expect(await getGithubBearer()).toBe("ghs_first");
    mocks.fetch.mockImplementation(async () => tokenResponse("ghs_second"));
    resetGithubAppTokenCache();
    expect(await getGithubBearer()).toBe("ghs_second");
  });

  it("throws with the status when GitHub refuses the exchange, and retries next time", async () => {
    mocks.fetch.mockImplementationOnce(async () => response(401, { message: "Bad credentials" }));
    await expect(getGithubBearer()).rejects.toThrow(/exchange failed \(401\).*160924398.*Bad credentials/);
    expect(await getGithubBearer()).toBe("ghs_first");
  });
});
