/**
 * The preflight's checks (src/preflight.ts), each over facts made up here:
 * what it says for each state it can find, which checks block agent work,
 * and that on a deployment holding only public material none does. The
 * gathering of the facts is tested against a real database in
 * tests/db/preflight.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, type Config } from "../../src/config.js";
import { MODELS, OPENROUTER_MODELS } from "../../src/llm/models.js";
import {
  PREFLIGHT_CHECKS,
  UNLOGGED_WORK,
  WEB_SEARCH_AGENT_MODELS,
  agentWorkGate,
  agentWorkRefusal,
  evaluatePreflight,
  type DatabaseFacts,
  type PreflightFacts,
  type PreflightReport,
} from "../../src/preflight.js";
import { noDeploymentFacts } from "../../src/preflight-deployment.js";

const SRC = resolve(__dirname, "..", "..", "src");

/** A configuration with every key present and every optional service unconfigured. */
function config(over: Partial<Config> = {}): Config {
  return {
    ...loadConfig(),
    featuresOff: [],
    runLogMode: "best_effort",
    anthropicApiKey: "k",
    openaiApiKey: "k",
    openrouterApiKey: "k",
    elicitEnabled: undefined,
    elicitApiKey: "",
    pangramEnabled: undefined,
    pangramApiKey: "",
    paymentsEnabled: undefined,
    stripeSecretKey: "",
    stripeWebhookSecret: "",
    githubIssuesRepo: "",
    githubToken: "",
    githubAppId: "",
    githubAppInstallationId: "",
    githubAppPrivateKey: "",
    stewardStrongModel: "",
    modelEndpoints: [],
    providerLabels: {},
    ...over,
  } as Config;
}

const FOLDER = [
  { tag: "0000_first", when: 100 },
  { tag: "0001_second", when: 200 },
  { tag: "0002_third", when: 300 },
];

const CURRENT: DatabaseFacts = { reachable: true, pgvector: true, folder: FOLDER, applied: [100, 200, 300] };

/**
 * Facts for a deployment that is in order. One made to hold private
 * material has the one other label "internal" unless the test names its own.
 */
function facts(over: Partial<PreflightFacts> = {}): PreflightFacts {
  const holdsPrivate = over.holdsPrivate === undefined ? false : over.holdsPrivate;
  return {
    config: config(),
    configFile: null,
    holdsPrivate,
    privateLabels: holdsPrivate === null ? null : holdsPrivate ? ["internal"] : [],
    endpointKeysMissing: [],
    database: CURRENT,
    runLog: { ok: true, steps: 2 },
    deployment: noDeploymentFacts(),
    ...over,
  };
}

/** A deployment with these labels besides `public`. */
function withLabels(privateLabels: string[], over: Partial<Config> = {}): Partial<PreflightFacts> {
  return { holdsPrivate: privateLabels.length > 0, privateLabels, config: config(over) };
}

/** Every role on one Anthropic model, so a test can move the roles it is about. */
const ALL_ANTHROPIC: Partial<Config> = {
  matcherModel: MODELS.sonnet,
  taggerModel: MODELS.sonnet,
  lookoutModel: MODELS.sonnet,
  programOfficerModel: MODELS.sonnet,
  consistencyModel: MODELS.sonnet,
  assistantTitleModel: MODELS.sonnet,
  researcherCheapModel: MODELS.sonnet,
};

const LOCAL = { name: "local", baseUrl: "http://vllm.internal:8000/v1", inputUsdPerMtok: 0.5, outputUsdPerMtok: 1.5 };

function check(name: string, over: Partial<PreflightFacts> = {}) {
  const result = evaluatePreflight(facts(over)).checks.find((c) => c.name === name);
  if (!result) throw new Error(`no check named ${name}`);
  return result;
}

describe("config_file", () => {
  it("does not apply when no file is named", () => {
    expect(check("config_file")).toMatchObject({
      status: "not_applicable",
      message: "No config file is named, so every setting comes from the environment or its default.",
    });
  });

  it("says what was read, and which settings the environment overrides", () => {
    const configFile = { path: "/etc/minerval.toml", settings: ["run_log.mode", "hosting.port"], overridden: [] };
    expect(check("config_file", { configFile })).toMatchObject({
      status: "pass",
      message: "2 settings were read from /etc/minerval.toml.",
    });
    expect(
      check("config_file", {
        configFile: { ...configFile, overridden: [{ key: "run_log.mode", env: "RUN_LOG_MODE" }] },
      }).message
    ).toBe(
      "2 settings were read from /etc/minerval.toml; the environment overrides 1 of them: run_log.mode (RUN_LOG_MODE)."
    );
  });
});

describe("database", () => {
  const db = (database: DatabaseFacts) => check("database", { database });

  it("passes when it is reachable, has pgvector and has every migration", () => {
    expect(db(CURRENT)).toMatchObject({
      status: "pass",
      message: "The database is reachable, has pgvector, and has all 3 migrations applied.",
    });
  });

  it("fails, saying which, when it cannot be reached, lacks pgvector, or the folder is missing", () => {
    expect(db({ reachable: false, error: "connect ECONNREFUSED 127.0.0.1:5432" })).toMatchObject({
      status: "fail",
      message: "The database cannot be reached: connect ECONNREFUSED 127.0.0.1:5432.",
    });
    expect(db({ ...CURRENT, pgvector: false }).message).toBe(
      "The database is reachable but does not have the pgvector extension; run CREATE EXTENSION vector in it."
    );
    expect(db({ ...CURRENT, folder: null }).message).toBe(
      "The migrations folder was not found beside the code, so it cannot be told whether the database is current."
    );
  });

  it("fails when the database is behind the code, naming the first migration waiting", () => {
    expect(db({ ...CURRENT, applied: [100] })).toMatchObject({
      status: "fail",
      message: "The database is behind the code: 2 of 3 migrations have not been applied (the first is 0001_second).",
    });
    expect(db({ ...CURRENT, applied: [] }).message).toBe(
      "No migration has been applied to the database; 3 are waiting."
    );
  });

  it("fails on a migration the migrator would pass over, which applying the folder again would not fix", () => {
    expect(db({ ...CURRENT, applied: [100, 300] })).toMatchObject({
      status: "fail",
      message:
        "1 migration has not been applied and will not be, because a later one already has and the migrator " +
        "passes over any dated before the newest it has run (the first is 0001_second).",
    });
  });

  it("fails when the database was migrated by newer code", () => {
    expect(db({ ...CURRENT, applied: [100, 200, 300, 400] })).toMatchObject({
      status: "fail",
      message:
        "The database has 1 migration applied that this code does not have, so it was migrated by newer code than is running.",
    });
  });
});

describe("run_log", () => {
  it("passes when the test run was written and checked, naming the mode", () => {
    expect(check("run_log")).toMatchObject({
      status: "pass",
      message:
        "A test run of 2 steps was written to the run log, sealed, checked against its seal and removed; " +
        "the log is in best-effort mode.",
    });
    expect(check("run_log", { holdsPrivate: true, config: config({ runLogMode: "record" }) }).message).toMatch(
      /the log is in record mode\.$/
    );
  });

  it("fails when the test run could not be logged", () => {
    expect(check("run_log", { runLog: { ok: false, reason: "the database cannot be reached" } })).toMatchObject({
      status: "fail",
      message: "A test run could not be logged: the database cannot be reached.",
    });
  });

  it("fails a deployment that holds private material and is not in record mode", () => {
    expect(check("run_log", { holdsPrivate: true })).toMatchObject({
      status: "fail",
      blocking: true,
      message:
        "The run log is in best-effort mode, where a run carries on when a step cannot be written; " +
        'a deployment that holds private material keeps its log in record mode (run_log.mode = "record").',
    });
  });
});

describe("models", () => {
  it("passes when every role's provider has its key", () => {
    const result = check("models");
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(
      /^Each of the \d+ roles names a model whose provider has its key set \(Anthropic, OpenRouter\)\.$/
    );
  });

  it("fails naming the key that is missing and the roles that need it", () => {
    const result = check("models", {
      config: config({
        openrouterApiKey: "",
        matcherModel: OPENROUTER_MODELS.flash,
        taggerModel: OPENROUTER_MODELS.flash,
        lookoutModel: MODELS.sonnet,
        programOfficerModel: MODELS.sonnet,
        consistencyModel: MODELS.sonnet,
        assistantTitleModel: MODELS.sonnet,
        researcherCheapModel: MODELS.sonnet,
      }),
    });
    expect(result).toMatchObject({
      status: "fail",
      message: "OPENROUTER_API_KEY is not set, and 2 roles run on OpenRouter models (matcher, tagger).",
    });
  });

  it("leaves out the roles of features that are off, and a role with no model", () => {
    const allAnthropic = {
      matcherModel: MODELS.sonnet,
      taggerModel: MODELS.sonnet,
      lookoutModel: MODELS.sonnet,
      programOfficerModel: MODELS.sonnet,
      consistencyModel: MODELS.sonnet,
      assistantTitleModel: MODELS.sonnet,
      researcherCheapModel: MODELS.sonnet,
    };
    const on = check("models", { config: config({ ...allAnthropic, extensionModel: "gpt-example", openaiApiKey: "" }) });
    expect(on.message).toBe("OPENAI_API_KEY is not set, and 1 role runs on OpenAI models (extension).");
    const off = check("models", {
      config: config({ ...allAnthropic, extensionModel: "gpt-example", openaiApiKey: "", featuresOff: ["extension"] }),
    });
    expect(off.status).toBe("pass");
  });

  it("fails on a model no provider serves", () => {
    expect(check("models", { config: config({ stewardStrongModel: "no-such-model" }) })).toMatchObject({
      status: "fail",
      message: 'No provider this check knows serves the model named for steward_strong ("no-such-model").',
    });
  });
});

describe("models on an endpoint the deployment runs itself", () => {
  const onLocal = { ...ALL_ANTHROPIC, matcherModel: "endpoint:local/org/model", taggerModel: "endpoint:local/org/model" };

  it("passes when the endpoint is declared and takes no key, or its key is set", () => {
    expect(check("models", { config: config({ ...onLocal, modelEndpoints: [LOCAL] }) })).toMatchObject({
      status: "pass",
      message: expect.stringMatching(
        /^Each of the \d+ roles names a model whose provider has what it needs: Anthropic has its key set; the endpoint "local" is declared and takes no key\.$/
      ),
    });
    expect(
      check("models", { config: config({ ...onLocal, modelEndpoints: [{ ...LOCAL, keyEnv: "LOCAL_LLM_KEY" }] }) }).message
    ).toMatch(/Anthropic has its key set; the endpoint "local" is declared and its key \(LOCAL_LLM_KEY\) is set\.$/);
  });

  it("fails naming the endpoint that is not declared and the roles on it", () => {
    expect(check("models", { config: config(onLocal) })).toMatchObject({
      status: "fail",
      message:
        'The endpoint "local" is not declared in model_providers.endpoints, and 2 roles run on its models (matcher, tagger).',
    });
  });

  it("fails naming the variable an endpoint reads its key from when that is not set", () => {
    expect(
      check("models", {
        config: config({ ...onLocal, modelEndpoints: [{ ...LOCAL, keyEnv: "LOCAL_LLM_KEY" }] }),
        endpointKeysMissing: ["LOCAL_LLM_KEY"],
      })
    ).toMatchObject({
      status: "fail",
      message:
        'LOCAL_LLM_KEY is not set, and 2 roles run on the endpoint "local", which reads its key from that variable (matcher, tagger).',
    });
  });

  it("searches the web through OpenRouter for a searching role on an endpoint", () => {
    const result = check("web_search", {
      config: config({ lookoutModel: "endpoint:local/org/model", modelEndpoints: [LOCAL], openrouterApiKey: "" }),
    });
    expect(result.status).toBe("fail");
    expect(result.message).toMatch(/^Open-web search for .*lookout.* goes through OpenRouter, and OPENROUTER_API_KEY is not set/);
  });
});

describe("providers cleared by label", () => {
  const CLEARANCE = ["model_clearance", "embeddings_clearance", "outside_service_clearance"];

  it("does not apply where public is the only label, and says so", () => {
    expect(check("model_clearance")).toMatchObject({
      status: "not_applicable",
      message:
        "This deployment defines no label besides public, so there is no other label for a model provider to be cleared for.",
    });
    expect(check("embeddings_clearance").message).toBe(
      "This deployment defines no label besides public, so there is no other label for embeddings to be cleared for."
    );
    expect(check("outside_service_clearance").message).toBe(
      "This deployment defines no label besides public, so there is no other label for an outside service to be cleared for."
    );
    expect(check("provider_labels")).toMatchObject({
      status: "not_applicable",
      message:
        "provider_labels is not set, so every model provider and outside service is cleared for public and for no other label.",
    });
  });

  it("fails each of them when the labels could not be read", () => {
    for (const name of CLEARANCE) {
      expect(check(name, { holdsPrivate: null }), name).toMatchObject({
        status: "fail",
        message:
          "This could not be checked: the labels could not be read, so it is not known whether " +
          "this deployment holds private material.",
      });
    }
    expect(
      check("provider_labels", { holdsPrivate: null, config: config({ providerLabels: { anthropic: ["internal"] } }) })
    ).toMatchObject({
      status: "fail",
      message:
        "This could not be checked: the labels could not be read, so it is not known whether the labels " +
        "provider_labels names are defined.",
    });
  });

  describe("provider_labels: every label the setting names is defined", () => {
    it("passes when each is, and when it names none besides public", () => {
      expect(
        check(
          "provider_labels",
          withLabels(["internal", "restricted"], {
            providerLabels: { anthropic: ["public", "internal"], embeddings: ["restricted", "internal"] },
          })
        )
      ).toMatchObject({
        status: "pass",
        message: 'Every label provider_labels names is defined ("internal", "restricted").',
      });
      expect(check("provider_labels", { config: config({ providerLabels: { pangram: [], openai: ["public"] } }) })).toMatchObject({
        status: "pass",
        message: "provider_labels names no label besides public, which every deployment has.",
      });
    });

    it("fails, blocking, on a name that is not a label, saying who it was for and what it stops", () => {
      const result = check(
        "provider_labels",
        withLabels(["internal"], { providerLabels: { anthropic: ["public", "internl"], embeddings: ["internl", "internal"] } })
      );
      expect(result).toMatchObject({
        status: "fail",
        blocking: true,
        message:
          'provider_labels names "internl" (for anthropic, embeddings), which this deployment does not define as a ' +
          "label, so every model call and every call to an outside service is refused, at every label, until it is " +
          "defined or the name is corrected.",
      });
    });

    it("fails on a deployment whose only label is public too, where nothing blocks", () => {
      const result = check("provider_labels", {
        config: config({ providerLabels: { anthropic: ["public", "internal"], openai: ["secret"] } }),
      });
      expect(result).toMatchObject({ status: "fail", blocking: false });
      expect(result.message).toMatch(
        /^provider_labels names "internal" \(for anthropic\) and "secret" \(for openai\), which .* until they are defined or the names are corrected\.$/
      );
    });
  });

  describe("model_clearance: no role would be refused at a label", () => {
    it("fails when nothing is cleared for a label, which is how a new label starts, and does not block", () => {
      const result = check("model_clearance", withLabels(["internal"]));
      expect(result).toMatchObject({
        status: "fail",
        blocking: false,
        message:
          "None of the providers the roles' models are on (Anthropic, OpenRouter) is cleared for the label " +
          '"internal", so every agent run there would be refused before anything is sent. Clear the provider for ' +
          "the label in provider_labels, or name the role a model on a provider that is cleared. This check does " +
          "not stop agent work, because that would also stop the work at labels that are served, and a refused " +
          "run sends nothing.",
      });
    });

    it("names the provider that is not cleared and the roles on it, label by label", () => {
      const result = check(
        "model_clearance",
        withLabels(["internal", "restricted"], {
          ...ALL_ANTHROPIC,
          matcherModel: OPENROUTER_MODELS.flash,
          taggerModel: "endpoint:local/org/model",
          modelEndpoints: [LOCAL],
          providerLabels: {
            anthropic: ["public", "internal", "restricted"],
            openrouter: ["public", "restricted"],
            "endpoint:local": ["restricted"],
          },
        })
      );
      expect(result.status).toBe("fail");
      expect(result.message).toMatch(
        /^At the label "internal", OpenRouter is not cleared \(matcher\) and the endpoint "local" is not cleared \(tagger\), so those roles' runs there would be refused before anything is sent\. Clear the provider /
      );
      expect(result.message).not.toContain('"restricted"');
    });

    it("passes when the provider of every role's model is cleared for every label", () => {
      expect(
        check(
          "model_clearance",
          withLabels(["internal", "restricted"], {
            providerLabels: {
              anthropic: ["public", "internal", "restricted"],
              openrouter: ["internal", "restricted", "public"],
            },
          })
        )
      ).toMatchObject({
        status: "pass",
        message: 'The provider of every role\'s model is cleared for the labels "internal" and "restricted".',
      });
    });

    it("reads clearance by name only: being cleared for one label says nothing of another", () => {
      const result = check(
        "model_clearance",
        withLabels(["internal", "restricted"], {
          ...ALL_ANTHROPIC,
          providerLabels: { anthropic: ["public", "restricted"] },
        })
      );
      expect(result.message).toMatch(
        /^None of the providers the roles' models are on \(Anthropic\) is cleared for the label "internal"/
      );
    });

    it("leaves out the roles of features that are off", () => {
      const over = {
        ...ALL_ANTHROPIC,
        extensionModel: "gpt-example",
        providerLabels: { anthropic: ["public", "internal"] },
      };
      expect(check("model_clearance", withLabels(["internal"], over)).message).toMatch(
        /^At the label "internal", OpenAI is not cleared \(extension\), so /
      );
      expect(check("model_clearance", withLabels(["internal"], { ...over, featuresOff: ["extension"] }))).toMatchObject({
        status: "pass",
        message: 'The provider of every role\'s model is cleared for the label "internal".',
      });
    });
  });

  describe("embeddings_clearance", () => {
    it("passes when embeddings are cleared for every label", () => {
      expect(
        check("embeddings_clearance", withLabels(["internal"], { providerLabels: { embeddings: ["public", "internal"] } }))
      ).toMatchObject({ status: "pass", message: 'Embeddings are cleared for the label "internal".' });
    });

    it("passes where they are not, saying what the label goes without and what clearing them sends", () => {
      expect(
        check(
          "embeddings_clearance",
          withLabels(["internal", "restricted"], { providerLabels: { embeddings: ["public", "internal"] } })
        )
      ).toMatchObject({
        status: "pass",
        message:
          'Embeddings are not cleared for the label "restricted", so what is written there is stored without a ' +
          "vector, and a search there matches on keywords where it can and returns an error where it cannot. " +
          "This passes because nothing is sent out and it may be what the deployment chose; clearing them " +
          "(embeddings, in provider_labels) sends the text of each claim, tag, finding, request and report there, " +
          "and each search query, to OpenAI.",
      });
    });
  });

  describe("outside_service_clearance", () => {
    it("says which services a label goes without, and passes: leaving one uncleared is a choice", () => {
      expect(check("outside_service_clearance", withLabels(["internal"]))).toMatchObject({
        status: "pass",
        message:
          'At the label "internal", open-web search through OpenRouter and page reading are not cleared, so runs ' +
          "there are not offered their tools and are told so, and a source submitted there by its address is not " +
          "fetched. Elicit and Pangram are not in use at any label. Nothing here fails: a service that is not " +
          "cleared for a label is sent nothing from it, and which services may be sent private text is the " +
          "deployment's choice (provider_labels).",
      });
    });

    it("says which are cleared, and that searches Anthropic runs go under Anthropic's clearance", () => {
      const result = check(
        "outside_service_clearance",
        withLabels(["internal"], {
          elicitApiKey: "k",
          pangramApiKey: "k",
          pangramEnabled: "false",
          providerLabels: {
            anthropic: ["public", "internal"],
            web_pages: ["public", "internal"],
            elicit: ["public", "internal"],
          },
        })
      );
      expect(result.status).toBe("pass");
      expect(result.message).toMatch(
        /^At the label "internal", open-web search through OpenRouter is not cleared, so runs there are not offered its tools and are told so; page reading and Elicit are cleared; the \d+ roles whose models Anthropic searches for still search the web there, inside Anthropic's API, which Anthropic's clearance covers\. Pangram is not in use at any label\. Nothing here fails: /
      );
    });

    it("says so when every service in use is cleared, for each label", () => {
      const all = ["public", "internal", "restricted"];
      const result = check(
        "outside_service_clearance",
        withLabels(["internal", "restricted"], {
          ...ALL_ANTHROPIC,
          elicitApiKey: "k",
          providerLabels: { web_search: all, web_pages: all, elicit: ["public", "internal"] },
        })
      );
      // Every searching role is on a model Anthropic searches for, so the OpenRouter search is not in use.
      expect(result.message).toMatch(
        /^At the label "internal", every outside service that is on is cleared \(page reading and Elicit\)\. At the label "restricted", Elicit is not cleared, so runs there are not offered its tools and are told so; page reading is cleared\. Open-web search through OpenRouter and Pangram are not in use at any label\. /
      );
    });
  });
});

describe("outside services", () => {
  it("embeddings need the OpenAI key and have no off switch", () => {
    expect(check("embeddings").message).toBe(
      "Embeddings are made by OpenAI and OPENAI_API_KEY is set; embeddings have no off switch."
    );
    expect(check("embeddings", { config: config({ openaiApiKey: "" }) })).toMatchObject({
      status: "fail",
      message:
        "Embeddings are made by OpenAI and OPENAI_API_KEY is not set, so nothing that matches or searches claims " +
        "can run; embeddings have no off switch.",
    });
  });

  it("web search fails when a searching role's model is searched through OpenRouter and its key is missing", () => {
    const anthropicOnly = { lookoutModel: MODELS.sonnet, researcherCheapModel: MODELS.sonnet };
    expect(check("web_search", { config: config(anthropicOnly) })).toMatchObject({
      status: "pass",
      message: "Open-web search runs inside Anthropic's API for all 8 roles that search; it has no off switch.",
    });
    const mixed = { lookoutModel: OPENROUTER_MODELS.flash, researcherCheapModel: MODELS.sonnet };
    expect(check("web_search", { config: config(mixed) }).message).toBe(
      "Open-web search runs inside Anthropic's API for 7 roles and through OpenRouter for lookout, " +
        "and OPENROUTER_API_KEY is set; it has no off switch."
    );
    expect(check("web_search", { config: config({ ...mixed, openrouterApiKey: "" }) })).toMatchObject({
      status: "fail",
      message:
        "Open-web search for lookout goes through OpenRouter, and OPENROUTER_API_KEY is not set, " +
        "so those searches fail; open-web search has no off switch.",
    });
  });

  it("lists the agents that are given web search as the code has them", () => {
    const agents = join(SRC, "llm", "agents");
    const withSearch = readdirSync(agents)
      .filter((file) => readFileSync(join(agents, file), "utf8").includes("createWebSearch("))
      .sort();
    expect(Object.keys(WEB_SEARCH_AGENT_MODELS).sort()).toEqual(withSearch);
  });

  it("page reading has nothing to configure", () => {
    expect(check("page_reading")).toMatchObject({
      status: "not_applicable",
      message:
        "Agents read public web pages by fetching them directly, which needs no key; page reading has no off switch.",
    });
  });

  it("Elicit and Pangram are on with a key, off without one, and fail only when switched on without one", () => {
    expect(check("elicit").message).toBe("Elicit is off: ELICIT_API_KEY is not set.");
    expect(check("elicit", { config: config({ elicitApiKey: "k" }) }).message).toBe(
      "Elicit is on and ELICIT_API_KEY is set."
    );
    expect(check("elicit", { config: config({ elicitEnabled: "false" }) }).message).toBe("Elicit is switched off.");
    expect(check("elicit", { config: config({ elicitEnabled: "true" }) })).toMatchObject({
      status: "fail",
      message:
        "Elicit is switched on (outside_services.elicit.use) but ELICIT_API_KEY is not set, " +
        "so its tools are not offered to any agent.",
    });
    expect(check("pangram", { config: config({ pangramEnabled: "true" }) })).toMatchObject({
      status: "fail",
      message:
        "Pangram is switched on (outside_services.pangram.use) but PANGRAM_API_KEY is not set, " +
        "so its tools are not offered to any agent.",
    });
    expect(check("pangram", { config: config({ pangramEnabled: "true", pangramApiKey: "k" }) }).status).toBe("pass");
  });

  it("payments are on with both Stripe keys, off with neither, and fail on any half", () => {
    const pay = (over: Partial<Config>) => check("payments", { config: config(over) });
    expect(pay({}).message).toBe("Payments are off: no Stripe key is set.");
    expect(pay({ paymentsEnabled: "false" }).message).toBe("Payments are switched off.");
    expect(pay({ stripeSecretKey: "rk_live_x", stripeWebhookSecret: "whsec_x" })).toMatchObject({
      status: "pass",
      message: "Payments are on: both Stripe keys are set.",
    });
    expect(pay({ stripeSecretKey: "sk_live_x" })).toMatchObject({
      status: "fail",
      message:
        "STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not, so a purchase would be paid for and never credited.",
    });
    expect(pay({ stripeSecretKey: "placeholder", stripeWebhookSecret: "whsec_x" })).toMatchObject({
      status: "fail",
      message:
        "STRIPE_SECRET_KEY is set but is not a Stripe key (it starts with neither sk_ nor rk_), so payments are off.",
    });
    expect(pay({ stripeWebhookSecret: "whsec_x" }).message).toBe(
      "STRIPE_WEBHOOK_SECRET is set but STRIPE_SECRET_KEY is not, so payments are off."
    );
    expect(pay({ paymentsEnabled: "true" })).toMatchObject({
      status: "fail",
      message: "Payments are switched on (outside_services.payments.use) but STRIPE_SECRET_KEY is not set.",
    });
  });

  it("GitHub issue filing is off with no repository, on with a repository and a credential, and fails on a half", () => {
    const gh = (over: Partial<Config>) => check("github_issues", { config: config(over) });
    expect(gh({ githubToken: "t" }).message).toBe(
      "No GitHub issue repository is named, so agents' reports are not filed on GitHub."
    );
    expect(gh({ githubIssuesRepo: "an-owner/a-repo", githubToken: "t" })).toMatchObject({
      status: "pass",
      message: "Agents' reports are filed as issues in an-owner/a-repo.",
    });
    expect(
      gh({ githubIssuesRepo: "an-owner/a-repo", githubAppId: "1", githubAppInstallationId: "2", githubAppPrivateKey: "p" })
        .status
    ).toBe("pass");
    expect(gh({ githubIssuesRepo: "a-repo" })).toMatchObject({
      status: "fail",
      message:
        'outside_services.github_issues.repo is "a-repo", which is not an owner/name repository, so nothing is filed.',
    });
    expect(gh({ githubIssuesRepo: "an-owner/a-repo" })).toMatchObject({
      status: "fail",
      message:
        "Reports are to be filed in an-owner/a-repo, but no GitHub credential is set (the app's ids with " +
        "GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN), so nothing is filed.",
    });
    expect(gh({ githubIssuesRepo: "an-owner/a-repo", githubAppId: "1", githubAppInstallationId: "2" })).toMatchObject({
      status: "fail",
      message:
        "Reports are to be filed in an-owner/a-repo, but the GitHub App is partly configured " +
        "(GITHUB_APP_PRIVATE_KEY is not set) and there is no GITHUB_TOKEN, so nothing is filed.",
    });
  });
});

describe("reports_stay_inside", () => {
  const filing = config({ githubIssuesRepo: "an-owner/a-repo", githubToken: "t" });

  it("passes with no repository, whatever the deployment holds", () => {
    expect(check("reports_stay_inside", { holdsPrivate: true })).toMatchObject({
      status: "pass",
      message: "No GitHub issue repository is configured, so agents' reports stay inside this deployment.",
    });
  });

  it("does not apply to a deployment that holds only public material", () => {
    expect(check("reports_stay_inside", { config: filing })).toMatchObject({
      status: "not_applicable",
      blocking: false,
      message:
        "This deployment holds only public material, so its agents' reports may be filed in an-owner/a-repo.",
    });
  });

  it("fails, blocking, where private material is held and a repository is configured", () => {
    expect(check("reports_stay_inside", { config: filing, holdsPrivate: true })).toMatchObject({
      status: "fail",
      blocking: true,
      message:
        "This deployment holds private material and its agents' reports are to be filed as GitHub issues in " +
        'an-owner/a-repo; set outside_services.github_issues.repo to "" so the reports stay inside.',
    });
  });
});

describe("features and work the run log leaves out", () => {
  it("reports which features are off", () => {
    expect(check("features")).toMatchObject({ status: "pass", message: "No feature is switched off." });
    expect(check("features", { config: config({ featuresOff: ["mathematics"] }) }).message).toBe(
      "Switched off: mathematics, prizes."
    );
  });

  it("fails the extension being on where private material is held and the log is best-effort, and passes once it is off", () => {
    expect(check("features", { holdsPrivate: true })).toMatchObject({
      status: "fail",
      blocking: false,
      message:
        "The extension feature is on, and its page analysis and chat are not written to a best-effort run log; " +
        'put the log in record mode (run_log.mode = "record"), or switch it off (features.off), ' +
        "while this deployment holds private material.",
    });
    expect(check("features", { holdsPrivate: true, config: config({ featuresOff: ["extension"] }) })).toMatchObject({
      status: "pass",
      message: "Switched off: extension; no feature that is on does work the run log leaves out.",
    });
  });

  it("passes the extension being on in record mode, which logs its work", () => {
    expect(check("features", { holdsPrivate: true, config: config({ runLogMode: "record" }) })).toMatchObject({
      status: "pass",
      message: "No feature is switched off; the run log is in record mode, which logs every feature's work.",
    });
  });

  it("fails the unlogged work that has no switch where private material is held and the log is best-effort, and only there", () => {
    expect(check("work_outside_the_run_log")).toMatchObject({
      status: "not_applicable",
      message:
        "This deployment holds only public material, where the MCP tools match_claim, extract_claims and " +
        "assess_text, and the naming of an Assistant conversation run without a log on purpose: " +
        "what they are given is a reader's own text.",
    });
    expect(check("work_outside_the_run_log", { holdsPrivate: true })).toMatchObject({
      status: "fail",
      blocking: false,
      message:
        "The MCP tools match_claim, extract_claims and assess_text, and the naming of an Assistant conversation " +
        "are not written to a best-effort run log and have no switch, so on this deployment they handle private " +
        'material unlogged; put the log in record mode (run_log.mode = "record").',
    });
  });

  it("passes the work with no switch in record mode, which logs it", () => {
    for (const holdsPrivate of [true, false, null]) {
      expect(
        check("work_outside_the_run_log", { holdsPrivate, config: config({ runLogMode: "record" }) })
      ).toMatchObject({
        status: "pass",
        message:
          "The run log is in record mode, where the MCP tools match_claim, extract_claims and assess_text, " +
          "and the naming of an Assistant conversation are logged runs like any other.",
      });
    }
  });

  it("lists the work that runs untraced as the code has it", () => {
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) {
          // A call, not the definition in usage-context.ts or a mention in a comment.
          const code = readFileSync(path, "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
          if (/(?<!function )\buntraced\(/.test(code)) callers.push(path.slice(SRC.length + 1));
        }
      }
    };
    walk(SRC);
    expect(callers.sort()).toEqual(UNLOGGED_WORK.map((w) => w.file).sort());
  });
});

describe("the report as a whole", () => {
  const broken: Partial<PreflightFacts> = {
    database: { reachable: false, error: "down" },
    runLog: { ok: false, reason: "the database cannot be reached" },
    config: config({ githubIssuesRepo: "an-owner/a-repo", githubToken: "t", openaiApiKey: "" }),
  };

  it("marks no check blocking on a deployment that holds only public material, whatever fails", () => {
    const report = evaluatePreflight(facts(broken));
    expect(report.holds_private_material).toBe(false);
    expect(report.checks.filter((c) => c.status === "fail").map((c) => c.name)).toEqual(
      expect.arrayContaining(["database", "run_log", "embeddings"])
    );
    expect(report.checks.every((c) => c.blocking === false)).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.agent_work).toBe("allowed");
  });

  it("refuses agent work where private material is held and a blocking check fails", () => {
    const report = evaluatePreflight(facts({ ...broken, holdsPrivate: true }));
    expect(report.checks.filter((c) => c.blocking).map((c) => c.name)).toEqual([
      "database",
      "run_log",
      "provider_labels",
      "reports_stay_inside",
      "model_prices",
      "sandbox_confinement",
    ]);
    expect(report.agent_work).toBe("refused");
  });

  it("allows agent work where private material is held and only checks that do not block fail", () => {
    const report = evaluatePreflight(
      facts({ holdsPrivate: true, config: config({ runLogMode: "record", openaiApiKey: "" }) })
    );
    expect(report.ready).toBe(false);
    expect(report.agent_work).toBe("allowed");
  });

  it("treats labels that could not be read as holding private material", () => {
    const report = evaluatePreflight(facts({ ...broken, holdsPrivate: null }));
    expect(report.holds_private_material).toBeNull();
    expect(report.agent_work).toBe("refused");
    expect(report.checks.find((c) => c.name === "reports_stay_inside")).toMatchObject({
      status: "fail",
      message:
        "This could not be checked: the labels could not be read, so it is not known whether " +
        "this deployment holds private material.",
    });
  });

  it("answers every check with one of three statuses and a sentence", () => {
    const report = evaluatePreflight(facts());
    expect(report.checks.map((c) => c.name)).toEqual(PREFLIGHT_CHECKS.map((c) => c.name));
    for (const c of report.checks) {
      expect(["pass", "fail", "not_applicable"]).toContain(c.status);
      expect(c.message).toMatch(/\.$/);
    }
    expect(report.ready).toBe(true);
  });
});

describe("the gate on agent work", () => {
  const report = (over: Partial<PreflightFacts>): PreflightReport => evaluatePreflight(facts(over));

  it("opens for a deployment that holds only public material without running a single check", async () => {
    const preflight = vi.fn(async () => report({ database: { reachable: false, error: "down" } }));
    const gate = await agentWorkGate({ holdsPrivate: async () => false, preflight });
    expect(gate).toEqual({ open: true, holdsPrivate: false, failed: [] });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("closes for a deployment that holds private material while a blocking check fails, naming it", async () => {
    const gate = await agentWorkGate({
      holdsPrivate: async () => true,
      preflight: async () => report({ holdsPrivate: true }),
    });
    expect(gate.open).toBe(false);
    expect(gate.failed.map((c) => c.name)).toEqual(["run_log"]);
    expect(agentWorkRefusal(gate.failed)).toBe(
      "Agent work is not started: this deployment holds private material and 1 preflight check that must pass " +
        "first has failed. run_log: The run log is in best-effort mode, where a run carries on when a step cannot " +
        'be written; a deployment that holds private material keeps its log in record mode (run_log.mode = "record"). ' +
        "The API is serving, so GET /setup/preflight and `npm run preflight` show every check."
    );
  });

  it("opens for a deployment that holds private material once the blocking checks pass", async () => {
    const gate = await agentWorkGate({
      holdsPrivate: async () => true,
      // The extension is on, which fails a check that does not block.
      preflight: async () => report({ holdsPrivate: true, config: config({ runLogMode: "record" }) }),
    });
    expect(gate).toEqual({ open: true, holdsPrivate: true, failed: [] });
  });

  it("does not answer when the labels cannot be read", async () => {
    await expect(
      agentWorkGate({
        holdsPrivate: async () => {
          throw new Error("relation \"labels\" does not exist");
        },
        preflight: async () => report({}),
      })
    ).rejects.toThrow(/labels/);
  });
});
