import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

/**
 * Where a deployment has more than one label, the database holds every read
 * and write to a clearance (src/db/clearance.ts), and work with nothing in
 * context reads `public` alone. Some work must see every label: migrations,
 * the workers that find work at any label before running each piece at its
 * own, retention, the step that turns enforcement on. It says so through
 * one seam, withSystemClearance(reason, fn), which puts it on the tables'
 * owner's connection, past the policies.
 *
 * Every call of that seam under src/ and scripts/ is listed here with the
 * reason written at the call, and with what the work writes while it sees
 * every label. A failure means a call was added, moved or
 * reworded without that list changing: decide whether the work really has
 * to see every label (most work does not; a run sees what its label reads,
 * and a sweep can run each piece with runAtLabel), and if it does, add it
 * here with its reason.
 *
 * The same goes for the other ways past the policies: a file that opens a
 * database connection of its own is listed below, with whose connection it
 * is.
 */
/**
 * Each call: the reason written at the call, and what the work writes or
 * sends while it sees every label, with why that is safe.
 *
 * The rule the second column is held to: system clearance may find work at
 * any label, but what it writes for a recipient (a lookout, a correspondent,
 * a node's Steward, a mandate, anything outside the deployment) names a row
 * only where the recipient's label reads that row's label. The way to keep
 * it is to find with every label in sight and then put each recipient's
 * piece together inside runAtLabel(recipient's label), from rows read
 * there, so that the database decides what the recipient is shown. Passing
 * rows that were read here into a write at another label is the mistake.
 */
type SystemCall = [reason: string, writes: string];

const SYSTEM_CALLERS: Record<string, SystemCall[]> = {
  "src/index.ts": [
    [
      "Migrations change tables, which only their owner may do, and a migration that updates rows must see every one.",
      "What each migration says. A migration that inserts into a labelled table names the label (tests/unit/db/migration-label-stamps.test.ts).",
    ],
    [
      "Creating and updating read-only SQL's login roles is the owner's to do.",
      "Roles and their passwords. No rows.",
    ],
    [
      "Deciding whether a failed enforcement check may be passed over reads the label table as the owner.",
      "Nothing.",
    ],
    [
      "The page-hash fill writes a hash into every source's own row, whatever its label.",
      "A hash of the source's own URL into the source's own row. Nothing moves between rows.",
    ],
    [
      "Shutdown hands back every claim this process holds a lease on, whatever its label.",
      "The lease columns of rows this process leased. No content.",
    ],
  ],
  "src/db/enforcement.ts": [
    [
      "The step that turns enforcement on changes every labelled table, which only their owner may do.",
      "Policies, triggers and grants in the catalog. No rows.",
    ],
    [
      "The step that turns enforcement on changes every labelled table, which only their owner may do.",
      "Policies, triggers and grants in the catalog. No rows.",
    ],
    [
      "Checking enforcement reads the catalog and the label table as the owner, to compare with what a cleared connection sees.",
      "Nothing. The facts go to the startup check and name tables and roles, not rows.",
    ],
  ],
  "src/services/api-key-service.ts": [
    [
      "An API key says who a request is, so keys are written on the owner's connection. The caller has checked whose key it is.",
      "A key for the account the caller was checked to be, its revocation, and the time it was last used. Nothing read from another row.",
    ],
  ],
  "src/services/oauth-service.ts": [
    [
      "OAuth clients, authorizations and tokens say who a request is, so they are written on the owner's connection. The flow has verified the client, the code or the token.",
      "A client's registration, a pending authorization, and tokens for the account that approved it. Nothing read from a labelled table.",
    ],
  ],
  "src/services/label-admin-service.ts": [
    [
      "A label and what it reads are the wall itself, so they are written on the owner's connection. The caller has checked that the actor may administer.",
      "A label, a pair in label_reads, and the administrators' log entry for each: what the administrator asked for and nothing read from elsewhere.",
    ],
  ],
  "src/services/permission-service.ts": [
    [
      "The groups a verified sign-in carried decide what the account may read, so they are written on the owner's connection.",
      "The account's own group names, as its verified sign-in carried them.",
    ],
    [
      "The first administrator's grants say what that account may read, so they are written on the owner's connection.",
      "Grants to the one account the deployment's setting names, once, when no administrator has ever existed.",
    ],
    [
      "A grant says who may read a label, so it is written on the owner's connection. The caller has checked that the actor may administer.",
      "One grant, as the administrator asked for it.",
    ],
    [
      "Removing a grant changes who may read a label, so it is written on the owner's connection. The caller has checked that the actor may administer.",
      "The removal mark on one grant.",
    ],
  ],
  "src/services/setup-service.ts": [
    [
      "A setup part is stored once for every label and numbered across all of them, so storing one must see them all.",
      "A prompt part's text, which comes from files in the repository and is the same for every label, at the label of the run that first used it.",
    ],
  ],
  "src/services/sql-service.ts": [
    ["The key that signs read-only SQL's clearance is readable by the tables' owner alone.", "Nothing. The key is read and never returned."],
  ],
  "src/services/trace-service.ts": [
    [
      "A run's log is written at the run's label whatever the work in progress may read, so a step is never refused by the clearance of the moment.",
      "The run's own steps, at the run's own label. The recipient of a log is the run it is the log of.",
    ],
  ],
  "src/workers/allocation-scheduler.ts": [
    [
      "The scheduler reconciles the ledger and looks for stale or pending work at every label; each piece it starts runs at its own row's label.",
      "Ledger rows, each opened inside runAtLabel at the label of the claim, mandate, lookout or correspondent it is for, from that row alone. " +
        "A mandate's plan is materialized at the mandate's label and reads the nodes it names there. Money is placed at the label of the row it pays for. " +
        "A follow-up is commissioned at its petition's label and an expired session's answer goes to its node at the session's label, each from its own row. " +
        "The reconcile-candidate scan finds a pair with every label in sight, but raises the request at the anchor's label through requestCuration, " +
        "which reads both claims there and raises nothing when it cannot read the other. Queue priorities are numbers.",
    ],
  ],
  "src/services/steward-lease.ts": [
    [
      "A process that exits mid-run hands back the leases it holds, which were taken by runs at any label.",
      "A time, moved back, on the slot each of this process's own runs was holding (a node's own row, or its label's row in steward_slots), and the status of that run's own ledger row. No text, and nothing for another recipient.",
    ],
  ],
  "src/services/mirror-apply-service.ts": [
    [
      "The mirror's applier writes the public graph's rows, which belong to no run, and must see a row at any label that points to one it removes.",
      "Mirrored rows, each named as `public` and as the mirror's, copied from a batch whose signature was checked; its own bookkeeping; and, in mirror_node_changes at `public`, what the batch replaced on a mirrored node (a wording, an argument's name), which is the public graph's own text. " +
        "Of this deployment's own rows it changes one thing: a judgment recorded at a mirrored node's own label, which is `public`, is retired. The batch's notes count local rows by table and name no text from them. Nothing read at a private label is written anywhere.",
    ],
  ],
  "src/services/mirror-upkeep.ts": [
    [
      "After a batch of the mirror, finding what of this deployment's own rests on the nodes the batch touched means reading every label; each Steward's piece is then written at its own label, from rows read there.",
      "Nothing while it sees every label: it reads the node a merge ended in, the labels that recorded something on the merged node, and the nodes that have it under them by an edge of this deployment's own. Each message, slot and ledger row is then written inside runAtLabel at that label, and what the message names is read there.",
    ],
    [
      "After a batch of the mirror, finding what of this deployment's own rests on the nodes the batch touched means reading every label; each Steward's piece is then written at its own label, from rows read there.",
      "Nothing while it sees every label: it reads which nodes have the withdrawn node under them by an edge of this deployment's own, and that edge's label. Each message is then written inside runAtLabel at that label, from rows read there.",
    ],
  ],
  "src/services/curation-service.ts": [
    [
      "Pairing each of this deployment's own nodes with a public node that has just arrived means reading nodes at every label; each request is then raised at the deployment's node's label.",
      "Nothing while it sees every label: it pairs each of the deployment's own nodes with the nearest node that arrived, by their vectors. The request to the Curator is then raised inside runAtLabel at the deployment's node's label, through requestCuration, and names the public node's id and a similarity, in fixed words.",
    ],
  ],
  "src/services/reconciliation-service.ts": [
    [
      "A merge moves what every label recorded on the merged node, and finding which labels did means reading every label; each label's rows are then moved, and its Steward told, at that label.",
      "Nothing while it sees every label: it reads which labels, other than the merge's own, have a row that names the merged node. Each such label's rows are then moved to the surviving node inside runAtLabel at that label, by the merge's own statements kept to that label's rows; the record of the move and the message to the surviving node's Steward are written there, and the message names what moved and that label's own version, read there.",
    ],
    [
      "A merge moves what every label recorded on the merged node, and finding which labels did means reading every label; each label's rows are then moved, and its Steward told, at that label.",
      "Nothing while it sees every label: when a merge is undone it reads the ids and labels of the records of what the merge carried to other labels. Each is then undone inside runAtLabel at its label, from that label's own record, and the restored node's Steward at that label is told in fixed words that name the other node.",
    ],
  ],
  "src/services/redaction-policy.ts": [
    [
      "A boundary's policy is kept as one row on each side of the boundary, and the two sides may share no label.",
      "One version of a boundary's policy, as two rows with the same text: one at the label pages are written at and one at the label they are shown to. The text is categories an administrator saved, or the starting text in the repository, and the destination's row names no label of origin.",
    ],
    [
      "A boundary's policy is kept as one row on each side of the boundary, and the two sides may share no label.",
      "Nothing: it reads whether the boundary has a policy yet. The starting text is then saved by the call above.",
    ],
  ],
  "src/services/showing-service.ts": [
    [
      "Showing a page below its label keeps rows on both sides of a boundary, the page's label and the destination's, and the two may share no label.",
      "This is the one path by which text reaches a label that does not read the label it was written at, so it is the exception to the rule above and is held to its own: on the destination side it writes fixed words, ids, dates, hashes, counts and party names, and the text of a part only once every party the part rests on has released it, with the Redactor's removals already made (settle in release-gate-service.ts, which is the only statement that writes text there). The page is read inside runAtLabel at the page's label, and the reassessment that follows an arrival is opened inside runAtLabel at the destination's.",
    ],
  ],
  "src/services/version-upkeep.ts": [
    [
      "The upkeep of versions finds, at every label, the versions made beside one that has since been replaced; each node's reassessment is then opened at its own version's label.",
      "Nothing while it sees every label: it reads ids and labels. Each node's message, slot and ledger row are then written inside runAtLabel at the label of the version that is out of date, and the message names only labels that label reads (the versions it was made beside), in fixed words.",
    ],
    [
      "The upkeep of versions finds, at every label, the versions on a node at another label whose material at their own label is gone; each node's reassessment is then opened at its own version's label.",
      "Nothing while it sees every label: it reads ids and labels. Each node's message, slot and ledger row are then written inside runAtLabel at the version's own label, and the message is fixed words that name that label and no other.",
    ],
  ],
  "src/workers/correspondent-triggers.ts": [
    [
      "The change scan checks every correspondent, whatever its label, and wakes each at its own.",
      "One wake for each correspondent, written inside runAtLabel at its label, naming a change that was looked for at that label. A change it does not read is not found and not named.",
    ],
  ],
  "src/workers/local-runner.ts": [
    [
      "The runner finds waiting work at every label (queued jobs, covered ledger rows, pending claims); each piece then runs at the label of its own row.",
      "Nothing of its own across labels: every lane claims a row and runs it inside runAtLabel at that row's label, and what the run writes is the run's. " +
        "A mandate's events are collected inside runAtLabel at the mandate's label, by statements that read the judgments and flags there. " +
        "Settlement reads and updates money through the whole views (src/db/money.ts), which hold no text.",
    ],
  ],
  "src/workers/lookout-triggers.ts": [
    [
      "The retraction poll matches notices against sources at every label and queues each lookout's input at that lookout's label.",
      "A source event at the source's own label. Each lookout's event is put together inside runAtLabel at the lookout's label, from the matched sources and nodes read there. " +
        "Each Steward's letter is written at its node's label and says only how the notice reaches the node as read there. Crossref is asked for a window of dates, never for a document.",
    ],
    [
      "The graph feed wakes every lookout that watches the graph, whatever its label; each then runs at its own.",
      "One wake for each lookout, inside runAtLabel at its label, when a change it reads is waiting. The payload is the kind of that change.",
    ],
    [
      "The feed poll finds every due feed, whatever its lookout's label, and polls each at that label.",
      "Feed items and a wake, inside the lookout's label, from the feed's own URL. Nothing read from another row.",
    ],
  ],
  "src/workers/poller.ts": [
    [
      "A queue handler loads the row its message names, at whatever label, and then runs the work at that row's label.",
      "Nothing of its own: the handler runs the work inside runAtLabel at the row's label. A message carries ids and a label, no content.",
    ],
  ],
  "src/workers/queue-depth-sampler.ts": [
    [
      "The sampler counts waiting work at every label. It stores counts and no content.",
      "Counts of waiting work, into a table with no label. A reader of it learns how much is waiting in all, not what or at which label.",
    ],
  ],
  "src/workers/recovery-sweep.ts": [
    [
      "The recovery sweep finds stalled reviews and orders at every label and re-enqueues each at its own.",
      "Queue messages that name a row by id. The handler that takes one reads the row and runs at its label.",
    ],
  ],
  "src/workers/report-embedding-backfill.ts": [
    [
      "The backfill gives a vector to reports at every label that lack one. It writes into the report's own row.",
      "A vector into the report's own row. The report's text goes to the embedding provider, as the text of any run at that label does; it goes nowhere else.",
    ],
  ],
  "src/workers/source-backfill.ts": [
    [
      "The backfill finds sources at every label that lack facts or segments and fills each at the source's label.",
      "A source's facts, segments and notices, inside runAtSourceLabel, from that source's own document. The fetch asks the source's own address.",
    ],
  ],
  "src/workers/tagging-pipeline.ts": [
    [
      "The tagging drain leases untagged claims at every label and tags each at the claim's label.",
      "A lease on the claim's own row; the tagging itself runs inside runAtLabel at the claim's label.",
    ],
  ],
  "src/workers/trace-retention.ts": [["Retention deletes expired runs at every label.", "Nothing: it deletes."]],
  "scripts/enforcement-plans.ts": [["Measuring plans reads the seeded rows as the owner.", "Nothing: it explains statements."]],
};

/** Files that open a connection themselves, and whose it is. */
const OWN_CONNECTIONS: Record<string, string> = {
  "src/db/client.ts":
    "The pools themselves: the owner's, and one per session, each connection opened with its clearance.",
  "src/services/sql-service.ts":
    "Read-only SQL's own login roles, which hold nothing but the public_read views; their clearance is signed.",
  "scripts/enforcement-plans.ts":
    "Explains statements as the owner and as cleared connections, to compare their plans. Read-only.",
  "scripts/judgment-plans.ts":
    "Explains the hot reads of the judgment in force as the owner, to compare their plans before and after a change. Read-only.",
  "scripts/corpus/agreement.ts": "The corpus harness, on its own evaluation database (CORPUS_DATABASE_URL).",
  "scripts/corpus/cascade-load.ts": "The corpus harness, on its own evaluation database.",
  "scripts/corpus/graph-load.ts": "The corpus harness, on its own evaluation database.",
  "scripts/corpus/replay.ts": "The corpus harness, on its own evaluation database.",
  "scripts/corpus/reset.ts": "The corpus harness: drops and rebuilds its own evaluation database.",
  "scripts/corpus/snapshot-core.ts": "The corpus harness: creates and drops its own snapshot databases.",
};

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const files = [...sourceFiles(join(repo, "src")), ...sourceFiles(join(repo, "scripts"))];
const rel = (path: string) => relative(repo, path).split("\\").join("/");

/** The reason of each withSystemClearance call in a file, in order: the literal, or the constant's value. */
function systemReasons(text: string): string[] {
  const constants = new Map(
    [...text.matchAll(/const ([A-Z_]+) =\s*"((?:[^"\\]|\\.)*)";/g)].map((m) => [m[1]!, m[2]!])
  );
  return [...text.matchAll(/withSystemClearance\(\s*(?:"((?:[^"\\]|\\.)*)"|([A-Z_]+))\s*,/g)].map((m) =>
    m[1] !== undefined ? m[1].replace(/\\"/g, '"') : (constants.get(m[2]!) ?? `the constant ${m[2]}`)
  );
}

describe("work that sees every label", () => {
  it("sees the source tree", () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it("says so through withSystemClearance, and every caller is listed here with its reason", () => {
    const found: Record<string, string[]> = {};
    for (const path of files) {
      const file = rel(path);
      // The seam's own file defines it; it calls it nowhere.
      if (file === "src/db/clearance.ts") continue;
      const text = readFileSync(path, "utf-8");
      const calls = (text.match(/withSystemClearance\(/g) ?? []).length;
      if (calls === 0) continue;
      const reasons = systemReasons(text);
      // A call whose reason is not a literal or a constant in the same file cannot be listed.
      expect(reasons.length, `${file}: each call gives its reason as a string or a constant of the file`).toBe(calls);
      found[file] = reasons;
    }
    expect(found).toEqual(
      Object.fromEntries(Object.entries(SYSTEM_CALLERS).map(([file, calls]) => [file, calls.map(([reason]) => reason)]))
    );
  });

  it("gives a reason that is a sentence, and says what each caller writes", () => {
    for (const calls of Object.values(SYSTEM_CALLERS)) {
      for (const [reason, writes] of calls) {
        expect(reason.length, reason).toBeGreaterThan(30);
        expect(reason, reason).toMatch(/\.$/);
        expect(writes.length, reason).toBeGreaterThan(5);
        expect(writes, reason).toMatch(/\.$/);
      }
    }
  });

  it("sends nothing to a tracker outside the deployment under system clearance", () => {
    // Only public reports are ever filed, so the sync needs to see no other.
    expect(readFileSync(join(repo, "src/workers/github-issue-sync.ts"), "utf-8")).not.toContain("withSystemClearance(");
  });

  it("opens no connection of its own outside the files listed here", () => {
    const opening = files
      .filter((path) => /new (?:pg\.)?(?:Pool|Client)\(\{/.test(readFileSync(path, "utf-8")))
      .map(rel)
      // An MCP client is not a database connection.
      .filter((file) => !/assistant-tools|elicit-tools/.test(file))
      .sort();
    expect(opening).toEqual(Object.keys(OWN_CONNECTIONS).sort());
  });

  it("is never the session of a test helper outside a test run", async () => {
    const { setNoContextSessionForTests } = await import("../../../src/db/clearance.js");
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => setNoContextSessionForTests({ role: "owner" })).toThrow(/test runs only/);
    } finally {
      process.env.VITEST = vitest;
    }
    const callers = files
      .filter((path) => rel(path) !== "src/db/clearance.ts")
      .filter((path) => readFileSync(path, "utf-8").includes("setNoContextSessionForTests"))
      .map(rel);
    expect(callers).toEqual([]);
  });
});
