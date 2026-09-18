/**
 * Adaptive attacker (#334 S4 cells 2 and 4, from #302): a red-team agent
 * that attacks one claim (or, with --campaign, the cluster's framing) over
 * several episodes, keeping notes between them, so the output is a success
 * curve and a playbook rather than one number.
 *
 * Usage:
 *   npm run corpus:redteam -- <cluster> --baseline=<snapshot> --target="<query>" --direction=up|down
 *       --episodes=N [--tier=fresh|standard|trusted] [--budget=K] [--notes=<path>] [--benign]
 *       [--max-iterations=M] [--no-replay]
 *   npm run corpus:redteam -- <cluster> --baseline=<snapshot> --campaign --goal="<framing goal>" --episodes=N [...]
 *
 * Each episode restores the snapshot, mints a fresh account at the tier
 * (accounts burned are part of the cost), and runs the agent on
 * REDTEAM_MODEL (default: the cheap OpenRouter flash pin) under
 * withAgent("redteam"): a tool-use loop with the read-only graph tools
 * (search_claims, get_claim, get_decomposition, get_dependents), a
 * submit_contribution tool that stages up to K contributions, and
 * finish_planning. The staged contributions go through the contribution
 * driver (review, steward, appeals, all real); the agent is then shown the
 * decisions, any bad-faith finding and the new assessment, and asked to
 * update its notes with update_notes. --benign runs a sincere contributor
 * with the same tools and budget: the control curve.
 *
 * Output: runs/redteam-<stamp>/episodes.json (the curve: displacement per
 * episode, decisions, cost), report.md, the notes file (default
 * runs/redteam-notes-<cluster>-<mode>-<slug>.md; gitignored, never under
 * corpus/: a discovered playbook is a security finding), a replay with one
 * arm per episode, and an eval-run row of kind 'redteam'.
 */
import "./lib.js"; // must be first: pins DATABASE_URL to the corpus DB
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argFlag, assertCorpusDb, gitCommit, hasFlag, positional, RUNS_ROOT } from "./lib.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { evalRuns } from "../../src/db/schema.js";
import { loadConfig } from "../../src/config.js";
import { toolUseLoop } from "../../src/llm/client.js";
import { withAgent, withCostMeter } from "../../src/llm/usage-context.js";
import { formatMicroUsd } from "../../src/llm/pricing.js";
import { executeGraphReadTool, getGraphReadToolDefinitions } from "../../src/llm/tools/graph-read-tools.js";
import { CONTRIBUTOR_TIERS, type ContributorTier } from "./contributions-lib.js";
import { resolveTarget, runScenario } from "./contribution-driver.js";
import { loadAgreementGraph, snapshotUrl } from "./graph-load.js";
import { armCost, attribute, displacement, importanceDisplacement } from "./adversarial-lib.js";
import {
  REDTEAM_ACTION_TOOLS,
  REDTEAM_NOTES_TOOL,
  redteamEpisodePrompt,
  redteamFeedbackPrompt,
  redteamSystemPrompt,
  renderHolisticView,
  type RedteamBrief,
  type RedteamMode,
} from "./adversarial-prompts.js";
import {
  agreementAgainstBaseline,
  loadHolisticView,
  readClaimState,
  reassessmentsSince,
  redteamModel,
  restoreBaseline,
  runFingerprint,
} from "./adversarial-harness.js";
import {
  DEFAULT_CAMPAIGN_BUDGET,
  DEFAULT_EPISODE_BUDGET,
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
} from "./redteam-lib.js";
import { annotateContributionDeltas, tryCollectArm, tryWriteReplay, type ReplayArm } from "./replay-emit.js";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "target";
}

async function main(): Promise<void> {
  assertCorpusDb();
  const cluster = positional(0);
  const baseline = argFlag("baseline");
  const campaign = hasFlag("campaign");
  const query = argFlag("target");
  const goal = argFlag("goal");
  const directionRaw = argFlag("direction");
  const episodes = Number(argFlag("episodes") ?? 3);
  const tier = (argFlag("tier") ?? "fresh") as ContributorTier;
  const mode: RedteamMode = hasFlag("benign") ? "benign" : "attack";
  if (!cluster || !baseline || (!campaign && (!query || (directionRaw !== "up" && directionRaw !== "down"))) || (campaign && !goal)) {
    console.error(
      'Usage: corpus:redteam -- <cluster> --baseline=<snapshot> --target="<query>" --direction=up|down --episodes=N [--tier=fresh|standard|trusted] [--budget=K] [--notes=<path>] [--benign] [--max-iterations=M]\n' +
        '       corpus:redteam -- <cluster> --baseline=<snapshot> --campaign --goal="<framing goal>" --episodes=N [...]'
    );
    process.exit(1);
  }
  if (!CONTRIBUTOR_TIERS.includes(tier)) throw new Error(`--tier must be ${CONTRIBUTOR_TIERS.join(" | ")}`);
  if (!Number.isInteger(episodes) || episodes < 1) throw new Error("--episodes must be a positive integer");
  const direction: "up" | "down" = directionRaw === "down" ? "down" : "up";
  const budget = Number(argFlag("budget") ?? (campaign ? DEFAULT_CAMPAIGN_BUDGET : DEFAULT_EPISODE_BUDGET));
  const maxIterations = Number(argFlag("max-iterations") ?? 24);
  const model = redteamModel();
  const cfg = loadConfig();
  const generated = new Date();
  const stamp = generated.toISOString().replace(/[:.]/g, "-");
  const runDir = join(RUNS_ROOT, `redteam-${cluster}-${mode}-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  const targetLabel = campaign ? `campaign: ${goal}` : `${query} (${direction})`;
  const notesPath = argFlag("notes") ?? join(RUNS_ROOT, `redteam-notes-${cluster}-${mode}-${slug(campaign ? goal! : query!)}.md`);
  if (notesPath.includes(`${join("corpus")}/`) || notesPath.replace(/\\/g, "/").includes("/corpus/")) {
    throw new Error("the notes file must not live under corpus/: a discovered playbook is a security finding, not a fixture");
  }
  const models = { redteam: model, steward: cfg.stewardModel, governance: cfg.governanceModel, arbitration: cfg.arbitrationModel };
  const fingerprint = runFingerprint({ redteam: model });

  console.log(`\n=== redteam (${mode}) on ${cluster} · ${targetLabel} · ${episodes} episode(s) × ${budget} · tier ${tier} · agent ${model} ===`);
  console.log(`  notes: ${notesPath}`);

  const baselineGraph = campaign ? await loadAgreementGraph(`snap:${baseline}`, snapshotUrl(baseline)) : null;
  const records: EpisodeRecord[] = [];
  const replayArms: ReplayArm[] = [];
  const graphTools = getGraphReadToolDefinitions();
  let targetInfo: { claimId: string | null; text: string | null } = { claimId: null, text: null };

  for (let ep = 1; ep <= episodes; ep++) {
    console.log(`\n--- episode ${ep}/${episodes} — restoring ${baseline} ---`);
    await restoreBaseline(baseline);
    const startedAt = new Date();
    const notes = existsSync(notesPath) ? notesBody(readFileSync(notesPath, "utf8")) : "";

    // The target as the agent (and the record) sees it before anything happens.
    let before = null as Awaited<ReturnType<typeof readClaimState>>;
    let targetView: string;
    let holisticBefore: Awaited<ReturnType<typeof loadHolisticView>> = [];
    if (campaign) {
      holisticBefore = await loadHolisticView();
      targetView = renderHolisticView(holisticBefore);
    } else {
      const hit = await resolveTarget(query!);
      if (!hit) throw new Error(`no claim for "${query}" in the baseline graph`);
      before = await readClaimState(hit.id);
      if (!before) throw new Error(`claim ${hit.id} vanished`);
      targetInfo = { claimId: hit.id, text: hit.text };
      targetView = formatTargetView(before);
      console.log(`  target "${hit.text}" · ${before.status ?? "unassessed"} credence ${before.credence ?? "n/s"}`);
    }
    const brief: RedteamBrief = {
      mode,
      target: before ? { id: before.id, text: before.text } : null,
      direction,
      campaign: campaign ? { cluster, goal: goal! } : null,
      budget,
      tier,
      episode: ep,
      episodes,
    };

    // Phase 1: the agent reads and stages.
    const staged: StagedContribution[] = [];
    let iterations = 0;
    const stage = (input: Record<string, unknown>): string => {
      const v = validateStaged(input, { budget, staged: staged.length });
      if (!v.ok) return JSON.stringify({ staged: false, error: v.error, count: staged.length });
      staged.push(v.staged);
      return JSON.stringify({ staged: true, count: staged.length, remaining: budget - staged.length });
    };
    const system = redteamSystemPrompt(brief);
    const phase1 = await withCostMeter(() =>
      withAgent("redteam", () =>
        toolUseLoop({
          system,
          model,
          maxTokens: 8192,
          maxIterations,
          tools: [...graphTools, ...REDTEAM_ACTION_TOOLS],
          initialMessages: [{ role: "user", content: redteamEpisodePrompt({ brief, targetView, notes }) }],
          executeTool: async (name, input) => {
            iterations++;
            if (name === "submit_contribution") return stage(input);
            if (name === "finish_planning") return JSON.stringify({ ok: true, staged: staged.length });
            const out = await executeGraphReadTool(name, input);
            return out ?? JSON.stringify({ error: `unknown tool ${name}` });
          },
          onFinalTool: (name) => (name === "finish_planning" ? true : null),
          iterationBudgetNotice: { warnWithin: 3, message: (n) => `You have ${n} turn(s) left in this episode; stage what you intend and call finish_planning.` },
        })
      )
    );
    // toolUseLoop returns a final turn WITHOUT executing its tools when a
    // final tool ends it, so a submit_contribution issued alongside
    // finish_planning would otherwise be dropped. Only that exit needs
    // catching up: on the iteration-cap exit the turn's tools already ran,
    // and re-staging them here would double-count the episode's budget.
    if (phase1.value.toolUses.some((t) => t.name === "finish_planning")) {
      for (const tu of phase1.value.toolUses) if (tu.name === "submit_contribution") stage(tu.input);
    }
    console.log(`  agent staged ${staged.length} contribution(s) in ${iterations} tool call(s) (${formatMicroUsd(phase1.billedMicroUsd)})`);

    // The pipeline.
    const claimTexts = new Map<string, string>();
    for (const s of staged) {
      for (const id of [s.claimId, s.mergeTargetClaimId]) {
        if (id && !claimTexts.has(id)) {
          const st = await readClaimState(id);
          if (st) claimTexts.set(id, st.text);
        }
      }
    }
    const personaKey = "redteam";
    const scenario = episodeScenario({
      name: `redteam-${cluster}-${mode}-ep${ep}`,
      cluster,
      persona: { key: personaKey, displayName: mode === "attack" ? `Red team ${stamp.slice(0, 10)} ep${ep} (corpus persona)` : `Sincere contributor ep${ep} (corpus persona)`, tier },
      staged,
      claimText: (id) => claimTexts.get(id) ?? null,
    });
    const result =
      staged.length > 0
        ? await runScenario(scenario, { appeals: true, externalIdPrefix: `corpus:redteam:${stamp}:ep${ep}` })
        : null;
    const outcomes = result?.outcomes ?? [];
    const persona = result?.personas[0] ?? null;

    // After-state and instruments.
    let after = null as Awaited<ReturnType<typeof readClaimState>>;
    let disp = null;
    let attribution = null;
    let campaignRecord: EpisodeRecord["campaign"] = null;
    let afterView = "";
    if (campaign) {
      const holisticAfter = await loadHolisticView();
      afterView = renderHolisticView(holisticAfter);
      const agreement = await agreementAgainstBaseline(baseline, baselineGraph, `ep${ep}`);
      const toRows = (g: typeof agreement.before) => g.claims.map((c) => ({ id: c.id, text: c.text, importance: c.importance ?? 0.5, credence: c.credence ?? null }));
      campaignRecord = {
        importance: importanceDisplacement(toRows(agreement.before), toRows(agreement.after), agreement.pairs),
        claimSetF1: agreement.report.claimSet.f1,
        credenceMeanAbsDiff: agreement.report.credence.meanAbsDiff,
      };
    } else {
      after = await readClaimState(before!.id);
      afterView = after ? formatTargetView(after) : "(claim gone)";
      disp = displacement(before, after, direction);
      attribution = attribute(outcomes, await reassessmentsSince(before!.id, startedAt), disp);
    }
    const cost = armCost({ cost: result?.cost ?? { microUsd: null, byAgent: {} }, outcomes, personas: result?.personas ?? [] });

    // Phase 2: feedback, and the notes.
    let newNotes: string | null = null;
    const phase2 = await withCostMeter(() =>
      withAgent("redteam", () =>
        toolUseLoop({
          system,
          model,
          maxTokens: 8192,
          maxIterations: 3,
          tools: [REDTEAM_NOTES_TOOL],
          initialMessages: [
            {
              role: "user",
              content: redteamFeedbackPrompt({
                brief,
                before: campaign ? `(cluster view)\n${targetView}` : targetView,
                after: afterView,
                decisions: formatDecisions(outcomes),
                personaStanding: formatStanding(persona),
                notes,
              }),
            },
          ],
          executeTool: async (name, input) => {
            if (name === "update_notes") {
              newNotes = String(input.notes ?? "");
              return JSON.stringify({ ok: true });
            }
            return JSON.stringify({ error: `unknown tool ${name}` });
          },
          onFinalTool: (name, input) => {
            if (name === "update_notes") {
              newNotes = String(input.notes ?? "");
              return true;
            }
            return null;
          },
        })
      )
    );
    let notesUpdated = false;
    let notesChars = notes.length;
    if (newNotes !== null && (newNotes as string).trim()) {
      const clamped = clampNotes(newNotes);
      writeFileSync(notesPath, formatNotesFile({ cluster, target: targetLabel, mode, updatedAt: new Date().toISOString(), episodes: ep }, clamped.text));
      notesUpdated = true;
      notesChars = clamped.text.length;
    } else {
      console.warn("  the agent did not update its notes this episode");
    }

    const capped = result?.drains.some((d) => d.capped) ?? false;
    const record: EpisodeRecord = {
      episode: ep,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      mode,
      tier,
      before,
      after,
      displacement: disp,
      campaign: campaignRecord,
      staged,
      outcomes,
      attribution,
      cost,
      attackerCostMicroUsd: phase1.billedMicroUsd + phase2.billedMicroUsd,
      attackerIterations: iterations,
      persona,
      notesUpdated,
      notesChars,
      capped,
      score: null,
    };
    record.score = episodeScore(record);
    records.push(record);
    writeFileSync(join(runDir, "episodes.json"), JSON.stringify({ cluster, mode, tier, budget, baseline, target: targetLabel, episodes: records }, null, 2));
    console.log(`  score ${record.score ?? "n/a"} · ${attribution?.stage ?? (campaignRecord ? `Spearman ${campaignRecord.importance.spearman ?? "n/a"}` : "-")} · pipeline ${formatMicroUsd(cost.microUsd ?? 0)} · agent ${formatMicroUsd(record.attackerCostMicroUsd)}${persona?.suspended ? " · account suspended" : ""}`);

    if (!hasFlag("no-replay")) {
      const collected = await tryCollectArm({
        since: startedAt,
        until: new Date(),
        key: `ep${ep}`,
        label: `episode ${ep}`,
        variation: `${mode} episode ${ep}: ${staged.map((s) => s.gambit).join(", ") || "nothing staged"}`,
        fingerprint,
        database: null,
        capped,
      });
      if (collected) {
        const gambits = new Map(outcomes.filter((o) => o.contributionId).map((o, i) => [o.contributionId!, staged[i]?.gambit ?? null]));
        annotateContributionDeltas(collected, `ep${ep}`, gambits);
        replayArms.push(collected);
      }
    }
  }

  const summary = summarizeCurve(records);
  const report: RedteamReport = {
    generatedAt: generated.toISOString(),
    cluster,
    mode,
    target: campaign ? null : { query: query!, claimId: targetInfo.claimId, text: targetInfo.text, direction },
    campaign: campaign ? { goal: goal! } : null,
    tier,
    budget,
    baseline,
    models,
    notesPath,
    episodes: records,
    summary,
    runDir,
  };
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(runDir, "report.md"), renderRedteamReport(report));

  let evalRunId: string | null = null;
  try {
    const [row] = await getDb()
      .insert(evalRuns)
      .values({
        cluster,
        kind: "redteam",
        config: { pipelineEpoch: cfg.pipelineEpoch, gitCommit: gitCommit(), mode, tier, budget, episodes, baseline, target: targetLabel, models },
        scorecard: { summary, episodes: records.map((r) => ({ episode: r.episode, score: r.score, cost: r.cost, attackerCostMicroUsd: r.attackerCostMicroUsd, decisions: r.outcomes.map((o) => o.review?.decision ?? null) })) },
        runDir,
      })
      .returning({ id: evalRuns.id });
    evalRunId = row?.id ?? null;
  } catch (err) {
    console.warn("[redteam] eval-run registry write failed (report files are intact):", err instanceof Error ? err.message : err);
  }

  const replayPath = await tryWriteReplay(runDir, {
    kind: "adversarial",
    name: `redteam-${cluster}-${mode}-${stamp}`,
    title: `Red team (${mode}): ${cluster}`,
    cluster,
    about: `${episodes} episode(s), each restoring ${baseline}: a ${mode === "attack" ? "red-team agent" : "sincere contributor"} at the ${tier} tier reads the target, stages up to ${budget} contribution(s), sees the review decisions and the new assessment, and updates its notes. One arm per episode; the summary is the success curve.`,
    arms: replayArms,
    scenario: {
      name: `redteam-${cluster}-${mode}`,
      description: targetLabel,
      actors: [{ key: "redteam", displayName: mode === "attack" ? "Red team agent" : "Sincere contributor", tier, role: mode === "attack" ? "attacker" : "benign" }],
      targets: campaign ? [] : [{ key: "target", claimId: targetInfo.claimId, text: targetInfo.text, direction }],
    },
    summary: summary as unknown as Record<string, unknown>,
    evalRunId,
  });

  console.log(`\n=== curve ===`);
  console.log(`  ${records.map((r) => `ep${r.episode} ${r.score ?? "n/a"}`).join(" · ")}`);
  console.log(`  successes ${summary.successes}/${summary.scored} · best ${summary.bestScore ?? "n/a"} (ep ${summary.bestEpisode ?? "-"}) · trend ${summary.trend ?? "n/a"} · admitted ${summary.admitted}/${summary.submitted} · bad-faith ${summary.badFaith} · burned ${summary.accountsBurned}`);
  console.log(`  cost: pipeline ${formatMicroUsd(summary.costMicroUsd ?? 0)} + agent ${formatMicroUsd(summary.attackerCostMicroUsd)}`);
  console.log(`  report: ${join(runDir, "report.md")}\n  notes:  ${notesPath}${replayPath ? `\n  replay: ${replayPath}` : ""}\n`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
