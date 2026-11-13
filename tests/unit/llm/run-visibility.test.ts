import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AGENT_INPUTS,
  TOOL_READS,
  REASONS_A_LABEL_COVERS,
  REDACTION_CHECK_REASON,
  agentPrivateReason,
  labelCoversReason,
  toolPrivateReason,
} from "../../../src/llm/run-visibility.js";
import { RESEARCH_REPORT_REASON } from "../../../src/services/session-service.js";

const ROOT = join(__dirname, "../../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/**
 * Every agent tool defined in the code: a `name: "…"` whose object carries an
 * input schema before the next name. The MCP server and the provider dialects
 * define tools for callers and for the wire, not for the graph's own agents.
 */
function definedTools(): Map<string, string> {
  const found = new Map<string, string>();
  const dirs = ["src/llm/tools", "src/llm/agents", "src/services"].map((d) => join(ROOT, d));
  // A tool's name may be a constant (name: WAIT_FOR_ANSWERS): resolve every
  // `const NAME = "snake_case"` in the source so those are found too.
  const constants = new Map<string, string>();
  for (const file of files(join(ROOT, "src"))) {
    for (const m of readFileSync(file, "utf8").matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*"([a-z_][a-z0-9_]*)"/g)) {
      constants.set(m[1]!, m[2]!);
    }
  }
  for (const file of dirs.flatMap(files)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/name:\s*(?:"([a-z_][a-z0-9_]*)"|([A-Z][A-Z0-9_]*)\b)/g)) {
      const name = m[1] ?? constants.get(m[2]!);
      if (!name) continue;
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 6000);
      const next = after.search(/name:\s*["A-Z]/);
      const own = next === -1 ? after : after.slice(0, next);
      if (/input_schema|inputSchema/.test(own)) found.set(name, relative(ROOT, file));
    }
  }
  // Skill tools are declared in each skill's tools.json.
  for (const dir of readdirSync(join(ROOT, "skills"))) {
    const path = join(ROOT, "skills", dir, "tools.json");
    try {
      const tools = JSON.parse(readFileSync(path, "utf8")) as Array<{ name: string }>;
      for (const t of tools) found.set(t.name, relative(ROOT, path));
    } catch {
      // A skill without tools.
    }
  }
  return found;
}

/** withAgent("…") names: every agent that opens a run. */
function definedAgents(): Set<string> {
  const agents = new Set<string>();
  for (const file of files(join(ROOT, "src"))) {
    // The agent argument may be a literal or a choice between literals
    // (program-officer.ts); every literal before the first comma counts.
    for (const m of readFileSync(file, "utf8").matchAll(/withAgent\(([^,]*),/g)) {
      // Literals compared against (role === "officer") are not agent names.
      for (const lit of m[1]!.matchAll(/(?<!===?\s*)"([a-z_]+)"/g)) agents.add(lit[1]!);
    }
  }
  return agents;
}

describe("run visibility", () => {
  it("classifies every tool defined in the code", () => {
    const missing = [...definedTools()]
      .filter(([name]) => !(name in TOOL_READS))
      .map(([name, file]) => `${name} (${file})`);
    expect(missing, "add each to TOOL_READS in src/llm/run-visibility.ts").toEqual([]);
  });

  it("classifies every agent that opens a run", () => {
    const missing = [...definedAgents()].filter((a) => !(a in AGENT_INPUTS));
    expect(missing, "add each to AGENT_INPUTS in src/llm/run-visibility.ts").toEqual([]);
  });

  it("gives every classification a reason", () => {
    for (const [name, c] of [...Object.entries(TOOL_READS), ...Object.entries(AGENT_INPUTS)]) {
      expect(c.why.trim().length, name).toBeGreaterThan(0);
    }
  });

  it("makes unclassified tools and agents private", () => {
    expect(toolPrivateReason("no_such_tool")).toBe("tool:no_such_tool:unclassified");
    expect(agentPrivateReason("no_such_agent")).toBe("agent:no_such_agent:unclassified");
  });

  // In a members-only deployment a member who reads a run's label reads a
  // run whose every private reason that label covers (run-view-service.ts).
  describe("the reasons a label covers", () => {
    it("are private reasons that exist, each with why", () => {
      for (const [reason, why] of Object.entries(REASONS_A_LABEL_COVERS)) {
        expect(why.trim().length, reason).toBeGreaterThan(0);
        const [kind, name] = reason.split(":") as [string, string];
        if (kind === "tool") expect(TOOL_READS[name]?.reads, reason).toBe("private");
        else if (kind === "agent") expect(AGENT_INPUTS[name]?.reads, reason).toBe("private");
        else expect([REDACTION_CHECK_REASON, RESEARCH_REPORT_REASON], reason).toContain(reason);
      }
    });

    it("are the organization's material at the run's label, and nothing that is a person's, a funder's or the operator's", () => {
      expect(Object.keys(REASONS_A_LABEL_COVERS).sort()).toEqual([
        "agent:redactor",
        "input:redaction-check",
        "input:research-report",
        "tool:cannot_cross",
        "tool:finish_redaction",
        "tool:get_page_to_redact",
        "tool:get_redaction_policies",
        "tool:get_redaction_policy",
        "tool:get_redaction_to_check",
        "tool:keep_analysis",
        "tool:keep_file",
        "tool:keep_reading",
        "tool:notebook_read",
        "tool:notebook_write",
        "tool:open_output",
        "tool:open_reading",
        "tool:record_fidelity_outcome",
        "tool:redact",
        "tool:restore",
        "tool:run_command",
      ]);
      const all = ["tool:warehouse__run_query"];
      expect(labelCoversReason("tool:warehouse__run_query", all)).toBe(true);
      for (const reason of [
        "agent:assistant", "agent:grantmaker", "agent:program_officer", "agent:math_solver", "agent:extension",
        "tool:raise_issue", "tool:get_issue", "tool:get_research_run", "tool:get_report_to_redact", "tool:cost_sheet",
        "tool:get_contributor_profile", "tool:get_prize_claim", "tool:delegate", "tool:grant_overview",
        "input:grantmaker-brief", "input:audit-brief", "input:lookout-poke-note", "input:readers-own-content",
        "tool:no_such_tool:unclassified", "agent:no_such_agent:unclassified",
      ]) {
        expect(labelCoversReason(reason, [reason]), reason).toBe(false);
      }
    });

    it("cover an Audit run only where it says its context was a page to check", () => {
      expect(labelCoversReason("agent:audit", ["agent:audit"])).toBe(false);
      expect(labelCoversReason("agent:audit", ["agent:audit", REDACTION_CHECK_REASON])).toBe(true);
    });
  });
});
