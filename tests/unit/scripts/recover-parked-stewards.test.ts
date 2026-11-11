import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/load-env.js", () => ({}));
vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(), closeDb: vi.fn() }));

import { parseRecoverArgs, selectParks } from "../../../scripts/recover-parked-stewards.js";

const A = "a1111111-1111-4111-8111-111111111111";
const B = "b2222222-2222-4222-8222-222222222222";
const C = "c3333333-3333-4333-8333-333333333333";

const PARKED = [
  { id: A, steward_error: "401 authentication_error: API key is invalid", steward_error_reason: "credentials_fault", steward_attempts: 3 },
  { id: B, steward_error: "Model claude-opus-5-5 refused the request", steward_error_reason: "model_refusal", steward_attempts: 3 },
  { id: C, steward_error: "boom: null reference in decomposition", steward_error_reason: "other", steward_attempts: 3 },
];

describe("recover-parked-stewards arguments (#846)", () => {
  it("defaults to a dry run over the transient parks", () => {
    expect(parseRecoverArgs([])).toEqual({ confirm: false, transient: true, match: [], ids: [] });
  });

  it("turns the transient selection off once a selector is given, unless asked", () => {
    expect(parseRecoverArgs(["--match", "authentication_error"])).toMatchObject({
      transient: false,
      match: ["authentication_error"],
      confirm: false,
    });
    expect(parseRecoverArgs(["--ids", `${A},${B}`, "--ids", C, "--confirm"])).toMatchObject({
      transient: false,
      ids: [A, B, C],
      confirm: true,
    });
    expect(parseRecoverArgs(["--ids", A, "--transient"]).transient).toBe(true);
  });

  it("refuses a malformed call rather than guess", () => {
    expect(() => parseRecoverArgs(["--match"])).toThrow(/--match needs/);
    expect(() => parseRecoverArgs(["--match", "--confirm"])).toThrow(/--match needs/);
    expect(() => parseRecoverArgs(["--ids", "not-a-uuid"])).toThrow(/not a claim id/);
    expect(() => parseRecoverArgs(["--yes"])).toThrow(/Unknown argument/);
  });
});

describe("recover-parked-stewards selection (#846)", () => {
  const sel = (argv: string[]) => selectParks(PARKED, parseRecoverArgs(argv)).map((c) => c.id);

  it("by default takes what the pipeline now calls transient, which includes rejected credentials", () => {
    expect(sel([])).toEqual([A]);
  });

  it("takes parks whose error contains the text, whatever its case", () => {
    expect(sel(["--match", "REFUSED the request"])).toEqual([B]);
    expect(sel(["--match", "authentication_error", "--match", "boom"])).toEqual([A, C]);
    expect(sel(["--match", "no such text"])).toEqual([]);
  });

  it("takes explicit ids, and both together", () => {
    expect(sel(["--ids", C])).toEqual([C]);
    expect(sel(["--ids", C, "--match", "refused"])).toEqual([B, C]);
  });
});
