import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { apiConfigured, fetchSetupPart } from "@/lib/api";
import { lineDiff } from "@/lib/line-diff";
import { PageHead } from "@/components/PageHead";

// One version of a setup part: its text when public, its source on GitHub at
// the commit it first ran under, and what changed from the version before.

type Params = { kind: string; name: string; version: string };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { name, version } = await params;
  return { title: `${decodeURIComponent(name)} v${version} · Setup · Minerval` };
}

export default async function SetupPartPage({ params }: { params: Promise<Params> }) {
  const { kind, name: rawName, version: rawVersion } = await params;
  const name = decodeURIComponent(rawName);
  const version = Number(rawVersion);
  if (!apiConfigured() || !Number.isInteger(version) || version < 1) notFound();

  const part = await fetchSetupPart(kind, name, version);
  if (!part) notFound();
  const previous =
    part.previous_version && part.content !== null
      ? await fetchSetupPart(kind, name, part.previous_version)
      : null;
  const diff =
    previous?.content != null && part.content !== null ? lineDiff(previous.content, part.content) : null;
  const href = (v: number) => `/docs/setup/${kind}/${encodeURIComponent(name)}/${v}`;

  return (
    <div className="col-wide">
      <PageHead
        back={{ href: "/docs/setup", label: "setup versions" }}
        kicker={kind}
        title={<><code>{name}</code> v{part.version}</>}
        meta={
          <>
              first ran {new Date(part.first_seen_at).toISOString().slice(0, 10)}
              {part.first_seen_commit ? (
                <>
                  {" "}under commit <code>{part.first_seen_commit.slice(0, 7)}</code>
                </>
              ) : null}
              {part.source_url ? (
                <>
                  {" "}· <a href={part.source_url}>source on GitHub</a>
                </>
              ) : null}
              {" "}· sha256 <code title={part.hash}>{part.hash.slice(0, 12)}</code>
              {part.previous_version ? (
                <>
                  {" "}· <Link href={href(part.previous_version)}>v{part.previous_version}</Link>
                </>
              ) : null}
          </>
        }
      />

      {part.content === null ? (
        <p style={{ fontFamily: "var(--sans)", color: "var(--muted)" }}>
          This part is recorded by its hash only. Its text will be published with the run
          viewer, once the rules for what in a run is public are in place.
        </p>
      ) : (
        <>
          {diff ? (
            <details style={{ margin: "1rem 0" }}>
              <summary className="sc">Changes from v{part.previous_version}</summary>
              <pre className="setup-diff" style={{ overflowX: "auto", fontSize: ".78rem" }}>
                {diff
                  .filter((l, i, all) =>
                    l.op !== "same" ||
                    all.slice(Math.max(0, i - 2), i + 3).some((x) => x.op !== "same"),
                  )
                  .map((l, i) => (
                    <div
                      key={i}
                      style={{
                        color:
                          l.op === "add"
                            ? "var(--st-verified)"
                            : l.op === "del"
                              ? "var(--st-contradicted)"
                              : "var(--muted)",
                      }}
                    >
                      {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
                      {l.text}
                    </div>
                  ))}
              </pre>
            </details>
          ) : null}
          <pre style={{ whiteSpace: "pre-wrap", fontSize: ".82rem", lineHeight: 1.5 }}>
            {part.content}
          </pre>
        </>
      )}
    </div>
  );
}
