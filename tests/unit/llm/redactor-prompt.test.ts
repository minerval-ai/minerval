/**
 * What the Redactor is told (src/llm/prompts/redactor.ts,
 * src/llm/agents/redactor.ts), where the first run with real models showed
 * the wording itself led it wrong.
 */
import { describe, expect, it } from "vitest";
import { getRedactorSystemPrompt } from "../../../src/llm/prompts/redactor.js";
import { redactorTaskMessage } from "../../../src/llm/agents/redactor.js";
import { getRedactorToolDefinitions } from "../../../src/llm/tools/redactor-tools.js";

describe("the Redactor's prompt", () => {
  const prompt = getRedactorSystemPrompt();
  const role = prompt.slice(prompt.indexOf("# Your Role: Redactor"));

  it("keeps a supplier's name and the words of an interest out of what is always shown", () => {
    // Inside the always-shown paragraph, "A supplier's name ... a part of the
    // page like any other" was read as making those words unremovable, and the
    // Redactor held whole pages over them.
    const alwaysShown = role.slice(role.indexOf("Some things are shown whenever"), role.indexOf("A supplier's name"));
    expect(alwaysShown).toContain("get_page_to_redact gives them\nunder always_shown");
    expect(alwaysShown).not.toMatch(/supplier's name|words of/);
    expect(role).toContain(
      "A supplier's name, the words of a recorded interest and the words of a\ngap are not among these. They are parts, and you remove from them as from\nany part."
    );
  });
});

describe("the Redactor's task", () => {
  it("says the policy protects what the readers on the other side do not already have, and offers the look at what they hold", () => {
    // In the first run the Redactor removed the destination's own file names and a published figure it already read.
    for (const round of [1, 2]) {
      expect(redactorTaskMessage({ round })).toContain(
        "The policy protects what those readers do not already have: look_at_destination shows what is already where they read."
      );
    }
    expect(getRedactorToolDefinitions().map((t) => t.name)).toContain("look_at_destination");
  });
});
