import { describe, expect, it } from "vitest";
import { getClaimStewardSystemPromptBlocks } from "../../../src/llm/prompts/claim-steward.js";
import { getConstitution } from "../../../src/llm/prompts/constitution.js";
import { withRunDate } from "../../../src/llm/run-date.js";
import { classifyParts } from "../../../src/services/setup-service.js";
import {
  CONSTITUTION_PLACEHOLDER,
  hashText,
  setupRecord,
  splitSetup as split,
} from "../../../src/services/setup-split.js";

// Split and classify, as the client and the storage do together.
const splitSetup = (input: Parameters<typeof split>[0] & { agent: string }) =>
  classifyParts(split(input), input.agent);

const stewardSystem = () => getClaimStewardSystemPromptBlocks();

describe("splitSetup", () => {
  it("splits a known role's prompt into the constitution and the role, both public", () => {
    const parts = splitSetup({ agent: "steward", system: stewardSystem() });
    const constitution = parts.find((p) => p.kind === "constitution")!;
    const role = parts.find((p) => p.kind === "role")!;
    expect(constitution.public).toBe(true);
    expect(constitution.hash).toBe(hashText(getConstitution()));
    expect(constitution.sourcePath).toBe("admin_constitution.md");
    expect(role.name).toBe("claim-steward");
    expect(role.public).toBe(true);
    expect(role.sourcePath).toBe("src/llm/prompts/claim-steward.ts");
    expect(role.content).toContain(CONSTITUTION_PLACEHOLDER);
    expect(role.content).not.toContain(getConstitution());
  });

  it("gives the same parts whatever the run's date", () => {
    const a = splitSetup({
      agent: "steward",
      system: withRunDate(stewardSystem(), new Date("2026-01-01T00:00:00Z")) as string[],
    });
    const b = splitSetup({
      agent: "steward",
      system: withRunDate(stewardSystem(), new Date("2026-11-09T00:00:00Z")) as string[],
    });
    expect(a.map((p) => p.hash)).toEqual(b.map((p) => p.hash));
    expect(a.map((p) => p.hash)).toEqual(
      splitSetup({ agent: "steward", system: stewardSystem() }).map((p) => p.hash)
    );
  });

  it("names a prompt no known role produces after its agent, and keeps it private", () => {
    const parts = splitSetup({ agent: "steward", system: "You assess claims. Claim 42 is about X." });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ kind: "role", name: "steward", public: false, sourcePath: null });
  });

  it("records each tool as a part, private for now, independent of key order", () => {
    const tool = { name: "lookup", description: "Look it up", input_schema: { type: "object" } };
    const reordered = { input_schema: { type: "object" }, description: "Look it up", name: "lookup" };
    const [a] = splitSetup({ agent: "x", tools: [tool] });
    const [b] = splitSetup({ agent: "x", tools: [reordered] });
    expect(a).toMatchObject({ kind: "tool", name: "lookup", public: false });
    expect(a!.hash).toBe(b!.hash);
  });

  it("records references and settings, not text, in the setup record", () => {
    const parts = split({ system: stewardSystem() });
    const record = setupRecord(parts, { model: "claude-opus-5-5", effort: "high" }, "abc123", "public", [], "anthropic");
    expect(record).toMatchObject({
      commit: "abc123",
      label: "public",
      featuresOff: [],
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "high",
      maxTokens: null,
    });
    expect(JSON.stringify(record).length).toBeLessThan(1000);
    expect(record.parts.map((p) => p.kind)).toEqual(["constitution", "role"]);
  });

  it("records the features that were off for the run, and an empty list when none was", () => {
    const parts = split({ system: stewardSystem() });
    const settings = { model: "claude-opus-5-5" };
    expect(setupRecord(parts, settings, null, "public", [], "anthropic").featuresOff).toEqual([]);
    const off = ["mathematics", "prizes"] as const;
    const record = setupRecord(parts, settings, null, "public", off, "anthropic");
    expect(record.featuresOff).toEqual(["mathematics", "prizes"]);
    // Its own list, not the caller's.
    expect(record.featuresOff).not.toBe(off);
  });

  it("records the provider that served the run, always, beside the label it ran at", () => {
    const parts = split({ system: stewardSystem() });
    const settings = { model: "endpoint:local/meta-llama/Llama-3.3-70B-Instruct" };
    expect(setupRecord(parts, settings, null, "internal", [], "endpoint:local")).toMatchObject({
      label: "internal",
      provider: "endpoint:local",
    });
    // An id that resolved to nothing still leaves the field there.
    expect(setupRecord(parts, settings, null, "public", [], null)).toHaveProperty("provider", null);
  });
});
