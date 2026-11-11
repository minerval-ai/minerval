import { notFound } from "next/navigation";
import { Fingerprint } from "@/components/evals/Bits";
import { ReplayPlayer } from "@/components/evals/replay/ReplayPlayer";
import { getReplay, getReplays, isKnownVersion } from "@/lib/replay";
import type { ScorecardConfig } from "@/lib/evals";
import r from "../replays.module.css";
import { PageHead } from "@/components/PageHead";

// One recording (#334): header (title, about, each arm's fingerprint as the
// record it is), then the player. The JSON index is read at the server and
// handed to the client player; the per-event detail files are fetched from
// web/public by the player when a reader opens a step.

export function generateStaticParams() {
  return getReplays().map((x) => ({ name: x.name }));
}

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const replay = getReplay(name);
  return {
    title: replay ? `${replay.title} · Replays · Minerval` : "Replay · Minerval",
    description: replay?.about,
  };
}

function fmtUsd(micro: number | null | undefined): string {
  return micro == null ? "n/a" : `$${(micro / 1_000_000).toFixed(2)}`;
}

export default async function ReplayPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const replay = getReplay(name);
  if (!replay) notFound();
  const known = isKnownVersion(replay);
  const arms = known ? replay.arms : [];
  const events = arms.reduce((n, a) => n + a.events.length, 0);

  return (
    <div className={r.wide}>
      <PageHead
        back={{ href: "/docs/evals/replays", label: "replays" }}
        kicker="Replay"
        tags={
          <>
            <span className="tag kind">{replay.kind}</span>
            {replay.cluster ? <span className="tag">{replay.cluster}</span> : null}
          </>
        }
        title={replay.title}
        meta={
          <>
            generated {String(replay.generatedAt ?? "").slice(0, 10)} · {arms.length} arm{arms.length === 1 ? "" : "s"} ·{" "}
            {events} events · cost {fmtUsd(replay.costMicroUsd)}
            {replay.evalRunId ? <> · eval run <code>{replay.evalRunId}</code></> : null}
          </>
        }
        lede={replay.about}
      />

      {known && arms.length > 0 ? (
        <details style={{ margin: "0 0 1rem" }}>
          <summary className="sc" style={{ cursor: "pointer" }}>Fingerprint{arms.length > 1 ? "s" : ""}: what built each arm</summary>
          <div className={r.fps}>
            {arms.map((arm) => {
              const config: ScorecardConfig = {
                pipelineEpoch: arm.fingerprint.pipelineEpoch ?? "unknown",
                gitCommit: arm.fingerprint.gitCommit,
                models: arm.fingerprint.models,
                modelsSource: "run",
                profile: arm.fingerprint.profile,
                swap: arm.fingerprint.swap,
                order: arm.fingerprint.order,
                caps: arm.fingerprint.caps,
              };
              return (
                <div key={arm.key}>
                  <p className="sc">{arm.label}{arm.variation ? ` · ${arm.variation}` : ""}</p>
                  <Fingerprint config={config} generatedAt={replay.generatedAt} judgeCost={null} />
                </div>
              );
            })}
          </div>
        </details>
      ) : null}

      <ReplayPlayer replay={replay} name={name} />
    </div>
  );
}
