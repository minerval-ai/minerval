import { pipelineOf, type Pipeline as PipelineModel, type PipelineInput } from "@/lib/pipeline";
import "./pipeline.css";

export { pipelineOf, type PipelineInput };

/**
 * Where one version of a node's page stands under a release, as one status:
 * four step bars (Redact, Audit, Release, Shown) and a word (lib/pipeline.ts).
 * Give it the version as either side describes it, or an already-made status.
 */
export function Pipeline({ of, status, pill = true }: { of?: PipelineInput; status?: PipelineModel; pill?: boolean }) {
  const p = status ?? pipelineOf(of ?? {});
  return (
    <span className={p.dashed ? "w-pipe w-dashed" : "w-pipe"} title={p.title}>
      <span className="w-pipe-s" aria-hidden>
        {p.steps.map((s) => (
          <i key={s.step} className={s.mark === "todo" ? undefined : `w-${s.mark}`} />
        ))}
      </span>
      {pill ? <span className={`w-pill w-${p.pill.tone}`}>{p.pill.text}</span> : <span className="w-muted w-small">{p.pill.text}</span>}
    </span>
  );
}
