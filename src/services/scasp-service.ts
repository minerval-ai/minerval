import { loadConfig } from "../config.js";
import type { TreeNode } from "../schemas/claim.js";
import { CITATION_AUTHOR, citationUrl } from "./citation-service.js";
import { CONTENT_LICENSE_IRI, resolveClaimLinks } from "./nanopub-service.js";
import { getClaimTree } from "./tree-service.js";

// s(CASP) export: a claim's decomposition rendered as a logic program for the
// goal-directed answer-set solver s(CASP) (Arias et al. 2018), so a reader can
// query whether the conclusion follows from the premises the graph records,
// under which assumptions, and get a justification tree back. Renders existing
// state only, like the nanopub export: no inference step is invented, and a
// judgment the graph has not made (an unevaluated argument) is not encoded as
// a rule.
//
// The encoding, in one place so docs/scasp.md can describe it:
//
//   holds(C)   the claim C is true;  -holds(C)  it is false (classical
//              negation; s(CASP) rules out a model holding both).
//   Arguments  rated `certain` become strict rules; `likely` become defeasible
//              rules, blocked by the opposite conclusion. `slight`, `none`,
//              unevaluated, and neutral arguments are left as comments.
//   Edges      `requires`: the child's falsity makes the parent false.
//              `assumes`: the child's falsity makes the parent ill-posed.
//              Other relations carry no rule of their own; they bear on the
//              parent only through the arguments that group them.
//   Basis      a claim no exported argument concludes takes its own verdict:
//              verified/supported as a fact, doubtful/contradicted as a
//              negated fact, and inconclusive, unknown, or unassessed as open
//              (an even loop, so s(CASP) explores both). assessed/2 and
//              edge/3 record the raw graph, so a reader can swap the policy.

/** Statuses read as settled for, and against, a basis claim. */
const HOLDS_STATUSES = new Set(["verified", "supported"]);
const FAILS_STATUSES = new Set(["doubtful", "contradicted"]);

export interface ScaspOptions {
  pageUrl: string;
  claimUri: string;
  generatedAt: Date;
  maxDepth: number;
}

interface FlatNode {
  id: string;
  text: string;
  kind: "claim" | "quantity" | "question";
  status: string | null;
}

interface FlatArgument {
  id: string;
  parent: string;
  name: string | null;
  stance: string | null;
  verdict: string | null;
  premises: string[];
}

interface FlatGraph {
  nodes: Map<string, FlatNode>;
  edges: { parent: string; child: string; relation: string }[];
  arguments: Map<string, FlatArgument>;
  truncated: Set<string>;
}

/** The program atom for a claim: a lowercase Prolog constant from its id. */
export function claimAtom(id: string): string {
  return `c_${id.toLowerCase().replace(/[^0-9a-f]/g, "")}`;
}

/** A single-quoted Prolog atom, on one line. */
function quoted(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return `'${oneLine.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Text for a #pred template: `@(` would read as a placeholder, so break it. */
function predText(text: string): string {
  return quoted(text.replace(/@\(/g, "@ ("));
}

/** Prose inside a `%` comment, on one line. */
function commentText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Flatten the nested tree into nodes, edges, and arguments. A shared subclaim
 * appears once per parent but is expanded only at its first occurrence, so
 * every edge is still seen exactly once per (parent, child, relation).
 */
function flatten(root: TreeNode): FlatGraph {
  const graph: FlatGraph = {
    nodes: new Map(),
    edges: [],
    arguments: new Map(),
    truncated: new Set(),
  };
  const seenEdges = new Set<string>();

  const visit = (node: TreeNode, parent: string | null) => {
    if (!graph.nodes.has(node.id)) {
      graph.nodes.set(node.id, {
        id: node.id,
        text: node.text,
        kind: node.node_kind ?? "claim",
        status: node.assessment_status,
      });
    }
    if (node.children_truncated) graph.truncated.add(node.id);

    if (parent && node.relation_type) {
      const key = `${parent}|${node.id}|${node.relation_type}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        graph.edges.push({ parent, child: node.id, relation: node.relation_type });
      }
      if (node.argument_id) {
        const arg = graph.arguments.get(node.argument_id) ?? {
          id: node.argument_id,
          parent,
          name: node.argument_name,
          stance: node.argument_stance,
          verdict: node.argument_verdict,
          premises: [],
        };
        if (!arg.premises.includes(node.id)) arg.premises.push(node.id);
        graph.arguments.set(node.argument_id, arg);
      }
    }
    for (const child of node.children) visit(child, node.id);
  };
  visit(root, null);
  return graph;
}

/** Why an argument stays a comment rather than a rule, or null if it is a rule. */
function argumentOmission(arg: FlatArgument, graph: FlatGraph): string | null {
  if (graph.truncated.has(arg.parent)) {
    return "its claim's premises were cut off by the node cap, so the rule would be incomplete";
  }
  if (arg.stance !== "for" && arg.stance !== "against") {
    return "it takes no side on the claim";
  }
  if (arg.premises.some((p) => graph.nodes.get(p)?.kind !== "claim")) {
    return "a premise is a question or quantity, which has no truth value";
  }
  if (arg.verdict === null) return "the Steward has not evaluated it";
  if (arg.verdict !== "certain" && arg.verdict !== "likely") {
    return `the Steward rates the inference ${arg.verdict}`;
  }
  return null;
}

/** Render a decomposition tree as an s(CASP) program. Pure. */
export function treeToScasp(root: TreeNode, opts: ScaspOptions): string {
  const graph = flatten(root);
  const textById = new Map([...graph.nodes.values()].map((n) => [n.id, n.text]));
  const claims = [...graph.nodes.values()].filter((n) => n.kind === "claim");
  const isClaim = (id: string) => graph.nodes.get(id)?.kind === "claim";
  const label = (id: string) => commentText(textById.get(id) ?? id);

  const lines: string[] = [
    `% ${commentText(root.text)}`,
    "%",
    `% s(CASP) export of this claim's decomposition from ${CITATION_AUTHOR},`,
    `% ${opts.maxDepth} level(s) deep. Source: ${opts.pageUrl}`,
    `% Identifier: ${opts.claimUri}`,
    `% Generated: ${opts.generatedAt.toISOString()}`,
    `% License: ${CONTENT_LICENSE_IRI}`,
    "%",
    "% holds(C) means claim C is true, -holds(C) that it is false. Arguments the",
    "% Steward rates certain are strict rules, likely ones defeasible; claims no",
    "% argument here concludes take their own verdict as the basis. assessed/2",
    "% and edge/3 record the graph as it stands. Encoding: docs/scasp.md.",
    "%",
    "% Run: scasp --tree <file>",
    "",
    "% ---- Readable justifications ----",
  ];
  for (const c of claims) {
    lines.push(`#pred holds(${claimAtom(c.id)}) :: ${predText(c.text)}.`);
  }
  lines.push(`#pred ill_posed(C) :: 'the framing of @(C) fails'.`);

  lines.push("", "% ---- The graph as recorded ----");
  for (const n of graph.nodes.values()) {
    lines.push(`assessed(${claimAtom(n.id)}, ${n.status ?? "unassessed"}).`);
  }
  for (const e of graph.edges) {
    lines.push(`edge(${claimAtom(e.parent)}, ${claimAtom(e.child)}, ${quoted(e.relation)}).`);
  }

  // Arguments, grouped under the claim they bear on.
  const concluded = new Set<string>();
  lines.push("", "% ---- Arguments ----");
  for (const arg of graph.arguments.values()) {
    const name = arg.name ? `"${commentText(resolveClaimLinks(arg.name, textById))}"` : "Unnamed argument";
    lines.push(
      `% ${name} (${arg.stance ?? "no stance"}, ${arg.verdict ?? "unevaluated"}) on: ${label(arg.parent)}`
    );
    const omission = argumentOmission(arg, graph);
    if (omission) {
      lines.push(`% Not encoded: ${omission}.`);
      continue;
    }
    const head =
      arg.stance === "for" ? `holds(${claimAtom(arg.parent)})` : `-holds(${claimAtom(arg.parent)})`;
    const body = arg.premises.map((p) => `holds(${claimAtom(p)})`);
    // A likely inference holds unless the opposite conclusion does.
    if (arg.verdict === "likely") {
      body.push(
        arg.stance === "for"
          ? `not -holds(${claimAtom(arg.parent)})`
          : `not holds(${claimAtom(arg.parent)})`
      );
    }
    lines.push(`${head} :-\n    ${body.join(",\n    ")}.`);
    concluded.add(arg.parent);
  }

  lines.push("", "% ---- What each relation entails on its own ----");
  for (const e of graph.edges) {
    if (!isClaim(e.parent) || !isClaim(e.child)) continue;
    if (e.relation === "requires") {
      lines.push(`-holds(${claimAtom(e.parent)}) :- -holds(${claimAtom(e.child)}).`);
    } else if (e.relation === "assumes") {
      lines.push(`ill_posed(${claimAtom(e.parent)}) :- -holds(${claimAtom(e.child)}).`);
    }
  }

  lines.push("", "% ---- Basis: claims no argument here concludes, by their verdict ----");
  for (const c of claims) {
    if (concluded.has(c.id)) continue;
    const a = claimAtom(c.id);
    lines.push(`% ${label(c.id)}`);
    if (c.status && HOLDS_STATUSES.has(c.status)) {
      lines.push(`holds(${a}).`);
    } else if (c.status && FAILS_STATUSES.has(c.status)) {
      lines.push(`-holds(${a}).`);
    } else {
      // Open: neither settled for nor against, so both are explored.
      lines.push(`holds(${a}) :- not -holds(${a}).`, `-holds(${a}) :- not holds(${a}).`);
    }
  }

  if (root.node_kind === undefined || root.node_kind === "claim") {
    lines.push("", `?- holds(${claimAtom(root.id)}).`);
  }
  return lines.join("\n") + "\n";
}

/** The s(CASP) program for a claim's decomposition, or null for an unknown claim. */
export async function assembleClaimScasp(
  claimId: string,
  maxDepth: number,
  generatedAt: Date = new Date()
): Promise<string | null> {
  const tree = await getClaimTree(claimId, maxDepth);
  if (!tree) return null;
  const config = loadConfig();
  return treeToScasp(tree, {
    pageUrl: `${config.publicWebBaseUrl.replace(/\/$/, "")}/claims/${tree.id}`,
    claimUri: citationUrl(tree.id),
    generatedAt,
    maxDepth,
  });
}
