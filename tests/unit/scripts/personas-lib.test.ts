/**
 * Persona simulation (#334 S8), the pure half: the committed manifest is
 * well-formed and covers every kind, the budget parses, the triage
 * deduplicates and ranks, the summary counts, and the prompt/tool builders
 * say what the manifest says.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  budgetIterations,
  parseBudget,
  personasForCluster,
  renderReport,
  summarizeOutcomes,
  triageFindings,
  validateManifest,
  type PersonaFinding,
  type PersonaManifest,
  type PersonaOutcome,
} from "../../../scripts/corpus/personas-lib.js";
import {
  SIMULATION_NOTICE,
  buildPersonaOpeningMessage,
  buildPersonaSystemPrompt,
  personaActionToolDefinitions,
  personaToolNames,
} from "../../../scripts/corpus/persona-prompts.js";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(here, "../../../corpus/personas/manifest.json"), "utf8")) as PersonaManifest;

describe("the committed manifest", () => {
  it("is valid, has twenty personas across every kind, with an adversarial minority", () => {
    expect(validateManifest(MANIFEST)).toEqual([]);
    expect(MANIFEST.personas).toHaveLength(20);
    const kinds = new Map<string, number>();
    for (const p of MANIFEST.personas) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
    expect([...kinds.keys()].sort()).toEqual(["adversarial", "contributor", "programmatic", "reader"]);
    expect(kinds.get("adversarial")!).toBeLessThan(MANIFEST.personas.length / 2);
    const tactics = new Set(MANIFEST.personas.filter((p) => p.kind === "adversarial").map((p) => p.tactic));
    expect(tactics).toEqual(new Set(["sea-lion", "spam", "sockpuppet", "prompt-injection"]));
    expect(MANIFEST.personas.some((p) => p.appeals)).toBe(true);
    expect(new Set(MANIFEST.personas.map((p) => p.tier))).toEqual(new Set(["fresh", "standard", "trusted"]));
  });

  it("selects by cluster and by key", () => {
    const eggs = personasForCluster(MANIFEST, "eggs");
    expect(eggs.some((p) => p.key === "first-timer")).toBe(true);
    expect(eggs.some((p) => p.key === "domain-expert")).toBe(false);
    expect(eggs.some((p) => p.key === "spammer")).toBe(true); // "*"
    expect(personasForCluster(MANIFEST, "eggs", ["spammer", "nobody"]).map((p) => p.key)).toEqual(["spammer"]);
  });
});

describe("parseBudget", () => {
  it("parses keys, defaults the rest to zero, and sizes the loop", () => {
    const b = parseBudget("reads:6 contributions:2 findings:1");
    expect(b).toEqual({ reads: 6, contributions: 2, proposals: 0, findings: 1 });
    expect(budgetIterations(b)).toBe(13);
  });
  it("rejects unknown keys and malformed tokens", () => {
    expect(() => parseBudget("reads:x")).toThrow(/not <key>:<n>/);
    expect(() => parseBudget("likes:3")).toThrow(/unknown/);
  });
});

describe("validateManifest", () => {
  const base = MANIFEST.personas[0]!;
  it("names the problems", () => {
    const bad: PersonaManifest = {
      name: "",
      personas: [
        { ...base, key: "a", kind: "programmatic", budget: "reads:2 contributions:1" },
        { ...base, key: "a", tier: "vip" as never, budget: "" },
        { ...base, key: "b", kind: "adversarial", budget: "reads:1" },
        { ...base, key: "c", kind: "reader", pairWith: "zzz", budget: "reads:1" },
      ],
    };
    const problems = validateManifest(bad);
    expect(problems).toContain("manifest needs a name");
    expect(problems).toContain("duplicate key a");
    expect(problems.some((p) => p.includes("programmatic clients only read"))).toBe(true);
    expect(problems.some((p) => p.includes('unknown tier "vip"'))).toBe(true);
    expect(problems.some((p) => p.includes("budget allows no action"))).toBe(true);
    expect(problems.some((p) => p.includes("adversarial personas name a tactic"))).toBe(true);
    expect(problems.some((p) => p.includes('pairWith "zzz" not in manifest'))).toBe(true);
  });
  it("rejects an adversarial majority", () => {
    const m: PersonaManifest = {
      name: "x",
      personas: [
        { ...base, key: "a", kind: "adversarial", tactic: "spam" },
        { ...base, key: "b", kind: "adversarial", tactic: "spam" },
        { ...base, key: "c", kind: "reader", budget: "reads:1" },
      ],
    };
    expect(validateManifest(m)).toContain("the adversarial minority is not a minority");
  });
});

describe("triageFindings", () => {
  const f = (persona: string, severity: PersonaFinding["severity"], where: string, what: string): PersonaFinding => ({
    persona, severity, where, what, expected: "something else",
  });
  it("clusters near-duplicates by where+what, keeps the max severity, and ranks by severity × count", () => {
    const out = triageFindings([
      f("a", "low", "search_claims for egg cholesterol", "search returned claims about black holes instead of eggs"),
      f("b", "medium", "search_claims egg cholesterol", "the search for egg cholesterol returned black hole claims"),
      f("c", "high", "get_claim assessment", "assessment reasoning references a subclaim that is not in the decomposition"),
      f("d", "low", "get_claim provenance", "instances list has no source url"),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]!.count).toBe(2);
    expect(out[0]!.severity).toBe("medium");
    expect(out[0]!.score).toBe(4);
    expect(out[0]!.personas).toEqual(["a", "b"]);
    expect(out[1]!.severity).toBe("high");
    expect(out[1]!.score).toBe(3);
    expect(out[2]!.score).toBe(1);
  });
  it("ignores ids and stopwords when comparing", () => {
    const out = triageFindings([
      f("a", "low", "get_claim 0123456789abcdef", "the claim has no assessment"),
      f("b", "low", "get_claim fedcba9876543210", "claim has no assessment"),
    ]);
    expect(out).toHaveLength(1);
  });
});

function outcome(over: Partial<PersonaOutcome>): PersonaOutcome {
  return {
    key: "k", name: "N", kind: "contributor", tier: "fresh", tactic: null, runId: null, model: "m", iterations: 3, stopReason: "end_turn",
    closing: "done", budget: parseBudget("reads:2 contributions:2 findings:1"), exhausted: [], reads: [], contributions: [], proposals: [], findings: [],
    toolErrors: [], reputation: { before: 50, after: 50, standing: "good", suspended: false, badFaithFlags: 0 }, costMicroUsd: 100,
    ...over,
  };
}

describe("summarizeOutcomes", () => {
  it("counts decisions and reports the adversarial minority separately", () => {
    const contribution = (decision: string | null, badFaith = false) => ({
      contributionId: "c1", type: "support" as const, claimId: "x", targetText: "t", content: "c", evidenceUrls: [], proposedCanonicalForm: null,
      mergeTargetClaimId: null, error: null, reviewStatus: decision ? "reviewed" : "pending",
      review: decision ? { decision, confidence: 0.8, reasoning: "r", policyCitations: [], suspectedBadFaith: badFaith, badFaithCategory: badFaith ? "spam" : null } : null,
      escalationReason: null, appeal: null, arbitration: null, claimChange: null,
    });
    const outcomes = [
      outcome({ key: "good", contributions: [contribution("accept")], findings: [{ persona: "good", severity: "high", where: "w", what: "x", expected: "e" }] }),
      outcome({
        key: "spam", kind: "adversarial", tactic: "spam",
        contributions: [contribution("reject", true), contribution(null)],
        reputation: { before: 50, after: 40, standing: "must_pay", suspended: false, badFaithFlags: 1 },
        exhausted: ["contributions"],
      }),
    ];
    const triaged = triageFindings(outcomes.flatMap((o) => o.findings));
    const s = summarizeOutcomes(outcomes, triaged);
    expect(s.byKind).toEqual({ contributor: 1, adversarial: 1 });
    expect(s.contributionsSubmitted).toBe(3);
    expect(s.contributionDecisions).toEqual({ accept: 1, reject: 1, pending: 1 });
    expect(s.findings).toBe(1);
    expect(s.findingClusters).toBe(1);
    expect(s.exhausted).toEqual([{ persona: "spam", keys: ["contributions"] }]);
    expect(s.personaCostMicroUsd).toBe(200);
    expect(s.adversarial).toHaveLength(1);
    expect(s.adversarial[0]).toMatchObject({ key: "spam", tactic: "spam", submitted: 2, rejected: 1, pending: 1, badFaithFlags: 1, standing: "must_pay", reputationDelta: -10, landed: [] });
    const md = renderReport({ manifest: MANIFEST, cluster: "eggs", outcomes, triaged, summary: s, totalCostMicroUsd: 5000, generatedAt: "now" });
    expect(md).toContain("## The adversarial minority");
    expect(md).toContain("A human reads this list before any issue is opened");
    expect(md).toContain("| N | spam | 2 | 1 | 0 | 0 | 1 | 0 (0) | must_pay | -10.0 |");
  });
});

describe("persona prompts", () => {
  it("build the system prompt from the manifest entry and the simulation notice", () => {
    const entry = MANIFEST.personas.find((p) => p.key === "careful-sceptic")!;
    const prompt = buildPersonaSystemPrompt(entry, { cluster: "lableak", clusterDescription: "the origin of SARS-CoV-2" });
    expect(prompt.startsWith(SIMULATION_NOTICE)).toBe(true);
    expect(prompt).toContain("isolated evaluation deployment");
    expect(prompt).toContain(`Name: ${entry.name}`);
    for (const g of entry.goals) expect(prompt).toContain(g);
    expect(prompt).toContain(entry.style);
    expect(prompt).toContain('"lableak" corpus: the origin of SARS-CoV-2');
    expect(prompt).toContain("8 reads");
    expect(prompt).toContain("2 contributions");
    expect(prompt).toContain("Tools available to you: search_claims, get_claim, submit_contribution, propose_claim, file_finding.");
    expect(prompt).not.toContain("## A note on your role");
    const adversarial = buildPersonaSystemPrompt(MANIFEST.personas.find((p) => p.key === "spammer")!, { cluster: "eggs" });
    expect(adversarial).toContain("## A note on your role");
    const programmatic = buildPersonaSystemPrompt(MANIFEST.personas.find((p) => p.key === "scraper")!, { cluster: "eggs" });
    expect(programmatic).not.toContain("contribution");
  });

  it("gate tools by kind and carry the opening and the pair addendum", () => {
    expect(personaToolNames("reader")).toEqual(["search_claims", "get_claim", "propose_claim", "file_finding"]);
    expect(personaToolNames("programmatic")).toEqual(["search_claims", "get_claim", "file_finding"]);
    expect(personaToolNames("adversarial")).toHaveLength(5);
    expect(personaActionToolDefinitions().map((t) => t.name)).toEqual(["submit_contribution", "propose_claim", "file_finding"]);
    const entry = MANIFEST.personas.find((p) => p.key === "first-timer")!;
    expect(buildPersonaOpeningMessage(entry)).toContain(entry.opening!);
    expect(buildPersonaOpeningMessage(entry, "Your other account did X")).toContain("Your other account did X");
  });
});
