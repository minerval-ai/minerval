import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

/**
 * What a process keeps in memory between requests.
 *
 * Where a deployment has more than one label the database shows each
 * connection the rows its clearance reads (src/db/clearance.ts), so what a
 * function returns depends on who asked. A cache in front of such a
 * function that is keyed by the question alone hands the first asker's
 * answer to everyone who asks while it lives, past the wall: a recorded
 * page's passages, a record counted over one label's attempts.
 *
 * So every piece of state a module keeps (a Map, a Set, a cache object, a
 * variable assigned later) is listed here with one of two things: that its
 * key includes the reader (readerKey in src/db/clearance.ts, or the
 * clearance itself), or the reason it holds nothing read from a labelled
 * table. A failure means one was added, renamed or removed: say which of
 * the two the new one is.
 *
 * What this finds is state declared at the top level of a module: an empty
 * Map, Set, WeakMap or WeakSet, an object of a class named ...Cache, and any
 * `let`. State kept inside a function or on a class is not found; a cache
 * built there needs the same thought.
 */
const KEYED = "keyed by clearance";

const MODULE_STATE: Record<string, string> = {
  // ---- caches of what was read from labelled tables -------------------------
  "src/services/allocation-policy-service.ts:mandateCache": KEYED,
  "src/services/attempt-stats-service.ts:cache": KEYED,
  "src/services/cost-estimate-service.ts:cache": KEYED,
  "src/services/extension-service.ts:cache": KEYED,
  "src/services/extension-service.ts:failedRuns": KEYED,
  "src/services/extension-service.ts:inFlight": KEYED,
  "src/services/recorded-page-service.ts:recent": KEYED,
  "src/services/sql-service.ts:cache": KEYED,

  // ---- the wall's own bookkeeping --------------------------------------------
  "src/db/clearance.ts:contextReader": "The function that reads the context, set once at startup. No rows.",
  "src/db/clearance.ts:enforcement": "Whether enforcement is on, and when that was asked. The same for every reader.",
  "src/db/clearance.ts:enforcementCheck": "The one check of enforcement in flight. The same for every reader.",
  "src/db/clearance.ts:labelClearances": "What each label reads, keyed by the label. It is what a clearance is made from, not something read under one.",
  "src/db/clearance.ts:unsettledUntil": "A time: until when this process asks the database afresh after writing a label.",
  "src/db/client.ts:_pool": "The owner's connection pool.",
  "src/db/client.ts:clearedLoginWorked": "Whether this process has opened a connection as the cleared role. A flag.",
  "src/db/client.ts:loginEnsuredAt": "A time: when the cleared role's login was last made sure of.",
  "src/db/client.ts:sessionConnectionsInUse": "A count of connections.",
  "src/db/client.ts:sessionPools": "The connection pools, keyed by the session they were opened with, clearance included.",
  "src/db/statement-observer.ts:observer": "A function a test installs to watch statements. No rows.",
  "src/services/sql-service.ts:clearanceKey": "The key read-only SQL's clearance is signed with. It is the same for every reader and is never returned.",
  "src/services/sql-service.ts:parserReady": "The SQL parser, loaded once.",

  // ---- clients, configuration and files ---------------------------------------
  "src/config.ts:_config": "The process's configuration, from its environment.",
  "src/llm/prompts/constitution.ts:_constitution": "The constitution's text, read from a file in the repository.",
  "src/llm/prompts/skills.ts:_skills": "The skills, read from files in the repository.",
  "src/llm/providers/anthropic.ts:_client": "A model provider's client.",
  "src/llm/providers/anthropic.ts:_longRunClient": "A model provider's client.",
  "src/llm/providers/endpoint.ts:clients": "A model provider's clients, one for each endpoint the deployment declares. No rows.",
  "src/llm/providers/openai.ts:_client": "A model provider's client.",
  "src/llm/providers/openrouter.ts:_client": "A model provider's client.",
  "src/llm/tools/elicit-tools.ts:clientPromise": "The client of an outside search service.",
  "src/llm/tools/skill-tools.ts:registry": "The tools a skill brings, registered by code at startup.",
  "src/mcp/caller-skills.ts:_skills": "The caller skills, read from files in the repository.",
  "src/mcp/route-tools.ts:inputCache": "Each route's input schema, worked out from the route catalog. No rows.",
  "src/services/embedding-service.ts:_client": "The embedding provider's client.",
  "src/services/github-app-auth.ts:cached": "The GitHub App's installation token.",
  "src/services/github-app-auth.ts:inflight": "The one request for that token in flight.",
  "src/services/lean-checker-client.ts:_client": "The proof checker's client.",
  "src/services/lean-checker-client.ts:_override": "A stand-in for the proof checker's client, set by tests.",
  "src/services/mirrored-node-service.ts:appliedHere": "Whether this process has applied a batch of the mirror: a yes or no.",
  "src/services/mirrored-node-service.ts:asOfRead": "When the public graph cut the newest batch applied here, kept for half a minute. Read from the applier's own bookkeeping, which carries no label and is the same for every reader.",
  "src/services/mirror-manifest.ts:_tables": "The list of mirrored tables and columns, built from the schema in the repository. No rows.",
  "src/db/migration-head.ts:_head": "The newest migration's number and tag, read from a file in the repository.",
  "src/llm/provider-clearance.ts:settingFoundWhole": "The provider setting once every label it names was found defined: the configuration object itself, which is the same for every reader.",
  "src/services/prompt-set.ts:cached": "The prompt set, read from files in the repository.",
  "src/services/report-sending-service.ts:toolNames": "The names of Minerval's own tools, gathered once from the tool definitions in the code. No rows.",
  "src/services/outbound-service.ts:cachedSigner": "The deployment's signing key for pages shown outside, parsed once from the configuration. No rows.",
  "src/services/queue-service.ts:_sqsClient": "The message queue's client.",
  "src/services/setup-service.ts:registry": "Where each prompt part comes from in the repository.",
  "src/services/stripe-service.ts:_stripe": "The payment provider's client.",

  // ---- who is asking, and how often -------------------------------------------
  "src/mcp/dispatch.ts:inFlight": "The caller's own authentication for one tool call, under a nonce made for that call and removed when it ends.",
  "src/server/optional-auth.ts:optionalAuthHooks": "Which route hooks are the optional-authentication hook. Functions, no rows.",
  "src/server/plugins/auth.ts:alreadyAuthenticated": "Which requests in flight have been authenticated. Request objects, no rows.",
  "src/server/plugins/members-only.ts:labelOfRequest": "The fixed label of the key or token each request in flight came with. Request objects and a label's name, no rows.",
  "src/server/plugins/quota.ts:windows": "Times of recent requests for each caller, for the rate limit. No content.",
  "src/server/require-permission.ts:permissionOfGuard": "Which permission each route guard checks. Functions, no rows.",
  "src/server/require-permission.ts:anyOfGuard": "Which permissions a route guard takes any one of. Functions, no rows.",
  "src/services/file-set-service.ts:walking": "The ids of the file sets whose directories this process is hashing now. Ids, no content, and a set's id is shown only by reads its own label holds.",
  "src/services/api-key-service.ts:lastTouched": "When each API key's last-used time was last written, by key id. No content.",
  "src/services/grant-conversation-service.ts:turnWindows": "Times of recent turns for each account, for the rate limit. No content.",
  "src/services/oauth-service.ts:lastTouched": "When each token's last-used time was last written, by token id. No content.",
  "src/services/report-service.ts:windows": "Times of recent reports for each reporter, for the rate limit. No content.",
  "src/services/reputation-service.ts:windows": "Times of recent contributions for each account, for the rate limit. No content.",

  // ---- work in flight and timers ------------------------------------------------
  "src/llm/budget-tracker.ts:_counters": "The process's spend counters: numbers of tokens and money, for the circuit breaker.",
  "src/services/assistant-service.ts:pendingTurns": "The turns in flight, kept so that shutdown and tests can wait for them. Promises of nothing.",
  "src/services/claim-events-service.ts:listeners": "The functions to tell when a claim event fires. Nothing in src registers one. A listener added later is handed events at every label and must hold what it passes on to what its own reader may read.",
  "src/services/github-issue-service.ts:closureCursor": "How far the tracker's closed issues have been read: a cursor of the tracker's.",
  "src/services/github-issue-service.ts:ensuredLabels": "The tracker's label names this process has made sure exist (kind, severity, origin). They are the tracker's labels, not sensitivity labels.",
  "src/services/grant-conversation-service.ts:pendingTurns": "The turns in flight, kept so that shutdown and tests can wait for them. Promises of nothing.",
  "src/services/mandate-event-service.ts:lastTickAt": "A time: when the events drain last ran.",
  "src/services/paper-files.ts:cache": "Source archives fetched from arXiv, by arXiv id. Public files from outside; nothing read from the database.",
  "src/services/setup-service.ts:known": "The hashes of the prompt parts this process has stored. A part is stored once for every label, under system clearance, and nothing is returned from here.",
  "src/services/shared-analysis-service.ts:recentOutcomes": "Whether a public URL served the page it was checked against: shared or not, and why not. No rows, and the same whoever asks.",
  "src/services/shared-analysis-service.ts:verifying": "The same check while it is in flight.",
  "src/services/steward-lease.ts:held": "The leases this process holds, so that it can renew and release them: claim ids it is itself working on.",
  "src/services/text-analysis-service.ts:pending": "The analyses in flight, kept so that tests can wait for them. Promises of nothing.",
  "src/workers/allocation-scheduler.ts:lastSweepAt": "A time: when the full sweep last ran.",
  "src/workers/engine-executor.ts:fallbackCuratorRuns": "A count of fallback runs, for a cap.",
  "src/workers/local-runner.ts:lastWindowCloserAt": "A time: when the prize windows were last looked at.",
  "src/workers/monitor-scheduler.ts:sweptPeriods": "Which periods the monitor has swept, by number.",
  "src/workers/prize-check-pipeline.ts:inFlightChecks": "The outside checker's id for each prize claim this process submitted, used by the lane that submitted it. Never returned to a reader.",
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "migrations" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const DECLARED = [
  // An empty container, filled as the process runs.
  /^(?:export )?(?:const|let) (\w+)[^=]*= new (?:Map|Set|WeakMap|WeakSet)\b.*\(\);?\s*$/,
  // An object of a cache class.
  /^(?:export )?(?:const|let) (\w+)[^=]*= new \w*Cache\b/,
  // Anything assigned later.
  /^(?:export )?let (\w+)\b/,
];

/** The state each module declares at its top level, as "file:name". */
export function moduleState(file: string, text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const name = DECLARED.map((re) => re.exec(line)?.[1]).find((n) => n !== undefined);
    if (name) found.push(`${file}:${name}`);
  }
  return found;
}

describe("what a process keeps in memory", () => {
  const files = sourceFiles(join(repo, "src"));
  const rel = (path: string) => relative(repo, path).split("\\").join("/");

  it("is listed here, each cache of labelled rows keyed by its reader and everything else with why it holds none", () => {
    const found = files.flatMap((path) => moduleState(rel(path), readFileSync(path, "utf-8"))).sort();
    expect(files.length).toBeGreaterThan(300);
    expect(found).toEqual(Object.keys(MODULE_STATE).sort());
  });

  it("puts the reader in the key of every cache that says so", () => {
    for (const [entry, how] of Object.entries(MODULE_STATE)) {
      if (how !== KEYED) continue;
      const file = entry.split(":")[0]!;
      const text = readFileSync(join(repo, file), "utf-8");
      expect(/readerKey\(\)|askerClearance\(\)/.test(text), `${file} reads the reader for its cache key`).toBe(true);
    }
  });

  it("gives a reason that is a sentence", () => {
    for (const [entry, how] of Object.entries(MODULE_STATE)) {
      if (how === KEYED) continue;
      expect(how.length, entry).toBeGreaterThan(15);
      expect(how, entry).toMatch(/\.$/);
    }
  });

  it("tells a container that is filled later from a constant", () => {
    expect(moduleState("f.ts", `const cache = new Map<string, number>();`)).toEqual(["f.ts:cache"]);
    expect(moduleState("f.ts", `export const recent = new AnalysisCache<Page>(60_000, 500);`)).toEqual(["f.ts:recent"]);
    expect(moduleState("f.ts", `let cached: Thing | null = null;`)).toEqual(["f.ts:cached"]);
    // A set of constants is not state.
    expect(moduleState("f.ts", `const KINDS = new Set(["claim", "question"]);`)).toEqual([]);
    // Nor is one declared inside a function.
    expect(moduleState("f.ts", `  const seen = new Set<string>();`)).toEqual([]);
  });
});
