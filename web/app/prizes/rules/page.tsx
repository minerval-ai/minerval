import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createHash } from "node:crypto";
import { loadFeatures } from "@/lib/data";
import { featureOn } from "@/lib/features";
import {
  PRIZE_RULES, PRIZE_RULES_EFFECTIVE, PRIZE_RULES_VERSION, prizeRulesText,
} from "@/lib/prize-rules";
import { fmtDateLong } from "@/lib/format";
import { PageHead } from "@/components/PageHead";

// The official prize rules (docs/mathematics.md §8.10): one versioned page,
// plain text, with an effective date and a content hash computed over the
// text at build time, so the rules the site shows are the rules the agents
// enforce and a reader can tell whether a copy is the copy in force.

export const metadata: Metadata = {
  title: "Prize rules · Minerval",
  description: "The official rules for prizes offered on Minerval, versioned, with an effective date and a content hash.",
};

// Rendered on request, like the prize listing. Built ahead of time, the page
// would be a stored copy made with whatever the build could see, and a copy
// made where the API could not be asked would stay up in a deployment that
// has prizes off.
export const dynamic = "force-dynamic";

const CONTENT_HASH = createHash("sha256").update(prizeRulesText(), "utf8").digest("hex");

export default async function PrizeRulesPage() {
  // The rules of a prize nobody can be offered here would read as an offer,
  // so the page is not found where prizes are off.
  if (!featureOn(await loadFeatures(), "prizes")) notFound();
  return (
    <div className="doc">
      <PageHead
        title="Prize rules"
        lede={
          <>
            The terms under which Minerval offers a prize for a machine-checked
            proof or disproof of a claim&rsquo;s formal statement. Each prize names
            the version in force when it was posted, and each submission records
            the version it was made under.
          </>
        }
      />
      <p className="rules-meta">
        Version {PRIZE_RULES_VERSION} · effective {fmtDateLong(PRIZE_RULES_EFFECTIVE)} ·{" "}
        <span className="mono" title="sha256 over the canonical text of these rules">
          sha256 {CONTENT_HASH}
        </span>
      </p>

      <ol className="rules-list">
        {PRIZE_RULES.map((r, i) => (
          <li key={r.slug} id={r.slug}>
            <h2 id={`${r.slug}-heading`}>
              <span className="rules-num">{i + 1}.</span> {r.title}
            </h2>
            <p>{r.body}</p>
          </li>
        ))}
      </ol>

      <hr className="thin" />
      <p style={{ fontFamily: "var(--sans)", fontSize: ".78rem", color: "var(--muted)" }}>
        Past versions are retained, and the version a prize or a submission
        names is the one that governs it. Bracketed passages are entered by
        counsel before the first prize is posted. The static policy the checker
        applies, and the machine-readable terms an outside solver needs, are
        served with each prize. <Link href="/prizes">Open prizes →</Link>
      </p>
    </div>
  );
}
