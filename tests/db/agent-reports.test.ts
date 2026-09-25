/**
 * Agent reports (#366) against real Postgres: the match search that
 * raise_issue and search_issues share, by meaning over pgvector and by
 * wording over full-text search, and the embedding backfill (#432).
 * Embeddings are stubbed with deterministic vectors so the similarity
 * arithmetic is under the test's control.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { rawQuery } from "../../src/db/client.js";

const embedMock = vi.hoisted(() => ({
  next: [] as Array<number[] | Error>,
}));
vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    const v = embedMock.next.shift();
    if (!v) throw new Error("no stub embedding queued");
    if (v instanceof Error) throw v;
    return v;
  }),
}));
vi.mock("../../src/services/github-issue-service.js", () => ({
  fileIssueForReport: vi.fn(async () => null),
  syncSightingToIssue: vi.fn(async () => undefined),
  syncTriageToIssue: vi.fn(async () => undefined),
}));

import {
  backfillReportEmbeddings,
  findNearReports,
  getReportView,
  raiseIssue,
  searchReports,
} from "../../src/services/report-service.js";

/** A unit vector along one axis, padded to 1536 dims. */
function axis(i: number, weight = 1): number[] {
  const v = new Array(1536).fill(0);
  v[i] = weight;
  return v;
}
/** Two axes mixed: cosine against axis(a) is a/sqrt(a²+b²). */
function mix(a: number, b: number, wa: number, wb: number): number[] {
  const v = new Array(1536).fill(0);
  v[a] = wa;
  v[b] = wb;
  return v;
}

/** Each test gets its own agent, so its reports share no dedupe key or wording with another's. */
let agent = "";
let seq = 0;

async function raise(input: {
  title: string;
  body?: string;
  embedding: number[] | Error;
  surface?: string | null;
}): Promise<string> {
  embedMock.next.push(input.embedding);
  const result = await raiseIssue({
    kind: "system_failure",
    severity: "degraded",
    title: input.title,
    body: input.body ?? "",
    surface: input.surface ?? null,
    agent,
  });
  if (!result.reportId) {
    throw new Error(`seed did not persist: ${JSON.stringify(result)}`);
  }
  return result.reportId;
}

beforeEach(() => {
  embedMock.next = [];
  agent = `agent-${++seq}-${Date.now()}`;
});

describe("findNearReports on a real database", () => {
  it("finds a report that has no embedding by the wording of its own title (#432)", async () => {
    const title = `match_claim returns is_match false on Matcher timeout instead of signalling no decision ${seq}`;
    const id = await raise({ title, embedding: new Error("embedder down") });
    const [row] = await rawQuery<{ embedding: string | null }>(
      `SELECT embedding FROM agent_reports WHERE id = $1`,
      [id]
    );
    expect(row!.embedding).toBeNull();

    embedMock.next.push(axis(0));
    const result = await searchReports(title);
    expect(result.problem).toBeUndefined();
    expect(result.matches.map((m) => m.id)).toContain(id);
    const match = result.matches.find((m) => m.id === id)!;
    expect(match.matched_by).toBe("wording");
    expect(match.similarity).toBe(0);
  });

  it("searches by wording alone when the query cannot be embedded", async () => {
    const title = `lookout poll skipped a retraction feed page ${seq}`;
    const id = await raise({ title, embedding: axis(1) });
    embedMock.next.push(new Error("embedder down"));
    const result = await searchReports(title);
    expect(result.problem).toBeUndefined();
    expect(result.matches.map((m) => m.id)).toEqual([id]);
    expect(result.matches[0]!.matched_by).toBe("wording");
  });

  it("puts a wording hit ahead of a nearer paraphrase, and reports both ways of matching", async () => {
    // The original, embedded at axis 2; a paraphrase, closer to the query.
    const originalTitle = `steward drain leaves a parked job unrequeued ${seq}`;
    const original = await raise({ title: originalTitle, embedding: axis(2) });
    const paraphrase = await raise({
      title: `parked jobs are not requeued when the steward drains ${seq}`,
      embedding: axis(3),
    });
    // The query sits nearer the paraphrase (0.8) than the original (0.6).
    const matches = await findNearReports(mix(3, 2, 4, 3), {
      origin: "internal",
      minSimilarity: 0.5,
      text: originalTitle,
      limit: 5,
    });
    expect(matches.map((m) => m.id)).toEqual([original, paraphrase]);
    expect(matches[0]).toMatchObject({ matched_by: "both" });
    expect(matches[0]!.similarity).toBeCloseTo(0.6, 5);
    expect(matches[1]).toMatchObject({ matched_by: "meaning" });
    expect(matches[1]!.similarity).toBeCloseTo(0.8, 5);
  });

  it("returns every match above the bar up to the limit, not only the best", async () => {
    const ids = await Promise.all(
      [4, 5, 6].map((i, n) =>
        raise({ title: `queue depth sampler ${n} misses a lane ${seq}`, embedding: axis(i) })
      )
    );
    const query = new Array(1536).fill(0);
    query[4] = 1;
    query[5] = 1;
    query[6] = 1;
    const matches = await findNearReports(query, {
      origin: "internal",
      minSimilarity: 0.5,
      text: "",
      limit: 5,
    });
    expect(new Set(matches.map((m) => m.id))).toEqual(new Set(ids));
    expect(matches.every((m) => m.matched_by === "meaning")).toBe(true);
  });

  it("matches by wording through stemming and word order, but not on a different problem", async () => {
    const id = await raise({
      title: `tagging pipeline skips claims without a domain ${seq}`,
      body: "Seen on three untagged claims in the mathematics lane.",
      embedding: axis(7),
    });
    embedMock.next.push(axis(8));
    const hit = await searchReports(`untagged claim skipped by the tagging pipeline ${seq}`);
    expect(hit.matches.map((m) => m.id)).toEqual([id]);

    embedMock.next.push(axis(8));
    const miss = await searchReports(`lean checker rejects a valid proof ${seq}`);
    expect(miss.matches.map((m) => m.id)).not.toContain(id);
  });

  it("scopes the wording match by surface and origin like the meaning match", async () => {
    const title = `add_instance rejects a source it has already seen ${seq}`;
    const id = await raise({ title, embedding: axis(9), surface: "add_instance" });
    embedMock.next.push(axis(10));
    const other = await searchReports(title, { surface: "add_relationship_edge" });
    expect(other.matches).toEqual([]);
    embedMock.next.push(axis(10));
    const external = await searchReports(title, { origin: "external" });
    expect(external.matches).toEqual([]);
    embedMock.next.push(axis(10));
    const same = await searchReports(title, { surface: "add_instance" });
    expect(same.matches.map((m) => m.id)).toEqual([id]);
  });

  it("records a raise and hands back a wording match with no embedding as a related report", async () => {
    const title = `search_issues returns only the single best match ${seq}`;
    const id = await raise({ title, embedding: new Error("embedder down") });
    embedMock.next.push(axis(11));
    // The same words, reordered: a wording match, and no vector to match by.
    const repeat = await raiseIssue({
      kind: "system_failure",
      severity: "degraded",
      title: `only the single best match returned by search_issues ${seq}`,
      body: "Every query this sweep returned exactly one row.",
      agent: `${agent}-other`,
    });
    expect(repeat.reportId).not.toBeNull();
    expect(repeat.related?.map((m) => m.id)).toEqual([id]);
    expect(repeat.related![0]!.matched_by).toBe("wording");

    // Having found it, the agent joins: a sighting on the original, no new row.
    const joined = await raiseIssue({
      kind: "system_failure",
      severity: "degraded",
      title: `seen again ${seq}`,
      body: "Same thing.",
      agent: `${agent}-third`,
      joins: id,
    });
    expect(joined).toMatchObject({ reportId: id, occurrenceCount: 2, deduplicated: true });
  });

  it("lists recent reports on a surface with no query, and reads one in full with its links", async () => {
    const parent = await raise({ title: `lean checker times out on long proofs ${seq}`, embedding: axis(13), surface: "lean_check" });
    const child = await raise({ title: `lean_check timeout on a long proof ${seq}`, embedding: axis(14), surface: "lean_check" });
    await rawQuery(
      `UPDATE agent_reports SET status = 'duplicate', duplicate_of_id = $1, triage_note = 'same timeout' WHERE id = $2`,
      [parent, child]
    );
    const listed = await searchReports(null, { surface: "lean_check" });
    expect(listed.matches.map((m) => m.id)).toEqual(expect.arrayContaining([parent, child]));
    expect(listed.matches.find((m) => m.id === child)).toMatchObject({
      matched_by: "recent",
      duplicate_of_id: parent,
    });
    const onlyDuplicates = await searchReports(null, { surface: "lean_check", status: "duplicate" });
    expect(onlyDuplicates.matches.map((m) => m.id)).toEqual([child]);

    const view = await getReportView(child);
    expect(view!.report.triage_note).toBe("same timeout");
    expect(view!.duplicate_of).toMatchObject({ id: parent, status: "new" });
    const parentView = await getReportView(parent);
    expect(parentView!.duplicates.map((d) => d.id)).toEqual([child]);
    expect(await getReportView(parent, { origin: "external" })).toBeNull();
  });
});

describe("backfillReportEmbeddings on a real database", () => {
  it("embeds title + body of the reports without a vector, so the meaning search sees them", async () => {
    const title = `audit scheduler runs two sweeps in one hour ${seq}`;
    const id = await raise({ title, body: "Observed twice.", embedding: new Error("down") });

    // Oldest first: earlier tests left unembedded rows ahead of this one.
    const pending = await rawQuery<{ n: string }>(
      `SELECT count(*) AS n FROM agent_reports WHERE embedding IS NULL`
    );
    for (let i = 1; i < Number(pending[0]!.n); i++) embedMock.next.push(axis(20));
    embedMock.next.push(axis(12));
    const result = await backfillReportEmbeddings(50);
    expect(result).toEqual({ pending: Number(pending[0]!.n), embedded: Number(pending[0]!.n), failed: 0 });
    const { generateEmbedding } = await import("../../src/services/embedding-service.js");
    expect(generateEmbedding).toHaveBeenCalledWith(`${title}\n\nObserved twice.`);

    const matches = await findNearReports(axis(12), {
      origin: "internal",
      minSimilarity: 0.9,
      limit: 5,
    });
    expect(matches.map((m) => m.id)).toEqual([id]);
    expect(matches[0]!.matched_by).toBe("meaning");

    // Nothing left to do: the next pass reads and embeds nothing.
    const again = await backfillReportEmbeddings(50);
    expect(again).toEqual({ pending: 0, embedded: 0, failed: 0 });
  });
});
