import { describe, expect, it } from "vitest";
import { ingestEndReason } from "../../../src/workers/url-extraction.js";
import { HttpStatusError, UnsafeUrlError } from "../../../src/services/url-guard.js";

/**
 * Why a failed extraction's row closed (#1045): the platform's words, read by
 * the mandate that paid for it, never a provider's or a database's own text.
 */
describe("ingestEndReason", () => {
  it("names a site's refusal by its status", () => {
    expect(ingestEndReason(new HttpStatusError("https://example.org/a", 403, null))).toBe(
      "the source could not be fetched: the site answered 403"
    );
  });

  it("names an address the platform does not fetch", () => {
    expect(ingestEndReason(new UnsafeUrlError("Refusing non-public address: 10.0.0.1"))).toMatch(/not a public address/);
  });

  it("names a source too long for the model", () => {
    expect(ingestEndReason(new Error("400 invalid_request_error: prompt is too long: 250000 tokens > 200000"))).toBe(
      "the source is too long for the extraction model to read at once"
    );
  });

  it("names a database fault by its class, not its text", () => {
    const err = Object.assign(new Error('Failed query: select "id", "claim_id" from "assessments"'), {
      code: "57014",
      severity: "ERROR",
    });
    const reason = ingestEndReason(err);
    expect(reason).toBe("the extraction failed because of a database fault");
    expect(reason).not.toContain("assessments");
  });
});
