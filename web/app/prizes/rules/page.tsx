import type { Metadata } from "next";
import Link from "next/link";
import { createHash } from "node:crypto";
import {
  PRIZE_RULES, PRIZE_RULES_EFFECTIVE, PRIZE_RULES_VERSION, prizeRulesText,
} from "@/lib/prize-rules";
import { fmtDateLong } from "@/lib/format";

// The official prize rules (docs/mathematics.md §8.10): one versioned page,
// plain text, with an effective date and a content hash computed over the
// text at build time, so the rules the site shows are the rules the agents
// enforce and a reader can tell whether a copy is the copy in force.

export const metadata: Metadata = {
  title: "Prize rules · Minerval",
  description: "The official rules for prizes offered on Minerval, versioned, with an effective date and a content hash.",
};

const CONTENT_HASH = createHash("sha256").update(prizeRulesText(), "utf8").digest("hex");

export default function PrizeRulesPage() {
  return (
    <div className="doc">
      <p className="sc" style={{ marginBottom: ".5rem" }}>Official rules</p>
      <h1>Prize rules</h1>
      <p className="lede">
        The terms under which Minerval offers a prize for a machine-checked
        proof or disproof of a claim&rsquo;s formal statement. Each prize names
        the version in force when it was posted, and each submission records
        the version it was made under.
      </p>
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
