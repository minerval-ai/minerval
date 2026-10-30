/**
 * s(CASP) export (docs/scasp.md): a decomposition rendered as a logic program.
 * The discipline under test: only arguments the Steward rated certain or
 * likely become rules, basis claims take their verdict, relations carry a
 * rule only where their meaning gives one, and claim text reaches the
 * program only as safely quoted atoms.
 */
import { describe, it, expect } from "vitest";

import { claimAtom, treeToScasp } from "../../../src/services/scasp-service.js";
import type { TreeNode } from "../../../src/schemas/claim.js";

const ROOT = "11111111-2222-3333-4444-555555555555";
const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-1111-2222-3333-444444444444";
const C = "cccccccc-1111-2222-3333-444444444444";
const ARG_FOR = "dddddddd-1111-2222-3333-444444444444";
const ARG_AGAINST = "eeeeeeee-1111-2222-3333-444444444444";

function node(overrides: Partial<TreeNode> & { id: string; text: string }): TreeNode {
  return {
    claim_type: "empirical_derived",
    state: "active",
    depth: 1,
    relation_type: null,
    reasoning: null,
    confidence: null,
    assessment_status: null,
    assessment_confidence: null,
    argument_id: null,
    argument_name: null,
    argument_stance: null,
    argument_content: null,
    argument_verdict: null,
    argument_evaluation: null,
    children: [],
    ...overrides,
  };
}

function premise(
  id: string,
  text: string,
  status: string | null,
  arg: { id: string; stance: string; verdict: string | null; name?: string } | null,
  relation = "requires"
): TreeNode {
  return node({
    id,
    text,
    relation_type: relation,
    assessment_status: status,
    argument_id: arg?.id ?? null,
    argument_name: arg?.name ?? null,
    argument_stance: arg?.stance ?? null,
    argument_verdict: arg?.verdict ?? null,
  });
}

/** A whole line of the program, so a fact is not matched inside the query. */
function line(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m");
}

const opts = {
  pageUrl: `https://minerval.ai/claims/${ROOT}`,
  claimUri: `https://w3id.org/minerval/claim/${ROOT}`,
  generatedAt: new Date("2026-10-30T00:00:00.000Z"),
  maxDepth: 3,
};

function tree(children: TreeNode[], status: string | null = "supported"): TreeNode {
  return node({ id: ROOT, text: "Inflation in 2022 was transitory.", depth: 0, assessment_status: status, children });
}

describe("claimAtom", () => {
  it("makes a lowercase Prolog constant from a claim id", () => {
    expect(claimAtom(A)).toBe("c_aaaaaaaa111122223333444444444444");
    expect(claimAtom(A.toUpperCase())).toBe(claimAtom(A));
  });
});

describe("treeToScasp", () => {
  const r = claimAtom(ROOT);
  const a = claimAtom(A);
  const b = claimAtom(B);
  const c = claimAtom(C);

  it("encodes a certain argument as a strict rule, and asks whether the claim holds", () => {
    const out = treeToScasp(
      tree([
        premise(A, "Supply chains drove the rise.", "supported", { id: ARG_FOR, stance: "for", verdict: "certain" }),
        premise(B, "Rates stayed low.", "verified", { id: ARG_FOR, stance: "for", verdict: "certain" }),
      ]),
      opts
    );
    expect(out).toContain(`holds(${r}) :-\n    holds(${a}),\n    holds(${b}).`);
    expect(out).toContain(`?- holds(${r}).`);
    // The concluded root is not also asserted from its own verdict.
    expect(out).not.toMatch(line(`holds(${r}).`));
    expect(out).toContain(`holds(${a}).`);
    expect(out).toContain(`holds(${b}).`);
  });

  it("makes a likely argument defeasible, on either side", () => {
    const out = treeToScasp(
      tree([
        premise(A, "For premise.", "supported", { id: ARG_FOR, stance: "for", verdict: "likely" }),
        premise(B, "Against premise.", "supported", { id: ARG_AGAINST, stance: "against", verdict: "likely" }, "contradicts"),
      ]),
      opts
    );
    expect(out).toContain(`holds(${r}) :-\n    holds(${a}),\n    not -holds(${r}).`);
    expect(out).toContain(`-holds(${r}) :-\n    holds(${b}),\n    not holds(${r}).`);
  });

  it("leaves slight, unevaluated, and neutral arguments as comments, and the claim on its verdict", () => {
    const out = treeToScasp(
      tree([
        premise(A, "Weak premise.", "supported", { id: ARG_FOR, stance: "for", verdict: "slight" }),
        premise(B, "Unrated premise.", "supported", { id: ARG_AGAINST, stance: "against", verdict: null }),
        premise(C, "Neutral premise.", "supported", { id: "ffffffff-1111-2222-3333-444444444444", stance: "neutral", verdict: "certain" }),
      ]),
      opts
    );
    expect(out).toContain("% Not encoded: the Steward rates the inference slight.");
    expect(out).toContain("% Not encoded: the Steward has not evaluated it.");
    expect(out).toContain("% Not encoded: it takes no side on the claim.");
    expect(out).not.toMatch(/^-?holds\(c_[0-9a-f]+\) :-\n/m);
    // No argument concludes the root, so it stands on its own verdict.
    expect(out).toMatch(line(`holds(${r}).`));
  });

  it("maps the basis statuses: for, against, and open", () => {
    const out = treeToScasp(
      tree(
        [
          premise(A, "Doubtful.", "doubtful", null),
          premise(B, "Inconclusive.", "inconclusive", null, "supports"),
          premise(C, "Never assessed.", null, null, "supports"),
        ],
        "contradicted"
      ),
      opts
    );
    expect(out).toContain(`-holds(${r}).`);
    expect(out).toContain(`-holds(${a}).`);
    for (const x of [b, c]) {
      expect(out).toContain(`holds(${x}) :- not -holds(${x}).`);
      expect(out).toContain(`-holds(${x}) :- not holds(${x}).`);
    }
    expect(out).toContain(`assessed(${c}, unassessed).`);
  });

  it("gives requires and assumes edges their own rules, and other relations none", () => {
    const out = treeToScasp(
      tree([
        premise(A, "Load-bearing.", "supported", null, "requires"),
        premise(B, "Framework.", "supported", null, "assumes"),
        premise(C, "Evidence.", "supported", null, "supports"),
      ]),
      opts
    );
    expect(out).toContain(`-holds(${r}) :- -holds(${a}).`);
    expect(out).toContain(`ill_posed(${r}) :- -holds(${b}).`);
    expect(out).not.toContain(`-holds(${c}).`);
    expect(out).toContain(`edge(${r}, ${c}, 'supports').`);
  });

  it("records a shared subclaim's edges once each, though it appears twice", () => {
    const shared = premise(C, "Shared.", "supported", null);
    const out = treeToScasp(
      tree([
        node({ ...premise(A, "Left.", "supported", null), children: [{ ...shared, depth: 2 }] }),
        node({ ...premise(B, "Right.", "supported", null), children: [{ ...shared, depth: 2, subtree_collapsed: true }] }),
      ]),
      opts
    );
    expect(out.match(new RegExp(`#pred holds\\(${c}\\)`, "g"))).toHaveLength(1);
    expect(out).toContain(`edge(${a}, ${c}, 'requires').`);
    expect(out).toContain(`edge(${b}, ${c}, 'requires').`);
  });

  it("does not encode an argument whose premises the node cap cut off", () => {
    const root = tree([premise(A, "Kept.", "supported", { id: ARG_FOR, stance: "for", verdict: "certain" })]);
    root.children_truncated = true;
    const out = treeToScasp(root, opts);
    expect(out).toContain("% Not encoded: its claim's premises were cut off by the node cap");
    expect(out).toMatch(line(`holds(${r}).`));
  });

  it("quotes claim text safely, on one line, and resolves claim references in names", () => {
    const out = treeToScasp(
      tree([
        premise(A, "It's a \\ backslash,\nand @(X) a placeholder.", "supported", {
          id: ARG_FOR,
          stance: "for",
          verdict: "certain",
          name: `Because [[claim:${A}|the premise]]`,
        }),
      ]),
      opts
    );
    expect(out).toContain(`#pred holds(${a}) :: 'It\\'s a \\\\ backslash, and @ (X) a placeholder.'.`);
    expect(out).toContain('% "Because the premise" (for, certain)');
    expect(out).not.toContain("[[claim:");
  });

  it("gives questions and quantities no truth value", () => {
    const out = treeToScasp(
      tree([
        node({ ...premise(A, "How large is it?", null, { id: ARG_FOR, stance: "for", verdict: "certain" }), node_kind: "question" }),
      ]),
      opts
    );
    expect(out).not.toContain(`#pred holds(${a})`);
    expect(out).toContain("% Not encoded: a premise is a question or quantity");
    expect(out).toContain(`assessed(${a}, unassessed).`);
  });
});
