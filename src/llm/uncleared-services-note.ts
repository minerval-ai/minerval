/**
 * What a run is not offered, and is told, when an outside service is not
 * cleared for the label it works at (src/provider-labels.ts).
 *
 * This is the features-off note's twin (features-off-note.ts). The role
 * prompts and skills are the same text in every deployment and speak of
 * web_search, read_page and the rest as tools the agent has. At a label a
 * service is not cleared for, its tools would send the run's text where the
 * deployment's owner has not allowed it, so they are taken out of the
 * toolset, and one passage at the head of the run's first task message says
 * which and why. It states the fact and its reason; what to make of it is
 * the agent's judgment. It does not name the label.
 *
 * Both happen in the LLM client (client.ts), so no agent's own code has to
 * know: every toolset passes through withoutUnclearedTools on its way to a
 * model, and every agent run's first message through unclearedServicesNote.
 * The service's own seam refuses the call as well
 * (provider-clearance.ts), so a tool this list misses still sends nothing.
 *
 * On the public graph every service is cleared for `public`, which is the
 * only label there: no tool is withheld and there is no passage.
 */
import { loadConfig } from "../config.js";
import { OUTSIDE_SERVICES, type OutsideServiceName, type ProviderLabelsConfig } from "../provider-labels.js";
import { providerClearedHere } from "./provider-clearance.js";
import { anthropicServerWebSearch, WEB_SEARCH_TOOL_NAME } from "./tools/web-search-tool.js";

/**
 * The tools that exist to reach the open web and do nothing else, by name:
 * read_page (tools/read-page-tool.ts), the figure tools
 * (tools/figure-tools.ts), the feed reader's read_listing
 * (tools/feed-tools.ts), and the Lookout's two Crossref lookups
 * (agents/lookout.ts). A tool that reaches the web as part of something
 * else (add_feed, read_item) stays, and says so when the fetch is refused.
 */
const WEB_PAGE_TOOLS: ReadonlySet<string> = new Set([
  "read_page",
  "view_image",
  "read_arxiv_source",
  "read_listing",
  "check_doi",
  "recent_retractions",
]);

/**
 * The outside service a tool sends text to, or null for a tool that sends
 * none. A web_search with no input schema is the model provider's server
 * tool, which that provider's clearance covers; the one the loop runs
 * itself goes to the `web_search` service.
 */
export function toolService(tool: object): OutsideServiceName | null {
  const name = (tool as { name?: unknown }).name;
  if (typeof name !== "string") return null;
  if (name === WEB_SEARCH_TOOL_NAME) return "input_schema" in tool ? "web_search" : null;
  if (WEB_PAGE_TOOLS.has(name)) return "web_pages";
  if (name.startsWith("elicit_")) return "elicit";
  if (name.startsWith("pangram_")) return "pangram";
  return null;
}

/**
 * `tools` without those of a service that is not cleared for the label this
 * run works at. The same array when none is withheld.
 */
export function withoutUnclearedTools<T extends object>(tools: T[], config?: ProviderLabelsConfig): T[] {
  const kept = tools.filter((tool) => {
    const service = toolService(tool);
    return service === null || providerClearedHere(service, config);
  });
  return kept.length === tools.length ? tools : kept;
}

/** The part of the config that says whether a keyed service is set up at all. */
interface ServiceKeysConfig {
  elicitApiKey?: string;
  pangramApiKey?: string;
}

/**
 * The services a run on `model` is told about: those not cleared for its
 * label that it would otherwise have had. Web search is left out for a
 * model whose provider searches inside the turn, and Elicit and Pangram
 * where the deployment has no key for them, since their tools were never
 * going to be offered.
 */
export function unclearedServices(
  model: string,
  config: ProviderLabelsConfig & ServiceKeysConfig = loadConfig()
): OutsideServiceName[] {
  return OUTSIDE_SERVICES.map((s) => s.name).filter((name) => {
    if (providerClearedHere(name, config)) return false;
    if (name === "web_search") return !anthropicServerWebSearch(model);
    if (name === "elicit") return (config?.elicitApiKey ?? "").length > 0;
    if (name === "pangram") return (config?.pangramApiKey ?? "").length > 0;
    return true;
  });
}

/**
 * The passage for a run on `model` at the label it works at: "" when every
 * service it would have is cleared. Each service is named by its
 * `agentPhrase`, in the list's order. Embeddings have no tool of their own
 * to withhold; what a run loses is search by meaning, said in a sentence of
 * its own.
 */
export function unclearedServicesNote(model: string, config?: ProviderLabelsConfig & ServiceKeysConfig): string {
  const uncleared = new Set<string>(unclearedServices(model, config));
  if (uncleared.size === 0) return "";
  const phrases = OUTSIDE_SERVICES.filter((s) => uncleared.has(s.name) && s.agentPhrase !== null).map(
    (s) => s.agentPhrase
  );
  const sentences: string[] = [];
  if (phrases.length === 1) {
    sentences.push(
      `This deployment has not cleared one outside service to receive the material this run ` +
        `works with: ${phrases[0]}. Its tools are not offered to you, so what your instructions ` +
        `and skills say about using it does not apply here.`
    );
  } else if (phrases.length > 1) {
    sentences.push(
      `This deployment has not cleared some outside services to receive the material this run ` +
        `works with: ${phrases.join("; ")}. Their tools are not offered to you, so what your ` +
        `instructions and skills say about using them does not apply here.`
    );
  }
  if (uncleared.has("embeddings")) {
    sentences.push(
      (phrases.length > 0
        ? `The service that search by meaning relies on is not cleared for it either, `
        : `This deployment has not cleared the service that search by meaning relies on to ` +
          `receive the material this run works with, `) +
        `so a search of the graph matches on keywords where it can and returns an error where it cannot.`
    );
  }
  return `${sentences.join(" ")} The rest of your instructions hold as written.`;
}
