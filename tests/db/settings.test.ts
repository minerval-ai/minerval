/**
 * The settings an administrator changes in the app
 * (src/services/settings-service.ts, src/routes/settings.ts;
 * docs/settings.md), against the real app and real tables in a members-only
 * deployment: who may read and change them, the four layers a value is
 * chosen from, what is checked before a change is saved, that each change is
 * logged, that a live setting is in force at once and one that applies at a
 * restart waits, and that a key is sealed and never read back.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";

const SERVICE_KEY = "settings-web-tier-key";
const FIRST_ADMINISTRATOR = "oidc:dbtest-settings-administrator";
const LABEL = "settings-internal";

// Set before any module reads config.
vi.hoisted(() => {
  process.env.READS = "members";
  process.env.API_KEYS = "settings-web-tier-key";
  process.env.FIRST_ADMINISTRATOR = "oidc:dbtest-settings-administrator";
  process.env.LOG_LEVEL = "fatal";
  // Whoever runs the machine fixed one setting, and left one present and empty, as a Compose file does.
  process.env.TAGGER_MODEL = "claude-haiku-4-5";
  process.env.STEWARD_STRONG_MODEL = "";
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GITHUB_ISSUES_REPO;
  delete process.env.RUN_LOG_MODE;
  delete process.env.PANGRAM_API_KEY;
});

import { rawQuery } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { MCP_EXCLUDED_ROUTES, ROUTE_TOOLS } from "../../src/mcp/route-tools.js";
import {
  readStoredSettings,
  resealStoredSettings,
  setSetting,
  type SettingsListing,
  type SettingView,
} from "../../src/services/settings-service.js";
import { setProcessEnder } from "../../src/services/restart.js";
import { evaluatePreflight, gatherPreflightFacts } from "../../src/preflight.js";
import { MODELS } from "../../src/llm/models.js";

let app: FastifyInstance;

interface Person {
  id: string;
  externalId: string;
}

async function signIn(name: string, externalId = `oidc:${name}-${randomUUID()}`): Promise<Person> {
  const res = await app.inject({
    method: "POST",
    url: "/users/provision",
    headers: { "x-api-key": SERVICE_KEY },
    payload: { external_id: externalId, display_name: name },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { id: res.json().user.id, externalId };
}

function as(person: Person, request: { method?: string; url: string; payload?: unknown }) {
  return app.inject({
    method: (request.method ?? "GET") as "GET",
    url: request.url,
    headers: { "x-api-key": SERVICE_KEY, "x-acting-user": person.externalId },
    ...(request.payload !== undefined ? { payload: request.payload as Record<string, unknown> } : {}),
  });
}

async function listing(person: Person): Promise<SettingsListing> {
  const res = await as(person, { url: "/settings" });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SettingsListing;
}

async function setting(person: Person, key: string): Promise<SettingView> {
  const found = (await listing(person)).settings.find((s) => s.key === key);
  expect(found, key).toBeDefined();
  return found!;
}

const put = (person: Person, key: string, value: unknown, reason?: string) =>
  as(person, { method: "PUT", url: `/settings/${encodeURIComponent(key)}`, payload: { value, ...(reason ? { reason } : {}) } });

const reset = (person: Person, key: string) => as(person, { method: "DELETE", url: `/settings/${encodeURIComponent(key)}`, payload: {} });

async function logged(action: string, settingKey: string) {
  return rawQuery<{ actor_id: string; detail: Record<string, string | null> }>(
    `SELECT actor_id, detail FROM administrative_events WHERE action = $1 AND detail->>'setting' = $2 ORDER BY created_at DESC`,
    [action, settingKey]
  );
}

let admin: Person;
let member: Person;

beforeAll(async () => {
  await rawQuery(`DELETE FROM administrative_events`);
  await rawQuery(`DELETE FROM permission_grants`);
  await rawQuery(`DELETE FROM account_groups`);
  await rawQuery(`DELETE FROM deployment_settings`);
  const { buildApp } = await import("../../src/server/app.js");
  app = await buildApp();
  await app.ready();
  admin = await signIn("Settings Administrator", FIRST_ADMINISTRATOR);
  member = await signIn("Settings Member");
  await readStoredSettings();
});

afterAll(async () => {
  await rawQuery(`DELETE FROM deployment_settings`);
  await readStoredSettings().catch(() => null);
  await app?.close();
});

describe("who may read and change the settings", () => {
  it("answers administrators only", async () => {
    expect((await as(member, { url: "/settings" })).statusCode).toBe(403);
    expect((await put(member, "models.curator", MODELS.strong)).statusCode).toBe(403);
    expect((await reset(member, "models.curator")).statusCode).toBe(403);
    expect((await as(member, { method: "POST", url: "/setup/restart", payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ url: "/settings" })).statusCode).toBe(401);
  });

  it("offers the reads and the two writes as tools, and not the restart", () => {
    expect(ROUTE_TOOLS["GET /settings"]?.name).toBe("list_settings");
    expect(ROUTE_TOOLS["PUT /settings/:key"]?.name).toBe("set_setting");
    expect(ROUTE_TOOLS["DELETE /settings/:key"]?.name).toBe("reset_setting");
    expect(MCP_EXCLUDED_ROUTES["POST /setup/restart"]).toMatch(/person's act/);
  });
});

describe("the list of settings", () => {
  it("names every setting with its value, where it comes from and whether the app may change it", async () => {
    const all = (await listing(admin)).settings;
    expect(all.length).toBeGreaterThan(250);

    const curator = all.find((s) => s.key === "models.curator")!;
    expect(curator).toMatchObject({
      env: "CURATOR_MODEL",
      group: "models",
      where: "app",
      applies: "live",
      source: "default",
      changeable: true,
      fixed_by: null,
      value: MODELS.sonnet,
      default: MODELS.sonnet,
      secret: false,
      waiting: null,
    });

    // The machine's own: shown, and not offered.
    const port = all.find((s) => s.key === "hosting.port")!;
    expect(port).toMatchObject({ where: "machine", changeable: false });
    expect(port.fixed_by).toMatch(/stays on the machine/);

    // Fixed by whoever runs the machine, by an environment variable.
    const tagger = all.find((s) => s.key === "models.tagger")!;
    expect(tagger).toMatchObject({ source: "environment", changeable: false, value: "claude-haiku-4-5" });
    expect(tagger.fixed_by).toMatch(/TAGGER_MODEL in its environment/);

    // A variable that is present and empty fixes nothing.
    expect(all.find((s) => s.key === "models.steward_strong")).toMatchObject({ source: "default", changeable: true });

    // A secret is never returned, in any layer.
    const operatorKey = all.find((s) => s.key === "hosting.operator_key")!;
    expect(operatorKey).toMatchObject({ secret: true, value: null, default: null, changeable: false });
    const anthropic = all.find((s) => s.key === "model_providers.anthropic_api_key")!;
    expect(anthropic).toMatchObject({ secret: true, where: "app_secret", value: null, is_set: false, changeable: true });
  });
});

describe("changing a setting", () => {
  it("saves a live setting, puts it in force at once, and logs who, what and why", async () => {
    expect(loadConfig().curatorModel).toBe(MODELS.sonnet);
    const res = await put(admin, "models.curator", MODELS.strong, "The Curator's splits need the strong tier.");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      in_force: "now",
      setting: { key: "models.curator", source: "app", value: MODELS.strong, set_by: { id: admin.id } },
    });
    expect(loadConfig().curatorModel).toBe(MODELS.strong);

    const [entry] = await logged("setting_changed", "models.curator");
    expect(entry).toMatchObject({
      actor_id: admin.id,
      detail: { before: null, after: MODELS.strong, reason: "The Curator's splits need the strong tier." },
    });

    // By its environment variable too, and the log names the value before.
    expect((await put(admin, "CURATOR_MODEL", MODELS.frontier)).statusCode).toBe(200);
    expect((await logged("setting_changed", "models.curator"))[0]!.detail).toMatchObject({
      before: MODELS.strong,
      after: MODELS.frontier,
    });

    const log = await as(admin, { url: "/permissions/log?type=settings" });
    expect(log.statusCode, log.body).toBe(200);
    expect(JSON.stringify(log.json())).toContain("models.curator");
  });

  it("takes each kind as the config file writes it", async () => {
    expect((await put(admin, "budgets.matcher_usd", 0.25)).statusCode).toBe(200);
    expect(loadConfig().matcherBudgetUsd).toBe(0.25);
    expect((await put(admin, "allocation.lookout_runs", false)).statusCode).toBe(200);
    expect(loadConfig().lookoutRunsEnabled).toBe(false);
    expect((await put(admin, "processing.trace_always_agents", ["math_solver", "steward"])).statusCode).toBe(200);
    expect(await setting(admin, "processing.trace_always_agents")).toMatchObject({ value: ["math_solver", "steward"] });
    const prices = [{ model: "a-vendor/priced", input_usd_per_mtok: 1, output_usd_per_mtok: 2 }];
    expect((await put(admin, "pricing.model_prices", prices)).statusCode).toBe(200);
    expect(loadConfig().modelPrices).toEqual([{ model: "a-vendor/priced", inputUsdPerMtok: 1, outputUsdPerMtok: 2 }]);
    expect(await setting(admin, "pricing.model_prices")).toMatchObject({ value: prices, source: "app" });
  });

  it("refuses a value the schema does not accept, saving nothing", async () => {
    const wrongKind = await put(admin, "budgets.matcher_usd", "a lot");
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json()).toMatchObject({ code: "INVALID_VALUE" });
    expect(wrongKind.json().error).toMatch(/must be a number/);

    const noSuchModel = await put(admin, "models.steward", "us.anthropic.claude-not-a-model");
    expect(noSuchModel.statusCode).toBe(400);
    expect(loadConfig().stewardModel).toBe(MODELS.sonnet);

    const outOfRange = await put(admin, "allocation.cost_estimate_percentile", 7);
    expect(outOfRange.statusCode).toBe(400);
    expect(await rawQuery(`SELECT 1 FROM deployment_settings WHERE key IN ('models.steward', 'allocation.cost_estimate_percentile')`)).toEqual([]);
  });

  it("refuses a setting it does not have, one that stays on the machine, and one the machine has fixed", async () => {
    const unknown = await put(admin, "models.stewrd", MODELS.strong);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toMatch(/Did you mean models\.steward\?/);

    const machine = await put(admin, "hosting.port", 4000);
    expect(machine.statusCode).toBe(409);
    expect(machine.json()).toMatchObject({ code: "ON_THE_MACHINE" });

    const trustRoot = await put(admin, "hosting.operator_key", "mine-now");
    expect(trustRoot.statusCode).toBe(409);
    expect(trustRoot.json()).toMatchObject({ code: "ON_THE_MACHINE" });

    const fixed = await put(admin, "models.tagger", MODELS.sonnet);
    expect(fixed.statusCode).toBe(409);
    expect(fixed.json()).toMatchObject({ code: "FIXED_ON_THE_MACHINE" });
    expect(loadConfig().taggerModel).toBe("claude-haiku-4-5");

    const retired = await put(admin, "PUBLIC_GRAPH_API_KEY", "k");
    expect(retired.statusCode).toBe(410);
  });

  it("never reads a setting that stays on the machine from the table, whatever the table holds", async () => {
    await rawQuery(`INSERT INTO deployment_settings (key, value) VALUES ('hosting.port', '4444'), ('accounts.reads', 'open')`);
    await readStoredSettings();
    expect(loadConfig().port).not.toBe(4444);
    expect(loadConfig().reads).toBe("members");
    await rawQuery(`DELETE FROM deployment_settings WHERE key IN ('hosting.port', 'accounts.reads')`);
  });

  it("saves a setting that applies at a restart and says it waits", async () => {
    const before = loadConfig().corsOrigins;
    const res = await put(admin, "hosting.cors_origins", ["https://a.test"]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ in_force: "at_restart", setting: { waiting: { value: ["https://a.test"] } } });
    // This process keeps the value it started with.
    expect(loadConfig().corsOrigins).toBe(before);
    const all = await listing(admin);
    expect(all.waiting_for_restart).toBe(1);

    const check = evaluatePreflight(await gatherPreflightFacts({ callOut: false })).checks.find((c) => c.name === "settings")!;
    expect(check.status).toBe("pass");
    expect(check.message).toMatch(/hosting\.cors_origins waits for the API to be started again/);

    expect((await reset(admin, "hosting.cors_origins")).json()).toMatchObject({ in_force: "at_restart", setting: { waiting: null } });
  });

  it("returns a setting to its default, logged, and refuses where nothing is set", async () => {
    const res = await reset(admin, "models.curator");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ setting: { source: "default", value: MODELS.sonnet, set_by: null } });
    expect(loadConfig().curatorModel).toBe(MODELS.sonnet);
    expect((await logged("setting_reset", "models.curator"))[0]).toMatchObject({
      actor_id: admin.id,
      detail: { before: MODELS.frontier },
    });
    const again = await reset(admin, "models.curator");
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ code: "NOT_SET" });
  });

  it("is in force in a process that did not make the change, when it next reads the table", async () => {
    // Another process's write, as this process sees it at its next read.
    await rawQuery(`INSERT INTO deployment_settings (key, value) VALUES ('models.audit', $1)`, [MODELS.strong]);
    expect(loadConfig().auditModel).toBe(MODELS.sonnet);
    await readStoredSettings();
    expect(loadConfig().auditModel).toBe(MODELS.strong);
    await rawQuery(`DELETE FROM deployment_settings WHERE key = 'models.audit'`);
    await readStoredSettings();
    expect(loadConfig().auditModel).toBe(MODELS.sonnet);
  });

  it("leaves the stored settings out, and says why, when together with the machine's they cannot be used", async () => {
    await rawQuery(`INSERT INTO deployment_settings (key, value) VALUES ('models.audit', 'us.anthropic.claude-gone')`);
    const problem = await readStoredSettings();
    expect(problem).toMatch(/us\.anthropic\.claude-gone/);
    expect(loadConfig().auditModel).toBe(MODELS.sonnet);
    expect((await listing(admin)).problem).toMatch(/claude-gone/);
    const check = evaluatePreflight(await gatherPreflightFacts({ callOut: false })).checks.find((c) => c.name === "settings")!;
    expect(check.status).toBe("fail");
    await rawQuery(`DELETE FROM deployment_settings WHERE key = 'models.audit'`);
    expect(await readStoredSettings()).toBeNull();
  });

  it("writes what is set in the app as a config file, with no secret in it", async () => {
    const res = await as(admin, { url: "/settings/file" });
    expect(res.statusCode, res.body).toBe(200);
    const toml = res.json().toml as string;
    expect(toml).toContain("[budgets]");
    expect(toml).toContain("matcher_usd = 0.25");
    expect(toml).not.toMatch(/api_key/);
  });
});

describe("a key someone outside issued", () => {
  const KEY = `sk-ant-test-${randomBytes(12).toString("hex")}`;

  it("is refused where the deployment has no key to seal it with", async () => {
    const res = await put(admin, "model_providers.anthropic_api_key", KEY);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NO_SEALING_KEY" });
    expect(res.json().error).toMatch(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it("is sealed, in force at once, and never read back", async () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const res = await put(admin, "model_providers.anthropic_api_key", KEY, "Our own Anthropic account.");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(KEY);
    expect(res.json()).toMatchObject({
      in_force: "now",
      setting: { secret: true, value: null, is_set: true, last_four: KEY.slice(-4), source: "app", set_by: { id: admin.id } },
    });
    expect(loadConfig().anthropicApiKey).toBe(KEY);

    const [row] = await rawQuery<{ value: string | null; sealed_value: string; last_four: string }>(
      `SELECT value, sealed_value, last_four FROM deployment_settings WHERE key = 'model_providers.anthropic_api_key'`
    );
    expect(row!.value).toBeNull();
    expect(row!.sealed_value).not.toContain(KEY);
    expect((await as(admin, { url: "/settings" })).body).not.toContain(KEY);

    const [entry] = await logged("setting_changed", "model_providers.anthropic_api_key");
    expect(entry!.detail).toMatchObject({ before: "not set", after: "set", secret: "true" });
    expect(JSON.stringify(entry)).not.toContain(KEY);
  });

  it("is given only from a signed-in session: a tool call or an API key is told where to give it", async () => {
    const outcome = await setSetting({
      key: "outside_services.pangram.api_key",
      value: "pangram-test-key",
      actorId: admin.id,
      fromSession: false,
    });
    expect(outcome).toMatchObject({ ok: false, code: "SECRET_NEEDS_SESSION" });
    expect(outcome.ok === false && outcome.message).toMatch(/settings page \(\/admin\/settings\)/);
  });

  it("is set and not in force when the sealing key is no longer the one that sealed it", async () => {
    const sealedWith = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await readStoredSettings();
    expect(loadConfig().anthropicApiKey).toBe("");
    expect(await setting(admin, "model_providers.anthropic_api_key")).toMatchObject({ is_set: false, unopened: true });
    process.env.CREDENTIAL_ENCRYPTION_KEY = sealedWith;
    await readStoredSettings();
    expect(loadConfig().anthropicApiKey).toBe(KEY);
  });

  it("is moved onto a new sealing key by the reseal script's step, and opens under it alone afterwards", async () => {
    const old = process.env.CREDENTIAL_ENCRYPTION_KEY!;
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS = old;
    await readStoredSettings();
    // Still opens, under the previous key.
    expect(loadConfig().anthropicApiKey).toBe(KEY);
    expect(await resealStoredSettings()).toEqual({ ok: true, resealed: 1, already_current: 0, not_opened: [] });
    expect(await resealStoredSettings()).toEqual({ ok: true, resealed: 0, already_current: 1, not_opened: [] });
    delete process.env.CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS;
    await readStoredSettings();
    expect(loadConfig().anthropicApiKey).toBe(KEY);
  });

  it("is removed like any setting", async () => {
    const res = await reset(admin, "model_providers.anthropic_api_key");
    expect(res.statusCode, res.body).toBe(200);
    expect(loadConfig().anthropicApiKey).toBe("");
    expect((await logged("setting_reset", "model_providers.anthropic_api_key"))[0]!.detail).toMatchObject({ before: "set" });
  });

  it("takes the key of a model endpoint the deployment declared, under the variable the endpoint names", async () => {
    const undeclared = await put(admin, "endpoint_keys.LOCAL_LLM_KEY", "local-secret-key-1234");
    expect(undeclared.statusCode).toBe(404);
    const endpoints = [
      { name: "local", base_url: "http://vllm.internal:8000/v1", key_env: "LOCAL_LLM_KEY", input_usd_per_mtok: 0, output_usd_per_mtok: 0 },
    ];
    expect((await put(admin, "model_providers.endpoints", endpoints)).statusCode).toBe(200);
    const res = await put(admin, "endpoint_keys.LOCAL_LLM_KEY", "local-secret-key-1234");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ setting: { key: "endpoint_keys.LOCAL_LLM_KEY", is_set: true, last_four: "1234", value: null } });
    const { givenVariable } = await import("../../src/given-variables.js");
    expect(givenVariable("LOCAL_LLM_KEY")).toBe("local-secret-key-1234");
    expect((await reset(admin, "endpoint_keys.LOCAL_LLM_KEY")).statusCode).toBe(200);
    expect(givenVariable("LOCAL_LLM_KEY")).toBeUndefined();
    expect((await reset(admin, "model_providers.endpoints")).statusCode).toBe(200);
  });
});

describe("rules that turn on what the deployment holds", () => {
  it("does not change whether owls are sold or created while any account holds owls", async () => {
    await rawQuery(`INSERT INTO owl_ledger (user_id, amount_micro_usd, reason) VALUES ($1, 3000000, 'admin_adjust')`, [member.id]);
    const res = await put(admin, "pricing.owls", "created");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "HELD_BY_WORK" });
    expect(res.json().error).toMatch(/1 account holds 3 of them/);
    await rawQuery(`DELETE FROM owl_ledger WHERE user_id = $1`, [member.id]);
    const allowed = await put(admin, "pricing.owls", "created");
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json()).toMatchObject({ in_force: "at_restart" });
    expect((await reset(admin, "pricing.owls")).statusCode).toBe(200);
  });

  it("refuses a change that would make a check that holds agent work fail, with the check's sentence", async () => {
    await rawQuery(`INSERT INTO labels (name, description) VALUES ($1, 'dbtest') ON CONFLICT DO NOTHING`, [LABEL]);
    await ensureEnforcement();
    // Where private material is held, problem reports stay inside: no issue repository.
    const res = await put(admin, "outside_services.github_issues.repo", "an-owner/a-repo");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "WOULD_FAIL_CHECK" });
    expect(res.json().error).toMatch(/reports_stay_inside/);
    expect(loadConfig().githubIssuesRepo).toBe("");
  });

  it("leaves the run log's mode to whoever runs the machine once a private label is defined", async () => {
    const res = await put(admin, "run_log.mode", "best_effort");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "ON_THE_MACHINE" });
    expect(await setting(admin, "run_log.mode")).toMatchObject({ changeable: false });
    // A row left from before the label was defined is not read either.
    await rawQuery(`INSERT INTO deployment_settings (key, value) VALUES ('run_log.mode', 'record')`);
    await readStoredSettings();
    expect(loadConfig().runLogMode).toBe("best_effort");
    await rawQuery(`DELETE FROM deployment_settings WHERE key = 'run_log.mode'`);
  });

  it("still reads and writes the settings where the database holds every connection to a clearance", async () => {
    expect((await put(admin, "models.curator", MODELS.strong)).statusCode).toBe(200);
    expect(await setting(admin, "models.curator")).toMatchObject({ source: "app", value: MODELS.strong });
    expect((await reset(admin, "models.curator")).statusCode).toBe(200);
  });
});

describe("starting the API again", () => {
  it("ends the process for an administrator, and logs it with what was waiting", async () => {
    let ended = 0;
    const before = setProcessEnder(() => {
      ended += 1;
    });
    try {
      expect((await put(admin, "hosting.cors_origins", ["https://b.test"])).statusCode).toBe(200);
      const res = await as(admin, { method: "POST", url: "/setup/restart", payload: { reason: "To take the new origins." } });
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toEqual({ restarting: true, waiting: ["hosting.cors_origins"] });
      await new Promise((r) => setTimeout(r, 700));
      expect(ended).toBe(1);
      const [entry] = await rawQuery<{ actor_id: string; detail: Record<string, string> }>(
        `SELECT actor_id, detail FROM administrative_events WHERE action = 'restart_requested' ORDER BY created_at DESC LIMIT 1`
      );
      expect(entry).toMatchObject({ actor_id: admin.id, detail: { waiting: "hosting.cors_origins", reason: "To take the new origins." } });
    } finally {
      setProcessEnder(before);
      await reset(admin, "hosting.cors_origins");
    }
  });
});
