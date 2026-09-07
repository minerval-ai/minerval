import { describe, expect, it } from "vitest";
import { clampLimits, loadServerConfig } from "../src/config.js";
import { pinFromFile } from "../src/pins.js";

describe("configuration", () => {
  it("reads the per-job and daily limits from the environment with the design's defaults", () => {
    const c = loadServerConfig({ LEAN_CHECKER_TOKEN: "t" });
    expect(c.jobLimits).toEqual({ timeout_s: 600, memory_mb: 12288, max_heartbeats: 400000 });
    expect(c.dailyCpuHours).toBe(20);
    expect(c.lane).toBe("warm");
    expect(c.replayTool).toBe("leanchecker");
    const d = loadServerConfig({ LEAN_CHECKER_TOKEN: "t", LEAN_CHECKER_JOB_TIMEOUT_S: "300", LEAN_CHECKER_DAILY_CPU_HOURS: "4", LEAN_CHECKER_LANE: "cold" });
    expect(d.jobLimits.timeout_s).toBe(300);
    expect(d.dailyCpuHours).toBe(4);
    expect(d.lane).toBe("cold");
  });

  it("rejects bad values", () => {
    expect(() => loadServerConfig({ LEAN_CHECKER_LANE: "hot" })).toThrow(/LEAN_CHECKER_LANE/);
    expect(() => loadServerConfig({ LEAN_CHECKER_JOB_TIMEOUT_S: "soon" })).toThrow(/number/);
    expect(() => loadServerConfig({ LEAN_CHECKER_REPLAY_TOOL: "hope" })).toThrow(/REPLAY_TOOL/);
  });

  it("clamps requested limits to the ceiling and ignores nonsense", () => {
    const ceiling = { timeout_s: 600, memory_mb: 12288, max_heartbeats: 400000 };
    expect(clampLimits(ceiling, { timeout_s: 60 })).toEqual({ ...ceiling, timeout_s: 60 });
    expect(clampLimits(ceiling, { timeout_s: 6000, memory_mb: -1, max_heartbeats: Number.NaN })).toEqual(ceiling);
    expect(clampLimits(ceiling, null)).toEqual(ceiling);
  });

  it("prefers the deployed image digest over the pin file's placeholder", () => {
    const file = { pin_id: "p", lean_toolchain: "t", mathlib_rev: "r", mathlib_tag: "v", image_digest_placeholder: "unknown-at-build", checker_version: "0.1.0" };
    expect(pinFromFile(file).image_digest).toBe("unknown-at-build");
    expect(pinFromFile(file, "sha256:abc").image_digest).toBe("sha256:abc");
    expect(pinFromFile({ ...file, mathlib_tag: undefined }).mathlib_tag).toBeNull();
  });
});
