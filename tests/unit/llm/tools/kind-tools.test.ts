import { describe, it, expect } from "vitest";
import {
  KIND_TOOL_NAMES,
  getChangeKindToolDefinition,
  getQuantityToolDefinitions,
  getQuestionToolDefinitions,
  getRequestToolDefinitions,
} from "../../../../src/llm/tools/kind-tools.js";
import { REQUEST_REPORT_TOOL } from "../../../../src/llm/agents/researcher.js";
import { getStewardToolDefinitions } from "../../../../src/llm/tools/steward-tools.js";
import { getCuratorToolDefinitions } from "../../../../src/llm/tools/curator-tools.js";

// The kinds' tool definitions: no name collides with a Steward tool, only the
// Curator retargets requests, and a run that takes up a request must report
// its outcome.

describe("kind tool definitions", () => {
  it("collide with no Steward tool and with each other", () => {
    const names = [
      ...getQuantityToolDefinitions(),
      ...getQuestionToolDefinitions(),
      ...getRequestToolDefinitions("curator"),
      getChangeKindToolDefinition(),
    ].map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...KIND_TOOL_NAMES].sort()).toEqual([...names].sort());
    const steward = new Set(getStewardToolDefinitions().map((t) => t.name));
    expect(names.filter((n) => steward.has(n))).toEqual([]);
  });

  it("let every agent search, page and filter requests by keeper (#764)", () => {
    for (const role of ["claim_steward", "curator"] as const) {
      const list = getRequestToolDefinitions(role).find((t) => t.name === "list_requests")!;
      const props = (list.input_schema as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(props)).toEqual(expect.arrayContaining(["q", "offset", "keeper", "claim_id", "live"]));
      expect(list.description).toContain("Up to 50 per call");
    }
  });

  it("collide with none of the Curator's own tools, which the kind executor would otherwise take", () => {
    const curator = getCuratorToolDefinitions().map((t) => t.name);
    expect(curator.filter((n) => KIND_TOOL_NAMES.has(n))).toEqual([]);
  });

  it("give set_request_targets to the Curator alone", () => {
    expect(getRequestToolDefinitions("claim_steward").map((t) => t.name)).not.toContain("set_request_targets");
    expect(getRequestToolDefinitions("curator").map((t) => t.name)).toContain("set_request_targets");
  });

  it("require a request outcome of a run that takes up a request", () => {
    expect(REQUEST_REPORT_TOOL.input_schema.required).toContain("request_outcome");
    expect(REQUEST_REPORT_TOOL.name).toBe("report");
  });
});
