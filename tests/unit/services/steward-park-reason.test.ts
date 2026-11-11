import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { LlmRefusalError } from "../../../src/llm/errors.js";
import { MAX_STEWARD_ATTEMPTS, parksAtOnce, stewardFailureSet } from "../../../src/services/steward-lease.js";
import {
  STEWARD_ERROR_REASONS,
  STEWARD_ERROR_REASON_LABELS,
  classifyStewardErrorText,
  classifyStewardFailure,
  stewardErrorReasonOf,
  stewardErrorReasonSql,
  stewardPark,
  stewardParkNote,
  stewardParkedField,
} from "../../../src/services/steward-park-reason.js";

/**
 * A Steward failure is stored twice (#846): its raw text, for logs and the
 * service-scoped report, and a fixed class that is all a public surface
 * shows. These hold the classifier, the wording built from it, and the SQL
 * that backfilled rows parked before the class was stored.
 */
describe("classifying a Steward failure", () => {
  it("reads what the error is before what its message says", () => {
    expect(classifyStewardFailure(new LlmRefusalError("claude-opus-5-5", "policy"))).toBe("model_refusal");
    expect(classifyStewardFailure(Object.assign(new Error("x"), { status: 401 }))).toBe("credentials_fault");
    expect(classifyStewardFailure(Object.assign(new Error("x"), { name: "AuthenticationError" }))).toBe(
      "credentials_fault"
    );
    // node-postgres' DatabaseError, whatever it says.
    expect(
      classifyStewardFailure(
        Object.assign(new Error('null value in column "x" of relation "claims"'), { code: "23502", severity: "ERROR" })
      )
    ).toBe("database_fault");
    // A bare HTTP error from the provider with nothing more specific said.
    expect(classifyStewardFailure(Object.assign(new Error("bad request"), { status: 400 }))).toBe("provider_error");
    expect(classifyStewardFailure(new Error("Cannot read properties of undefined (reading 'id')"))).toBe("other");
    expect(classifyStewardFailure("a thrown string")).toBe("other");
    expect(classifyStewardFailure(undefined)).toBe("other");
  });

  it("classifies stored text, which is all the parks from before the column have", () => {
    const cases: Array<[string, string]> = [
      // The two populations parked in production when this was written.
      ["401 authentication_error: API key is invalid", "credentials_fault"],
      ["Model claude-opus-5-5 refused the request (category: cyber)", "model_refusal"],
      ['401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_1"}', "credentials_fault"],
      ['duplicate key value violates unique constraint "claims_text_key"', "database_fault"],
      ['relation "public_read.nodez" does not exist', "database_fault"],
      ['permission denied for table claims', "database_fault"],
      ["Unknown tool: frobnicate", "tool_failure"],
      ['400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: too long"}}', "provider_error"],
      ["OpenRouter returned no choices", "provider_error"],
      ["boom: null reference in decomposition", "other"],
      ["", "other"],
    ];
    for (const [text, reason] of cases) expect(classifyStewardErrorText(text), text).toBe(reason);
    expect(classifyStewardErrorText(null)).toBe("other");
  });

  it("has a publishable label for every class, and reads anything else as 'other'", () => {
    for (const r of STEWARD_ERROR_REASONS) expect(STEWARD_ERROR_REASON_LABELS[r].length).toBeGreaterThan(5);
    expect(stewardErrorReasonOf("model_refusal")).toBe("model_refusal");
    expect(stewardErrorReasonOf(null)).toBe("other");
    expect(stewardErrorReasonOf("req_011C leaked text")).toBe("other");
  });
});

describe("the backfill in migration 0113", () => {
  it("is the classifier's own SQL, verbatim", () => {
    const dir = resolve(__dirname, "../../../src/db/migrations");
    const file = readFileSync(resolve(dir, "0113_steward_error_reason.sql"), "utf8");
    expect(file).toContain(`SET steward_error_reason = ${stewardErrorReasonSql("steward_error")}`);
  });
});

describe("the parked marker and the commission note", () => {
  it("builds the marker only for a row that carries a reason", () => {
    expect(stewardParkedField({ park_reason: null, park_since: new Date(), park_attempts: 3 })).toEqual({});
    expect(
      stewardParkedField({ park_reason: "model_refusal", park_since: new Date("2026-07-14T09:00:00Z"), park_attempts: 3 })
    ).toEqual({
      steward_parked: {
        reason: "model_refusal",
        reason_label: "the model refused the request",
        since: "2026-07-14T09:00:00.000Z",
        failed_passes: 3,
      },
    });
  });

  it("tells a payer since when, after how many failures, why, and what the money buys", () => {
    const atCap = stewardParkNote(
      stewardPark({ reason: "database_fault", since: "2026-08-10T12:00:00Z", attempts: MAX_STEWARD_ATTEMPTS })
    );
    expect(atCap).toContain("parked since 2026-08-10");
    expect(atCap).toContain(`after ${MAX_STEWARD_ATTEMPTS} failed passes`);
    expect(atCap).toContain("a database fault");
    expect(atCap).toContain("buys one more attempt");
    // A refusal parks on the first failure, so the cap has attempts left.
    const early = stewardParkNote(stewardPark({ reason: "model_refusal", since: null, attempts: 1 }));
    expect(early).toContain("after 1 failed pass:");
    expect(early).toContain(`at most ${MAX_STEWARD_ATTEMPTS - 1} more attempts`);
  });
});

describe("parking at once", () => {
  it("is for a model refusal only", () => {
    expect(parksAtOnce(new LlmRefusalError("m", null))).toBe(true);
    expect(parksAtOnce(new Error("boom"))).toBe(false);
    expect(parksAtOnce(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
  });

  it("is a branch of the failure update, beside the attempt cap", () => {
    const set = stewardFailureSet("$2", "$3", "$4", "$5::boolean");
    expect(set).toContain(`steward_attempts + 1 >= ${MAX_STEWARD_ATTEMPTS} OR $5::boolean THEN 'error'`);
    expect(set).toContain("steward_error_reason = $4");
    expect(stewardFailureSet("$2", "$3", "$4")).toContain("OR false THEN 'error'");
  });
});
