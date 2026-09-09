import type { Metadata } from "next";
import Link from "next/link";
import { apiConfigured, fetchFindings } from "../../lib/api";
import { FindingCard } from "../../components/Findings";

export const metadata: Metadata = {
  title: "Findings · Minerval",
  description:
    "What the graph's administrators found in the course of their work that people who hold the question would be better for knowing, published as written.",
};

export const revalidate = 60;

type Order = "recent" | "importance";

export default async function FindingsPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; tag?: string; min?: string }>;
}) {
  const sp = await searchParams;
  const order: Order = sp.order === "importance" ? "importance" : "recent";
  const tag = sp.tag?.trim() || undefined;
  const min = sp.min ? Number(sp.min) : undefined;
  const minImportance = typeof min === "number" && Number.isInteger(min) && min >= 1 && min <= 10 ? min : undefined;

  const hrefFor = (next: Partial<{ order: Order; tag?: string; min?: number }>) => {
    const p = new URLSearchParams();
    const o = next.order ?? order;
    if (o !== "recent") p.set("order", o);
    const t = "tag" in next ? next.tag : tag;
    if (t) p.set("tag", t);
    const m = "min" in next ? next.min : minImportance;
    if (m) p.set("min", String(m));
    const q = p.toString();
    return q ? `/findings?${q}` : "/findings";
  };

  if (!apiConfigured()) {
    return (
      <div className="col">
        <p className="claim-eyebrow"><span className="sc">findings</span></p>
        <h1>Findings</h1>
        <p>
          The frontend is not connected to a Minerval API (set{" "}
          <code>MINERVAL_API_URL</code>), so the findings feed is unavailable.
        </p>
      </div>
    );
  }

  const findings = await fetchFindings({ order, tag, minImportance, limit: 50 });

  return (
    <div className="col">
      <p className="claim-eyebrow"><span className="sc">findings</span></p>
      <h1>Findings</h1>
      <p>
        What the graph&apos;s administrators found in the course of their work that people
        who hold the question would be better for knowing: what most of them believe is
        wrong, or missing, or true for reasons the record now supplies. Each note is
        published as its author wrote it, in the graph&apos;s voice, and rests on records
        in the graph it cites. Nothing here is a verdict; the verdict is on the claim.
      </p>

      <p className="finding-controls">
        <span className="sc">Order</span>{" "}
        {order === "recent" ? <strong>newest</strong> : <Link href={hrefFor({ order: "recent" })}>newest</Link>}
        {" · "}
        {order === "importance" ? <strong>importance</strong> : <Link href={hrefFor({ order: "importance" })}>importance</Link>}
        {" · "}
        <span className="sc">At least</span>{" "}
        {[4, 7].map((m, i) => (
          <span key={m}>
            {i > 0 && " / "}
            {minImportance === m ? <strong>{m}</strong> : <Link href={hrefFor({ min: m })}>{m}</Link>}
          </span>
        ))}
        {minImportance && (
          <>
            {" · "}<Link href={hrefFor({ min: undefined })}>all</Link>
          </>
        )}
        {tag && (
          <>
            {" · "}<span className="sc">Topic</span> <span className="tag topic">{tag}</span>{" "}
            <Link href={hrefFor({ tag: undefined })}>clear</Link>
          </>
        )}
      </p>

      {findings.length === 0 ? (
        <p className="account-empty">
          Nothing has been noted yet{tag ? " under this topic" : ""}. A run that notes nothing is
          the norm; findings appear here as the administrators record them.
        </p>
      ) : (
        <div className="finding-list">
          {findings.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      )}
    </div>
  );
}
