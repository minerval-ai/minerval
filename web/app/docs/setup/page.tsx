import type { Metadata } from "next";
import Link from "next/link";
import { apiConfigured, fetchSetupParts } from "@/lib/api";
import type { SetupPart } from "@/lib/types";
import { PageHead } from "@/components/PageHead";

// Every version of every part of the setups agent runs have run under
// (#552 groundwork): the constitution, each role prompt, each tool. A
// version is numbered the first time its text runs, and each run records
// the versions it ran under.

export const metadata: Metadata = {
  title: "Setup versions · Minerval",
  description:
    "Every version of the constitution, role prompts and tools Minerval's agents have run under.",
};
export const dynamic = "force-dynamic";

const KIND_LABEL: Record<SetupPart["kind"], string> = {
  constitution: "Constitution",
  role: "Role prompts",
  tool: "Tools",
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default async function SetupPage() {
  let parts: SetupPart[] = [];
  if (apiConfigured()) {
    try {
      parts = await fetchSetupParts();
    } catch (err) {
      console.error("[minerval] setup parts fetch failed:", err);
    }
  }

  // kind → name → versions (newest first, as served)
  const groups = new Map<SetupPart["kind"], Map<string, SetupPart[]>>();
  for (const p of parts) {
    const byName = groups.get(p.kind) ?? new Map<string, SetupPart[]>();
    byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
    groups.set(p.kind, byName);
  }

  return (
    <div className="col-wide">
      <PageHead
        back={{ href: "/docs", label: "docs" }}
        title="Setup versions"
        lede={
          <>
            Every agent run records the setup it ran under: the constitution, its role prompt,
            its tools and its model settings. Each distinct text gets a version number the first
            time it runs, and the number never changes. The constitution and the role prompts are
            shown in full, with their source at the commit they first ran under. Tools are
            listed by version; their text will be published with the run viewer.
          </>
        }
      />

      {parts.length === 0 ? (
        <p style={{ color: "var(--muted)", fontFamily: "var(--sans)" }}>
          No setups recorded yet.
        </p>
      ) : (
        (["constitution", "role", "tool"] as const).map((kind) => {
          const byName = groups.get(kind);
          if (!byName) return null;
          return (
            <section key={kind} style={{ marginTop: "2rem" }}>
              <h2>{KIND_LABEL[kind]}</h2>
              <table className="account-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>Part</th>
                    <th>Current</th>
                    <th>First ran</th>
                    <th>Earlier versions</th>
                  </tr>
                </thead>
                <tbody>
                  {[...byName.entries()].map(([name, versions]) => {
                    const [latest, ...older] = versions;
                    const href = (v: SetupPart) =>
                      `/docs/setup/${v.kind}/${encodeURIComponent(v.name)}/${v.version}`;
                    return (
                      <tr key={name}>
                        <td><code>{name}</code></td>
                        <td><Link href={href(latest!)}>v{latest!.version}</Link></td>
                        <td>{fmtDate(latest!.first_seen_at)}</td>
                        <td>
                          {older.length === 0
                            ? "none"
                            : older.map((v, i) => (
                                <span key={v.version}>
                                  {i > 0 ? ", " : ""}
                                  <Link href={href(v)}>v{v.version}</Link>
                                </span>
                              ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          );
        })
      )}
    </div>
  );
}
