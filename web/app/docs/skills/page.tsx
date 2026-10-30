import Link from "next/link";
import { getAgentIndex, getSkills } from "@/lib/content";

export const metadata = { title: "The skills · Minerval" };

// One card per skill: what it is, its version, which agents can load it, and
// the tools it brings. The skill's own page shows the text verbatim and the
// exact view each agent loads.
export default function SkillsIndex() {
  const skills = getSkills();
  const agents = getAgentIndex();
  const roleName = (key: string) =>
    agents.find((a) => a.key === key)?.name ?? (key === "math-solver" ? "Solver" : key);

  return (
    <div className="col-wide">
      <p className="sc" style={{ marginBottom: ".5rem" }}>Skills</p>
      <h1>How the constitution applies in a domain</h1>
      <p className="lede" style={{ fontSize: "1.08rem" }}>
        A skill is the third layer of an administrator&rsquo;s prompt, between its role and
        its task: how the <Link href="/docs/constitution">Constitution</Link>&rsquo;s standards
        apply in one domain, what the domain&rsquo;s characteristic objects are, what counts
        as evidence of which grade there, and what tools the domain brings. One document
        serves every role; each agent receives only its sections. A skill may sharpen a
        role&rsquo;s obligations and never loosen them, and where it appears to diverge from
        the constitution, the constitution wins.
      </p>
      <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".82rem" }}>
        Skills load on demand. Each agent&rsquo;s prompt lists the skills it can load, and
        the agent reads one with the load_skill tool when its work calls for it; every load
        is recorded with the run and with any assessment it writes. A claim&rsquo;s domain
        tags (recorded by its Steward; the Extractor emits a prior, and a subclaim inherits
        its parent&rsquo;s tags) point its administrators to the domain skills that cover its
        subject. A skill&rsquo;s tools are in an agent&rsquo;s toolset whether or not it loads
        the skill. Funding never points an agent that writes to the graph to a skill.
      </p>

      {skills.length === 0 ? (
        <p>No skills are defined yet.</p>
      ) : (
        <div className="cards" style={{ marginTop: ".8rem" }}>
          {skills.map((s) => (
            <Link href={`/docs/skills/${s.name}`} className="card" key={s.name}>
              <div style={{ display: "flex", alignItems: "baseline", gap: ".6rem" }}>
                <span className="card-claim" style={{ marginBottom: 0, fontWeight: 600 }}>
                  {s.displayName}
                </span>
                <span className="sc" style={{ color: "var(--faint)" }}>version {s.version}</span>
              </div>
              <p style={{ fontSize: ".9rem", color: "var(--ink-soft)", margin: ".4rem 0 .5rem" }}>
                {s.description}
              </p>
              <p style={{ fontSize: ".82rem", color: "var(--muted)", fontFamily: "var(--sans)", margin: "0 0 .5rem" }}>
                <strong style={{ color: "var(--ink-soft)" }}>Loaded by:</strong>{" "}
                {s.roles.map((r) => roleName(r.key)).join(", ")}.
                {s.tools.length > 0 && (
                  <>
                    {" "}
                    <strong style={{ color: "var(--ink-soft)" }}>Tools:</strong>{" "}
                    {s.tools.map((t) => t.name).join(", ")}.
                  </>
                )}
              </p>
              <div className="card-foot">
                {s.kind === "method" ? (
                  <span className="tag">method skill: every run</span>
                ) : (
                  s.domains.map((d) => (
                    <span className="tag" key={d}>domain: {d}</span>
                  ))
                )}
                <span className="sc" style={{ marginLeft: "auto", color: "var(--link)" }}>
                  read skill →
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
