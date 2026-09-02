/**
 * The run fingerprint (#334 L1): which epoch, prompts, models and caps
 * produced the graph a scorecard measures. Comparisons only mean something
 * within a fingerprint, and a fingerprint is only trustworthy if it is
 * recorded when the graph is BUILT, not when it is scored — the first epoch
 * baseline (#349) recorded the Matcher as Haiku because scoring read config
 * at score time while ingestion had run under a MATCHER_MODEL override.
 *
 * So `corpus:run` records the fingerprint at run start (configured models and
 * caps) and at run end (the models actually observed in llm_usage over the
 * run window), and `corpus:score` reads it back rather than re-deriving it.
 * Pure helpers here; the DB and env plumbing live in run.ts / score.ts.
 */

export type ModelsSource = "run" | "registry" | "score-time";

export interface AgentModels {
  extractor?: string;
  matcher: string;
  steward: string;
  curator: string;
  /** Chosen at score time, never part of the ingest. */
  judge: string;
}

export interface ScorecardConfig {
  pipelineEpoch: string;
  gitCommit: string | null;
  models: AgentModels;
  /**
   * Where the agent models came from: recorded by corpus:run ("run"), read
   * back from that run's registry row ("registry"), or config at score time
   * ("score-time" — the fallback when no ingest row exists, correct only if
   * nothing changed between the run and the score).
   */
  modelsSource?: ModelsSource;
  /** `--profile=<name>` in force for the run, if any. */
  profile?: string | null;
  /**
   * Models actually observed in llm_usage during the run window, per agent,
   * most-called first. Normally one per agent; a second entry means a
   * fallback fired (refusal → EXTRACTOR_FALLBACK_MODEL, server-side Opus).
   */
  observed?: Record<string, string[]>;
  /** The spend caps in force — a capped run is a partial baseline. */
  caps?: Record<string, number>;
}

export interface UsageRow {
  agent: string;
  model: string;
  calls: number;
}

/** Group llm_usage rows into per-agent model lists, most-called first. */
export function observedModels(rows: UsageRow[]): Record<string, string[]> {
  const byAgent = new Map<string, Array<{ model: string; calls: number }>>();
  for (const r of rows) {
    const list = byAgent.get(r.agent) ?? [];
    const existing = list.find((x) => x.model === r.model);
    if (existing) existing.calls += r.calls;
    else list.push({ model: r.model, calls: r.calls });
    byAgent.set(r.agent, list);
  }
  const out: Record<string, string[]> = {};
  for (const [agent, list] of [...byAgent.entries()].sort()) {
    out[agent] = list.sort((a, b) => b.calls - a.calls).map((x) => x.model);
  }
  return out;
}

/**
 * The steward model the graph was actually built with: observed if we have
 * it (the run recorded what ran), else the configured one.
 */
export function effectiveStewardModel(config: ScorecardConfig): string {
  return config.observed?.steward?.[0] ?? config.models.steward;
}

/**
 * The judge must never share a model with the agent under test — the rule
 * SCORING.md has always stated and the first baseline broke (Sonnet Steward
 * judged by Sonnet). Returns a reason when `judgeModel` collides with the
 * Steward that produced the graph, null when it is fine.
 */
export function judgeConflict(
  config: ScorecardConfig,
  judgeModel: string
): string | null {
  const steward = effectiveStewardModel(config);
  if (judgeModel === steward) {
    return (
      `judge model ${judgeModel} is the Steward model that produced this graph — ` +
      `an agent must not grade its own output with its own framing (corpus/SCORING.md). ` +
      `Set JUDGE_MODEL to a different model, or pass --allow-same-model-judge to override.`
    );
  }
  return null;
}
