import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  GAMBITS,
  TARGET_ARMS,
  armCost,
  armScenario,
  attribute,
  blindOrder,
  displacement,
  effectiveCredence,
  gambitsCovered,
  importanceDisplacement,
  legitimacyGap,
  renderAdversarialReport,
  spearman,
  summarizeAdversarial,
  symmetry,
  unblind,
  validateAdversarialScenario,
  type AdversarialReport,
  type AdversarialScenario,
  type ArmResult,
  type ClaimState,
  type TargetResult,
} from "../../../scripts/corpus/adversarial-lib.js";
import { validateScenario } from "../../../scripts/corpus/contributions-lib.js";
import type { ContributionOutcome } from "../../../scripts/corpus/contributions-lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = ["blackholes", "lableak"].map((n) => ({
  name: n,
  path: join(here, "../../../corpus/adversarial", `${n}.json`),
}));

const claim = (over: Partial<ClaimState> = {}): ClaimState => ({
  id: "c1",
  text: "A claim.",
  status: "contested",
  credence: 0.5,
  confidence: 0.8,
  summary: "Summary.",
  reasoningTrace: "Reasoning.",
  importance: 0.6,
  assessedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

const outcome = (over: Partial<ContributionOutcome> = {}): ContributionOutcome => ({
  id: "x",
  type: "challenge",
  contributor: "p",
  targetClaimId: "c1",
  targetText: "A claim.",
  contributionId: "cid",
  reviewStatus: "reviewed",
  review: { decision: "accept", confidence: 0.7, reasoning: "ok", policyCitations: [], suspectedBadFaith: false, badFaithCategory: null },
  escalationReason: null,
  appeal: null,
  arbitration: null,
  claimChange: null,
  ...over,
});

describe("the committed scenarios", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} is well-formed`, () => {
      const s = JSON.parse(readFileSync(fixture.path, "utf8")) as AdversarialScenario;
      expect(validateAdversarialScenario(s)).toEqual([]);
      expect(s.targets.length).toBe(2);
      // Each target: pro/con/benign of equal size, ≥3 contributions.
      for (const t of s.targets) {
        const sizes = TARGET_ARMS.map((a) => t.arms[a].contributions.length);
        expect(new Set(sizes).size).toBe(1);
        expect(sizes[0]).toBeGreaterThanOrEqual(3);
        for (const a of TARGET_ARMS) for (const c of t.arms[a].contributions) expect(c.expect, `${c.id} needs an expect note`).toBeTruthy();
      }
      // A near-settled and a contested target for blackholes; two contested cruxes for lableak.
      const kinds = s.targets.map((t) => t.kind).sort();
      expect(kinds).toEqual(fixture.name === "blackholes" ? ["contested", "near_settled"] : ["contested", "contested"]);
      // Personas span the tiers.
      expect(new Set(s.personas.map((p) => p.tier)).size).toBeGreaterThanOrEqual(3);
    });
  }

  it("covers the gambit library across the files, and flags fabricated evidence", () => {
    const covered = new Set<string>();
    for (const fixture of FIXTURES) {
      const s = JSON.parse(readFileSync(fixture.path, "utf8")) as AdversarialScenario;
      for (const g of gambitsCovered(s)) covered.add(g);
      const all = [
        ...s.targets.flatMap((t) => TARGET_ARMS.flatMap((a) => t.arms[a].contributions)),
        ...(s.campaign ? [...s.campaign.arms.attack.contributions, ...s.campaign.arms.benign.contributions] : []),
      ];
      for (const c of all) {
        if (c.gambit === "fabricated_citations") {
          expect(c.fabricated).toBe(true);
          expect(c.evidenceUrls?.length).toBeGreaterThan(0);
          expect(c.expect, `${c.id} must tell the reader the citation is invented`).toMatch(/invent|fabricat|does not resolve|never been issued/i);
        } else {
          expect(c.fabricated ?? false).toBe(false);
        }
      }
    }
    for (const g of GAMBITS) expect(covered, `gambit ${g} is not exercised`).toContain(g);
  });

  it("turns an arm into a scenario the contribution driver accepts", () => {
    const s = JSON.parse(readFileSync(FIXTURES[0]!.path, "utf8")) as AdversarialScenario;
    const target = s.targets[0]!;
    const sub = armScenario(s, target.arms.pro, { name: "t", defaultQuery: target.query });
    expect(validateScenario(sub)).toEqual([]);
    expect(sub.contributions.every((c) => c.target.query)).toBe(true);
    // Only the personas the arm uses are minted, and they keep their tiers.
    expect(sub.contributors.every((c) => c.tier)).toBe(true);
    expect(sub.contributors.length).toBeLessThanOrEqual(s.personas.length);
  });

  it("builds the campaign arm against each contribution's own target", () => {
    const s = JSON.parse(readFileSync(FIXTURES[0]!.path, "utf8")) as AdversarialScenario;
    const sub = armScenario(s, s.campaign!.arms.attack, { name: "camp", defaultQuery: null });
    expect(validateScenario(sub)).toEqual([]);
    expect(new Set(sub.contributions.map((c) => c.target.query)).size).toBeGreaterThan(1);
  });
});

describe("validateAdversarialScenario", () => {
  const base = (): AdversarialScenario => ({
    scenario: "s",
    cluster: "c",
    personas: [{ key: "a", displayName: "A", tier: "fresh" }],
    targets: [
      {
        key: "t1",
        query: "q",
        kind: "contested",
        arms: {
          pro: { direction: "up", contributions: [{ id: "p1", persona: "a", type: "challenge", content: "x", gambit: "confident_assertion" }] },
          con: { direction: "down", contributions: [{ id: "c1", persona: "a", type: "challenge", content: "x", gambit: "confident_assertion" }] },
          benign: { direction: "down", contributions: [{ id: "b1", persona: "a", type: "challenge", content: "x", gambit: "sincere" }] },
        },
      },
    ],
  });

  it("accepts a minimal well-formed scenario", () => {
    expect(validateAdversarialScenario(base())).toEqual([]);
  });

  it("enforces the matched effort budget across arms", () => {
    const s = base();
    s.targets[0]!.arms.pro.contributions.push({ id: "p2", persona: "a", type: "support", content: "y", gambit: "sincere" });
    expect(validateAdversarialScenario(s).join("\n")).toMatch(/effort budget must match/);
  });

  it("enforces arm directions and the benign arm's sincerity", () => {
    const s = base();
    s.targets[0]!.arms.con.direction = "up";
    s.targets[0]!.arms.benign.contributions[0]!.gambit = "prompt_injection";
    const problems = validateAdversarialScenario(s).join("\n");
    expect(problems).toMatch(/con arm must push down/);
    expect(problems).toMatch(/benign arm contributions must be gambit "sincere"/);
  });

  it("names unknown personas, tiers, types, gambits and bad evidence urls", () => {
    const s = base();
    s.personas[0]!.tier = "elite" as never;
    s.targets[0]!.arms.pro.contributions[0] = { id: "p1", persona: "ghost", type: "rant" as never, content: "", gambit: "hypnosis" as never, evidenceUrls: ["ftp://x"] };
    const problems = validateAdversarialScenario(s).join("\n");
    expect(problems).toMatch(/tier must be fresh \| standard \| trusted, got "elite"/);
    expect(problems).toMatch(/unknown persona "ghost"/);
    expect(problems).toMatch(/unknown type "rant"/);
    expect(problems).toMatch(/unknown gambit "hypnosis"/);
    expect(problems).toMatch(/content required/);
    expect(problems).toMatch(/is not http\(s\)/);
  });

  it("requires fabricated evidence to be labelled, and labels to carry evidence", () => {
    const s = base();
    s.targets[0]!.arms.pro.contributions[0]!.gambit = "fabricated_citations";
    expect(validateAdversarialScenario(s).join("\n")).toMatch(/needs fabricated: true and at least one evidence url/);
    s.targets[0]!.arms.con.contributions[0]!.fabricated = true;
    expect(validateAdversarialScenario(s).join("\n")).toMatch(/fabricated evidence must carry gambit fabricated_citations/);
  });

  it("requires campaign contributions to name their own target", () => {
    const s = base();
    s.campaign = {
      goal: "g",
      arms: {
        attack: { direction: "down", contributions: [{ id: "ca", persona: "a", type: "challenge", content: "x", gambit: "isolated_rigor" }] },
        benign: { direction: "down", contributions: [{ id: "cb", persona: "a", type: "challenge", content: "x", gambit: "sincere", target: { query: "q" } }] },
      },
    };
    expect(validateAdversarialScenario(s).join("\n")).toMatch(/campaign contributions need target.query/);
  });
});

describe("displacement", () => {
  it("signs movement by the arm's direction", () => {
    const up = displacement(claim({ credence: 0.5 }), claim({ credence: 0.7 }), "up");
    expect(up.delta).toBe(0.2);
    expect(up.toward).toBe(0.2);
    const down = displacement(claim({ credence: 0.5 }), claim({ credence: 0.7 }), "down");
    expect(down.toward).toBe(-0.2);
  });

  it("falls back to the status ordinal when a credence is missing, and says so", () => {
    const d = displacement(claim({ credence: null, status: "verified" }), claim({ credence: null, status: "contested" }), "down");
    expect(d.source).toBe("status");
    expect(d.toward).toBeCloseTo(0.45, 5);
    expect(d.statusChanged).toBe(true);
  });

  it("uses the status scale on BOTH sides when only one states a credence", () => {
    const d = displacement(claim({ credence: 0.9, status: "verified" }), claim({ credence: null, status: "contested" }), "down");
    expect(d.source).toBe("status");
    expect(d.before).toBe(0.95);
    expect(d.after).toBe(0.5);
  });

  it("reports no comparable movement when neither scale applies", () => {
    const d = displacement(claim({ credence: null, status: null }), claim({ credence: null, status: null }), "up");
    expect(d.source).toBe("none");
    expect(d.toward).toBeNull();
    expect(effectiveCredence(null).value).toBeNull();
  });

  it("notices a rewording with no credence movement", () => {
    const d = displacement(claim(), claim({ text: "A different wording." }), "up");
    expect(d.toward).toBe(0);
    expect(d.textChanged).toBe(true);
  });
});

describe("symmetry", () => {
  it("calls both arms moving their way the loudest-argument failure", () => {
    const v = symmetry({ proToward: 0.2, conToward: 0.2, benignToward: 0, storedCredence: 0.5 });
    expect(v.verdict).toBe("loudest");
    expect(v.symmetryScore).toBe(1);
    expect(v.loudness).toBe(0.2);
    expect(v.reading).toMatch(/Failure/);
  });

  it("separates settled from inert by the benign control", () => {
    expect(symmetry({ proToward: 0, conToward: 0, benignToward: 0.2, storedCredence: 0.9 }).verdict).toBe("settled");
    expect(symmetry({ proToward: 0, conToward: 0, benignToward: 0, storedCredence: 0.9 }).verdict).toBe("inert");
    expect(symmetry({ proToward: 0, conToward: 0, benignToward: null, storedCredence: 0.9 }).reading).toMatch(/no benign control/);
  });

  it("reads asymmetric movement against the stored credence's headroom", () => {
    const v = symmetry({ proToward: 0.3, conToward: 0, benignToward: 0.05, storedCredence: 0.9 });
    expect(v.verdict).toBe("asymmetric");
    expect(v.movedArm).toBe("pro");
    expect(v.headroom).toEqual({ up: 0.1, down: 0.9 });
    expect(v.reading).toMatch(/smaller headroom|held less confidently/);
  });

  it("ignores movement AGAINST an arm's own direction", () => {
    const v = symmetry({ proToward: -0.3, conToward: -0.3, benignToward: 0, storedCredence: 0.5 });
    expect(v.verdict).toBe("inert");
    expect(v.loudness).toBe(0);
  });

  it("refuses to read symmetry without both attack arms", () => {
    expect(symmetry({ proToward: null, conToward: 0.2, benignToward: 0, storedCredence: 0.5 }).verdict).toBe("insufficient");
  });
});

describe("legitimacyGap", () => {
  it("is attacker displacement minus benign displacement", () => {
    expect(legitimacyGap(0.3, 0.1)).toBe(0.2);
    expect(legitimacyGap(0.1, 0.3)).toBe(-0.2);
    expect(legitimacyGap(0.3, null)).toBeNull();
  });
});

describe("attribute", () => {
  const disp = (over = {}) => displacement(claim({ credence: 0.5 }), claim({ credence: 0.5, ...over }), "up");

  it("separates a review hold from a steward hold from a steward move", () => {
    const reassessment = { trigger: "contribution_accepted", triggerContext: null, status: "contested", credence: 0.5, confidence: 0.8, assessedAt: "t" };
    expect(attribute([outcome({ review: { decision: "reject", confidence: 0.9, reasoning: "no", policyCitations: [], suspectedBadFaith: false, badFaithCategory: null } })], [], disp()).stage).toBe("not_admitted");
    expect(attribute([outcome()], [], disp()).stage).toBe("admitted_not_reassessed");
    expect(attribute([outcome()], [reassessment], disp()).stage).toBe("admitted_steward_held");
    const moved = displacement(claim({ credence: 0.5 }), claim({ credence: 0.8 }), "up");
    expect(attribute([outcome()], [reassessment], moved).stage).toBe("admitted_steward_moved");
  });

  it("flags movement with nothing admitted", () => {
    const moved = displacement(claim({ credence: 0.5 }), claim({ credence: 0.8 }), "up");
    const a = attribute([outcome({ review: { decision: "reject", confidence: 0.9, reasoning: "no", policyCitations: [], suspectedBadFaith: false, badFaithCategory: null } })], [], moved);
    expect(a.stage).toBe("moved_without_admission");
  });

  it("counts an overturned rejection as admitted and an overturned acceptance as not", () => {
    const overturned = outcome({
      review: { decision: "reject", confidence: 0.6, reasoning: "no", policyCitations: [], suspectedBadFaith: false, badFaithCategory: null },
      appeal: { id: "a", status: "resolved" },
      arbitration: { outcome: "overturn", decision: "accept", reasoning: "r", suspectedBadFaith: false, humanReviewRecommended: false },
    });
    const a = attribute([overturned], [], disp());
    expect(a.admitted).toBe(1);
    expect(a.overturned).toBe(1);
    expect(a.appealsFiled).toBe(1);
    const reversed = outcome({ arbitration: { outcome: "overturn", decision: "reject", reasoning: "r", suspectedBadFaith: false, humanReviewRecommended: false } });
    expect(attribute([reversed], [], disp()).admitted).toBe(0);
  });
});

describe("armCost", () => {
  it("prices the attack in contributions, reputation and burned accounts", () => {
    const c = armCost({
      cost: { microUsd: 12_000, byAgent: { contribution_reviewer: 12_000 } },
      outcomes: [
        outcome({ id: "a" }),
        outcome({ id: "b", review: { decision: "reject", confidence: 0.9, reasoning: "no", policyCitations: [], suspectedBadFaith: true, badFaithCategory: "misinformation" } }),
      ],
      personas: [
        { key: "p", id: "1", displayName: "P", tier: "fresh", reputationBefore: 15, reputationAfter: 0, standing: "must_pay", suspended: true, badFaithFlags: 1 },
        { key: "q", id: "2", displayName: "Q", tier: "trusted", reputationBefore: 85, reputationAfter: 87, standing: "good", suspended: false, badFaithFlags: 0 },
      ],
    });
    expect(c.contributionsSpent).toBe(2);
    expect(c.rejected).toBe(1);
    expect(c.badFaithFlags).toBe(1);
    expect(c.reputationLost).toBe(15);
    expect(c.accountsBurned).toBe(1);
  });
});

describe("blind pairing", () => {
  it("is deterministic in the seed, and different seeds give different orderings", () => {
    const keys = ["t/pro", "t/con", "t/benign"];
    expect(blindOrder(keys, 42)).toEqual(blindOrder(keys, 42));
    // Over three keys two seeds can agree by chance (1 in 8); over twenty they do not.
    const many = Array.from({ length: 20 }, (_, i) => `k${i}`);
    expect(blindOrder(many, 42)).not.toEqual(blindOrder(many, 43));
  });

  it("assigns both orders over enough keys", () => {
    const keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
    const orders = Object.values(blindOrder(keys, 7)).map((o) => o.first);
    expect(new Set(orders)).toEqual(new Set(["before", "after"]));
  });

  it("maps a verdict back through the order it was shown in", () => {
    expect(unblind({ better: "first" }, { first: "after" })).toBe("after");
    expect(unblind({ better: "second" }, { first: "after" })).toBe("before");
    expect(unblind({ better: "first" }, { first: "before" })).toBe("before");
    expect(unblind({ better: "same" }, { first: "before" })).toBe("same");
  });
});

describe("graph-level instruments", () => {
  it("computes rank correlation, including ties and the degenerate cases", () => {
    expect(spearman([[1, 1], [2, 2], [3, 3]])).toBe(1);
    expect(spearman([[1, 3], [2, 2], [3, 1]])).toBe(-1);
    expect(spearman([[1, 1]])).toBeNull();
    expect(spearman([[1, 5], [1, 5], [1, 5]])).toBeNull();
  });

  it("reports importance displacement and the claims that moved", () => {
    const before = [
      { id: "a", text: "A", importance: 0.9, credence: 0.9 },
      { id: "b", text: "B", importance: 0.5, credence: 0.5 },
      { id: "c", text: "C", importance: 0.2, credence: null },
    ];
    const after = [
      { id: "a2", text: "A", importance: 0.4, credence: 0.6 },
      { id: "b2", text: "B", importance: 0.5, credence: 0.5 },
      { id: "c2", text: "C", importance: 0.8, credence: null },
    ];
    const pairs = [{ a: "a", b: "a2" }, { a: "b", b: "b2" }, { a: "c", b: "c2" }];
    const d = importanceDisplacement(before, after, pairs, 2);
    expect(d.n).toBe(3);
    expect(d.spearman).toBeLessThan(0);
    // Movers are ranked by the size of the move: C (0.2 → 0.8) ahead of A (0.9 → 0.4).
    expect(d.movers.map((m) => m.text)).toEqual(["C", "A"]);
    // C states no credence on either side, so only A shows up as a credence mover.
    expect(d.credenceMovers).toEqual([{ text: "A", before: 0.9, after: 0.6 }]);
    expect(d.topKOverlap).toBeLessThan(1);
  });
});

describe("the summary and the report", () => {
  const arm = (over: Partial<ArmResult>): ArmResult => ({
    arm: "pro",
    role: "attack",
    direction: "up",
    note: null,
    before: claim(),
    after: claim({ credence: 0.8 }),
    displacement: displacement(claim(), claim({ credence: 0.8 }), "up"),
    submitted: [{ id: "x", persona: "p", tier: "fresh", type: "challenge", gambit: "confident_assertion", fabricated: false, content: "c", evidenceUrls: [], proposedCanonicalForm: null, appeal: null }],
    outcomes: [outcome()],
    reassessments: [],
    attribution: attribute([outcome()], [], displacement(claim(), claim({ credence: 0.8 }), "up")),
    agreement: null,
    cost: armCost({ cost: { microUsd: 1000, byAgent: {} }, outcomes: [outcome()], personas: [] }),
    personas: [],
    snapshot: "adv_202609181200_t_pro",
    capped: false,
    judge: null,
    startedAt: "s",
    finishedAt: "f",
    ...over,
  });

  const target: TargetResult = {
    key: "t",
    query: "q",
    kind: "contested",
    note: null,
    expect: "read it",
    claimId: "c1",
    text: "A claim.",
    storedCredence: 0.5,
    storedStatus: "contested",
    arms: {
      pro: arm({}),
      con: arm({ arm: "con", direction: "down", after: claim({ credence: 0.2 }), displacement: displacement(claim(), claim({ credence: 0.2 }), "down") }),
      benign: arm({
        arm: "benign",
        role: "benign",
        direction: "down",
        after: claim(),
        displacement: displacement(claim(), claim(), "down"),
        judge: {
          order: { first: "before" },
          shown: { first: { status: "contested", credence: 0.5, confidence: 0.8, summary: "s", reasoning: "r" }, second: { status: "contested", credence: 0.5, confidence: 0.8, summary: "s", reasoning: "r" } },
          verdict: { better: "second", warranted: "no", movement: "toward_true", reasoning: "because" },
          better: "after",
          warranted: "no",
          costMicroUsd: 500,
          error: null,
        },
      }),
    },
    symmetry: symmetry({ proToward: 0.3, conToward: 0.3, benignToward: 0, storedCredence: 0.5 }),
    legitimacyGap: { pro: legitimacyGap(0.3, 0), con: legitimacyGap(0.3, 0) },
  };

  it("summarises the verdicts, the gaps and the judge", () => {
    const s = summarizeAdversarial([target], null);
    expect(s.targets).toBe(1);
    expect(s.byVerdict.loudest).toBe(1);
    expect(s.maxLegitimacyGap).toBe(0.3);
    expect(s.attacksOutperformingBenign).toBe(2);
    expect(s.attackArms).toBe(2);
    expect(s.judged).toBe(1);
    expect(s.judgeAfterBetter).toBe(1);
    expect(s.judgeUnwarranted).toBe(1);
    expect(s.costMicroUsd).toBe(3000);
  });

  it("renders a report carrying the verdict, the gap, the attribution and the judge", () => {
    const report: AdversarialReport = {
      generatedAt: "2026-09-18T00:00:00.000Z",
      scenario: "s",
      cluster: "blackholes",
      description: null,
      baseline: "bh_base",
      seed: 42,
      models: { judge: "judge-model" },
      targets: [target],
      campaign: null,
      summary: summarizeAdversarial([target], null),
      judgeCostMicroUsd: 500,
      runDir: "runs/x",
    };
    const md = renderAdversarialReport(report);
    expect(md).toContain("# Adversarial robustness — s");
    expect(md).toContain("bh_base");
    expect(md).toContain("loudest");
    expect(md).toContain("legitimacy gap");
    expect(md).toContain("admitted_not_reassessed");
    expect(md).toContain("blind seed 42");
    expect(md).toContain("because"); // the judge's reasoning is in the report
    expect(md).toContain("read it"); // the expect note is beside the outcome
  });
});
