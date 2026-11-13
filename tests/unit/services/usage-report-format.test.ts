/**
 * The usage report's format (src/services/usage-report-service.ts): what a
 * report is made of, and that a body carrying anything else is not one.
 * Sending and receiving against real tables are in
 * tests/db/usage-reports.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  FLAT_PRICE_SENDS_NOTHING,
  USAGE_REPORT_FORMAT,
  USAGE_REPORT_KIND,
  WHAT_IS_NEVER_SENT,
  WHAT_IS_SENT,
  formatOwls,
  readUsageReport,
  usageReportBody,
  usageReportFileName,
} from "../../../src/services/usage-report-service.js";

const REPORT = {
  format: USAGE_REPORT_FORMAT,
  kind: USAGE_REPORT_KIND,
  deployment: "5b1f5c0e-6a57-4f0e-9d53-0f6c1f6f4c11",
  period: "2026-11-10",
  revision: 0,
  owls_spent: "12.500000",
} as const;

describe("a usage report", () => {
  it("is six fields in canonical form, and nothing else", () => {
    expect(usageReportBody(REPORT)).toBe(
      '{"deployment":"5b1f5c0e-6a57-4f0e-9d53-0f6c1f6f4c11","format":1,"kind":"minerval-usage-report",' +
        '"owls_spent":"12.500000","period":"2026-11-10","revision":0}'
    );
    expect(Object.keys(JSON.parse(usageReportBody(REPORT))).sort()).toEqual([
      "deployment",
      "format",
      "kind",
      "owls_spent",
      "period",
      "revision",
    ]);
  });

  it("writes owls to six decimal places", () => {
    expect(formatOwls(0)).toBe("0.000000");
    expect(formatOwls(1)).toBe("0.000001");
    expect(formatOwls(12_500_000)).toBe("12.500000");
    expect(formatOwls(123_456_789_012)).toBe("123456.789012");
  });

  it("is read back as it was written", () => {
    const read = readUsageReport(JSON.parse(usageReportBody(REPORT)));
    expect(read).toEqual({ ok: true, report: REPORT });
  });

  it("is refused when it carries a field the format does not have", () => {
    const read = readUsageReport({ ...REPORT, claims: ["a claim"], runs: 14 });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.message).toBe(
      "A usage report carries format, kind, deployment, period, revision, owls_spent and nothing " +
        'else. This one also has "claims", "runs".'
    );
  });

  it("is refused when a field is not what the format says", () => {
    const bad = (change: Record<string, unknown>) => readUsageReport({ ...REPORT, ...change });
    expect(bad({ kind: "something-else" }).ok).toBe(false);
    expect(bad({ format: 2 }).ok).toBe(false);
    expect(bad({ deployment: "the-acme-deployment" }).ok).toBe(false);
    expect(bad({ period: "2026-13-40" }).ok).toBe(false);
    expect(bad({ period: "10 Nov 2026" }).ok).toBe(false);
    expect(bad({ revision: -1 }).ok).toBe(false);
    expect(bad({ revision: 1.5 }).ok).toBe(false);
    expect(bad({ owls_spent: 12.5 }).ok).toBe(false);
    expect(bad({ owls_spent: "12.5" }).ok).toBe(false);
    expect(bad({ owls_spent: "-1.000000" }).ok).toBe(false);
    expect(readUsageReport("a string").ok).toBe(false);
    expect(readUsageReport([REPORT]).ok).toBe(false);
  });

  it("is named for its day and revision when written to a file", () => {
    expect(usageReportFileName("2026-11-10", 0)).toBe("usage-report-2026-11-10-r0.json");
    expect(usageReportFileName("2026-11-10", 2)).toBe("usage-report-2026-11-10-r2.json");
  });
});

describe("what the administrators' page says", () => {
  it("says what is sent, what is never sent, and that the flat price sends nothing", () => {
    expect(WHAT_IS_SENT).toMatch(/one figure/);
    expect(WHAT_IS_SENT).toMatch(/exactly as it is sent, before it is sent and after/);
    expect(WHAT_IS_NEVER_SENT).toMatch(/never says which claims, questions, sources, mandates, labels or people/);
    expect(FLAT_PRICE_SENDS_NOTHING).toMatch(/reports nothing/);
  });

  it("uses no em-dash", () => {
    for (const text of [WHAT_IS_SENT, WHAT_IS_NEVER_SENT, FLAT_PRICE_SENDS_NOTHING]) {
      expect(text).not.toMatch(/—/);
    }
  });
});
