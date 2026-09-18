import Link from "next/link";
import { getEvalsIndex, type ReplaySummary } from "@/lib/evals";
import { getReplays, replayModels } from "@/lib/replay";
import { modelDisplayName } from "@/lib/model-names";
import s from "@/app/docs/evals/evals.module.css";
import r from "./replays.module.css";

// The replays index (#334): one card per committed recording. Reads the
// evals index's `replays` line when the sync wrote one, else the files
// themselves; either way an empty directory is a state, not an error.

export const metadata = {
  title: "Replays · Evals · Minerval",
  description: "Recordings of the agents building a claim graph, played back event by event: every prompt, every tool call, every change to the graph.",
};

function fmtUsd(micro: number | null | undefined): string {
  return micro == null ? "n/a" : `$${(micro / 1_000_000).toFixed(2)}`;
}

function summaries(): ReplaySummary[] {
  let index: ReplaySummary[] | undefined;
  try {
    index = getEvalsIndex().replays;
  } catch {
    index = undefined;
  }
  if (index?.length) return index;
  return getReplays().map(({ name, replay }) => ({
    name,
    kind: replay.kind,
    title: replay.title,
    cluster: replay.cluster,
    generatedAt: replay.generatedAt,
    arms: (replay.arms ?? []).map((a) => a.label ?? a.key),
    events: (replay.arms ?? []).reduce((n, a) => n + (a.events?.length ?? 0), 0),
    models: replayModels(replay),
    costMicroUsd: replay.costMicroUsd,
  }));
}

export default function ReplaysIndex() {
  const items = summaries();
  return (
    <div>
      <p className="sc" style={{ marginBottom: "1rem" }}><Link href="/docs/evals">← evals</Link></p>
      <h1>Replays</h1>
      <p className="lede" style={{ fontSize: "1.02rem", marginBottom: "1.2rem" }}>
        A scorecard says how a graph came out. A replay shows how it was built: the sources landing one by one, the Extractor listing claims, the Matcher searching and deciding, each Steward&rsquo;s tool calls and verdict, the Curator&rsquo;s merges; for a two-arm episode, the same sources building two graphs side by side. Everything in a recording is derived from what the run wrote; nothing is narrated.
      </p>

      {items.length === 0 ? (
        <p className={s.small} style={{ border: "1px dashed var(--rule)", borderRadius: 4, padding: "0.8rem 1rem", maxWidth: "36rem" }}>
          No recordings committed yet. Every driver that runs the real agents writes one at <code>runs/&lt;run&gt;/replay.json</code>; commit the ones worth showing as <code>corpus/replays/&lt;name&gt;.json</code> and run the sync.
        </p>
      ) : (
        <div className={r.cards}>
          {items.map((it) => (
            <Link key={it.name} href={`/docs/evals/replays/${encodeURIComponent(it.name)}`} className={r.card}>
              <span className={r.cardHead}>
                <span className="tag kind">{it.kind}</span>
                {it.cluster ? <span className="tag">{it.cluster}</span> : null}
                <span className={r.date}>{it.generatedAt.slice(0, 10)}</span>
              </span>
              <span className={r.cardTitle}>{it.title}</span>
              <span className={r.cardMeta}>
                {it.arms.length} arm{it.arms.length === 1 ? "" : "s"} · {it.events} events · {fmtUsd(it.costMicroUsd)}
              </span>
              <span className={r.cardArms}>{it.arms.join(" · ")}</span>
              <span className={r.cardModels}>
                {Object.entries(it.models).filter(([, m]) => m).map(([agent, m]) => (
                  <span key={agent}><b>{agent}</b> {modelDisplayName(m!)}</span>
                ))}
              </span>
            </Link>
          ))}
        </div>
      )}

      <p className={s.small} style={{ marginTop: "1.4rem", maxWidth: "36rem" }}>
        What a replay cannot show: anything the trace did not record. A run traced <code>off</code> yields events with no steps, and the player says so. The player refuses a schema version it does not know.
      </p>
    </div>
  );
}
