import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAgentIndex,
  getSkill,
  getSkillBody,
  getSkillIndex,
  getSkillView,
  getSkills,
} from "@/lib/content";
import { Markdown } from "@/components/Markdown";
import { DocLayout } from "@/components/DocLayout";
import { extractToc } from "@/lib/toc";

export function generateStaticParams() {
  return getSkills().map((s) => ({ name: s.name }));
}

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const s = getSkill(name);
  return { title: s ? `${s.displayName} · Minerval skills` : "Skill · Minerval" };
}

// The skill page (prompt transparency): the text verbatim with a table of
// contents, the composition table generated from the loader's ROLE_VIEW, the
// exact block each receiving role gets, and the tool definitions verbatim.
export default async function SkillPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const skill = getSkill(name);
  if (!skill) notFound();

  const body = getSkillBody(name);
  const { roleView } = getSkillIndex();
  const agents = getAgentIndex();
  const roleName = (key: string) =>
    agents.find((a) => a.key === key)?.name ??
    (key === "math-solver" ? "Solver (an instrument, not an administrator)" : key);

  const toc = [
    ...extractToc(body, { minDepth: 2, maxDepth: 3 }),
    { depth: 2, text: "Who receives which sections", slug: "who-receives-which-sections" },
    { depth: 2, text: "What each role receives", slug: "what-each-role-receives" },
    { depth: 2, text: "Tools", slug: "skill-tools" },
  ];

  const sectionsOf = (roleKey: string) =>
    skill.roles.find((r) => r.key === roleKey)?.sections ?? [];

  return (
    <div>
      <p className="sc" style={{ marginBottom: "1rem" }}>
        <Link href="/docs/skills">← skills</Link>
      </p>
      <DocLayout
        toc={toc}
        aside={
          <aside className="rail-note">
            <span className="sc">Verbatim</span>
            This is the skill text exactly as the loader reads it from the repository.
            Each administrator receives only its sections, wrapped as the block shown
            under &ldquo;What each role receives&rdquo;, as the third layer of its system
            prompt: after the constitution and its role, before the task.
          </aside>
        }
      >
        <div className="doc">
          <p className="sc" style={{ marginBottom: ".5rem" }}>
            Domain skill · version {skill.version} · since epoch {skill.sinceEpoch}
          </p>
          <h1>{skill.displayName}</h1>
          <p className="lede">{skill.description}</p>
          <p style={{ fontFamily: "var(--sans)", fontSize: ".84rem", color: "var(--muted)" }}>
            <strong style={{ color: "var(--ink-soft)" }}>Activated by:</strong> a claim whose
            recorded domains include{" "}
            {skill.domains.map((d, i) => (
              <span key={d}>
                {i > 0 ? ", " : ""}
                <code>{d}</code>
              </span>
            ))}
            . Source: <code>skills/{skill.name}/SKILL.md</code>.
          </p>
        </div>

        <Markdown>{body}</Markdown>

        <hr className="thin" />

        <div className="doc">
          <h2 id="who-receives-which-sections">Who receives which sections</h2>
          <p>
            Generated from the loader&rsquo;s composition table (<code>ROLE_VIEW</code> in{" "}
            <code>src/llm/prompts/skills.ts</code>). A role receives the listed sections in
            document order; the solver is an instrument rather than an administrator and
            receives no constitution.
          </p>
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Sections received</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(roleView).map(([key, sections]) => (
                <tr key={key}>
                  <td>
                    {agents.some((a) => a.key === key) ? (
                      <Link href={`/docs/agents/${key}`}>{roleName(key)}</Link>
                    ) : (
                      roleName(key)
                    )}
                  </td>
                  <td>{sections.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 id="what-each-role-receives">What each role receives</h2>
          <p>
            The exact block spliced into each role&rsquo;s system prompt when this skill is
            active: the heading the agent can cite, one sentence of standing, and the
            role&rsquo;s sections verbatim.
          </p>
          {Object.keys(roleView).map((key) => {
            const view = getSkillView(skill.name, key);
            const sections = sectionsOf(key);
            return (
              <details key={key} style={{ marginBottom: ".8rem" }}>
                <summary style={{ cursor: "pointer", fontFamily: "var(--sans)", fontSize: ".84rem", color: "var(--link)" }}>
                  {roleName(key)} ·{" "}
                  {sections.length > 0
                    ? `${sections.length} section${sections.length === 1 ? "" : "s"}`
                    : "no sections"}{" "}
                  · {view.length.toLocaleString()} characters
                </summary>
                <pre className="prompt-pre" style={{ marginTop: ".6rem" }}>{view}</pre>
              </details>
            );
          })}

          <h2 id="skill-tools">Tools</h2>
          {skill.tools.length === 0 ? (
            <p>This skill brings no tools.</p>
          ) : (
            <>
              <p>
                The tool definitions this skill adds to a run&rsquo;s toolset, with their
                descriptions verbatim, exactly as the model receives them. Each joins the
                toolset of the roles listed, and only when the skill is active.
              </p>
              {skill.tools.map((t) => (
                <details key={t.name} style={{ marginBottom: ".8rem" }}>
                  <summary style={{ cursor: "pointer", fontFamily: "var(--sans)", fontSize: ".84rem", color: "var(--link)" }}>
                    <code>{t.name}</code> · {t.roles.map(roleName).join(", ")}
                  </summary>
                  <p style={{ marginTop: ".6rem" }}>{t.description}</p>
                  <pre className="prompt-pre">{JSON.stringify(t.input_schema, null, 2)}</pre>
                </details>
              ))}
            </>
          )}
        </div>
      </DocLayout>
    </div>
  );
}
