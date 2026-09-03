import { describe, expect, it } from "vitest";
import { parseCheckerJson, parseLeanMessages, parseTimeOutput } from "../src/lean-output.js";

describe("parsing Lean output", () => {
  it("reads lean --json messages and shifts lines past the header", () => {
    const stdout = [
      '{"severity":"error","pos":{"line":5,"column":8},"endPos":{"line":5,"column":11},"fileName":"x.lean","data":"unknown identifier \'foo\'"}',
      '{"severity":"warning","pos":{"line":2,"column":0},"endPos":null,"fileName":"x.lean","data":"declaration uses \'sorry\'"}',
      "not json",
    ].join("\n");
    const diags = parseLeanMessages(stdout, "", "submission", 3);
    expect(diags).toHaveLength(2);
    expect(diags[0]).toMatchObject({ severity: "error", line: 2, column: 8, end_line: 2, end_column: 11, file: "submission" });
    expect(diags[1]).toMatchObject({ severity: "warning", line: 0, in_header: true });
  });

  it("falls back to the text form with continuation lines", () => {
    const stderr = "/w/MinervalCheck/Submission.lean:4:2: error: type mismatch\n  h\nhas type\n  1 < n\n/w/x.lean:9:0: warning: unused variable";
    const diags = parseLeanMessages("", stderr, "submission", 3);
    expect(diags).toHaveLength(2);
    expect(diags[0]!.line).toBe(1);
    expect(diags[0]!.message).toBe("type mismatch\n  h\nhas type\n  1 < n");
    expect(diags[1]).toMatchObject({ severity: "warning", line: 6 });
  });

  it("takes the last JSON line minerval_check prints", () => {
    const out = 'stray\n{"ok":false,"error":"old"}\n{"ok":true,"mode":"check"}\n';
    expect(parseCheckerJson(out)).toEqual({ ok: true, mode: "check" });
    expect(parseCheckerJson("nothing")).toEqual({ ok: false, error: "minerval_check printed no JSON result" });
  });

  it("reads GNU time's summary", () => {
    expect(parseTimeOutput("12.34 10.50 0.75 1048576\n")).toEqual({ cpu_ms: 11250, max_rss_mb: 1024 });
    expect(parseTimeOutput("Command exited with non-zero status 1\n3.0 2.0 1.0 2048\n")).toEqual({ cpu_ms: 3000, max_rss_mb: 2 });
    expect(parseTimeOutput("")).toEqual({ cpu_ms: null, max_rss_mb: null });
  });
});
