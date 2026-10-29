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

  it("give set_request_targets to the Curator alone", () => {
    expect(getRequestToolDefinitions("claim_steward").map((t) => t.name)).not.toContain("set_request_targets");
    expect(getRequestToolDefinitions("curator").map((t) => t.name)).toContain("set_request_targets");
  });

  it("require a request outcome of a run that takes up a request", () => {
    expect(REQUEST_REPORT_TOOL.input_schema.required).toContain("request_outcome");
    expect(REQUEST_REPORT_TOOL.name).toBe("report");
  });
});
