/**
 * The registry of settings (src/settings-registry.ts; docs/settings.md):
 * every environment variable src/config.ts reads has a row that says who
 * may change it and when a change is in force, so a new setting is given
 * its place when it is added.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configFieldProblem } from "../../src/config.js";
import {
  OTHER_VARIABLES,
  SETTINGS,
  SETTING_PREFIXES,
  findSetting,
  settingByEnv,
  strayVariables,
} from "../../src/settings-registry.js";

const ROOT = resolve(__dirname, "..", "..");
const source = readFileSync(join(ROOT, "src", "config.ts"), "utf8");

/** Variables config.ts reads that are not settings: the test runner's own. */
const NOT_SETTINGS = new Set(["VITEST"]);

/** Each `field: ... env.NAME` of the config schema's reading of the layered environment (buildConfig). */
function fieldsRead(): Array<{ field: string; env: string }> {
  const start = source.indexOf("configSchema.parse({");
  const end = source.indexOf("\n  });", start);
  const literal = source.slice(start, end).replace(/\n\s+/g, " ");
  return [...literal.matchAll(/([A-Za-z0-9]+): (?:[^,]*?)\benv\.([A-Z0-9_]+)/g)].map((m) => ({
    field: m[1]!,
    env: m[2]!,
  }));
}

describe("the registry of settings", () => {
  it("has a row for every environment variable src/config.ts reads", () => {
    const read = new Set([...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!));
    const missing = [...read].filter((env) => !NOT_SETTINGS.has(env) && !settingByEnv(env) && !(env in OTHER_VARIABLES));
    expect(
      missing,
      "src/config.ts reads a variable that has no row in src/settings-registry.ts. Give it one: " +
        "say whether it stays on the machine or moves to the app, and whether a change applies live."
    ).toEqual([]);
  });

  it("maps each variable onto the field of the schema it fills", () => {
    const read = fieldsRead();
    expect(read.length).toBeGreaterThan(250);
    // API_KEYS fills two fields, and the retired keys are read only to say they are set.
    const special = new Set(["apiKeyContributors", "retiredKeysSet"]);
    for (const { field, env } of read) {
      if (special.has(field)) continue;
      const row = settingByEnv(env);
      if (!row || row.secret) continue;
      expect(row.field, `${env} fills ${field}`).toBe(field);
    }
  });

  it("gives every setting a place, a field the schema has, and a sentence", () => {
    for (const row of SETTINGS) {
      expect(row.about.length, row.key).toBeGreaterThan(5);
      expect(row.about, row.key).toMatch(/[.]$/);
      if (row.secret || row.retired) continue;
      expect(row.field, row.key).toBeTruthy();
      expect(configFieldProblem(row.field!, "") ?? "", row.key).not.toMatch(/no field named/);
    }
  });

  it("keeps the trust root and what is needed before the database answers on the machine", () => {
    for (const env of [
      "DATABASE_URL", "DB_PASSWORD", "API_KEYS", "MINERVAL_OPERATOR_KEY", "CREDENTIAL_ENCRYPTION_KEY",
      "CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS", "SANDBOX_TOKEN", "CLEARED_ROLE_PASSWORD", "ENVIRONMENT", "HOST",
      "PORT", "READS", "SANDBOX_URL", "FILE_SET_STORE_DIR", "FILE_SET_DIRECTORY_ROOT", "LEAN_CHECKER_URL",
      "AWS_REGION", "SQS_STEWARD_QUEUE", "PUBLISH_SIGNING_KEY", "MIRROR_SIGNING_KEY", "OIDC_SIGNING_KEY",
    ]) {
      expect(settingByEnv(env)?.where, env).toBe("machine");
    }
  });

  it("seals the keys someone else issued, and nothing else", () => {
    expect(SETTINGS.filter((s) => s.where === "app_secret").map((s) => s.env).sort()).toEqual([
      "ANTHROPIC_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "ELICIT_API_KEY", "GITHUB_APP_PRIVATE_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY",
      "OPENROUTER_API_KEY", "PANGRAM_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
    ]);
    for (const row of SETTINGS) if (row.where === "app_secret") expect(row.secret, row.key).toBe(true);
  });

  it("finds a setting by its name in the file or by its variable", () => {
    expect(findSetting("models.steward")?.env).toBe("STEWARD_MODEL");
    expect(findSetting("STEWARD_MODEL")?.key).toBe("models.steward");
    expect(findSetting("no.such")).toBeUndefined();
  });
});

describe("variables that look like settings and are none", () => {
  it("names a misspelt variable with the one it is nearest to", () => {
    expect(strayVariables({ STEWRD_MODEL: "claude-opus-5-5" }).unknown).toEqual([
      { env: "STEWRD_MODEL", nearest: "STEWARD_MODEL" },
    ]);
  });

  it("names one that only begins like a setting, with no guess", () => {
    expect(SETTING_PREFIXES).toContain("STEWARD_");
    expect(strayVariables({ STEWARD_SOMETHING_ELSE_ENTIRELY: "1" }).unknown).toEqual([
      { env: "STEWARD_SOMETHING_ELSE_ENTIRELY", nearest: null },
    ]);
  });

  it("names a retired setting with what replaced it", () => {
    const { retired, unknown } = strayVariables({ PUBLIC_GRAPH_API_KEY: "k" });
    expect(unknown).toEqual([]);
    expect(retired).toEqual([
      { env: "PUBLIC_GRAPH_API_KEY", retiredIn: "0.2.0", replacedBy: "the connection to minerval.ai, made on the Overview" },
    ]);
  });

  it("leaves alone a setting, an empty variable, another part's variable and the machine's own", () => {
    expect(
      strayVariables({
        STEWARD_MODEL: "claude-opus-5-5",
        STEWRD_MODEL: "",
        AUTH_SECRET: "s",
        AUTH_OIDC_ISSUER: "https://idp.example",
        CONNECTION_ACME_TOKEN: "t",
        AWS_ACCESS_KEY_ID: "a",
        GITHUB_ACTIONS: "true",
        PATH: "/usr/bin",
        HOME: "/root",
        npm_package_version: "0.2.0",
      })
    ).toEqual({ unknown: [], retired: [] });
  });
});
