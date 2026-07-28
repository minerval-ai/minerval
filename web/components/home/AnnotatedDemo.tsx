"use client";

import { useState } from "react";
import Link from "next/link";
import { StatusBadge, VerdictConfidence, Unassessed } from "@/components/Assessment";
import styles from "./home.module.css";

// The browser-extension demo (issue #80): a mock article whose sentences are
// the graph's real claims, underlined by verdict. Hovering or focusing an
// underline reveals its margin card: the canonical claim, its verdict, the
// steward's reasoning, and (for the flagship) the subclaims beneath it. The
// article and every card are built from the same fixture data as the rest of
// the site; nothing here is generated.

type CardId =
  | "c-high" | "c-bls" | "c-wages" | "c-squeeze" | "c-over" | "c-defl" | "c-shelter";

const CARDS: {
  id: CardId;
  status: string | null; // null = unassessed
  confidence: number | null;
  claim: string;
  match: string;
  reason: string;
  subs?: { status: string; text: string; conf: string }[];
}[] = [
  {
    id: "c-high", status: "supported", confidence: 0.78,
    claim: "US CPI inflation in 2022 exceeded the threshold for ‘high’ inflation.",
    match: "canonical match 0.82 · empirical (derived)",
    reason:
      "The 6.5% magnitude is verified; the claim turns on a contested definitional subclaim: what counts as “high.” Verified arithmetic on a contested definition: supported, not verified.",
    subs: [
      { status: "verified", text: "BLS reported CPI-U growth of 6.5% for 2022", conf: "0.97" },
      { status: "contested", text: "The threshold for ‘high’ inflation is 5%", conf: "0.55" },
      { status: "verified", text: "6.5% is greater than 5%", conf: "1.00" },
    ],
  },
  {
    id: "c-bls", status: "verified", confidence: 0.97,
    claim: "The US Bureau of Labor Statistics reported CPI-U growth of 6.5% for the 12 months ending December 2022.",
    match: "canonical match 0.99 · primary_data · BLS, Dec 2022",
    reason:
      "Checkable against the primary source, with no serious dispute. It is a required subclaim of the “high inflation” claim above.",
  },
  {
    id: "c-wages", status: "verified", confidence: 0.9,
    claim: "Real (inflation-adjusted) wages fell for most US workers in 2022.",
    match: "empirical · requires → the CPI claim",
    reason:
      "Rests on the verified CPI figure by a requires edge, one of five claims in the graph that lean on it.",
  },
  {
    id: "c-squeeze", status: "contested", confidence: 0.58,
    claim: "2022 was the worst US cost-of-living squeeze in four decades.",
    match: "evaluative · supports ← the CPI claim",
    reason:
      "Evidence exists but interpretation is disputed: “worst” depends on which measure of living costs you pick. The disagreement is definitional, not factual.",
  },
  {
    id: "c-over", status: "contested", confidence: 0.47,
    claim: "The 2022 tightening was a policy overreaction to transitory inflation.",
    match: "causal · contradicts ← the CPI claim",
    reason:
      "The supported “high inflation” claim weighs against this one by a contradicts edge; the rest hangs on the contested word “transitory.”",
  },
  {
    id: "c-defl", status: "contradicted", confidence: 0.88,
    claim: "The United States experienced sustained deflation throughout 2009.",
    match: "empirical (verifiable)",
    reason:
      "Evidence leans against: prices fell for part of 2009, but the decline was neither sustained nor year-long. A confident sentence; a contradicted claim.",
  },
  {
    id: "c-shelter", status: null, confidence: null,
    claim: "The CPI shelter component was reweighted in the 2023 basket revision.",
    match: "empirical (verifiable) · unassessed",
    reason:
      "Extracted and matched, but the Claim Steward hasn’t weighed it yet. No verdict is shown until one exists: a dashed line, not a guess.",
  },
];

const HL_CLASS: Record<string, string> = {
  verified: styles.hlVerified,
  supported: styles.hlSupported,
  contested: styles.hlContested,
  contradicted: styles.hlContradicted,
};

export function AnnotatedDemo() {
  const [active, setActive] = useState<CardId>("c-high");

  const hl = (id: CardId, status: string | null, text: string) => (
    <span
      className={[
        styles.hl,
        status ? HL_CLASS[status] : styles.hlPending,
        active === id ? styles.hlActive : "",
      ].join(" ").trim()}
      role="button"
      tabIndex={0}
      aria-expanded={active === id}
      onMouseEnter={() => setActive(id)}
      onFocus={() => setActive(id)}
      onClick={() => setActive(id)}
    >
      {text}
    </span>
  );

  return (
    <div className={styles.browser} role="group" aria-label="The Minerval extension annotating a news article">
      <div className={styles.chrome}>
        <span className={styles.dots} aria-hidden><i /><i /><i /></span>
        <span className={styles.urlbar}>news.example.com/2022/economy/a-year-of-soaring-prices-in-charts</span>
        <span className={styles.extPill}>
          <span className={styles.glyph} aria-hidden />minerval <span className={styles.count}>· 7 claims</span>
        </span>
      </div>
      <div className={styles.pagebody}>
        <article className={styles.articleCol}>
          <span className={styles.aKicker}>Economy · Year in review</span>
          <h3 className={styles.aTitle}>A year of soaring prices, in charts</h3>
          <p className={styles.aByline}>December 2022 · 6 min read</p>
          <p>
            {hl("c-high", "supported", "Inflation hit a 40-year high in 2022, squeezing households across the country.")}{" "}
            {hl("c-bls", "verified", "The Consumer Price Index for All Urban Consumers (CPI-U) rose 6.5 percent over the 12 months ending December 2022,")}{" "}
            the Bureau of Labor Statistics reported, and by year’s end,{" "}
            {hl("c-wages", "verified", "real, inflation-adjusted wages had fallen for most US workers")}.
          </p>
          <p>
            For many families, {hl("c-squeeze", "contested", "it was the worst cost-of-living squeeze in four decades")}.
            Some critics of the Federal Reserve counter that{" "}
            {hl("c-over", "contested", "the 2022 tightening was a policy overreaction to transitory inflation")},
            the mirror image, they argue, of 2009, when{" "}
            {hl("c-defl", "contradicted", "the United States experienced sustained deflation throughout the year")}.
          </p>
          <p>
            The yardsticks themselves kept moving:{" "}
            {hl("c-shelter", null, "the CPI shelter component was reweighted in the 2023 basket revision")},
            complicating comparisons across years.
          </p>
        </article>

        <aside className={styles.marginCol} aria-label="Minerval margin notes">
          <p className={styles.marginHint}>Hover or tap an underlined claim ↤</p>
          <div className={styles.mcards}>
            {CARDS.map((c) => (
              <div
                key={c.id}
                className={`${styles.mcard}${active === c.id ? ` ${styles.mcardActive}` : ""}`}
              >
                <div className={styles.mMeta}>
                  {c.status ? <StatusBadge status={c.status} size="lg" /> : <Unassessed />}
                  {c.status && <VerdictConfidence value={c.confidence} />}
                </div>
                <p className={styles.mClaim}>{c.claim}</p>
                <p className={styles.mMatch}>{c.match}</p>
                <p className={styles.mReason}>{c.reason}</p>
                {c.subs && (
                  <ul className={styles.mSubs}>
                    {c.subs.map((s) => (
                      <li key={s.text}>
                        <StatusBadge status={s.status} />
                        <span className={styles.txt}>{s.text}</span>
                        <span className="conf-num" title="verdict confidence">{s.conf}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <Link
                  className={styles.mOpen}
                  href={c.id === "c-high" ? "/claims/inflation-2022" : "/claims"}
                >
                  Open in graph →
                </Link>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
