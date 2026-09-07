import Link from "next/link";
import { notFound } from "next/navigation";
import { getAgent, getAgentIndex, getAgentPrompt } from "@/lib/content";
import { Markdown } from "@/components/Markdown";

export function generateStaticParams() {
  return getAgentIndex().map((a) => ({ key: a.key }));
}

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const a = getAgent(key);
  return { title: a ? `${a.name} · Minerval agents` : "Agent · Minerval" };
}

export default async function AgentPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const agent = getAgent(key);
  if (!agent) notFound();

  const role = getAgentPrompt(key, "role");
  const full = getAgentPrompt(key, "full");

  return (
    <div>
      <p className="sc" style={{ marginBottom: "1rem" }}>
        <Link href="/docs/agents">← agents</Link>
      </p>

      <div className="claim-eyebrow">
        <span className="sc">Agent {String(agent.stage).padStart(2, "0")}</span>
        <span className="tag">{agent.group}</span>
        <span className="tag">{agent.model}</span>
      </div>
      <h1 className="claim-hero" style={{ fontSize: "2.1rem" }}>{agent.name}</h1>
      <p className="lede" style={{ fontSize: "1.05rem", maxWidth: "32rem" }}>{agent.tagline}</p>

      <p style={{ fontFamily: "var(--sans)", fontSize: ".84rem", color: "var(--muted)", maxWidth: "34rem" }}>
        <strong style={{ color: "var(--ink-soft)" }}>Invoked when:</strong> {agent.invokedWhen}
      </p>

      <hr className="thin" />

      {/* layered-prompt explanation */}
      <div className="col">
        <h2>System prompt</h2>
        <p style={{ fontFamily: "var(--sans)", fontSize: ".84rem", color: "var(--muted)" }}>
          Every agent&rsquo;s prompt is layered: <strong>(1)</strong> the full{" "}
          <Link href="/docs/constitution">Constitution</Link> (identical for all agents),{" "}
          <strong>(2)</strong> the role-specific instructions below, which carry this
          agent&rsquo;s operating standards, <strong>(3)</strong> the{" "}
          <Link href="/docs/skills">domain skills</Link> active for the run, one block each
          after the role, and <strong>(4)</strong> the task context, supplied at runtime.
          Authority runs in that order: a skill may sharpen a role&rsquo;s obligations and
          never loosen them. What follows is layer 2, verbatim.
        </p>
        <p style={{ fontFamily: "var(--sans)", fontSize: ".84rem", color: "var(--muted)", maxWidth: "34rem" }}>
          <strong style={{ color: "var(--ink-soft)" }}>Domain skills:</strong>{" "}
          {agent.skills.length === 0 ? (
            <>none can be spliced into this agent.</>
          ) : (
            <>
              {agent.skills.map((s, i) => (
                <span key={s.name}>
                  {i > 0 ? "; " : ""}
                  <Link href={`/docs/skills/${s.name}`}>{s.name}</Link> ({s.sections.join(", ")})
                </span>
              ))}
              . A skill is spliced in when the claim the run serves carries its domain tag
              {agent.key === "grantmaker"
                ? " (for the Grantmaker, when its mandate names the skill)"
                : agent.key === "extractor"
                  ? " (the Extractor always carries its section, since it tags claims)"
                  : ""}
              ; funding never selects it.
            </>
          )}
        </p>
      </div>

      <div className="col">
        <Markdown>{role}</Markdown>
      </div>

      <details style={{ marginTop: "1.6rem", maxWidth: "46rem" }}>
        <summary style={{ cursor: "pointer", fontFamily: "var(--sans)", fontSize: ".82rem", color: "var(--link)" }}>
          Show the complete assembled system prompt (Constitution included) · {full.length.toLocaleString()} characters
        </summary>
        <pre className="prompt-pre" style={{ marginTop: ".8rem" }}>{full}</pre>
      </details>
    </div>
  );
}
