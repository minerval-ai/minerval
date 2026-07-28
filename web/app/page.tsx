import { Suspense } from "react";
import Link from "next/link";
import { FLAGSHIP_ID } from "@/lib/fixtures";
import { apiConfigured } from "@/lib/api";
import { loadClaim } from "@/lib/data";
import { TERRITORIES } from "@/lib/territories";
import { SearchInput } from "@/components/home/SearchInput";
import { Surfaces } from "@/components/home/Surfaces";
import { HomeTour } from "@/components/home/Tour";
import styles from "@/components/home/home.module.css";

// The home page (issue #80): show the graph, don't describe it. Hero + search,
// the three-surface tabs (live claim map / extension demo / MCP & API), and a
// closing triptych into the documentation. Explanation lives on the docs pages;
// the triptych links into /docs (#112). A corpus-counters row was considered
// and cut:
// too early while the corpus is in flux and there is no stats endpoint to
// report real figures.

// The claim the homepage map opens on. FLAGSHIP_ID names the fixture claim,
// which exists only offline: in production the fetch for it 404'd and the page
// silently fell back to fixture data under a "live" badge. In live mode the
// map now opens on a real claim: contested, with a stated credence, named
// arguments, and real structure — the product's differentiator on display.
// FLAGSHIP_CLAIM_ID repoints it without a code change (if the claim's state
// degrades, or a better flagship emerges); loadClaim still degrades to the
// fixture if the live fetch fails.
const LIVE_FLAGSHIP_ID = "585e0bd0-5830-4104-851e-7d4130a1be05"; // egg consumption → CVD risk
const FLAGSHIP =
  process.env.FLAGSHIP_CLAIM_ID ?? (apiConfigured() ? LIVE_FLAGSHIP_ID : FLAGSHIP_ID);

export default async function Home() {
  const { detail, source } = await loadClaim(FLAGSHIP);

  return (
    <div>
      {/* hero: one line, one search box */}
      <div className={styles.hero}>
        <p className={`sc ${styles.eyebrow}`}>An open repository of claims</p>
        <h1 className={styles.heroTitle}>
          Knowledge that compounds instead of starting over.
        </h1>
        <p className={styles.heroLede}>
          Every claim decomposed to its bedrock, weighed against the evidence, and kept
          current as the world changes, by AI administrators bound by a public
          constitution.
        </p>
        <form className={styles.search} role="search" action="/claims" method="get" data-tour="search">
          <SearchInput />
        </form>
        {/* coverage caption (#246): the corpus is a few investigations so far, and
            search makes a broader promise than that. Name what's mapped, at the
            point of action, rendered from TERRITORIES so a fourth cluster shows
            up here without a copy edit. Each name is the same front door the
            /claims cards use. */}
        <p className={styles.coverage}>
          Mapped so far:{" "}
          {TERRITORIES.map((t, i) => (
            <span key={t.key}>
              {i > 0 && " · "}
              <Link href={`/claims/${t.anchorId}/map`}>{t.name}</Link>
            </span>
          ))}
          . The graph grows as claims are ingested; a search outside these areas
          may miss for now.
        </p>
      </div>

      {/* guided walkthrough (#251), opened only from the masthead's "tour"
          entry; Suspense because it watches ?tour=1 via useSearchParams */}
      <Suspense fallback={null}>
        <HomeTour />
      </Suspense>

      {/* what's built on the graph: 01 map · 02 extension · 03 MCP & API */}
      <Surfaces detail={detail} source={source} />

      {/* how it works: the docs triptych closes the page */}
      <section className={styles.section}>
        <h2>How Minerval works</h2>
        <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".92rem", maxWidth: "40rem", marginTop: ".4rem" }}>
          The graph is maintained by seven LLM administrators. Every decision carries a
          reasoning trace, and every trace is open to challenge.
        </p>
        <div className={styles.triptych} data-tour="docs">
          <Link className={styles.panelLink} href="/docs/constitution">
            <span className="sc">The constitution</span>
            <h3>The principles that bind every agent</h3>
            <p>
              Twenty-five articles governing evidence, neutrality, decomposition, and
              appeal, published in full.
            </p>
            <span className={styles.go}>Read the constitution →</span>
          </Link>
          <Link className={styles.panelLink} href="/docs/architecture">
            <span className="sc">The architecture</span>
            <h3>How the graph is built and governed</h3>
            <p>
              Claims, arguments, and typed edges; the six verdicts; the pipeline from
              source to assessment; the operating policies.
            </p>
            <span className={styles.go}>Read the architecture →</span>
          </Link>
          <Link className={styles.panelLink} href="/docs/agents">
            <span className="sc">The agents</span>
            <h3>Seven administrators, in the open</h3>
            <p>
              Extractor, matcher, steward, curator, reviewer, arbitrator, auditor, each
              with its complete system prompt.
            </p>
            <span className={styles.go}>Meet the agents →</span>
          </Link>
        </div>
      </section>
    </div>
  );
}
