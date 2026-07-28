import Link from "next/link";
import { getAgentIndex } from "@/lib/content";

export const metadata = { title: "The agents · Minerval" };

export default function AgentsIndex() {
  const agents = getAgentIndex();
  const processing = agents.filter((a) => a.group === "processing");
  const governance = agents.filter((a) => a.group === "governance");

  return (
    <div className="col-wide">
      <p className="sc" style={{ marginBottom: ".5rem" }}>The administrators</p>
      <h1>Who maintains the graph</h1>
      <p className="lede" style={{ fontSize: "1.08rem" }}>
        Minerval is run by seven LLM administrators, each with a narrow role and a
        published system prompt. Every one of them is given the full{" "}
        <Link href="/docs/constitution">Constitution</Link> as the first layer of its
        prompt; below, you can read each agent&rsquo;s role-specific instructions and the
        complete assembled prompt, exactly as the system uses them.
      </p>

      <h2>Processing · building the graph</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".82rem", marginTop: "-.3rem" }}>
        A claim is extracted from a source, matched against what already exists, decomposed
        into subclaims, and assessed.
      </p>
      <AgentList agents={processing} />

      <h2>Governance · keeping it honest</h2>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".82rem", marginTop: "-.3rem" }}>
        Contributions are reviewed, claims are stewarded over time, disputes are arbitrated,
        and the system audits itself.
      </p>
      <AgentList agents={governance} />
    </div>
  );
}

function AgentList({ agents }: { agents: ReturnType<typeof getAgentIndex> }) {
  return (
    <div className="cards" style={{ marginTop: ".8rem" }}>
      {agents.map((a) => (
        <Link href={`/docs/agents/${a.key}`} className="card" key={a.key}>
          <div style={{ display: "flex", alignItems: "baseline", gap: ".6rem" }}>
            <span className="sc" style={{ color: "var(--faint)" }}>
              {String(a.stage).padStart(2, "0")}
            </span>
            <span className="card-claim" style={{ marginBottom: 0, fontWeight: 600 }}>{a.name}</span>
          </div>
          <p style={{ fontSize: ".9rem", color: "var(--ink-soft)", margin: ".4rem 0 .5rem" }}>
            {a.tagline}
          </p>
          <div className="card-foot">
            <span className="tag">{a.model}</span>
            <span className="sc" style={{ marginLeft: "auto", color: "var(--link)" }}>
              read prompt →
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
