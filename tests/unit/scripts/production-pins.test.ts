import { describe, it, expect } from "vitest";
import {
  applyProductionProfile,
  parseModelPins,
  productionPins,
} from "../../../scripts/corpus/production-pins.js";

describe("parseModelPins", () => {
  it("reads every quoted *_MODEL literal and ignores prose about pins", () => {
    const source = `
      environment: {
        // production sets STEWARD_MODEL=claude-x here; see EXTRACTOR_FALLBACK_MODEL (Sonnet).
        STEWARD_MODEL: "claude-fable-5-1",
        MATCHER_MODEL: "deepseek/deepseek-v4-flash",
        NOT_A_PIN: "value",
      }`;
    expect(parseModelPins(source)).toEqual([
      { envVar: "STEWARD_MODEL", model: "claude-fable-5-1" },
      { envVar: "MATCHER_MODEL", model: "deepseek/deepseek-v4-flash" },
    ]);
  });
});

describe("the committed CDK stack", () => {
  it("pins the load-bearing agents", () => {
    const vars = productionPins().map((p) => p.envVar);
    for (const v of ["STEWARD_MODEL", "MATCHER_MODEL", "EXTRACTOR_MODEL", "CURATOR_MODEL"]) {
      expect(vars).toContain(v);
    }
  });
});

describe("applyProductionProfile", () => {
  it("sets every pin on the given env, overriding what was there", () => {
    const env: NodeJS.ProcessEnv = { MATCHER_MODEL: "claude-haiku-4-5-20251001" };
    const pins = applyProductionProfile(env);
    expect(pins.length).toBeGreaterThan(0);
    const matcher = pins.find((p) => p.envVar === "MATCHER_MODEL")!;
    expect(env.MATCHER_MODEL).toBe(matcher.model);
    expect(env.MATCHER_MODEL).not.toBe("claude-haiku-4-5-20251001");
    for (const p of pins) expect(env[p.envVar]).toBe(p.model);
  });
});
