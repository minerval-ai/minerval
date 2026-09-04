import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/Markdown";
import { DocLayout } from "@/components/DocLayout";
import { Section, Tags } from "@/components/evals/Bits";
import { loadEvalsData } from "@/lib/evals";
import { extractToc } from "@/lib/toc";
import { GROUPS, TOPICS, topicBySlug } from "../guide";
import s from "../evals.module.css";

// One topic of the evals guide: a title, one line, the tags, and collapsed
// sections the reader opens. The rubric is the exception: a verbatim document
// with a table of contents, since metrics link into its sections.

export function generateStaticParams() {
  return TOPICS.map((t) => ({ slug: t.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = topicBySlug(slug);
  return { title: t ? `${t.title} · Evals · Minerval` : "Evals · Minerval", description: t?.line };
}

export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const topic = topicBySlug(slug);
  if (!topic) notFound();

  const d = loadEvalsData();
  const group = GROUPS.find((g) => g.key === topic.group);

  if (topic.slug === "rubric") {
    const text = d.artifacts.rubric;
    const toc = extractToc(text, { minDepth: 2, maxDepth: 2 });
    return (
      <div>
        <p className="sc" style={{ marginBottom: "1rem" }}><Link href="/docs/evals">← evals</Link></p>
        <DocLayout
          toc={toc}
          aside={
            <aside className="rail-note">
              <span className="sc">Verbatim</span>
              The rubric a run&rsquo;s report is read against, as committed at <code>corpus/RUBRIC.md</code>. The structural scorecard&rsquo;s metrics link into these sections.
            </aside>
          }
        >
          <Markdown>{text}</Markdown>
        </DocLayout>
      </div>
    );
  }

  const tags = topic.tags ? topic.tags(d) : [];
  const all = topic.sections(d);
  // The first section is the setup: a diagram and a short explanation of the
  // property and the method, shown in the open. Everything after it is detail
  // the reader opens: the prompt, the fixture, the results, the cost, the
  // limits, the commands.
  const intro = all[0]?.open ? all[0] : null;
  const sections = intro ? all.slice(1) : all;

  return (
    <div>
      <p className="sc" style={{ marginBottom: "1rem" }}><Link href="/docs/evals">← evals</Link></p>
      <div className="claim-eyebrow">
        <span className="sc">{topic.kind === "eval" ? "Eval" : "Background"}</span>
        {group && topic.kind === "eval" ? <span className="tag">{group.title}</span> : null}
      </div>
      <h1 className="claim-hero" style={{ fontSize: "2.1rem" }}>{topic.title}</h1>
      <p className={s.summary}>{topic.line}</p>
      {tags.length ? <Tags items={tags} /> : null}

      {intro ? (
        <div className={s.intro}>
          <p className={`sc ${s.introLabel}`}>{intro.title}</p>
          {intro.body}
        </div>
      ) : null}
      {sections.length ? <p className={`sc ${s.detailLabel}`}>Detail</p> : null}

      {sections.map((sec) => (
        <Section key={sec.title} title={sec.title} hint={sec.hint} open={sec.open}>
          {sec.body}
        </Section>
      ))}
    </div>
  );
}
