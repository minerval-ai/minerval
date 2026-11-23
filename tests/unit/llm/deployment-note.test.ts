/**
 * What a caller is told of a private deployment (#1120): nothing on the
 * public graph, and on a private one its own addresses, who reads it, and
 * where its administrators connect the organization's systems.
 */
import { describe, it, expect } from "vitest";
import {
  DEPLOYMENT_NOTE_HEADING,
  deploymentNote,
  skillTextHere,
  type DeploymentFacts,
} from "../../../src/llm/deployment-note.js";
import { getAssistantContext, webSection, WEB_SECTION } from "../../../src/llm/prompts/assistant.js";
import { getCallerSkill } from "../../../src/mcp/caller-skills.js";

const facts: DeploymentFacts = {
  webBase: "https://graph.example.org",
  apiBase: "https://graph-api.example.org",
  mirror: false,
};

describe("the deployment note", () => {
  it("says nothing on the public graph", () => {
    expect(deploymentNote(null)).toBe("");
  });

  it("gives a private deployment its own addresses, and names the public graph's as not its own", () => {
    const note = deploymentNote(facts);
    expect(note.startsWith(DEPLOYMENT_NOTE_HEADING)).toBe(true);
    expect(note).toContain("The site is https://graph.example.org.");
    expect(note).toContain("its MCP server is https://graph-api.example.org/mcp");
    expect(note).toContain("claude mcp add --transport http minerval https://graph-api.example.org/mcp");
    // The public address appears once, as the one that is not this deployment's.
    expect(note.match(/api\.claimgraph\.io/g)).toHaveLength(1);
    expect(note).toMatch(/https:\/\/api\.claimgraph\.io, those are the public graph's/);
  });

  it("says what is added stays inside, and where an administrator connects a system", () => {
    const note = deploymentNote(facts);
    expect(note).toMatch(/It is not the public graph at minerval\.ai/);
    expect(note).toMatch(/stays inside the deployment/);
    expect(note).toMatch(/An administrator connects one .* on `\/admin\/connections`/s);
    expect(note).toMatch(/give the connection a label/);
  });

  it("names no label, so that it holds whatever the members' layer is called (#1203)", () => {
    for (const mirror of [false, true]) {
      expect(deploymentNote({ ...facts, mirror })).not.toMatch(/`(public|members|published)`/);
    }
  });

  it("says whether the public graph is held here", () => {
    expect(deploymentNote(facts)).toMatch(/keeps no copy of the public graph/);
    const mirrored = deploymentNote({ ...facts, mirror: true });
    expect(mirrored).toMatch(/keeps a copy of the public graph/);
    expect(mirrored).toMatch(/never this graph as a whole/);
  });
});

describe("a caller skill served by a private deployment", () => {
  const skill = getCallerSkill("using-minerval")!.text;

  it("is the file as it is on the public graph", () => {
    expect(skillTextHere(skill, {}, null)).toBe(skill);
  });

  it("carries the note between its frontmatter and its body", () => {
    const served = skillTextHere(skill, {}, facts);
    expect(served.startsWith("---\nname: using-minerval\n")).toBe(true);
    expect(served.indexOf(DEPLOYMENT_NOTE_HEADING)).toBeLessThan(served.indexOf("# Using Minerval"));
    expect(served).toContain("https://graph-api.example.org/mcp");
    expect(served.endsWith(skill.slice(skill.indexOf("# Using Minerval")))).toBe(true);
  });

  it("points a reader already told to its instructions, without repeating the note", () => {
    const served = skillTextHere(skill, { told: true }, facts);
    expect(served).not.toContain(DEPLOYMENT_NOTE_HEADING);
    expect(served).toMatch(/You are on a private deployment/);
  });

  it("says in its own text that its addresses are public Minerval's", () => {
    expect(skill).toMatch(/## Which Minerval/);
    expect(skill).toMatch(/MINERVAL_MCP_URL/);
  });
});

describe("the Assistant on a private deployment", () => {
  it("is told the site it is on by that site's name", () => {
    expect(WEB_SECTION).toContain("On minerval.ai.");
    const here = webSection("graph.example.org");
    expect(here).toContain("On graph.example.org.");
    expect(here).not.toContain("minerval.ai");
  });

  const context = (label?: string) =>
    getAssistantContext({
      openedFrom: "the Ask page",
      model: "a model",
      balanceMicroUsd: 0,
      conversationMicroUsd: 0,
      allowedKinds: [],
      waiting: [],
      decided: [],
      maxTurns: 10,
      ...(label ? { label } : {}),
    });

  it("is told that the label called public is the members' layer and not the public graph", () => {
    expect(context("public")).toMatch(/It is not the public graph\./);
    expect(context("sensitive")).not.toMatch(/It is not the public graph\./);
    expect(context()).not.toMatch(/It is not the public graph\./);
  });
});
