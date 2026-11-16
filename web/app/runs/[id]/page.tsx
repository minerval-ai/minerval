import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiConfigured, fetchRun, fetchRunSteps } from "@/lib/api";
import { modelDisplayName } from "@/lib/model-names";
import { PageHead } from "@/components/PageHead";
import { LiveRefresh } from "@/components/LiveRefresh";

// One agent run (#553): what it was given, what it did, step by step. A run
// that read private data is withheld, and the page says why.

export const dynamic = "force-dynamic";

type Params = { id: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Run ${id.slice(0, 8)} · Minerval` };
}

const REASON_TEXT: Record<string, string> = {
  "recorded-before-visibility-rules": "it ran before the rules for publishing runs existed",
  "input:lookout-poke-note": "its briefing included a note that can relay a funder's words",
  "input:grantmaker-brief": "its task came from a funder's private conversation",
  "input:audit-brief": "its task came from an audit context that can carry operator data",
  "input:research-report": "a research report reached it, and research reports are not published",
};

function reasonText(r: string): string {
  if (REASON_TEXT[r]) return REASON_TEXT[r];
  const [kind, name, flag] = r.split(":");
  if (kind === "agent") return flag === "unclassified" ? `its agent (${name}) has not been classified` : `its agent (${name}) works from private inputs`;
  if (kind === "tool") return flag === "unclassified" ? `it called a tool (${name}) that has not been classified` : `it called a tool (${name}) that reads private data`;
  return r;
}

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "not finished";
}

export default async function RunPage({ params }: { params: Promise<Params> }) {
  const { id } = await params;
  if (!apiConfigured()) notFound();
  const run = await fetchRun(id);
  if (!run) notFound();

  if ("withheld" in run) {
    return (
      <div className="col-wide">
        <PageHead
          kicker="Agent run"
          title={
            <>
              <code>{run.agent}</code> run {run.id.slice(0, 8)}
            </>
          }
          lede={<>This run is not public, because {run.private_reasons.map(reasonText).join("; and because ")}.</>}
        />
        <p style={{ fontFamily: "var(--sans)", fontSize: ".85rem", color: "var(--muted)" }}>
          A run is published only when nothing it read is private. Its setup (the
          constitution and role prompts) is public at <Link href="/docs/setup">setup versions</Link>.
        </p>
      </div>
    );
  }

  const page = await fetchRunSteps(id);
  const steps = page?.steps ?? [];
  const setup = run.setup;

  // A run still going is followed as it works. One that never finished (its
  // process died) looks the same on the record, so only a recent one is.
  const following = !run.finished_at && Date.now() - new Date(run.started_at).getTime() < 3 * 3_600_000;

  return (
    <div className="col-wide">
      {following && <LiveRefresh />}
      <PageHead
        kicker="Agent run"
        title={
          <>
            <code>{run.agent}</code> run {run.id.slice(0, 8)}
          </>
        }
        meta={
      <>
        {fmt(run.started_at)} to {fmt(run.finished_at)} · {run.outcome ?? "running"}
        {run.claim_id ? (
          <>
            {" "}· on <Link href={`/claims/${run.claim_id}`}>claim {run.claim_id.slice(0, 8)}</Link>
          </>
        ) : null}
        {" "}· {run.model_calls} model call{run.model_calls === 1 ? "" : "s"}, ${run.cost_usd.toFixed(2)}
        {run.commit && run.commit_url ? (
          <>
            {" "}· code at <a href={run.commit_url}><code>{run.commit.slice(0, 7)}</code></a>
          </>
        ) : null}
      </>
        }
      />
      {run.error ? (
        <p style={{ fontFamily: "var(--sans)", color: "var(--st-contradicted)" }}>Error: {run.error}</p>
      ) : null}

      <h2>Setup</h2>
      {setup ? (
        <>
          <p style={{ fontFamily: "var(--sans)", fontSize: ".9rem" }}>
            {modelDisplayName(setup.model)} <code>{setup.model}</code>
            {setup.effort ? ` · effort ${setup.effort}` : ""}
            {setup.maxTokens ? ` · up to ${setup.maxTokens} tokens a turn` : ""}
            {setup.temperature != null ? ` · temperature ${setup.temperature}` : ""}
          </p>
          <ul style={{ fontFamily: "var(--sans)", fontSize: ".9rem" }}>
            {setup.parts.map((p) => (
              <li key={`${p.kind}:${p.hash}`}>
                {p.kind}{" "}
                {p.name && p.version ? (
                  <Link href={`/docs/setup/${p.kind}/${encodeURIComponent(p.name)}/${p.version}`}>
                    <code>{p.name}</code> v{p.version}
                  </Link>
                ) : (
                  <code>{p.name ?? p.hash.slice(0, 12)}</code>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p style={{ fontFamily: "var(--sans)", color: "var(--muted)" }}>
          This run recorded no setup (it ran before setups were recorded).
        </p>
      )}

      <h2>Steps</h2>
      {run.steps_recorded < run.steps_counted ? (
        <p style={{ fontFamily: "var(--sans)", fontSize: ".85rem", color: "var(--muted)" }}>
          {run.steps_recorded} of {run.steps_counted} steps were recorded; the rest were lost when written.
        </p>
      ) : null}
      <ol start={0} style={{ fontFamily: "var(--sans)", fontSize: ".88rem", paddingLeft: "1.5rem" }}>
        {steps.map((s) => (
          <li key={s.seq} value={s.seq} style={{ marginBottom: ".35rem" }}>
            <Link href={`/runs/${run.id}/steps/${s.seq}`}>{s.kind.replace("_", " ")}</Link>{" "}
            <span style={{ color: "var(--ink-soft)" }}>{s.summary}</span>
          </li>
        ))}
      </ol>
      {page?.next_after != null ? (
        <p style={{ fontFamily: "var(--sans)", fontSize: ".85rem", color: "var(--muted)" }}>
          The first {steps.length} steps are shown. The rest are available through the API and MCP
          (list_run_steps, after={page.next_after}).
        </p>
      ) : null}
    </div>
  );
}
