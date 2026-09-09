/**
 * Build a human-readable report of the claim graph produced by a corpus run.
 *
 * The report is a legibility surface, not a scorecard: it lays out what got
 * extracted, what collapsed into what, the decomposition structure, and a set
 * of neutral "worth a look" flags — organized so it can be read straight down
 * alongside corpus/RUBRIC.md (sections cite the rubric dimension they serve).
 *
 * Usage:  tsx scripts/corpus/report.ts [cluster]
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertCorpusDb, RUNS_ROOT } from "./lib.js";
import { closeDb, rawQuery } from "../../src/db/client.js";

const NEAR_DUP_THRESHOLD = 0.9; // cosine ≥ this but unmerged ⇒ fragmentation candidate
const TREE_MAX_DEPTH = 4;
const TREE_MAX_LINES = 50;

function cell(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}
function trunc(s: unknown, n: number): string {
  const t = cell(s);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export async function generateReport(cluster: string, outDir?: string): Promise<string> {
  assertCorpusDb(); // never report off (or connect to) the main graph
  const out: string[] = [];
  const w = (line = "") => out.push(line);

  // --- gather ---------------------------------------------------------------
  const [sourceCount] = await rawQuery<{ n: number }>(`SELECT count(*)::int n FROM sources`);
  const [instanceCount] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int n FROM claim_instances`
  );
  const [claimCount] = await rawQuery<{ n: number }>(`SELECT count(*)::int n FROM claims`);
  const [topLevelCount] = await rawQuery<{ n: number }>(
    `SELECT count(DISTINCT claim_id)::int n FROM claim_instances`
  );
  const byCreatedBy = await rawQuery<{ created_by: string; n: number }>(
    `SELECT created_by, count(*)::int n FROM claims GROUP BY 1 ORDER BY 2 DESC`
  );
  const byStatus = await rawQuery<{ decomposition_status: string; n: number }>(
    `SELECT decomposition_status, count(*)::int n FROM claims GROUP BY 1 ORDER BY 2 DESC`
  );
  const byType = await rawQuery<{ claim_type: string; n: number }>(
    `SELECT claim_type, count(*)::int n FROM claims GROUP BY 1 ORDER BY 2 DESC`
  );
  const byRelation = await rawQuery<{ relation_type: string; n: number }>(
    `SELECT relation_type, count(*)::int n FROM claim_relationships GROUP BY 1 ORDER BY 2 DESC`
  );
  const byAssessment = await rawQuery<{ status: string; n: number }>(
    `SELECT status, count(*)::int n FROM assessments WHERE is_current GROUP BY 1 ORDER BY 2 DESC`
  );
  const [argCount] = await rawQuery<{ n: number }>(`SELECT count(*)::int n FROM arguments`);
  const [relCount] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int n FROM claim_relationships`
  );

  const perSource = await rawQuery<{
    title: string;
    instances: number;
    distinct_claims: number;
  }>(
    `SELECT s.title,
       count(ci.id)::int AS instances,
       count(DISTINCT ci.claim_id)::int AS distinct_claims
     FROM sources s LEFT JOIN claim_instances ci ON ci.source_id = s.id
     GROUP BY s.id, s.title ORDER BY s.retrieved_at`
  );

  const canonical = await rawQuery<{
    id: string;
    text: string;
    claim_type: string;
    created_by: string;
    instance_count: number;
    source_count: number;
    assessment_status: string | null;
  }>(
    `SELECT c.id, c.text, c.claim_type, c.created_by,
       count(ci.id)::int AS instance_count,
       count(DISTINCT ci.source_id)::int AS source_count,
       a.status AS assessment_status
     FROM claims c
     JOIN claim_instances ci ON ci.claim_id = c.id
     LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current
     GROUP BY c.id, a.status
     ORDER BY instance_count DESC, source_count DESC, c.text`
  );

  const instanceRows = await rawQuery<{
    claim_id: string;
    source_title: string;
    verbatim_text: string;
  }>(
    `SELECT ci.claim_id, s.title AS source_title, ci.verbatim_text
     FROM claim_instances ci JOIN sources s ON s.id = ci.source_id
     ORDER BY ci.claim_id, s.title`
  );
  const instancesByClaim = new Map<string, Array<{ source_title: string; verbatim_text: string }>>();
  for (const r of instanceRows) {
    const list = instancesByClaim.get(r.claim_id) ?? [];
    list.push({ source_title: r.source_title, verbatim_text: r.verbatim_text });
    instancesByClaim.set(r.claim_id, list);
  }

  const nearDups = await rawQuery<{
    a_text: string;
    b_text: string;
    sim: number;
  }>(
    `SELECT a.text AS a_text, b.text AS b_text,
       round((1 - (a.embedding <=> b.embedding))::numeric, 4) AS sim
     FROM claims a JOIN claims b ON a.id < b.id
     WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
       AND (1 - (a.embedding <=> b.embedding)) >= $1
     ORDER BY sim DESC LIMIT 200`,
    [NEAR_DUP_THRESHOLD]
  );

  const shared = await rawQuery<{ id: string; text: string; parents: number }>(
    `SELECT c.id, c.text, count(DISTINCT cr.parent_claim_id)::int AS parents
     FROM claims c JOIN claim_relationships cr ON cr.child_claim_id = c.id
     GROUP BY c.id, c.text HAVING count(DISTINCT cr.parent_claim_id) > 1
     ORDER BY parents DESC, c.text`
  );
  const sharedIds = new Set(shared.map((s) => s.id));

  const unassessed = await rawQuery<{ text: string }>(
    `SELECT c.text
     FROM claims c JOIN claim_instances ci ON ci.claim_id = c.id
     LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current
     WHERE a.id IS NULL GROUP BY c.id, c.text ORDER BY c.text`
  );

  const args = await rawQuery<{ name: string | null; stance: string; claim_text: string }>(
    `SELECT ar.name, ar.stance, c.text AS claim_text
     FROM arguments ar JOIN claims c ON c.id = ar.claim_id
     ORDER BY c.text, ar.stance`
  );

  // adjacency for trees
  const edges = await rawQuery<{ parent: string; child: string; rel: string }>(
    `SELECT parent_claim_id AS parent, child_claim_id AS child, relation_type AS rel
     FROM claim_relationships`
  );
  const claimText = new Map<string, string>();
  for (const c of await rawQuery<{ id: string; text: string }>(`SELECT id, text FROM claims`)) {
    claimText.set(c.id, c.text);
  }
  const childrenOf = new Map<string, Array<{ child: string; rel: string }>>();
  for (const e of edges) {
    const list = childrenOf.get(e.parent) ?? [];
    list.push({ child: e.child, rel: e.rel });
    childrenOf.set(e.parent, list);
  }

  // --- render ---------------------------------------------------------------
  const now = new Date().toISOString();
  const dedupRatio =
    topLevelCount!.n > 0 ? (instanceCount!.n / topLevelCount!.n).toFixed(2) : "n/a";

  w(`# Corpus run report — ${cluster}`);
  w();
  w(`_generated ${now} · database \`${new URL(process.env.DATABASE_URL!).pathname.slice(1)}\`_`);
  w();
  w(`Read this alongside [\`corpus/RUBRIC.md\`](../../corpus/RUBRIC.md). Each section notes the`);
  w(`rubric dimension it serves. Nothing here is a verdict — it's organized raw material for`);
  w(`your judgment. Log anything that looks wrong in the rubric's Field Notes (section I).`);
  w();

  w(`## 1. Counts — rubric A, C, E`);
  w();
  w(`| metric | value |`);
  w(`|---|---|`);
  w(`| sources ingested | ${sourceCount!.n} |`);
  w(`| claims (total) | ${claimCount!.n} |`);
  w(`| &nbsp;&nbsp;by creator | ${byCreatedBy.map((r) => `${r.created_by} ${r.n}`).join(", ")} |`);
  w(`| top-level claims (≥1 instance) | ${topLevelCount!.n} |`);
  w(`| instances (extracted mentions) | ${instanceCount!.n} |`);
  w(`| **dedup ratio** (instances ÷ top-level claims) | **${dedupRatio}** |`);
  w(`| relationships | ${relCount!.n} (${byRelation.map((r) => `${r.relation_type} ${r.n}`).join(", ")}) |`);
  w(`| arguments | ${argCount!.n} |`);
  w(`| decomposition status | ${byStatus.map((r) => `${r.decomposition_status} ${r.n}`).join(", ")} |`);
  w(`| claim types | ${byType.map((r) => `${r.claim_type} ${r.n}`).join(", ")} |`);
  w(`| current assessments | ${byAssessment.map((r) => `${r.status} ${r.n}`).join(", ") || "none"} |`);
  w();
  w(`> A dedup ratio near 1.0 means almost nothing collapsed across posts (possible`);
  w(`> fragmentation, rubric C); a very high ratio on few claims may signal over-merging.`);
  w();

  w(`## 2. Per-source — rubric A`);
  w();
  w(`| source | instances | distinct claims |`);
  w(`|---|--:|--:|`);
  for (const s of perSource) w(`| ${trunc(s.title, 70)} | ${s.instances} | ${s.distinct_claims} |`);
  w();

  w(`## 3. Canonical claims and what collapsed into them — rubric B, C`);
  w();
  w(`Every top-level claim with its instances. This is the core disambiguation view:`);
  w(`read the instances under each claim and ask whether they are really the same`);
  w(`proposition (good merge) or were wrongly fused (over-merge). Multi-source claims`);
  w(`are where cross-document canonicalization actually happened.`);
  w();
  for (const c of canonical) {
    const flags = c.source_count > 1 ? ` · **${c.source_count} sources**` : "";
    w(
      `### ${c.instance_count}× — ${trunc(c.text, 200)}`
    );
    w(
      `_${c.claim_type} · ${c.assessment_status ?? "unassessed"} · created_by ${c.created_by}${flags}_`
    );
    for (const inst of instancesByClaim.get(c.id) ?? []) {
      w(`- _${trunc(inst.source_title, 40)}_: "${trunc(inst.verbatim_text, 220)}"`);
    }
    w();
  }

  w(`## 4. Near-duplicate canonical pairs left unmerged — rubric C`);
  w();
  w(`Distinct claims whose embeddings are ≥ ${NEAR_DUP_THRESHOLD} cosine but were NOT merged.`);
  w(`Each is a fragmentation candidate (should they be one claim?) — or a legitimately`);
  w(`distinct pair the matcher correctly kept apart. Judge per row.`);
  w();
  if (nearDups.length === 0) {
    w(`_None at ≥ ${NEAR_DUP_THRESHOLD}._`);
  } else {
    w(`| sim | claim A | claim B |`);
    w(`|--:|---|---|`);
    for (const d of nearDups) w(`| ${d.sim} | ${trunc(d.a_text, 90)} | ${trunc(d.b_text, 90)} |`);
  }
  w();

  w(`## 5. Shared subclaims (cross-parent structure) — rubric D, E`);
  w();
  w(`Subclaims with more than one parent — the structural overlap that lets the graph`);
  w(`scale. Few or none, despite heavy topical overlap, is the main "not scaling" signal.`);
  w();
  if (shared.length === 0) {
    w(`_No subclaim has more than one parent._`);
  } else {
    w(`| parents | subclaim |`);
    w(`|--:|---|`);
    for (const s of shared) w(`| ${s.parents} | ${trunc(s.text, 110)} |`);
  }
  w();

  w(`## 6. Decomposition trees — rubric D`);
  w();
  w(`Each top-level claim's decomposition (depth ≤ ${TREE_MAX_DEPTH}, ≤ ${TREE_MAX_LINES} lines each).`);
  w(`\`[shared]\` marks a subclaim reused by another parent. Watch for shallow trees that`);
  w(`stop before bedrock, filler subclaims, and evaluation leaking into decomposition.`);
  w();
  for (const c of canonical) {
    w(`<details><summary>${trunc(c.text, 140)}</summary>`);
    w();
    w("```");
    const lines: string[] = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number) => {
      if (lines.length >= TREE_MAX_LINES) return;
      if (depth > TREE_MAX_DEPTH) return;
      for (const e of childrenOf.get(id) ?? []) {
        if (lines.length >= TREE_MAX_LINES) {
          lines.push(`${"  ".repeat(depth)}… (truncated)`);
          return;
        }
        const sharedTag = sharedIds.has(e.child) ? " [shared]" : "";
        const cyc = seen.has(e.child) ? " ↩" : "";
        lines.push(
          `${"  ".repeat(depth)}—${e.rel}→ ${trunc(claimText.get(e.child), 110)}${sharedTag}${cyc}`
        );
        if (!seen.has(e.child)) {
          seen.add(e.child);
          walk(e.child, depth + 1);
        }
      }
    };
    walk(c.id, 0);
    if (lines.length === 0) lines.push("(atomic — no decomposition)");
    for (const l of lines) w(l);
    w("```");
    w();
    w(`</details>`);
    w();
  }

  w(`## 7. Assessment — rubric F`);
  w();
  w(`Status distribution: ${byAssessment.map((r) => `${r.status} ${r.n}`).join(", ") || "none"}.`);
  w();
  if (unassessed.length > 0) {
    w(`Top-level claims with **no current assessment** (${unassessed.length}) — note the`);
    w(`pipeline swallows assessment errors silently, so these may be failures, not skips:`);
    w();
    for (const u of unassessed.slice(0, 50)) w(`- ${trunc(u.text, 160)}`);
    if (unassessed.length > 50) w(`- … and ${unassessed.length - 50} more`);
    w();
  }

  w(`## 8. Arguments — rubric D`);
  w();
  if (args.length === 0) {
    w(`_No named arguments were created (everything used the default/unnamed grouping)._`);
  } else {
    w(`| stance | argument | on claim |`);
    w(`|---|---|---|`);
    for (const a of args) w(`| ${a.stance} | ${trunc(a.name ?? "(unnamed)", 40)} | ${trunc(a.claim_text, 80)} |`);
  }
  w();

  w(`## 9. Field notes`);
  w();
  w(`Record anything that looks wrong — even if it fits none of A–H — in the Field Notes`);
  w(`section of [\`corpus/RUBRIC.md\`](../../corpus/RUBRIC.md). When a behavior recurs across`);
  w(`runs, promote it to a named failure mode there.`);
  w();

  // --- write ----------------------------------------------------------------
  const stamp = now.replace(/[:.]/g, "-");
  const dir = outDir ?? join(RUNS_ROOT, `${cluster}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, "report.md");
  writeFileSync(reportPath, out.join("\n"));

  // machine-readable dump for deeper offline inspection
  writeFileSync(
    join(dir, "graph.json"),
    JSON.stringify(
      {
        generatedAt: now,
        cluster,
        counts: {
          sources: sourceCount!.n,
          claims: claimCount!.n,
          topLevelClaims: topLevelCount!.n,
          instances: instanceCount!.n,
          relationships: relCount!.n,
          arguments: argCount!.n,
          dedupRatio,
        },
        canonical,
        instancesByClaim: Object.fromEntries(instancesByClaim),
        nearDuplicatePairs: nearDups,
        sharedSubclaims: shared,
        edges,
        arguments: args,
      },
      null,
      2
    )
  );

  return reportPath;
}

// Run directly.
if ((process.argv[1] ?? "").endsWith("report.ts")) {
  const cluster = process.argv.slice(2).filter((a) => !a.startsWith("--"))[0] ?? "lethalities";
  generateReport(cluster)
    .then(async (p) => {
      console.log(`Report: ${p}`);
      await closeDb();
    })
    .catch(async (err) => {
      console.error(err);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
