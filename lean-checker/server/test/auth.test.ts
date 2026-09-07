import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FakeLeanRunner } from "../src/runner-fake.js";
import { app, auth, config, pins, STATEMENT } from "./helpers.js";

describe("bearer-token auth", () => {
  it("leaves /health open and reports the pin and lane", async () => {
    const { app: a } = app();
    const res = await a.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.lane).toBe("warm");
    expect(body.pin.pin_id).toBe("mathlib-v4.33.0");
    expect(body.queue.queued).toBe(0);
  });

  it("refuses every other route without a token", async () => {
    const { app: a } = app();
    for (const [method, url, payload] of [
      ["GET", "/v1/pins", undefined],
      ["POST", "/v1/elaborate", { statement_source: STATEMENT }],
      ["POST", "/v1/scratch", { source: "example : True := trivial" }],
      ["POST", "/v1/search", { query: "Nat.add_zero" }],
      ["POST", "/v1/check", { mode: "attempt", kind: "proof", statement_source: STATEMENT, submission_source: "" }],
      ["GET", "/v1/checks/abc", undefined],
    ] as const) {
      const res = await a.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error).toBe("unauthorized");
    }
  });

  it("refuses a wrong token, a token of the wrong length, and a non-bearer scheme", async () => {
    const { app: a } = app();
    for (const header of ["Bearer nope", "Bearer test-token-0123456789x", "Basic dGVzdA==", "test-token-0123456789"]) {
      const res = await a.inject({ method: "GET", url: "/v1/pins", headers: { authorization: header } });
      expect(res.statusCode, header).toBe(401);
    }
  });

  it("accepts the right token", async () => {
    const { app: a } = app();
    const res = await a.inject({ method: "GET", url: "/v1/pins", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().platform_pin).toBe("mathlib-v4.33.0");
    expect(res.json().pins[0].image_digest).toBe("sha256:test");
  });

  it("refuses to build without a token (fails closed)", () => {
    expect(() =>
      buildApp({ config: config({ token: "" }), runner: new FakeLeanRunner(), pins: pins() })
    ).toThrow(/LEAN_CHECKER_TOKEN/);
  });
});
