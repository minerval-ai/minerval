/**
 * The layers a setting's value is chosen from (src/config.ts, "The
 * layers"; docs/settings.md): the environment, the config file, what an
 * administrator set in the app, the code's default, the first that has a
 * value winning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODELS } from "../../src/llm/models.js";

let saved: NodeJS.ProcessEnv;
let dir: string;

beforeEach(() => {
  saved = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), "minerval-layers-"));
  for (const name of ["CURATOR_MODEL", "AUDIT_MODEL", "CORS_ORIGINS", "PORT", "MINERVAL_CONFIG", "MATCHER_BUDGET_USD"]) {
    delete process.env[name];
  }
  vi.resetModules();
});

afterEach(() => {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  for (const [name, value] of Object.entries(saved)) process.env[name] = value;
  rmSync(dir, { recursive: true, force: true });
});

const fresh = () => import("../../src/config.js");

describe("the layers a value is chosen from", () => {
  it("takes what an administrator set in the app over the default, and makes the configuration again when it changes", async () => {
    const config = await fresh();
    expect(config.loadConfig().curatorModel).toBe(MODELS.sonnet);
    expect(config.noteStoredSettings({ CURATOR_MODEL: MODELS.strong })).toBeNull();
    expect(config.loadConfig().curatorModel).toBe(MODELS.strong);
    config.noteStoredSettings({});
    expect(config.loadConfig().curatorModel).toBe(MODELS.sonnet);
  });

  it("lets the environment fix a setting, whatever the app holds", async () => {
    process.env.CURATOR_MODEL = MODELS.frontier;
    const config = await fresh();
    config.noteStoredSettings({ CURATOR_MODEL: MODELS.strong });
    expect(config.loadConfig().curatorModel).toBe(MODELS.frontier);
    expect(config.fixedOnTheMachine("CURATOR_MODEL")).toBe("environment");
    expect(config.fixedOnTheMachine("AUDIT_MODEL")).toBeNull();
  });

  it("lets the config file fix a setting, and says it was the file", async () => {
    const path = join(dir, "minerval.toml");
    writeFileSync(path, `[models]\ncurator = "${MODELS.frontier}"\n`);
    process.env.MINERVAL_CONFIG = path;
    const config = await fresh();
    config.noteStoredSettings({ CURATOR_MODEL: MODELS.strong });
    expect(config.loadConfig().curatorModel).toBe(MODELS.frontier);
    expect(config.fixedOnTheMachine("CURATOR_MODEL")).toBe("file");
  });

  it("never reads a setting that stays on the machine from the app's layer", async () => {
    const config = await fresh();
    const port = config.loadConfig().port;
    config.noteStoredSettings({ PORT: "4444", MINERVAL_OPERATOR_KEY: "mine" });
    expect(config.loadConfig().port).toBe(port);
    expect(config.loadConfig().minervalOperatorKey).toBe("");
  });

  it("keeps a setting that applies at a restart at the value the process started with", async () => {
    const config = await fresh();
    config.loadConfig();
    // The first copy handed over is what the process started with.
    config.noteStoredSettings({ CORS_ORIGINS: "https://first.test" });
    expect(config.loadConfig().corsOrigins).toBe("https://first.test");
    config.noteStoredSettings({ CORS_ORIGINS: "https://second.test", MATCHER_BUDGET_USD: "0.5" });
    expect(config.loadConfig().corsOrigins).toBe("https://first.test");
    // A live setting in the same copy is in force.
    expect(config.loadConfig().matcherBudgetUsd).toBe(0.5);
    expect(config.storedSettings()).toEqual({
      now: { CORS_ORIGINS: "https://second.test", MATCHER_BUDGET_USD: "0.5" },
      atStart: { CORS_ORIGINS: "https://first.test" },
    });
  });

  it("stands without the stored layer, and says why, when it cannot be used", async () => {
    const config = await fresh();
    config.loadConfig();
    const problem = config.noteStoredSettings({ AUDIT_MODEL: "us.anthropic.claude-gone" });
    expect(problem).toMatch(/us\.anthropic\.claude-gone/);
    expect(config.storedSettingsProblem()).toBe(problem);
    expect(config.loadConfig().auditModel).toBe(MODELS.sonnet);
    expect(config.noteStoredSettings({})).toBeNull();
  });

  it("tries a change without keeping it", async () => {
    const config = await fresh();
    expect(config.configWith({ CURATOR_MODEL: MODELS.strong }).curatorModel).toBe(MODELS.strong);
    expect(config.loadConfig().curatorModel).toBe(MODELS.sonnet);
    let thrown: unknown;
    try {
      config.configWith({ CURATOR_MODEL: "us.anthropic.nope" });
    } catch (err) {
      thrown = err;
    }
    expect(config.configProblem(thrown)).toMatch(/^models\.curator \(CURATOR_MODEL\): .*us\.anthropic\.nope/);
  });

  it("tells a listener when the configuration is made again", async () => {
    const config = await fresh();
    const { onConfigChange } = await import("../../src/config-changes.js");
    let told = 0;
    onConfigChange(() => {
      told += 1;
    });
    config.loadConfig();
    config.noteStoredSettings({ CURATOR_MODEL: MODELS.strong });
    expect(told).toBe(1);
    // The same copy again changes nothing.
    config.noteStoredSettings({ CURATOR_MODEL: MODELS.strong });
    expect(told).toBe(1);
  });

  it("gives every default as the environment would hold it", async () => {
    const config = await fresh();
    expect(config.configFieldDefault("curatorModel")).toBe(MODELS.sonnet);
    expect(config.configFieldDefault("matcherBudgetUsd")).toBe("0.1");
    expect(config.configFieldDefault("owlPacks")).toMatch(/^5:2000:Clutch/);
    expect(config.configFieldDefault("featuresOff")).toBe("");
    expect(config.configFieldDefault("openrouterProviderSort")).toBeNull();
    expect(config.configFieldDefault("noSuchField")).toBeNull();
  });

  it("names the load-bearing roles whose model nobody chose", async () => {
    for (const name of ["STEWARD_MODEL", "CURATOR_MODEL", "AUDIT_MODEL", "ARBITRATION_MODEL", "EXTRACTOR_MODEL", "SOLVER_MODEL", "STEWARD_STRONG_MODEL", "FEATURES_OFF"]) {
      delete process.env[name];
    }
    const config = await fresh();
    expect(config.modelsNobodyChose()).toContain("STEWARD_MODEL");
    config.noteStoredSettings({ STEWARD_MODEL: MODELS.strong, FEATURES_OFF: "mathematics" });
    expect(config.modelsNobodyChose()).not.toContain("STEWARD_MODEL");
    expect(config.modelsNobodyChose()).not.toContain("SOLVER_MODEL");
    expect(config.modelsNobodyChose({ STEWARD_MODEL: null })).toContain("STEWARD_MODEL");
  });
});
