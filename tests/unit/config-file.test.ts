/**
 * The config file (src/config-file.ts; docs/deployment.md): the layer it
 * forms under the environment, what it refuses and how it says so, the
 * writer, and the checked-in example, which is public Minerval's settings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONFIG_FILE_GROUPS,
  CONFIG_FILE_KEYS,
  ConfigFileError,
  configFilePath,
  parseConfigFile,
  renderConfigFile,
  secretConfigFileKeys,
  settableConfigFileKeys,
  writeConfigFile,
  type ConfigFileSettings,
  type ConfigFileValue,
} from "../../src/config-file.js";
import { configFieldProblem } from "../../src/config.js";
import { MODELS } from "../../src/llm/models.js";

const ROOT = resolve(__dirname, "..", "..");
const EXAMPLE = join(ROOT, "deploy", "minerval.example.toml");

let dir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "minerval-config-"));
  savedEnv = { ...process.env };
  vi.resetModules();
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in savedEnv)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(savedEnv)) process.env[name] = value;
  rmSync(dir, { recursive: true, force: true });
  vi.doUnmock("../../src/config-file.js");
});

/** Write a config file and name it in the environment. */
function nameFile(text: string): string {
  const path = join(dir, "minerval.toml");
  writeFileSync(path, text);
  process.env.MINERVAL_CONFIG = path;
  return path;
}

/** The environment with none of the settings the file can hold, so a file's values are what load. */
function clearSettings(): void {
  for (const key of CONFIG_FILE_KEYS) delete process.env[key.env];
}

async function freshConfig() {
  return import("../../src/config.js");
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigFileError) return [...err.problems];
    throw err;
  }
  throw new Error("expected the settings to be refused");
}

describe("the table of settings", () => {
  it("names each setting, environment variable and group once", () => {
    const keys = CONFIG_FILE_KEYS.map((k) => k.key);
    const envs = CONFIG_FILE_KEYS.map((k) => k.env);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(envs).size).toBe(envs.length);
    for (const key of settableConfigFileKeys()) {
      const group = key.key.slice(0, key.key.lastIndexOf("."));
      expect(CONFIG_FILE_GROUPS[group], `a line on [${group}]`).toBeTruthy();
    }
  });

  it("maps every setting onto a field the config schema has", () => {
    for (const key of settableConfigFileKeys()) {
      expect(key.field, key.key).toBeTruthy();
      expect(configFieldProblem(key.field!, "") ?? "", key.key).not.toMatch(/no field named/);
    }
    expect(configFieldProblem("noSuchField", "x")).toMatch(/no field named noSuchField/);
  });

  it("lists the secrets, none of which has a schema field to be set through", () => {
    expect(secretConfigFileKeys().map((k) => k.env).sort()).toEqual(
      [
        "ANTHROPIC_API_KEY",
        "API_KEYS",
        "DATABASE_URL",
        "DB_PASSWORD",
        "ELICIT_API_KEY",
        "GITHUB_APP_PRIVATE_KEY",
        "GITHUB_TOKEN",
        "MINERVAL_OPERATOR_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "PANGRAM_API_KEY",
        "SQL_AGENT_DATABASE_URL",
        "SQL_AGENT_DB_PASSWORD",
        "SQL_CALLER_DATABASE_URL",
        "SQL_CALLER_DB_PASSWORD",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
      ].sort()
    );
    for (const key of secretConfigFileKeys()) expect(key.field, key.key).toBeUndefined();
  });
});

/**
 * A value for every setting that is not its default, and what the loaded
 * config holds for it. Where nothing is listed, the kind decides: a text
 * loads as itself, a number as itself, and so on.
 */
const SAMPLES: Record<string, { file: ConfigFileValue; loads?: unknown }> = {
  "features.off": { file: ["extension"] },
  // The two long-run roles take only a long-run family.
  "models.solver": { file: MODELS.strong },
  "models.researcher_strong": { file: MODELS.strong },
  "model_providers.openrouter_provider_sort": { file: "latency" },
  "outside_services.elicit.use": { file: false, loads: "false" },
  "outside_services.pangram.use": { file: true, loads: "true" },
  "outside_services.payments.use": { file: false, loads: "false" },
  "outside_services.pangram.max_words": { file: 77 },
  "outside_services.github_issues.include_external_reports": { file: true },
  "outside_services.github_issues.repo": { file: "an-owner/a-repo" },
  "run_log.mode": { file: "record" },
  "run_log.level": { file: "off" },
  "hosting.environment": { file: "staging" },
  "hosting.log_level": { file: "debug" },
  "hosting.cors_origins": { file: ["https://a.test", "https://b.test"], loads: "https://a.test,https://b.test" },
  "pricing.owl_packs": { file: ["3:900:Test"], loads: [{ owls: 3, priceCents: 900, name: "Test" }] },
};

function sampleFor(key: { key: string; kind: string }): { file: ConfigFileValue; loads: unknown } {
  const given = SAMPLES[key.key];
  const file: ConfigFileValue =
    given?.file ??
    (key.key.startsWith("models.")
      ? `a-vendor/${key.key.slice("models.".length)}`
      : key.kind === "number"
        ? 7
        : `https://a.test/${key.key}`);
  return { file, loads: given && "loads" in given ? given.loads : file };
}

describe("the file as a layer under the environment", () => {
  it("carries every setting it can hold to the config field it stands for", async () => {
    clearSettings();
    const settings: ConfigFileSettings = {};
    for (const key of settableConfigFileKeys()) settings[key.key] = sampleFor(key).file;
    nameFile(renderConfigFile(settings, configFieldProblem));

    const { loadConfig } = await freshConfig();
    const config = loadConfig() as unknown as Record<string, unknown>;
    for (const key of settableConfigFileKeys()) {
      expect(config[key.field!], key.key).toEqual(sampleFor(key).loads);
    }
  });

  it("lets an environment variable override the file for the same setting, and says so", async () => {
    clearSettings();
    process.env.RUN_LOG_MODE = "best_effort";
    const path = nameFile('[run_log]\nmode = "record"\nretention_days = 9\n');

    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.runLogMode).toBe("best_effort");
    expect(config.traceRetentionDays).toBe(9);

    const { appliedConfigFile } = await import("../../src/config-file.js");
    expect(appliedConfigFile()).toEqual({
      path,
      settings: ["run_log.mode", "run_log.retention_days"],
      overridden: [{ key: "run_log.mode", env: "RUN_LOG_MODE" }],
    });
  });

  it("takes an empty environment variable as an override too, as loadConfig always has", async () => {
    clearSettings();
    process.env.PUBLIC_WEB_BASE_URL = "";
    nameFile('[hosting]\nweb_base_url = "https://graph.example.test"\n');
    const { loadConfig } = await freshConfig();
    expect(loadConfig().publicWebBaseUrl).toBe("");
  });

  it("satisfies production's rule that the load-bearing models are chosen, when the file chooses them", async () => {
    clearSettings();
    nameFile(readFileSync(EXAMPLE, "utf8"));
    const { loadConfig } = await freshConfig();
    expect(loadConfig().env).toBe("production");
  });

  it("switches a paid service off whatever key the environment holds", async () => {
    clearSettings();
    process.env.ELICIT_API_KEY = "a-key";
    process.env.PANGRAM_API_KEY = "a-key";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    nameFile(
      "[outside_services.elicit]\nuse = false\n" +
        "[outside_services.pangram]\nuse = true\n" +
        "[outside_services.payments]\nuse = false\n"
    );
    const { loadConfig } = await freshConfig();
    const config = loadConfig();
    expect(config.elicitApiKey).toBe("");
    expect(config.pangramApiKey).toBe("a-key");
    expect(config.stripeSecretKey).toBe("");
    expect(config.stripeWebhookSecret).toBe("");
  });

  it("with no file, leaves the environment byte for byte and loads what loading without the layer loads", async () => {
    delete process.env.MINERVAL_CONFIG;
    const before = JSON.stringify(process.env);
    const { loadConfig } = await freshConfig();
    const withLayer = JSON.stringify(loadConfig());
    expect(JSON.stringify(process.env)).toBe(before);
    const { appliedConfigFile } = await import("../../src/config-file.js");
    expect(appliedConfigFile()).toBeNull();

    // The same load with the layer taken out altogether.
    vi.resetModules();
    vi.doMock("../../src/config-file.js", () => ({ applyConfigFile: () => null }));
    const without = await freshConfig();
    expect(JSON.stringify(without.loadConfig())).toBe(withLayer);
  });

  it("does not read a second file's leftovers as the operator's overrides", async () => {
    clearSettings();
    const { applyConfigFile } = await import("../../src/config-file.js");
    nameFile('[run_log]\nmode = "record"\n');
    applyConfigFile(configFieldProblem);
    expect(process.env.RUN_LOG_MODE).toBe("record");
    nameFile("[run_log]\nretention_days = 3\n");
    const second = applyConfigFile(configFieldProblem);
    expect(process.env.RUN_LOG_MODE).toBeUndefined();
    expect(second?.overridden).toEqual([]);
  });
});

describe("where the file is", () => {
  it("is the file MINERVAL_CONFIG names, which must exist", () => {
    const path = join(dir, "settings.toml");
    writeFileSync(path, "");
    expect(configFilePath({ MINERVAL_CONFIG: path }, dir)).toBe(path);
    expect(configFilePath({ MINERVAL_CONFIG: "settings.toml" }, dir)).toBe(path);
    const missing = join(dir, "nowhere.toml");
    expect(() => configFilePath({ MINERVAL_CONFIG: missing }, dir)).toThrow(
      `The config file ${missing} cannot be used. MINERVAL_CONFIG names it, but there is no file there.`
    );
  });

  it("is minerval.toml in the working directory when that exists, and otherwise there is none", () => {
    expect(configFilePath({}, dir)).toBeNull();
    writeFileSync(join(dir, "minerval.toml"), "");
    expect(configFilePath({}, dir)).toBe(join(dir, "minerval.toml"));
  });

  it("stops the load when the named file cannot be used", async () => {
    clearSettings();
    const path = nameFile('[run_log]\nmode = "recrod"\n');
    const { loadConfig } = await freshConfig();
    expect(() => loadConfig()).toThrow(
      `The config file ${path} cannot be used. run_log.mode is "recrod", which is not accepted: ` +
        'expected one of "best_effort", "record".'
    );
  });
});

describe("what a file is refused for", () => {
  const parse = (text: string) => parseConfigFile(text, configFieldProblem, "/etc/minerval.toml");

  it("names an unknown group or setting, what is near it, and what the place holds", () => {
    expect(problemsOf(() => parse('[run_logs]\nmode = "record"\n'))).toEqual([
      "run_logs is not a group of settings. Did you mean run_log? The groups are: features, models, " +
        "model_providers, outside_services, run_log, hosting, database, pricing.",
    ]);
    expect(problemsOf(() => parse('[run_log]\nmodes = "record"\n'))).toEqual([
      "run_log.modes is not a setting. Did you mean run_log.mode? [run_log] holds: mode, level, retention_days.",
    ]);
    expect(problemsOf(() => parse("[outside_services.slack]\nuse = true\n"))).toEqual([
      "outside_services.slack is not a setting. [outside_services] holds: elicit, pangram, payments, github_issues.",
    ]);
  });

  it("says where a setting goes when the file uses its environment variable's name", () => {
    expect(problemsOf(() => parse('RUN_LOG_MODE = "record"\n'))).toEqual([
      "RUN_LOG_MODE is an environment variable's name, not a setting in the file. In the file it is run_log.mode.",
    ]);
  });

  it("names a value of the wrong kind and what was expected", () => {
    expect(
      problemsOf(() =>
        parse(
          '[run_log]\nretention_days = "30"\n[features]\noff = "extension"\n' +
            '[hosting]\nport = true\nweb_base_url = 3\n[outside_services.elicit]\nuse = "yes"\n'
        )
      )
    ).toEqual([
      'run_log.retention_days must be a number (for example 30), but the file has the text "30".',
      'features.off must be a list of text in square brackets (for example ["one", "two"]), ' +
        'but the file has the text "extension".',
      "hosting.port must be a number (for example 30), but the file has true.",
      'hosting.web_base_url must be text in quotes (for example "value"), but the file has the number 3.',
      'outside_services.elicit.use must be true or false, but the file has the text "yes".',
    ]);
    expect(problemsOf(() => parse("run_log = 3\n"))).toEqual([
      "run_log is a group of settings, written [run_log], but the file gives it the number 3.",
    ]);
    expect(problemsOf(() => parse('[hosting]\ncors_origins = ["https://a.test,https://b.test"]\n'))).toEqual([
      'hosting.cors_origins has the item "https://a.test,https://b.test", and an item of this list cannot contain a comma.',
    ]);
  });

  it("names a value the config schema does not accept, in the schema's own words", () => {
    const problems = problemsOf(() =>
      parse(
        '[features]\noff = ["extnsion"]\n[models]\nsteward = "no-such-model"\n' +
          "[hosting]\nanonymous_rate_limit_per_minute = -3\n"
      )
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toBe(
      'features.off is not accepted: FEATURES_OFF names "extnsion", which is not a feature. ' +
        "The features are: extension, mathematics, prizes."
    );
    // The rest of this one is the routing table's account of the ids it takes.
    expect(problems[1]).toMatch(
      /^models\.steward is "no-such-model", which is not accepted: "no-such-model" does not resolve to a known provider\. Use /
    );
    expect(problems[2]).toBe(
      "hosting.anonymous_rate_limit_per_minute is -3, which is not accepted: Too small: expected number to be >0."
    );
  });

  it("refuses every secret, under its name in the file or its environment variable's, naming the variable to use", () => {
    for (const key of secretConfigFileKeys()) {
      const group = key.key.slice(0, key.key.lastIndexOf("."));
      const name = key.key.slice(group.length + 1);
      expect(problemsOf(() => parse(`[${group}]\n${name} = "s3cret"\n`)), key.key).toEqual([
        `${key.key} is a secret, and secrets are not kept in the config file. ` +
          `Set the environment variable ${key.env} instead.`,
      ]);
      expect(problemsOf(() => parse(`${key.env} = "s3cret"\n`)), key.env).toEqual([
        `${key.env} is a secret, and secrets are not kept in the config file. ` +
          `Set the environment variable ${key.env} instead.`,
      ]);
    }
  });

  it("reports everything wrong at once, and text that is not TOML with its line", () => {
    const error = (() => {
      try {
        parse('[run_log]\nmode = "recrod"\n[hosting]\napi_keys = "k"\nprot = 3000\n');
      } catch (err) {
        return err as ConfigFileError;
      }
      throw new Error("expected a refusal");
    })();
    expect(error.message).toBe(
      "The config file /etc/minerval.toml cannot be used, for 3 reasons:\n" +
        "  - hosting.prot is not a setting. Did you mean hosting.port? [hosting] holds: environment, web_base_url, " +
        "api_base_url, citation_url_base, cors_origins, host, port, log_level, anonymous_rate_limit_per_minute.\n" +
        '  - run_log.mode is "recrod", which is not accepted: expected one of "best_effort", "record".\n' +
        "  - hosting.api_keys is a secret, and secrets are not kept in the config file. " +
        "Set the environment variable API_KEYS instead."
    );
    expect(() => parse("[run_log\nmode = 1\n")).toThrow(
      "The config file /etc/minerval.toml cannot be used. It is not valid TOML: illegal character in key\n\n" +
        "1:  [run_log\n            ^\n2:  mode = 1"
    );
  });
});

describe("writing settings back", () => {
  const settings: ConfigFileSettings = {
    "features.off": ["mathematics", "extension"],
    "models.steward": MODELS.strong,
    "outside_services.elicit.use": false,
    "outside_services.github_issues.repo": "",
    "run_log.mode": "record",
    "run_log.retention_days": 0,
    "hosting.web_base_url": 'https://graph.example.test/a "quoted" path\\',
    "hosting.cors_origins": [],
    "pricing.cap_source_ingest_owls": 0.1,
    "pricing.owl_packs": ["5:2000:Clutch", "25:9000:Perch", "100:30000:Wisdom", "500:100000:Parliament"],
  };

  it("round-trips: what is written reads back as the same settings", () => {
    const text = renderConfigFile(settings, configFieldProblem);
    expect(parseConfigFile(text, configFieldProblem)).toEqual(settings);
    // Written in the table's order under a line on each group, whatever order they came in.
    expect(text).toContain(`# ${CONFIG_FILE_GROUPS.run_log}\n[run_log]\nmode = "record"\nretention_days = 0\n`);
    expect(text.indexOf("[features]")).toBeLessThan(text.indexOf("[models]"));
    const reversed = Object.fromEntries(Object.entries(settings).reverse());
    expect(renderConfigFile(reversed, configFieldProblem)).toBe(text);
  });

  it("writes the file whole, replacing what was there", () => {
    const path = join(dir, "written.toml");
    writeFileSync(path, '[run_log]\nmode = "best_effort"\n[hosting]\nport = 1\n');
    writeConfigFile(path, { "run_log.mode": "record" }, configFieldProblem);
    expect(parseConfigFile(readFileSync(path, "utf8"), configFieldProblem)).toEqual({ "run_log.mode": "record" });
  });

  it("never writes a secret, an unknown setting or a value the schema refuses", () => {
    expect(problemsOf(() => renderConfigFile({ "model_providers.anthropic_api_key": "k" }, configFieldProblem))).toEqual([
      "model_providers.anthropic_api_key is a secret, and secrets are not kept in the config file. " +
        "Set the environment variable ANTHROPIC_API_KEY instead.",
    ]);
    expect(() => renderConfigFile({ "run_log.colour": "red" }, configFieldProblem)).toThrow(/is not a setting/);
    expect(() => renderConfigFile({ "run_log.mode": "sometimes" }, configFieldProblem)).toThrow(
      'These settings cannot be used. run_log.mode is "sometimes", which is not accepted'
    );
    const path = join(dir, "kept.toml");
    writeFileSync(path, "kept");
    expect(() => writeConfigFile(path, { "database.password": "p" }, configFieldProblem)).toThrow(ConfigFileError);
    expect(readFileSync(path, "utf8")).toBe("kept");
  });
});

describe("the page that explains the file, docs/deployment.md", () => {
  const page = readFileSync(join(ROOT, "docs", "deployment.md"), "utf8");

  it("describes every setting the file can hold, under its group, with its environment variable", () => {
    for (const key of settableConfigFileKeys()) {
      const group = key.key.slice(0, key.key.lastIndexOf("."));
      // A group of outside_services is headed by its full name; a setting in one is named from the service on.
      const heading = page.indexOf(`\`[${group}]\``);
      expect(heading, `a heading for [${group}]`).toBeGreaterThan(-1);
      const name = group.startsWith("outside_services.") && !group.endsWith("github_issues")
        ? key.key.slice("outside_services.".length)
        : key.key.slice(group.length + 1);
      expect(page.indexOf(`\`${name}\``, heading), key.key).toBeGreaterThan(-1);
      expect(page, key.key).toContain(`\`${key.env}\``);
    }
  });

  it("names every secret's environment variable", () => {
    for (const key of secretConfigFileKeys()) expect(page, key.env).toContain(`\`${key.env}\``);
  });

  it("names every check the preflight runs", async () => {
    const { PREFLIGHT_CHECKS } = await import("../../src/preflight.js");
    for (const check of PREFLIGHT_CHECKS) expect(page, check.name).toContain(`\`${check.name}\``);
  });
});

describe("the example file, deploy/minerval.example.toml", () => {
  const text = readFileSync(EXAMPLE, "utf8");

  /** Environment variables the production task definition sets to a literal. */
  function productionLiterals(): Record<string, string> {
    const stack = readFileSync(join(ROOT, "infra", "lib", "api-stack.ts"), "utf8");
    const literals: Record<string, string> = {};
    for (const match of stack.matchAll(/^\s+([A-Z][A-Z0-9_]+): "([^"]*)",\s*$/gm)) literals[match[1]!] = match[2]!;
    return literals;
  }

  it("is accepted, and reads back the same after being written by the writer", () => {
    const settings = parseConfigFile(text, configFieldProblem, EXAMPLE);
    expect(parseConfigFile(renderConfigFile(settings, configFieldProblem), configFieldProblem)).toEqual(settings);
  });

  it("shows every setting a file can hold, set or as a commented line", () => {
    const uncommented = text.replace(/^# (\[[a-z_.]+\]|[a-z_]+ = .+)$/gm, "$1");
    const shown = parseConfigFile(uncommented, configFieldProblem);
    expect(Object.keys(shown).sort()).toEqual(
      settableConfigFileKeys()
        .map((k) => k.key)
        .sort()
    );
  });

  it("is public Minerval's settings: the production task's where it states one, the default elsewhere", async () => {
    const literals = productionLiterals();
    expect(Object.keys(literals)).toContain("STEWARD_MODEL");

    clearSettings();
    nameFile(text);
    const fromExample = (await freshConfig()).loadConfig() as unknown as Record<string, unknown>;

    vi.resetModules();
    delete process.env.MINERVAL_CONFIG;
    clearSettings();
    for (const key of settableConfigFileKeys()) {
      if (literals[key.env] !== undefined) process.env[key.env] = literals[key.env];
    }
    const fromProduction = (await freshConfig()).loadConfig() as unknown as Record<string, unknown>;

    // Whether each paid service is used is said only in the file (the task
    // definition says it by which keys it supplies): Elicit and Stripe keys
    // are supplied, a Pangram key is not.
    const saidOnlyInTheFile: Record<string, unknown> = {
      elicitEnabled: "true",
      pangramEnabled: "false",
      paymentsEnabled: "true",
    };
    for (const key of settableConfigFileKeys()) {
      const field = key.field!;
      const expected = field in saidOnlyInTheFile ? saidOnlyInTheFile[field] : fromProduction[field];
      expect(fromExample[field], key.key).toEqual(expected);
    }
  });
});
