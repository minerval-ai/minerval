import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiConfigured, fetchRunStep } from "@/lib/api";
import { PageHead } from "@/components/PageHead";

// One step of an agent run, in full: the setup it was given, a model turn,
// or a batch of tool results, as recorded.

export const dynamic = "force-dynamic";

type Params = { id: string; seq: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { id, seq } = await params;
  return { title: `Step ${seq} of run ${id.slice(0, 8)} · Minerval` };
}

/** Text blocks shown as text; anything else as indented JSON. */
function Body({ value }: { value: unknown }) {
  return (
    <pre style={{ whiteSpace: "pre-wrap", fontSize: ".8rem", lineHeight: 1.5, overflowX: "auto" }}>
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default async function RunStepPage({ params }: { params: Promise<Params> }) {
  const { id, seq: rawSeq } = await params;
  const seq = Number(rawSeq);
  if (!apiConfigured() || !Number.isInteger(seq) || seq < 0) notFound();
  const step = await fetchRunStep(id, seq);
  if (!step) notFound();

  const c = (step.content ?? {}) as Record<string, unknown>;
  const blocks = step.kind === "assistant" && Array.isArray(c.content) ? (c.content as Array<Record<string, unknown>>) : null;
  const results = step.kind === "tool_results" && Array.isArray(step.content) ? (step.content as Array<Record<string, unknown>>) : null;

  return (
    <div className="col-wide">
      <PageHead
        back={{ href: `/runs/${id}`, label: `run ${id.slice(0, 8)}` }}
        kicker="Run step"
        title={`Step ${step.seq}: ${step.kind.replace("_", " ")}`}
        meta={
          <>
            {new Date(step.created_at).toISOString().replace("T", " ").slice(0, 19)} UTC
            {" · "}
            {seq > 0 ? <Link href={`/runs/${id}/steps/${seq - 1}`}>previous step</Link> : null}
            {seq > 0 ? " · " : null}
            <Link href={`/runs/${id}/steps/${seq + 1}`}>next step</Link>
          </>
        }
      />

      {blocks ? (
        blocks.map((b, i) => (
          <section key={i} style={{ marginTop: "1rem" }}>
            <p className="sc">
              {b.type === "tool_use" || b.type === "server_tool_use" ? `Calls ${String(b.name)}` : String(b.type)}
            </p>
            <Body value={b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : (b.input ?? b)} />
          </section>
        ))
      ) : results ? (
        results.map((r, i) => (
          <section key={i} style={{ marginTop: "1rem" }}>
            <p className="sc">{String(r.name)}</p>
            <details>
              <summary style={{ fontFamily: "var(--sans)", fontSize: ".85rem" }}>Input</summary>
              <Body value={r.input} />
            </details>
            <Body value={r.output} />
          </section>
        ))
      ) : (
        <Body value={step.content} />
      )}
    </div>
  );
}
