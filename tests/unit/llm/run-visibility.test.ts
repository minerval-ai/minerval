import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AGENT_INPUTS,
  TOOL_READS,
  agentPrivateReason,
  toolPrivateReason,
} from "../../../src/llm/run-visibility.js";

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
    const missing = [...definedAgents()].filter((a) => !(a in AGENT_INPUTS) && a !== "extension");
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
});
