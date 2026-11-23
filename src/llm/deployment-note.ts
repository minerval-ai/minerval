/**
 * What a caller is told about the deployment it is on, where that is not
 * the public graph (#1120).
 *
 * The Assistant's role, the caller skills and the MCP server's instructions
 * are the same text in every deployment, and they describe public Minerval:
 * the site at minerval.ai, the API at api.claimgraph.io, a graph anyone
 * reads. On a private deployment an agent given only that text answers as
 * if it were there. It tells a member that what they add will be public,
 * gives them the public graph's address to connect to, and says the page
 * where an administrator connects the organization's systems does not
 * exist. This passage is how it learns where it is, the way
 * features-off-note.ts says what is switched off and permissions-note.ts
 * what its user may not do: stated from the configuration, outside the
 * hashed role text, with what differs and why.
 *
 * Three callers are given it: the Assistant, as a section of its system
 * prompt (services/assistant-service.ts); an agent connecting over MCP, in
 * the server's instructions (mcp/server.ts); and whoever reads a caller
 * skill from this deployment, at the head of the skill (mcp/caller-skills.ts).
 *
 * On the public graph there is no note, and nothing anyone is sent changes.
 * "Not the public graph" is read as members-only (`reads = "members"`): a
 * deployment that anyone may read is told nothing here.
 *
 * It names no label. Which label a run works at and who reads it is the
 * label note's to say (label-note.ts), and the name of the layer every
 * member reads is due to change (#1203); what is said here is true before
 * and after: what is added stays inside, and leaves only by a release.
 */
import { loadConfig } from "../config.js";
import { membersOnly } from "../permissions.js";
import { holdsMirror } from "../services/mirrored-node-service.js";

/** What the passage states, each read from the deployment's configuration. */
export interface DeploymentFacts {
  /** Where members open the site (hosting.web_base_url), without a trailing slash. */
  webBase: string;
  /** Where the API answers (hosting.api_base_url), without a trailing slash. Its MCP server is at /mcp under it. */
  apiBase: string;
  /** Whether the deployment keeps a mirror of the public graph. */
  mirror: boolean;
}

/** The start of the passage, by which text that already carries it is known. */
export const DEPLOYMENT_NOTE_HEADING = "## This deployment";

/** This deployment's facts, or null on the public graph, where nothing is said. */
export function deploymentFacts(): DeploymentFacts | null {
  if (!membersOnly()) return null;
  const config = loadConfig();
  return {
    webBase: config.publicWebBaseUrl.replace(/\/+$/, ""),
    apiBase: config.publicApiBaseUrl.replace(/\/+$/, ""),
    mirror: holdsMirror(),
  };
}

/** The passage for a deployment with these facts: "" for null, the public graph. */
export function deploymentNote(facts: DeploymentFacts | null = deploymentFacts()): string {
  if (!facts) return "";
  const mcp = `${facts.apiBase}/mcp`;
  const publicGraph = facts.mirror
    ? `This deployment keeps a copy of the public graph, brought in by a mirror that follows it. A ` +
      `node's full read marks a mirrored node under \`mirrored\`, and \`/admin/outside/mirror\` shows ` +
      `what the copy is as of. Everything else you read here is this deployment's own, and "the ` +
      `public graph" means that copy and never this graph as a whole.`
    : `This deployment keeps no copy of the public graph. Everything you read here is this ` +
      `deployment's own, and a search here does not look at the public graph. \`/admin/outside\` ` +
      `shows the deployment's connection to minerval.ai, where it has one.`;
  return [
    DEPLOYMENT_NOTE_HEADING,
    `This is a private deployment of Minerval: a graph of its own, run by one organization, that ` +
      `serves only its signed-in members. It is not the public graph at minerval.ai. The ` +
      `instructions and skills you are given are the same text in every deployment and are ` +
      `written for the public graph; where they differ from this passage, this passage is what ` +
      `holds here.`,
    `- Who reads it. Only members read this graph. What is added to it (a proposed node, a ` +
      `contribution, a source, a mandate, a conversation with a Grantmaker) stays inside the ` +
      `deployment, open to the members who read the label it is filed at. Nothing reaches the ` +
      `public graph or anyone outside except a page a member releases through the gate to ` +
      `outside (\`/releases\`, \`/gates\`). Where your instructions or a skill call something ` +
      `public, here it is open to those members and to nobody else.`,
    `- Addresses. The site is ${facts.webBase}. The API is ${facts.apiBase} and its MCP server ` +
      `is ${mcp}. Where a skill gives minerval.ai or https://api.claimgraph.io, those are the ` +
      `public graph's and reach the public graph. A member's own agent connects to this ` +
      `deployment at ${mcp}, as a custom connector or with \`claude mcp add --transport http ` +
      `minerval ${mcp}\`, and signs in as a member; the Claude plugin connects to public ` +
      `Minerval unless MINERVAL_MCP_URL is set to that address first. ${facts.webBase}/docs/connect ` +
      `shows each way for this deployment.`,
    `- The organization's own systems. An administrator connects one (a wiki, a warehouse, a ` +
      `ticket system: any MCP server over it) on \`/admin/connections\`: they add the server, ` +
      `choose which of its tools agents are offered, and give the connection a label, so that ` +
      `only runs at labels that read it are offered it. Sets of files for agents to explore are ` +
      `added on \`/file-sets\`. The public graph has neither, because what its agents read ` +
      `becomes public. The using-minerval skill lists every page only a private deployment has.`,
    `- The public graph. ${publicGraph}`,
  ].join("\n\n");
}

/**
 * A caller skill's text as this deployment serves it. On the public graph,
 * the file as it is. On a private deployment a passage stands between the
 * frontmatter and the body, so that a reader of the skill alone still knows
 * which addresses are whose: the whole note, or one line pointing to it for
 * a reader already given the note (`told`, the Assistant).
 */
export function skillTextHere(
  text: string,
  opts: { told?: boolean } = {},
  facts: DeploymentFacts | null = deploymentFacts()
): string {
  if (!facts) return text;
  const passage = opts.told
    ? `> This skill is written for the public graph. You are on a private deployment: its ` +
      `addresses, and what else differs here, are under "This deployment" in your instructions, ` +
      `which hold where this skill says otherwise.`
    : deploymentNote(facts);
  const end = text.startsWith("---\n") ? text.indexOf("\n---\n", 4) : -1;
  if (end === -1) return `${passage}\n\n${text}`;
  const head = text.slice(0, end + "\n---\n".length);
  return `${head}\n${passage}\n${text.slice(head.length)}`;
}
