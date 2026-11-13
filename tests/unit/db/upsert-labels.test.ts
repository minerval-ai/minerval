import { readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

/**
 * An upsert onto a labelled table does not write one label's words into
 * another label's row (sameLabelOnly in src/db/clearance.ts).
 *
 * A table holds one row for each identity whatever the labels, so an upsert
 * by work at one label can land on a row another label wrote. Where the
 * writer reads that row the label policy allows the update, and what the
 * update carries is then read by the row's own readers: a private run's
 * reasoning in a public edge. A review found a private run's words reaching
 * the public issue tracker this way.
 *
 * So every upsert onto a labelled table is here. One that carries text from
 * its writer applies only where the row is at the writer's own label, and
 * tells the writer when it is not. Each of the others is listed with what
 * it writes and why that is no one's words. A failure means an upsert was
 * added or changed: if its DO UPDATE sets anything the run wrote in words,
 * give it sameLabelOnly and writtenAtOwnLabel.
 */
const OTHERWISE: Record<string, string> = {
  "src/services/mirror-feed-service.ts feed_contributions":
    "The public record as the mirror's feed carries it, on a graph that publishes: such a graph has one label, and the row is a copy of public columns of a contribution, which no run at another label can have written.",
  "src/services/mirror-feed-service.ts feed_requests": "As feed_contributions: a copy of a request's public columns, on a graph whose only label is `public`.",
  "src/services/outward-acts-service.ts outward_settings":
    "A standing choice, keyed by its name and always at `public`, written as the tables' owner once the route has checked the person: an on or off, ids and hours, and the fixed text the person was shown.",
  "src/services/report-sending-service.ts actions":
    "The ledger row for the redaction of one report, keyed by the report, which has one label: the update sets a time and nothing else.",
  "src/services/report-sending-service.ts report_sendings":
    "The sending of one report, keyed by the report and written at the report's own label by work at that label: on a conflict it sets the key to itself and nothing else, to return the row that is there.",
  "src/services/action-service.ts actions":
    "The ledger's rows. A row's label never changes, and work at each label has its own key for a subject several labels can work on (groupAtLabel), so the row an upsert lands on is at the writer's own label; the database refuses any other. A finished row that is reopened takes the new work's text and target (LABEL_ON_REOPEN_SQL).",
  "src/services/showing-service.ts actions":
    "The ledger row of a page's redaction, keyed by the page, which has one label: the update reopens a finished row and changes no text.",
  "src/llm/agents/program-officer.ts actions": "A sitting's ledger row, for its mandate, at the mandate's label (LABEL_ON_REOPEN_SQL).",
  "src/services/prize-claim-service.ts actions": "A prize review's ledger row: the update sets a time and nothing else.",
  "src/services/commission-service.ts action_allocations": "Money added to a placement already there: an amount.",
  "src/services/report-service.ts agent_reports":
    "A repeat of a report. The update applies only where the row is at the reporter's own label (its own WHERE says so, with the incoming row's label); a repeat at another label changes nothing on the row and is recorded as a sighting at the reporter's label.",
  "src/services/attempt-service.ts lean_checks":
    "The checker's verdict on one submission, keyed by the submission's hash and the checker's version: the same output whoever asks.",
  "src/services/formalization-service.ts lean_checks": "The checker's verdict on one submission, as above.",
  "src/services/connection-service.ts connection_tools":
    "A tool's definition as its connection's server lists it: the system describing itself, the same whoever looks. It is written at the connection's label, by an administrator's request that works at that label (server/request-labels.ts), onto rows that carry it.",
  "src/services/feed-service.ts lookout_feeds":
    "A feed's settings and the title the feed itself gives, on the lookout's own row for that address.",
  "src/services/session-service.ts agent_sessions": "What a paused session is waiting for, added by that session's own run to its own row.",
  "src/services/inbox-service.ts node_message_reads":
    "That a pass at a label read a message sent at another, and what it answered. The key is the message and the reading label, and the row is written with the pass's own label, so the row it lands on is at the writer's label by its key.",
};

const HELD = "sameLabelOnly";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rel = (path: string) => relative(repo, path).split("\\").join("/");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "migrations" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The labelled tables, by their names in SQL and by the names of their schema objects. */
function labelledTables(): { sql: Set<string>; objects: Set<string> } {
  const schema = readFileSync(join(repo, "src/db/schema.ts"), "utf-8");
  const starts = [...schema.matchAll(/export const (\w+) = pgTable\(\s*"(\w+)"/g)];
  const sql = new Set<string>();
  const objects = new Set<string>();
  starts.forEach((m, i) => {
    const body = schema.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index! : schema.length);
    if (!body.includes("sensitivityLabelColumn()")) return;
    objects.add(m[1]!);
    sql.add(m[2]!);
  });
  return { sql, objects };
}

/** Each upsert in a file onto a labelled table: the table, and whether its update is held to the writer's label. */
export function upserts(text: string, tables: { sql: Set<string>; objects: Set<string> }): Array<{ table: string; held: boolean }> {
  const found: Array<{ table: string; held: boolean }> = [];
  for (const m of text.matchAll(/INSERT INTO\s+"?(\w+)"?[^`]*?ON CONFLICT[^`]*?DO UPDATE\s+SET([^`]*)`/g)) {
    if (tables.sql.has(m[1]!)) found.push({ table: m[1]!, held: m[2]!.includes(`\${${HELD}("${m[1]}")}`) });
  }
  for (const m of text.matchAll(/\.onConflictDoUpdate\(/g)) {
    const inserted = [...text.slice(Math.max(0, m.index! - 900), m.index!).matchAll(/\.insert\((\w+)\)/g)].pop()?.[1];
    if (!inserted || !tables.objects.has(inserted)) continue;
    const call = text.slice(m.index!, m.index! + 900);
    found.push({ table: inserted, held: /setWhere:[^\n]*sensitivityLabel\} = excluded\.sensitivity_label/.test(call) });
  }
  return found;
}

describe("an upsert onto a labelled table", () => {
  const tables = labelledTables();

  it("writes its words only into a row at its writer's own label, or is listed here with why it writes none", () => {
    expect(tables.sql.size).toBe(141);
    const unheld = new Set<string>();
    let held = 0;
    for (const path of sourceFiles(join(repo, "src"))) {
      for (const upsert of upserts(readFileSync(path, "utf-8"), tables)) {
        if (upsert.held) held++;
        else unheld.add(`${rel(path)} ${upsert.table}`);
      }
    }
    expect([...unheld].sort()).toEqual(Object.keys(OTHERWISE).sort());
    // The quantity's definition (three writers), a claim's cut of a
    // quantity, the three question edges, the five rows of a node's source
    // map, and a page's shared analysis.
    expect(held).toBe(13);
  });

  it("never takes a row's label from the incoming row: a ledger row reopened takes the new work's text and target, and keeps its label", () => {
    for (const path of sourceFiles(join(repo, "src"))) {
      const text = readFileSync(path, "utf-8");
      // An assignment, not a comparison of the two rows' labels (which is how an upsert is held to its own label).
      expect(/(?<![.\w])sensitivity_label = (?:CASE[^,]*)?EXCLUDED\.sensitivity_label/.test(text), rel(path)).toBe(false);
    }
    const fragment = /export const LABEL_ON_REOPEN_SQL = `([^`]*)`/.exec(
      readFileSync(join(repo, "src/services/action-service.ts"), "utf-8")
    )![1]!;
    expect(fragment).not.toContain("sensitivity_label");
    for (const column of ["label", "target_ref"]) {
      expect(fragment, column).toMatch(new RegExp(`\\b${column} = CASE\\s+WHEN actions\\.status IN \\$\\{FINISHED_STATUSES_SQL\\} THEN EXCLUDED\\.${column}`));
    }
  });

  it("tells an upsert that is held from one that is not", () => {
    const some = { sql: new Set(["tags"]), objects: new Set(["tags"]) };
    const sqlOf = (tail: string) => "`INSERT INTO tags (a) VALUES ($1) ON CONFLICT (a) DO UPDATE SET b = EXCLUDED.b " + tail + "`";
    expect(upserts(sqlOf(""), some)).toEqual([{ table: "tags", held: false }]);
    expect(upserts(sqlOf('${sameLabelOnly("tags")} RETURNING id'), some)).toEqual([{ table: "tags", held: true }]);
    expect(upserts("`INSERT INTO tags (a) VALUES ($1) ON CONFLICT DO NOTHING`", some)).toEqual([]);
    expect(upserts("`INSERT INTO other (a) VALUES ($1) ON CONFLICT (a) DO UPDATE SET b = 1`", some)).toEqual([]);
  });
});
