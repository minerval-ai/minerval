import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * No model is called outside a logged run.
 *
 * A run is logged when withAgent (src/llm/usage-context.ts) opened it. Two
 * things hold that, and this file tests both.
 *
 * At run time, the door to a provider refuses: in record mode getAdapter
 * and the web search throw when no run is open (src/llm/logged-run.ts). That
 * is the part that cannot be got round by code this file does not know of,
 * and it is tested at the bottom.
 *
 * Statically, the lists below say which files may stand where a call could
 * slip past the door or past the log, each with why. A failure here means a
 * file started doing one of these things without that decision:
 *
 *   - calling the LLM client without opening a run in the same file;
 *   - importing a provider adapter directly, around the client;
 *   - constructing a provider's SDK client;
 *   - marking work as a reader's own content with untraced(), which keeps
 *     it off the log while the log is best-effort.
 *
 * Make the call inside withAgent, through the client, or add the file to
 * the list it belongs on with its reason. The lists are by file, so they do
 * not see a second call added to a file already listed. Reviewing a change
 * to one of these files includes checking that.
 */

/** Files that call the LLM client and do not open the run themselves. */
const CALLS_THE_CLIENT_WITHOUT_OPENING_A_RUN: Record<string, string> = {};

/** Files outside src/llm/providers that import a provider adapter module. */
const MAY_IMPORT_A_PROVIDER: Record<string, string> = {
  "src/llm/client.ts":
    "The seam itself: every call it makes goes through getAdapter, which refuses a call with no run open in record mode.",
  "src/llm/tools/web-search-tool.ts":
    "Calls openrouterWebSearch, a completion of its own that makes the same check; it runs as a tool of a run, whose tool step records the query and the hits.",
};

/** Files that construct a provider's SDK client. */
const MAY_CONSTRUCT_A_PROVIDER_CLIENT: Record<string, string> = {
  "src/llm/providers/anthropic.ts": "The Anthropic adapter, reached through getAdapter.",
  "src/llm/providers/openai.ts": "The OpenAI adapter, reached through getAdapter.",
  "src/llm/providers/endpoint.ts": "The adapter for a deployment's own endpoint, reached through getAdapter.",
  "src/llm/providers/openrouter.ts":
    "The OpenRouter adapter, reached through getAdapter, and openrouterWebSearch, which makes the check itself.",
  "src/services/embedding-service.ts":
    "Embeddings are not agent work: text in, a vector out, with no prompt, reasoning or output to log.",
};

/** Files that call untraced(): work the best-effort log leaves out on purpose. */
const MAY_CALL_UNTRACED: Record<string, string> = {
  "src/mcp/server.ts":
    "match_claim, extract_claims and assess_text analyze a passage the caller hands over, which the public terms say is never stored. Logged in record mode.",
  "src/services/extension-service.ts":
    "Page analysis and the page chat read whatever page the reader has open, which the public terms say is never stored. Logged in record mode.",
  "src/services/assistant-service.ts":
    "Naming a conversation: deleting the conversation deletes the runs its messages name, and no message names this one. Logged in record mode.",
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rel = (path: string) => relative(repo, path).split("\\").join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const read = (path: string) => ({
  file: rel(path),
  dir: dirname(path),
  // Comments name these functions and files in prose; only code counts.
  code: readFileSync(path, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, ""),
});
const files = sourceFiles(join(repo, "src")).map(read);
// The harnesses and one-off scripts call the same client, on a deployment's
// own database, so the first check covers them too.
const scripts = sourceFiles(join(repo, "scripts")).map(read);

/** The src files a file imports values from (type-only imports carry no call). */
function valueImports(f: { dir: string; code: string }): string[] {
  const found: string[] = [];
  const statics = f.code.matchAll(/\b(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+"(\.[^"]+)"/g);
  const dynamics = f.code.matchAll(/\bimport\(\s*"(\.[^"]+)"\s*\)/g);
  for (const m of [...statics, ...dynamics]) {
    found.push(rel(resolve(f.dir, m[1]!)).replace(/\.js$/, ".ts"));
  }
  return found;
}

const CLIENT = "src/llm/client.ts";
const ADAPTER_MODULES = new Set([
  "src/llm/providers/index.ts",
  "src/llm/providers/anthropic.ts",
  "src/llm/providers/openai.ts",
  "src/llm/providers/openrouter.ts",
]);

const undecided = (found: string[], allowed: Record<string, string>) =>
  found.filter((file) => !(file in allowed)).sort();
const stale = (found: string[], allowed: Record<string, string>) =>
  Object.keys(allowed).filter((file) => !found.includes(file)).sort();

describe("model calls and the run log, statically", () => {
  it("sees the source tree", () => {
    // An empty scan would make the checks below pass vacuously.
    expect(files.length).toBeGreaterThan(300);
    expect(files.filter((f) => valueImports(f).includes(CLIENT)).length).toBeGreaterThan(15);
    expect(scripts.filter((f) => valueImports(f).includes(CLIENT)).length).toBeGreaterThan(5);
  });

  it("every file that calls the LLM client opens the run it calls from", () => {
    const callers = [...files, ...scripts]
      .filter((f) => f.file !== CLIENT && valueImports(f).includes(CLIENT))
      .filter((f) => !/\bwithAgent\(/.test(f.code))
      .map((f) => f.file);
    expect(
      undecided(callers, CALLS_THE_CLIENT_WITHOUT_OPENING_A_RUN),
      "These files import the LLM client and never call withAgent. Open the run where the call is made " +
        "(src/llm/usage-context.ts), or add the file to CALLS_THE_CLIENT_WITHOUT_OPENING_A_RUN with its reason."
    ).toEqual([]);
    expect(stale(callers, CALLS_THE_CLIENT_WITHOUT_OPENING_A_RUN), "no longer needs its entry").toEqual([]);
  });

  it("no file reaches a provider around the client without a written reason", () => {
    const importers = files
      .filter((f) => !f.file.startsWith("src/llm/providers/"))
      .filter((f) => valueImports(f).some((target) => ADAPTER_MODULES.has(target)))
      .map((f) => f.file);
    expect(
      undecided(importers, MAY_IMPORT_A_PROVIDER),
      "These files import a provider adapter. Call the model through src/llm/client.ts, " +
        "or add the file to MAY_IMPORT_A_PROVIDER with its reason."
    ).toEqual([]);
    expect(stale(importers, MAY_IMPORT_A_PROVIDER), "no longer needs its entry").toEqual([]);
  });

  it("no file constructs a provider's client without a written reason", () => {
    const constructing = files.filter((f) => /\bnew\s+(?:Anthropic|OpenAI)\(/.test(f.code)).map((f) => f.file);
    expect(
      undecided(constructing, MAY_CONSTRUCT_A_PROVIDER_CLIENT),
      "These files construct a provider's SDK client. Call the model through src/llm/client.ts, " +
        "or add the file to MAY_CONSTRUCT_A_PROVIDER_CLIENT with its reason."
    ).toEqual([]);
    expect(stale(constructing, MAY_CONSTRUCT_A_PROVIDER_CLIENT), "no longer needs its entry").toEqual([]);
  });

  it("inside the provider modules, a call is made only by an adapter or behind the check", () => {
    // An adapter is reached through getAdapter. Any other exported function
    // of a provider module that reaches the provider's client has to make
    // the check itself, as openrouterWebSearch does.
    const unchecked: string[] = [];
    for (const f of files.filter((x) => ADAPTER_MODULES.has(x.file))) {
      for (const m of f.code.matchAll(/^export (?:async )?function (\w+)[\s\S]*?^}/gm)) {
        const body = m[0];
        if (/\bget(?:LongRun)?Client\(\)\s*\./.test(body) && !/\brequireLoggedRun\(/.test(body)) {
          unchecked.push(`${f.file}: ${m[1]}`);
        }
      }
    }
    expect(unchecked).toEqual([]);
    const index = files.find((f) => f.file === "src/llm/providers/index.ts")!.code;
    expect(index).toMatch(/export function getAdapter[\s\S]*?requireLoggedRun\(/);
    const openrouter = files.find((f) => f.file === "src/llm/providers/openrouter.ts")!.code;
    expect(openrouter).toMatch(/export async function openrouterWebSearch[\s\S]*?requireLoggedRun\("A web search"\)/);
  });

  it("no file keeps work off the best-effort log without a written reason", () => {
    const calling = files
      .filter((f) => f.file !== "src/llm/usage-context.ts" && /\buntraced\(/.test(f.code))
      .map((f) => f.file);
    expect(
      undecided(calling, MAY_CALL_UNTRACED),
      "These files call untraced(), which keeps the work inside it off the run log while the log is " +
        "best-effort. Add the file to MAY_CALL_UNTRACED with its reason, or let the work be logged."
    ).toEqual([]);
    expect(stale(calling, MAY_CALL_UNTRACED), "no longer needs its entry").toEqual([]);
  });

  it("gives every entry a reason", () => {
    for (const list of [
      CALLS_THE_CLIENT_WITHOUT_OPENING_A_RUN,
      MAY_IMPORT_A_PROVIDER,
      MAY_CONSTRUCT_A_PROVIDER_CLIENT,
      MAY_CALL_UNTRACED,
    ]) {
      for (const [file, why] of Object.entries(list)) expect(why.trim().length, file).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// The door itself
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  config: { runLogMode: "best_effort" as "best_effort" | "record", traceLevel: "off" as "off" | "full" },
  create: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({ loadConfig: () => mocks.config }));

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
  rawQuery: async () => [],
}));

// The three adapters. The one the test's model id routes to records that it
// was reached.
vi.mock("../../../src/llm/providers/anthropic.js", () => ({ anthropicAdapter: { name: "anthropic" } }));
vi.mock("../../../src/llm/providers/openai.js", () => ({ openaiAdapter: { name: "openai" } }));
vi.mock("../../../src/llm/providers/openrouter.js", async () => {
  const { requireLoggedRun } = await import("../../../src/llm/logged-run.js");
  return {
    openrouterAdapter: {
      name: "openrouter",
      complete: async (req: unknown) => {
        mocks.create(req);
        return { content: "Lockdown costs and benefits", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
    // The first line of the real function, which the static test above pins.
    openrouterWebSearch: async () => {
      requireLoggedRun("A web search");
      mocks.create("search");
      return [];
    },
  };
});

import { complete, completeStructured, toolUseLoop, longRunToolLoop } from "../../../src/llm/client.js";
import { getAdapter } from "../../../src/llm/providers/index.js";
import { openrouterWebSearch } from "../../../src/llm/providers/openrouter.js";
import { UnloggedModelCallError, requireLoggedRun } from "../../../src/llm/logged-run.js";
import { getUsageContext, runWithUsageContext, untraced, withAgent } from "../../../src/llm/usage-context.js";

const MODEL = "vendor/test-model";
const ask = () => complete({ model: MODEL, messages: [{ role: "user", content: "name this" }] });

afterEach(() => {
  mocks.config.runLogMode = "best_effort";
  mocks.config.traceLevel = "off";
  mocks.create.mockClear();
});

describe("the model seam in record mode", () => {
  it("refuses a call with no run open, before the provider is reached", async () => {
    mocks.config.runLogMode = "record";
    expect(() => getAdapter(MODEL)).toThrow(UnloggedModelCallError);
    await expect(ask()).rejects.toThrow(UnloggedModelCallError);
    await expect(ask()).rejects.toThrow(
      "A model call (vendor/test-model) was refused: no agent run is open, so the call would leave no log, " +
        "and this deployment keeps its run log as a record (RUN_LOG_MODE=record). " +
        "Make the call inside withAgent (src/llm/usage-context.ts)."
    );
    await expect(
      completeStructured({ model: MODEL, messages: [], schema: {}, schemaName: "X" })
    ).rejects.toThrow(UnloggedModelCallError);
    await expect(
      toolUseLoop({ model: MODEL, initialMessages: [], tools: [], executeTool: async () => "" })
    ).rejects.toThrow(UnloggedModelCallError);
    await expect(
      longRunToolLoop({ model: MODEL, initialMessages: [], tools: [], executeTool: async () => "" })
    ).rejects.toThrow(UnloggedModelCallError);
    await expect(openrouterWebSearch("anything", 3)).rejects.toThrow("A web search was refused");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses an identity or a label alone: only an open run will do", async () => {
    mocks.config.runLogMode = "record";
    await expect(
      runWithUsageContext({ userId: "user-1", agent: "matcher", label: "internal" }, ask)
    ).rejects.toThrow(UnloggedModelCallError);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("lets a call through inside a run, and every run is one there, whatever TRACE_LEVEL says", async () => {
    mocks.config.runLogMode = "record";
    const result = await withAgent("assistant", async () => {
      expect(getUsageContext().trace).toBeDefined();
      return ask();
    });
    expect(result.content).toBe("Lockdown costs and benefits");
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("lets work over a reader's own content through, because there it is logged", async () => {
    mocks.config.runLogMode = "record";
    // The MCP's on-demand analysis and the extension: untraced outside, the agent's run inside.
    await untraced(() => withAgent("matcher", ask));
    // Naming a conversation: the run outside, untraced inside.
    await withAgent("assistant", () => untraced(ask));
    // The extension agent, never traced while the log is best-effort.
    await untraced(() => withAgent("extension", ask));
    await withAgent("extension", () => openrouterWebSearch("anything", 3));
    expect(mocks.create).toHaveBeenCalledTimes(4);
    // Marking the work is not opening a run.
    await expect(untraced(ask)).rejects.toThrow(UnloggedModelCallError);
  });
});

describe("the model seam while the log is best-effort", () => {
  it("refuses nothing: a call outside a run, or one kept off the log, goes through as before", async () => {
    mocks.config.traceLevel = "full";
    expect(() => requireLoggedRun("A model call")).not.toThrow();
    await ask();
    await untraced(() =>
      withAgent("matcher", async () => {
        expect(getUsageContext().trace).toBeUndefined();
        return ask();
      })
    );
    await openrouterWebSearch("anything", 3);
    expect(mocks.create).toHaveBeenCalledTimes(3);
  });
});
