import Link from "next/link";
import { getAgentIndex, getSkills } from "@/lib/content";

export const metadata = { title: "The skills · Minerval" };

// One card per domain skill: what it is, its version, which agents it can be
// spliced into, and the tools it brings. The skill's own page shows the text
// verbatim and the exact block each agent receives.
export default function SkillsIndex() {
  const skills = getSkills();
  const agents = getAgentIndex();
  const roleName = (key: string) =>
    agents.find((a) => a.key === key)?.name ?? (key === "math-solver" ? "Solver" : key);

  return (
    <div className="col-wide">
      <p className="sc" style={{ marginBottom: ".5rem" }}>Domain skills</p>
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
        A skill is active for a run when the claim the run serves carries the skill&rsquo;s
        domain tag, a judgment recorded by the claim&rsquo;s Steward (the Extractor emits
        a prior, and a subclaim inherits its parent&rsquo;s tags). The Grantmaker&rsquo;s
        skills come from its mandate. Funding never selects a skill for any agent that
        writes to the graph.
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
                <strong style={{ color: "var(--ink-soft)" }}>Spliced into:</strong>{" "}
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
                {s.domains.map((d) => (
                  <span className="tag" key={d}>domain: {d}</span>
                ))}
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
