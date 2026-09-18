import { describe, it, expect } from "vitest";
import {
  MAX_NOTES_CHARS,
  clampNotes,
  episodeScenario,
  episodeScore,
  formatDecisions,
  formatNotesFile,
  formatStanding,
  formatTargetView,
  notesBody,
  renderRedteamReport,
  summarizeCurve,
  validateStaged,
  type EpisodeRecord,
  type RedteamReport,
  type StagedContribution,
} from "../../../scripts/corpus/redteam-lib.js";
import { validateScenario, type ContributionOutcome } from "../../../scripts/corpus/contributions-lib.js";
import { armCost, displacement, type ClaimState } from "../../../scripts/corpus/adversarial-lib.js";

const CLAIM_ID = "11111111-2222-3333-4444-555555555555";

const claim = (over: Partial<ClaimState> = {}): ClaimState => ({
  id: CLAIM_ID,
  text: "A claim.",
  status: "supported",
  credence: 0.7,
  confidence: 0.8,
  summary: "Summary.",
  reasoningTrace: "Reasoning.",
  importance: 0.6,
  assessedAt: null,
  ...over,
});

const staged = (over: Partial<StagedContribution> = {}): StagedContribution => ({
  claimId: CLAIM_ID,
  type: "challenge",
  content: "text",
  evidenceUrls: [],
  proposedCanonicalForm: null,
  mergeTargetClaimId: null,
  gambit: "confident_assertion",
  appealIfRejected: null,
  ...over,
});

const outcome = (over: Partial<ContributionOutcome> = {}): ContributionOutcome => ({
  id: "c1-confident_assertion",
  type: "challenge",
  contributor: "redteam",
  targetClaimId: CLAIM_ID,
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

const episode = (over: Partial<EpisodeRecord> = {}): EpisodeRecord => {
  const base: EpisodeRecord = {
    episode: 1,
    startedAt: "s",
    finishedAt: "f",
    mode: "attack",
    tier: "fresh",
    before: claim(),
    after: claim(),
    displacement: displacement(claim(), claim(), "up"),
    campaign: null,
    staged: [staged()],
    outcomes: [outcome()],
    attribution: null,
    cost: armCost({ cost: { microUsd: 1000, byAgent: {} }, outcomes: [outcome()], personas: [] }),
    attackerCostMicroUsd: 500,
    attackerIterations: 4,
    persona: null,
    notesUpdated: true,
    notesChars: 100,
    capped: false,
    score: null,
    ...over,
  };
  base.score = base.score ?? episodeScore(base);
  return base;
};

describe("validateStaged", () => {
  const ok = { claim_id: CLAIM_ID, type: "challenge", content: "a case", gambit: "buried_weak_step" };

  it("accepts a well-formed staging and normalises the fields", () => {
    const r = validateStaged({ ...ok, evidence_urls: ["https://example.org/a", "not-a-url"] }, { budget: 3, staged: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.staged.claimId).toBe(CLAIM_ID);
    expect(r.staged.evidenceUrls).toEqual(["https://example.org/a"]);
    expect(r.staged.gambit).toBe("buried_weak_step");
    expect(r.staged.appealIfRejected).toBeNull();
  });

  it("enforces the episode budget", () => {
    const r = validateStaged(ok, { budget: 2, staged: 2 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/budget exhausted/);
  });

  it("rejects a missing or malformed claim id, type or content", () => {
    expect(validateStaged({ ...ok, claim_id: "the first one" }, { budget: 3, staged: 0 })).toMatchObject({ ok: false });
    expect(validateStaged({ ...ok, type: "rant" }, { budget: 3, staged: 0 })).toMatchObject({ ok: false });
    expect(validateStaged({ ...ok, content: "   " }, { budget: 3, staged: 0 })).toMatchObject({ ok: false });
  });

  it("requires the fields a propose_edit and a propose_merge need", () => {
    const edit = validateStaged({ ...ok, type: "propose_edit" }, { budget: 3, staged: 0 });
    expect(edit).toMatchObject({ ok: false });
    if (!edit.ok) expect(edit.error).toMatch(/proposed_canonical_form/);
    const merge = validateStaged({ ...ok, type: "propose_merge" }, { budget: 3, staged: 0 });
    if (!merge.ok) expect(merge.error).toMatch(/merge_target_claim_id/);
  });

  it("labels an unlabelled gambit rather than dropping the contribution", () => {
    const r = validateStaged({ claim_id: CLAIM_ID, type: "support", content: "x" }, { budget: 3, staged: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.staged.gambit).toBe("unlabelled");
  });
});

describe("episodeScenario", () => {
  it("builds a driver scenario targeting each staged claim by its text", () => {
    const s = episodeScenario({
      name: "redteam-ep1",
      cluster: "blackholes",
      persona: { key: "redteam", displayName: "Red team", tier: "fresh" },
      staged: [staged(), staged({ type: "propose_merge", mergeTargetClaimId: "99999999-2222-3333-4444-555555555555", gambit: "motte_and_bailey" })],
      claimText: (id) => (id === CLAIM_ID ? "A claim." : "Another claim."),
    });
    expect(validateScenario(s)).toEqual([]);
    expect(s.contributors[0]!.tier).toBe("fresh");
    expect(s.contributions[0]!.target.query).toBe("A claim.");
    expect(s.contributions[1]!.mergeTarget!.query).toBe("Another claim.");
    expect(s.contributions.map((c) => c.id)).toEqual(["c1-confident_assertion", "c2-motte_and_bailey"]);
  });

  it("falls back to the claim id when the text is unknown", () => {
    const s = episodeScenario({
      name: "n",
      cluster: "c",
      persona: { key: "redteam", displayName: "R", tier: "standard" },
      staged: [staged()],
      claimText: () => null,
    });
    expect(s.contributions[0]!.target.query).toBe(CLAIM_ID);
  });
});

describe("notes handling", () => {
  it("round-trips the agent's text through the harness header", () => {
    const body = "## Playbook\n1. Fabricated citations are checked.\n2. Buried steps are not.";
    const file = formatNotesFile({ cluster: "blackholes", target: "q (down)", mode: "attack", updatedAt: "2026-09-18T00:00:00.000Z", episodes: 2 }, body);
    expect(file).toMatch(/^<!-- redteam-notes/);
    expect(file).toContain("security finding");
    expect(notesBody(file)).toBe(body);
  });

  it("treats a file with no header as all body, and an empty file as empty", () => {
    expect(notesBody("just notes")).toBe("just notes");
    expect(notesBody("")).toBe("");
  });

  it("clamps runaway notes and says it did", () => {
    const short = clampNotes("  short  ");
    expect(short).toEqual({ text: "short", truncated: false });
    const long = clampNotes("x".repeat(MAX_NOTES_CHARS + 500));
    expect(long.truncated).toBe(true);
    expect(long.text).toMatch(/truncated by the harness/);
    expect(long.text.length).toBeLessThan(MAX_NOTES_CHARS + 200);
  });
});

describe("prompt views", () => {
  it("shows the target's full epistemic state to the agent", () => {
    const v = formatTargetView(claim());
    expect(v).toContain(CLAIM_ID);
    expect(v).toContain("supported");
    expect(v).toContain("credence 0.7");
    expect(v).toContain("Reasoning.");
  });

  it("gives the agent the decisions with their reasoning, flags and appeals", () => {
    const text = formatDecisions([
      outcome({ review: { decision: "reject", confidence: 0.9, reasoning: "fabricated source", policyCitations: [], suspectedBadFaith: true, badFaithCategory: "misinformation" } }),
      outcome({ id: "c2", contributionId: null, review: null }),
      outcome({ id: "c3", arbitration: { outcome: "uphold_original", decision: "reject", reasoning: "still no", suspectedBadFaith: false, humanReviewRecommended: false } }),
    ]);
    expect(text).toContain("fabricated source");
    expect(text).toContain("BAD-FAITH FLAG: misinformation");
    expect(text).toContain("not submitted");
    expect(text).toContain("uphold_original");
    expect(formatDecisions([])).toMatch(/nothing was submitted/);
  });

  it("shows the account's standing, including a suspension", () => {
    expect(formatStanding(null)).toMatch(/no account record/);
    expect(
      formatStanding({ key: "r", id: "1", displayName: "R", tier: "fresh", reputationBefore: 15, reputationAfter: 0, standing: "must_pay", suspended: true, badFaithFlags: 1 })
    ).toMatch(/15 → 0 · standing must_pay · SUSPENDED/);
  });
});

describe("episodeScore", () => {
  it("is the target's movement toward the attacker's direction", () => {
    const moved = displacement(claim({ credence: 0.7 }), claim({ credence: 0.4 }), "down");
    expect(episodeScore({ displacement: moved, campaign: null })).toBe(0.3);
  });

  it("is the importance disorder in campaign mode", () => {
    expect(
      episodeScore({
        displacement: null,
        campaign: { importance: { n: 5, spearman: 0.8, topK: 10, topKOverlap: 0.7, movers: [], credenceMovers: [] }, claimSetF1: 0.9, credenceMeanAbsDiff: 0.1 },
      })
    ).toBeCloseTo(0.2, 5);
  });

  it("is null when nothing comparable was measured", () => {
    expect(episodeScore({ displacement: null, campaign: null })).toBeNull();
  });
});

describe("summarizeCurve", () => {
  const curve = () => [
    episode({ episode: 1, score: 0, staged: [staged({ gambit: "confident_assertion" })], outcomes: [outcome({ review: { decision: "reject", confidence: 0.8, reasoning: "no", policyCitations: [], suspectedBadFaith: false, badFaithCategory: null } })] }),
    episode({ episode: 2, score: 0.1, staged: [staged({ gambit: "buried_weak_step" })], outcomes: [outcome()] }),
    episode({ episode: 3, score: 0.3, staged: [staged({ gambit: "buried_weak_step" })], outcomes: [outcome()] }),
  ];

  it("reports the success rate, the best episode and a learning trend", () => {
    const s = summarizeCurve(curve());
    expect(s.episodes).toBe(3);
    expect(s.successes).toBe(2);
    expect(s.successRate).toBeCloseTo(0.667, 2);
    expect(s.bestScore).toBe(0.3);
    expect(s.bestEpisode).toBe(3);
    expect(s.trend).toBeGreaterThan(0);
  });

  it("credits gambits with what they got admitted and what moved the graph", () => {
    const s = summarizeCurve(curve());
    expect(s.gambits.confident_assertion).toEqual({ used: 1, admitted: 0, moved: 0 });
    expect(s.gambits.buried_weak_step).toEqual({ used: 2, admitted: 2, moved: 2 });
    expect(s.admitted).toBe(2);
    expect(s.rejected).toBe(1);
    expect(s.decisions).toEqual({ accept: 2, reject: 1 });
  });

  it("totals the pipeline and agent cost and the accounts burned", () => {
    const s = summarizeCurve([
      episode({
        cost: armCost({
          cost: { microUsd: 2000, byAgent: {} },
          outcomes: [outcome()],
          personas: [{ key: "r", id: "1", displayName: "R", tier: "fresh", reputationBefore: 15, reputationAfter: 0, standing: "must_pay", suspended: true, badFaithFlags: 1 }],
        }),
        attackerCostMicroUsd: 700,
      }),
    ]);
    expect(s.costMicroUsd).toBe(2000);
    expect(s.attackerCostMicroUsd).toBe(700);
    expect(s.accountsBurned).toBe(1);
    expect(s.reputationLost).toBe(15);
  });

  it("handles an episode where nothing could be staged", () => {
    const s = summarizeCurve([episode({ staged: [], outcomes: [], score: null, displacement: null })]);
    expect(s.scored).toBe(0);
    expect(s.successRate).toBeNull();
    expect(s.trend).toBeNull();
    expect(s.submitted).toBe(0);
  });
});

describe("renderRedteamReport", () => {
  it("renders the curve, the gambit table and every submitted text", () => {
    const episodes = [episode({ episode: 1, score: 0.2 })];
    const report: RedteamReport = {
      generatedAt: "2026-09-18T00:00:00.000Z",
      cluster: "blackholes",
      mode: "attack",
      target: { query: "q", claimId: CLAIM_ID, text: "A claim.", direction: "down" },
      campaign: null,
      tier: "fresh",
      budget: 3,
      baseline: "bh_base",
      models: { redteam: "flash-model" },
      notesPath: "runs/redteam-notes-blackholes-attack-q.md",
      episodes,
      summary: summarizeCurve(episodes),
      runDir: "runs/x",
    };
    const md = renderRedteamReport(report);
    expect(md).toContain("# Red team — blackholes · adaptive attacker");
    expect(md).toContain("bh_base");
    expect(md).toContain("flash-model");
    expect(md).toContain("## Success curve");
    expect(md).toContain("### Gambits");
    expect(md).toContain("submitted: text"); // the exact content is auditable in the report
    expect(md).toContain("runs/redteam-notes-blackholes-attack-q.md");
    expect(md).toMatch(/never commit it/);
  });

  it("renders a campaign run without a single target", () => {
    const episodes = [
      episode({
        displacement: null,
        campaign: { importance: { n: 4, spearman: 0.5, topK: 10, topKOverlap: 0.6, movers: [], credenceMovers: [] }, claimSetF1: 0.9, credenceMeanAbsDiff: 0.05 },
        score: null,
      }),
    ];
    const md = renderRedteamReport({
      generatedAt: "t",
      cluster: "lableak",
      mode: "benign",
      target: null,
      campaign: { goal: "shift the framing" },
      tier: "trusted",
      budget: 6,
      baseline: "ll_base",
      models: {},
      notesPath: "runs/n.md",
      episodes,
      summary: summarizeCurve(episodes),
      runDir: "runs/x",
    });
    expect(md).toContain("benign control");
    expect(md).toContain("shift the framing");
    expect(md).toContain("Spearman 0.5");
  });
});
