// The MCP tool catalog on /docs/tools (#docs): the server's own tools/list,
// grouped by what a caller is trying to do, each with what it costs and the
// REST route it runs. Nothing here is written by hand per tool: the cost class
// comes from the notes the server itself puts in each description
// (src/mcp/route-tools.ts SPENDS_OWLS and ESCROWS_OWLS, and the native tools'
// "Runs a model" line), and the route from the "Same operation as" line every
// generated tool ends with. tests/unit/web/tool-catalog.test.ts holds every
// tool the server registers to a group.

export type ToolCost = "read" | "write" | "charged" | "escrow";

export interface ListedTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

export interface CatalogTool {
  name: string;
  /** The description's first sentence (a generated tool's route summary). */
  summary: string;
  cost: ToolCost;
  /** "GET /claims/:claim_id/card", or null for a tool written by hand in src/mcp/server.ts. */
  route: string | null;
  params: { name: string; required: boolean }[];
  /** Whether the tool takes `fields` to trim its answer. */
  fields: boolean;
}

export interface CatalogGroup {
  key: string;
  title: string;
  tools: CatalogTool[];
}

// In order: the first group whose test a tool passes is its group.
const GROUPS: { key: string; title: string; test: RegExp }[] = [
  { key: "check", title: "Checking text", test: /^(match_claim|extract_claims|assess_text|get_text_analysis|get_page_analysis|get_page_claims)$/ },
  { key: "cite", title: "Citing and exporting", test: /^(cite_claim|export_\w+)$/ },
  { key: "math", title: "Formal statements and prizes", test: /formaliz|lean|attempt|prize|bounty/ },
  {
    key: "read",
    title: "Reading the graph",
    test: /^(search_claims|get_claim|get_claim_card|get_claim_cards|list_claims|get_decomposition|get_dependents|get_argument|list_tags|get_tag|get_claim_provenance|get_judgment_inputs|get_assessment_history|get_assessment_trajectory|get_claim_events|get_claim_record|get_node_lookouts)$/,
  },
  { key: "follow", title: "Following change", test: /^(list_graph_changes|list_findings|get_finding)$|correspondent/ },
  { key: "sources", title: "Sources", test: /source|^get_job$/ },
  {
    key: "contribute",
    title: "Contributing",
    test: /^(submit_contribution|get_contribution_status|list_contributions|submit_appeal|get_appeal|propose_claim|propose_list|propose_safety_case|state_view|list_stated_views|list_contributors|get_contributor|raise_issue|get_my_report)$/,
  },
  { key: "organizations", title: "Organizations", test: /organization|account_conversion/ },
  { key: "requests", title: "Requests", test: /request/ },
  { key: "fund", title: "Commissioning work", test: /^(order_assessment|fund_claim_assessment|fund_deep_decomposition)$|_orders?$|budget_job/ },
  { key: "federation", title: "Published pages and mandates", test: /publish/ },
  { key: "grants", title: "Grants and mandates", test: /grant|mandate/ },
  { key: "account", title: "Your account", test: /^(get_account|get_usage|list_owl_packs|get_owl_ledger|list_api_keys)$/ },
  { key: "assistant", title: "The Assistant and pages", test: /assistant|^(save_page|list_pages|get_page|get_shared_page)$/ },
  { key: "sql", title: "SQL", test: /^query_sql$/ },
  { key: "transparency", title: "Runs, setups and health", test: /run|setup|prompt_set|features|queue|monitor|consistency|^get_version$|product_release/ },
  {
    key: "deployment",
    title: "Running a deployment",
    test: /permission|label|part(y|ies)|connection|file_set|usage_report|standing_mandate|owls_created|redaction|checklist|setting/,
  },
];

export const OTHER_GROUP = { key: "other", title: "Other" };

export function toolGroup(name: string): { key: string; title: string } {
  return GROUPS.find((g) => g.test.test(name)) ?? OTHER_GROUP;
}

const ROUTE_LINE = /Same operation as the REST API's (GET|POST|PUT|PATCH|DELETE) (\S+?)\.?\s*$/m;

/** The REST route a generated tool runs, from its description's last line. */
export function toolRoute(description: string): string | null {
  const m = description.match(ROUTE_LINE);
  return m ? `${m[1]} ${m[2]}` : null;
}

/**
 * What calling the tool does to the caller's owls, read from the notes the
 * server puts in its description. A tool written by hand that changes
 * anything says so in its name (submit_, raise_); every other one reads.
 */
export function toolCost(name: string, description: string): ToolCost {
  if (/Escrows owls/.test(description)) return "escrow";
  if (/Spends owls|Runs a model: metered|costs owls per second/.test(description)) return "charged";
  const route = toolRoute(description);
  if (route) return route.startsWith("GET ") ? "read" : "write";
  return /^(submit_|raise_)/.test(name) ? "write" : "read";
}

function summaryOf(description: string): string {
  const first = description.split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim();
  // A generated tool's first paragraph is its route's summary, with no full
  // stop; a hand-written tool's is prose, cut at its first sentence.
  const sentence = first.match(/^.+?[.!?](?=\s+[A-Z`(]|$)/);
  const s = (sentence ? sentence[0] : first).replace(/ Same operation as the REST API's .*$/, "");
  return s.length > 220 ? `${s.slice(0, 217).replace(/\s\S*$/, "")}…` : s;
}

export function catalogTool(t: ListedTool): CatalogTool {
  const description = t.description ?? "";
  const props = Object.keys(t.inputSchema?.properties ?? {});
  const required = new Set(t.inputSchema?.required ?? []);
  return {
    name: t.name,
    summary: summaryOf(description),
    cost: toolCost(t.name, description),
    route: toolRoute(description),
    params: props.filter((p) => p !== "fields").map((p) => ({ name: p, required: required.has(p) })),
    fields: props.includes("fields"),
  };
}

/** The catalog in group order, tools in the order the server lists them. */
export function buildCatalog(tools: ListedTool[]): CatalogGroup[] {
  const groups = new Map<string, CatalogGroup>();
  for (const g of [...GROUPS, OTHER_GROUP]) groups.set(g.key, { key: g.key, title: g.title, tools: [] });
  for (const t of tools) groups.get(toolGroup(t.name).key)!.tools.push(catalogTool(t));
  return [...groups.values()].filter((g) => g.tools.length > 0);
}
