/**
 * What a second independent review of the label wall found, each as a test
 * that the way across is closed. Labels are `public`, `rv2-a`, `rv2-b` and
 * `rv2-c`: `rv2-a` and `rv2-b` read `public`, `rv2-c` reads `rv2-a` and
 * `public`, and `rv2-a` and `rv2-b` do not read each other.
 *
 * Work with nothing in context is a connection that reads `public` alone,
 * as in a deployment. The relabel-on-reopen exception, which the review
 * found too wide, is held in tests/db/enforcement.test.ts ("a write"). One
 * finding is not closed here and has no test: a member's request writes at
 * `public` whatever it read, which is another change's to fix.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import {
  ClearanceError,
  sameLabelOnly,
  setNoContextSessionForTests,
  withSystemClearance,
  writtenAtOwnLabel,
} from "../../src/db/clearance.js";
import { ensureEnforcement } from "../../src/db/enforcement.js";
import { loadConfig } from "../../src/config.js";
import { runAtLabel, runWithUsageContext } from "../../src/llm/usage-context.js";
import { createApiKey, resolveApiKey, revokeApiKey } from "../../src/services/api-key-service.js";
import { listGraphChanges } from "../../src/services/graph-change-service.js";
import { raiseToMandate } from "../../src/services/mandate-inbox-service.js";
import { raiseIssue, triageAgentReport, updateReport } from "../../src/services/report-service.js";
import { githubIssueSyncTick } from "../../src/workers/github-issue-sync.js";

const A = "rv2-a";
const B = "rv2-b";
const C = "rv2-c";
const system = <T>(fn: () => Promise<T>) => withSystemClearance("A review test seeds and checks rows at every label.", fn);
const at = <T>(label: string, fn: () => Promise<T>) => runAtLabel(label, "a review test", fn);
const asPerson = <T>(clearance: string[], fn: () => Promise<T>) => runWithUsageContext({ clearance }, fn);
const sqlState = (err: unknown) => (err as { code?: string } | null)?.code;
const refusedWith = async (code: string, work: () => Promise<unknown>) => {
  const err = await work().then(
    () => null,
    (e: unknown) => e
  );
  expect(sqlState(err), err instanceof Error ? err.message : String(err)).toBe(code);
};
const DENIED = "42501";

const tag = randomUUID().slice(0, 8);
const claimIds: Record<string, string> = {};
let account = "";
let grantId = "";

beforeAll(async () => {
  setNoContextSessionForTests(null);
  await system(async () => {
    await rawQuery(
      `INSERT INTO labels (name, description) VALUES ($1, 'One partner.'), ($2, 'Another partner.'), ($3, 'Reads the first.')
       ON CONFLICT (name) DO NOTHING`,
      [A, B, C]
    );
    await rawQuery(
      `INSERT INTO label_reads (label, reads) VALUES ($1, 'public'), ($2, 'public'), ($3, $1), ($3, 'public') ON CONFLICT DO NOTHING`,
      [A, B, C]
    );
  });
  await ensureEnforcement();
  await system(async () => {
    for (const label of ["public", A, B]) {
      const [row] = await rawQuery<{ id: string }>(
        `INSERT INTO claims (text, steward_state, tagged_at, sensitivity_label) VALUES ($1, 'done', now(), $2) RETURNING id`,
        [`Review two ${tag} claim at ${label}`, label]
      );
      claimIds[label] = row!.id;
    }
    const [who] = await rawQuery<{ id: string }>(
      `INSERT INTO contributors (external_id, display_name) VALUES ($1, 'Review two account') RETURNING id`,
      [`review2-${tag}`]
    );
    account = who!.id;
    const [job] = await rawQuery<{ id: string }>(
      `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status, sensitivity_label) VALUES ($1, 'grant', 1000000, 'running', 'public') RETURNING id`,
      [account]
    );
    const [grant] = await rawQuery<{ id: string }>(
      `INSERT INTO grants (funder_user_id, budget_job_id, name, policy, status, daily_budget_micro_usd, sensitivity_label)
       VALUES ($1, $2, $3, 'custom', 'active', 100000, 'public') RETURNING id`,
      [account, job!.id, `Review two mandate ${tag}`]
    );
    grantId = grant!.id;
  });
});

afterAll(async () => {
  await system(async () => {
    const ids = Object.values(claimIds);
    await rawQuery(`DELETE FROM agent_report_sightings WHERE report_id IN (SELECT id FROM agent_reports WHERE title LIKE $1)`, [`%${tag}%`]);
    await rawQuery(`DELETE FROM agent_reports WHERE title LIKE $1`, [`%${tag}%`]);
    await rawQuery(`DELETE FROM action_allocations WHERE claim_id = ANY($1::uuid[]) OR grant_id = $2`, [ids, grantId]);
    await rawQuery(`DELETE FROM mandate_inbox WHERE grant_id = $1`, [grantId]);
    await rawQuery(`DELETE FROM claim_relationships WHERE parent_claim_id = ANY($1::uuid[])`, [ids]);
    await rawQuery(`DELETE FROM grants WHERE id = $1`, [grantId]);
    await rawQuery(`DELETE FROM budget_jobs WHERE user_id = $1`, [account]);
    await rawQuery(`DELETE FROM api_keys WHERE user_id = $1`, [account]);
    await rawQuery(`DELETE FROM claims WHERE id = ANY($1::uuid[])`, [ids]);
    await rawQuery(`DELETE FROM contributors WHERE id = $1`, [account]);
    await rawQuery(`DELETE FROM label_reads WHERE label = ANY($1::text[])`, [[A, B, C]]);
    await rawQuery(`DELETE FROM labels WHERE name = ANY($1::text[])`, [[A, B, C]]);
  }).catch((err: unknown) => console.warn("[enforcement-review-2] cleanup:", err instanceof Error ? err.message : err));
});

// ---------------------------------------------------------------------------

describe("C. work at one label does not write its words into a row at another", () => {
  const sent: Array<{ method: string; url: string; body: string }> = [];
  let trackerUp = false;
  let server: http.Server;
  const before = { githubToken: undefined as unknown, githubIssuesRepo: undefined as unknown, githubApiBaseUrl: undefined as unknown };

  beforeAll(async () => {
    // A stand-in for the tracker, which is outside the deployment.
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        sent.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.setHeader("content-type", "application/json");
        if (!trackerUp) {
          res.statusCode = 503;
          return res.end(`{"message":"down"}`);
        }
        res.statusCode = req.method === "POST" ? 201 : 200;
        res.end(
          req.url?.endsWith("/issues") ? `{"number":77,"html_url":"https://tracker.example/77"}` : req.method === "GET" ? "[]" : "{}"
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const config = loadConfig() as unknown as Record<string, unknown>;
    for (const key of Object.keys(before) as Array<keyof typeof before>) before[key] = config[key];
    Object.assign(config, {
      githubToken: "ghp_review",
      githubIssuesRepo: "outside/tracker",
      githubApiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    });
  });
  afterAll(async () => {
    Object.assign(loadConfig(), before);
    await new Promise((r) => server.close(() => r(undefined)));
  });
  const settle = () => new Promise((r) => setTimeout(r, 1200));

  it("a private run's sighting of a public report leaves the report's row as it was, and nothing of it reaches the tracker", async () => {
    const report = {
      kind: "system_failure",
      severity: "degraded",
      title: `fetch_source times out on PDFs (${tag})`,
      surface: "fetch_source",
      agent: "steward",
    };
    const first = await at("public", () => raiseIssue({ ...report, body: "Timed out after 30s on a public PDF." }));
    await settle();
    const privateWords = "A-ONLY: timed out fetching https://partner-a.example/board/2026-margin-41pct.pdf";
    const second = await at(A, () => raiseIssue({ ...report, body: privateWords, claimId: claimIds[A] }));
    // The report's own count does not move for a sighting at another label
    // (work changes only rows at its own label); the sighting is its own row.
    expect(second).toMatchObject({ reportId: first.reportId, deduplicated: true, occurrenceCount: 1 });
    // And by naming the report it joins.
    const third = await at(A, () => raiseIssue({ ...report, title: `${report.title} again`, body: privateWords, joins: first.reportId }));
    expect(third).toMatchObject({ reportId: first.reportId, occurrenceCount: 1 });
    await settle();

    const [row] = await system(() =>
      rawQuery<{ sensitivity_label: string; body: string; claim_id: string | null; occurrence_count: number }>(
        `SELECT sensitivity_label, body, claim_id, occurrence_count FROM agent_reports WHERE id = $1`,
        [first.reportId]
      )
    );
    // The public row is as it was: none of the private run's words or ids, and its count unmoved.
    expect(row).toEqual({ sensitivity_label: "public", body: "Timed out after 30s on a public PDF.", claim_id: null, occurrence_count: 1 });
    // The account is in the sighting's own row, at the sighting's label.
    const sightings = await system(() =>
      rawQuery<{ sensitivity_label: string; body: string }>(
        `SELECT sensitivity_label, body FROM agent_report_sightings WHERE report_id = $1 ORDER BY seen_at`,
        [first.reportId]
      )
    );
    expect(sightings).toEqual([
      { sensitivity_label: A, body: privateWords },
      { sensitivity_label: A, body: privateWords },
    ]);
    // A reader of public alone reads no sighting of it.
    expect(await rawQuery(`SELECT 1 FROM agent_report_sightings WHERE report_id = $1`, [first.reportId])).toEqual([]);

    // The tracker comes back up and the sync files the backlog, as its timer runs it.
    const from = sent.length;
    trackerUp = true;
    const tick = await githubIssueSyncTick();
    expect(tick.filed).toBeGreaterThanOrEqual(1);
    const out = sent.slice(from);
    expect(out.some((s) => s.body.includes(report.title))).toBe(true);
    expect(out.filter((s) => s.body.includes("A-ONLY") || s.body.includes("partner-a.example"))).toEqual([]);
    trackerUp = false;

    // Nor may work at another label re-rate, withdraw or triage it: it is told why.
    const rerated = await at(A, () => updateReport(first.reportId!, { agent: "steward", severity: "blocking" }));
    expect(rerated.reportId).toBeNull();
    expect(rerated.problem).toMatch(/filed by work at another label than yours/);
    await expect(
      at(A, () => triageAgentReport(first.reportId!, { status: "wontfix", triageNote: "Only partner A's files do this.", triagedBy: "audit:run" }))
    ).rejects.toThrow(/filed by work at another label than yours/);
    const [after] = await system(() =>
      rawQuery<{ severity: string; status: string; triage_note: string | null }>(
        `SELECT severity, status, triage_note FROM agent_reports WHERE id = $1`,
        [first.reportId]
      )
    );
    expect(after).toMatchObject({ severity: "degraded", triage_note: null });
    // A note is the writer's own row, and is taken.
    const noted = await at(A, () => updateReport(first.reportId!, { agent: "steward", note: "Seen on partner A's files too." }));
    expect(noted.reportId).toBe(first.reportId);
  });

  it("an upsert that carries its writer's words lands only on a row at the writer's own label, and says so otherwise", async () => {
    // The statement the question service uses for an edge, on an edge that exists at public.
    const edge = (reasoning: string, label: string) =>
      rawQuery<{ id: string }>(
        `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning, created_by, sensitivity_label)
         VALUES ($1, $2, 'part_of', $3, 'review', $4)
         ON CONFLICT (parent_claim_id, child_claim_id, relation_type) DO UPDATE
           SET reasoning = EXCLUDED.reasoning
         ${sameLabelOnly("claim_relationships")}
         RETURNING id`,
        [claimIds.public, claimIds[A], reasoning, label]
      );
    const [made] = await system(() => edge("The public reasoning.", "public"));
    const reasoningNow = async () =>
      (await system(() => rawQuery<{ reasoning: string }>(`SELECT reasoning FROM claim_relationships WHERE id = $1`, [made!.id])))[0]!.reasoning;
    // Work at rv2-a reads the public edge and may not put its reasoning into it.
    const rows = await at(A, () => edge("A-ONLY reasoning about partner A.", A));
    expect(rows).toEqual([]);
    expect(() => writtenAtOwnLabel(rows, "the edge between this question and its subquestion")).toThrow(ClearanceError);
    expect(() => writtenAtOwnLabel(rows, "the edge between this question and its subquestion")).toThrow(
      /already exists at another label than this work's/
    );
    expect(await reasoningNow()).toBe("The public reasoning.");
    // Work at public revises its own edge as before.
    expect(writtenAtOwnLabel(await at("public", () => edge("The public reasoning, revised.", "public")), "the edge")).toHaveLength(1);
    expect(await reasoningNow()).toBe("The public reasoning, revised.");
  });

  it("a note for a mandate is not folded into an item that waits at another label", async () => {
    const actionId = randomUUID();
    const raise = (summary: string) =>
      raiseToMandate({ grantId, source: "a review test", summary, detail: { action_id: actionId } });
    const first = await raise("A public note.");
    expect(first).toMatchObject({ folded: false });
    // The same work adds to its own item; work at rv2-a gets an item of its own.
    expect(await raise("More, still public.")).toMatchObject({ id: first!.id, folded: true });
    const other = await at(A, () => raise("A-ONLY: what partner A found."));
    expect(other).toMatchObject({ folded: false });
    expect(other!.id).not.toBe(first!.id);
    const items = await system(() =>
      rawQuery<{ sensitivity_label: string; summary: string }>(
        `SELECT sensitivity_label, summary FROM mandate_inbox WHERE grant_id = $1 ORDER BY created_at`,
        [grantId]
      )
    );
    expect(items).toEqual([
      { sensitivity_label: "public", summary: "A public note.\nMore, still public." },
      { sensitivity_label: A, summary: "A-ONLY: what partner A found." },
    ]);
  });
});

describe("D. the money views take a settlement's changes and nothing else", () => {
  let allocation = "";
  const key = `ingest:https://partner-b.example/${tag}.pdf`;

  beforeAll(async () => {
    const [row] = await at(B, () =>
      rawQuery<{ id: string }>(
        `INSERT INTO action_allocations (exclusion_group, claim_id, user_id, amount_micro_usd, commissioned_by, brief, reason)
         VALUES ($1, $2, $3, 5000000, 'claim_steward', 'B-ONLY brief', 'B-ONLY reason') RETURNING id`,
        [key, claimIds.public, account]
      )
    );
    allocation = row!.id;
  });

  it("no text and no key can be written through one, no row added, and no allocation deleted, at any label", async () => {
    const through = "minerval_whole.allocation_money";
    for (const reader of [<T>(fn: () => Promise<T>) => fn(), <T>(fn: () => Promise<T>) => at(A, fn), <T>(fn: () => Promise<T>) => at(B, fn)]) {
      await refusedWith(DENIED, () => reader(() => rawQuery(`UPDATE ${through} SET exclusion_group = 'text put here' WHERE id = $1`, [allocation])));
      await refusedWith(DENIED, () => reader(() => rawQuery(`UPDATE ${through} SET commissioned_by = 'someone else' WHERE id = $1`, [allocation])));
      await refusedWith(DENIED, () => reader(() => rawQuery(`UPDATE ${through} SET claim_id = NULL, user_id = $2 WHERE id = $1`, [allocation, account])));
      await refusedWith(DENIED, () => reader(() => rawQuery(`DELETE FROM ${through} WHERE id = $1`, [allocation])));
      await refusedWith(DENIED, () =>
        reader(() => rawQuery(`INSERT INTO ${through} (exclusion_group, user_id, amount_micro_usd) VALUES ('x', $1, 1)`, [account]))
      );
      await refusedWith(DENIED, () => reader(() => rawQuery(`UPDATE minerval_whole.regrant_money SET from_grant_id = to_grant_id`)));
    }
    const [row] = await system(() =>
      rawQuery<{ exclusion_group: string; commissioned_by: string; brief: string }>(
        `SELECT exclusion_group, commissioned_by, brief FROM action_allocations WHERE id = $1`,
        [allocation]
      )
    );
    expect(row).toEqual({ exclusion_group: key, commissioned_by: "claim_steward", brief: "B-ONLY brief" });
  });

  it("what settling money writes still goes through, whatever the row's label: the amount, what is spent, when it was released", async () => {
    // Work at rv2-a settles a row that work at rv2-b paid into, which is why the views exist.
    await at(A, () =>
      rawQuery(`UPDATE minerval_whole.allocation_money SET spent_micro_usd = 1000000, amount_micro_usd = 4000000 WHERE id = $1`, [allocation])
    );
    await rawQuery(`UPDATE minerval_whole.allocation_money SET released_at = now() WHERE id = $1`, [allocation]);
    const [row] = await system(() =>
      rawQuery<{ amount: string; spent: string; released: boolean }>(
        `SELECT amount_micro_usd::text AS amount, spent_micro_usd::text AS spent, released_at IS NOT NULL AS released
           FROM action_allocations WHERE id = $1`,
        [allocation]
      )
    );
    expect(row).toEqual({ amount: "4000000", spent: "1000000", released: true });
  });

  it("the change feed shows a commission to the readers of the label it was placed at, and to nobody else", async () => {
    const commissioned = async (read: <T>(fn: () => Promise<T>) => Promise<T>) =>
      (await read(() => listGraphChanges({ kinds: ["work_commissioned"], since: new Date(Date.now() - 3_600_000), limit: 200 }))).changes
        .filter((c) => c.claim_id === claimIds.public)
        .map((c) => c.kind);
    // The allocation is at rv2-b, on a public claim.
    expect(await commissioned((fn) => fn())).toEqual([]);
    expect(await commissioned((fn) => at(A, fn))).toEqual([]);
    expect(await commissioned((fn) => asPerson(["public", A], fn))).toEqual([]);
    expect(await commissioned((fn) => at(B, fn))).toEqual(["work_commissioned"]);
  });
});

describe("E. a connection held to a clearance cannot make itself a credential", () => {
  it("cannot write a key, a token, a client or an authorization, whatever it reads", async () => {
    for (const work of [
      () =>
        rawQuery(`INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES ($1, 'forged', 'mvl_forged', $2)`, [
          account,
          randomUUID(),
        ]),
      () => rawQuery(`UPDATE api_keys SET user_id = $1`, [account]),
      () => rawQuery(`DELETE FROM api_keys`),
      () => rawQuery(`UPDATE oauth_tokens SET revoked_at = NULL, user_id = $1`, [account]),
      () => rawQuery(`DELETE FROM oauth_tokens`),
      () => rawQuery(`UPDATE oauth_clients SET redirect_uris = '{}'`),
      () => rawQuery(`UPDATE oauth_authorization_requests SET status = 'approved', user_id = $1`, [account]),
    ]) {
      await refusedWith(DENIED, work);
      await refusedWith(DENIED, () => at(C, work));
      await refusedWith(DENIED, () => asPerson(["public", A, B, C], work));
    }
  });

  it("while a key made through the service, for the account the caller was checked to be, is written and works", async () => {
    // From a request held to public alone, as the route that mints a key is.
    const { key, plaintext } = await createApiKey({ userId: account, name: "review two" });
    expect((await resolveApiKey(plaintext))?.user.id).toBe(account);
    expect((await revokeApiKey(account, key.id))?.id).toBe(key.id);
    expect(await resolveApiKey(plaintext)).toBeNull();
  });

  it("cannot change which sign-in an account belongs to, and can change the rest of the account's row", async () => {
    await refusedWith("MVL05", () => rawQuery(`UPDATE contributors SET external_id = 'someone-else' WHERE id = $1`, [account]));
    await refusedWith("MVL05", () =>
      asPerson(["public", A, B, C], () => rawQuery(`UPDATE contributors SET external_id = $2 WHERE id = $1`, [account, `taken-${tag}`]))
    );
    await rawQuery(`UPDATE contributors SET display_name = 'Renamed', external_id = external_id WHERE id = $1`, [account]);
    const [row] = await system(() =>
      rawQuery<{ external_id: string; display_name: string }>(`SELECT external_id, display_name FROM contributors WHERE id = $1`, [account])
    );
    expect(row).toEqual({ external_id: `review2-${tag}`, display_name: "Renamed" });
  });
});
