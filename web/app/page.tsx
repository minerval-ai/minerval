import Link from "next/link";
import { FLAGSHIP_ID } from "@/lib/fixtures";
import { apiConfigured } from "@/lib/api";
import { loadClaim, loadDeploymentFront, loadFeatures, type DataSource } from "@/lib/data";
import type { DeploymentFront } from "@/lib/deployment-front";
import { membersOnly } from "@/lib/members";
import { mcpAddress } from "@/lib/mcp-address";
import { TERRITORIES, territoryHref } from "@/lib/territories";
import type { ClaimDetail } from "@/lib/types";
import { topicHref } from "@/components/Topics";
import { SearchInput } from "@/components/home/SearchInput";
import { Surfaces } from "@/components/home/Surfaces";
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
// map now opens on a real claim: disputed, with a stated credence, named
// arguments, and real structure — the product's differentiator on display.
// FLAGSHIP_CLAIM_ID repoints it without a code change (if the claim's state
// degrades, or a better flagship emerges); loadClaim still degrades to the
// fixture if the live fetch fails.
// It was the eggs/cardiovascular claim (585e0bd0-…), then goal
// misgeneralization (5477338c-…). It is now scalable oversight: the largest
// assessed AI-safety region (about 150 nodes, 100 assessed, nine assessed
// direct subclaims), doubtful and contested, with the case for and against
// both worked from primary sources.
const LIVE_FLAGSHIP_ID = "dc02e01f-ce69-4dbe-ba36-ed0e2e90d071"; // scalable oversight → reliable control of superintelligence
const FLAGSHIP =
  process.env.FLAGSHIP_CLAIM_ID ?? (apiConfigured() ? LIVE_FLAGSHIP_ID : FLAGSHIP_ID);

// A members-only deployment (lib/members.ts, #1092) is not public Minerval:
// its home page names none of the curated territories above, suggests none of
// public Minerval's claims, and opens its map on no hand-picked id. What it
// shows is read from its own graph as the reader (loadDeploymentFront): its
// most-used topics, and the flagship chosen by the rule in
// lib/deployment-front.ts. FLAGSHIP_CLAIM_ID still repoints the map there, as
// an operator's own choice; the read of it is the reader's like any other.
// Nothing on the public graph changes.

export default async function Home() {
  const members = membersOnly();
  const front = members ? await loadDeploymentFront() : null;
  const flagship = front ? (process.env.FLAGSHIP_CLAIM_ID ?? front.flagship?.id) : FLAGSHIP;
  const [{ detail, source }, features, address] = await Promise.all([
    flagship
      ? loadClaim(flagship)
      : Promise.resolve({ detail: null as ClaimDetail | null, source: "live" as DataSource }),
    loadFeatures(),
    members ? mcpAddress() : Promise.resolve(null),
  ]);

  return (
    <div>
      {/* hero: one line, one search box (a members-only deployment's own below) */}
      {front ? <DeploymentHero front={front} /> : (
      <div className={styles.hero}>
        <h1 className={styles.heroTitle}>
          A new constitution of knowledge
        </h1>
        <p className={styles.heroLede}>
          An open repository of claims and questions, assessed and maintained by AI administrators
          under a public constitution.
        </p>
        <form className={styles.search} role="search" action="/claims" method="get">
          <SearchInput />
        </form>
        {/* coverage caption (#246): the corpus is a few investigations so far, and
            search makes a broader promise than that. Name what's mapped, at the
            point of action, rendered from TERRITORIES so a fourth cluster shows
            up here without a copy edit. Each name is the same front door the
            /claims cards use — territoryHref, so a listing-backed territory
            opens its filtered list rather than a map. */}
        <p className={styles.coverage}>
          Mapped so far:{" "}
          {TERRITORIES.map((t, i) => (
            <span key={t.key}>
              {i > 0 && " · "}
              <Link href={territoryHref(t)}>{t.name}</Link>
            </span>
          ))}
          . The graph grows as claims are ingested; a search outside these areas
          may miss for now.
        </p>
        {/* the Assistant's door on the home page (#646): a link, so the hero
            keeps one input */}
        <p className={styles.coverage}>
          Or <Link href="/ask">ask the Assistant</Link>, which reads the graph for you and can
          propose, contribute and commission work with your account.
        </p>
      </div>
      )}

      {/* what's built on the graph: 01 map · 02 extension · 03 MCP & API
          (the extension's tab only where this deployment has the extension) */}
      <Surfaces
        detail={detail}
        source={source}
        features={features}
        {...(address ? { apiBase: address.apiBase } : {})}
        emptyMapNote={
          members
            ? "The map opens on the most important node you can read here once one has been assessed."
            : undefined
        }
      />

      {/* how it works: the docs triptych closes the page */}
      <section className={styles.section}>
        <h2>How Minerval works</h2>
        <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".92rem", maxWidth: "40rem", marginTop: ".4rem" }}>
          {members ? (
            <>
              This deployment&rsquo;s graph is maintained by LLM administrators under
              Minerval&rsquo;s constitution. Every decision carries a reasoning trace, and every
              trace is open to challenge by the members who may read it.
            </>
          ) : (
            <>
              The graph is maintained by LLM administrators under a public constitution. Every
              decision carries a reasoning trace, and every trace is open to challenge.
            </>
          )}
        </p>
        <div className={styles.triptych}>
          <Link className={styles.panelLink} href="/docs/constitution">
            <span className="sc">The constitution</span>
            <h3>The principles that bind every agent</h3>
            <p>
              The articles that govern evidence, decomposition, neutrality,
              contributions and appeal, published in full.
            </p>
            <span className={styles.go}>Read the constitution →</span>
          </Link>
          <Link className={styles.panelLink} href="/docs/architecture">
            <span className="sc">The architecture</span>
            <h3>How the graph is built and governed</h3>
            <p>
              Claims, quantities, and questions; arguments and typed edges; the six
              verdicts and a question&rsquo;s standing; the pipeline from source to
              assessment; the operating policies.
            </p>
            <span className={styles.go}>Read the architecture →</span>
          </Link>
          <Link className={styles.panelLink} href="/docs/agents">
            <span className="sc">The agents</span>
            <h3>The administrators, in the open</h3>
            <p>
              From the Extractor and the Matcher to the Stewards, the Grantmaker and the
              Consistency Checker, each with its model and its complete system prompt.
            </p>
            <span className={styles.go}>Meet the agents →</span>
          </Link>
        </div>
      </section>
    </div>
  );
}

// The hero of a members-only deployment (#1092): what this deployment holds,
// as far as the reader may read it, and how its graph grows while it holds
// nothing yet. Every name on it comes from the deployment's own graph.
function DeploymentHero({ front }: { front: DeploymentFront }) {
  return (
    <div className={styles.hero}>
      <h1 className={styles.heroTitle}>
        A new constitution of knowledge
      </h1>
      <p className={styles.heroLede}>
        A private deployment of Minerval: claims and questions, assessed and maintained by AI
        administrators, read only by its signed-in members, each as far as their labels reach.
      </p>
      <form className={styles.search} role="search" action="/claims" method="get">
        <SearchInput placeholder="Search this deployment’s claims and questions" />
      </form>
      {/* coverage caption: the deployment's own topics (GET /tags), most-used
          first, counted over what the reader may read. None until it has some. */}
      {front.topics.length > 0 ? (
        <p className={styles.coverage}>
          Topics here so far:{" "}
          {front.topics.map((t, i) => (
            <span key={t.slug}>
              {i > 0 && " · "}
              <Link href={topicHref(t.slug)}>{t.name}</Link>
            </span>
          ))}
          . The graph grows as this deployment&rsquo;s material is read; a search outside these
          topics may miss for now.
        </p>
      ) : (
        <p className={styles.coverage}>
          Nothing you can read here has a topic yet. This deployment&rsquo;s graph grows from the
          sources its members add and the mandates they fund: start from{" "}
          <Link href="/mandates">the mandates</Link> or <Link href="/claims">propose a claim</Link>,
          and see <Link href="/docs/running-a-private-graph">running a private graph</Link>.
        </p>
      )}
      <p className={styles.coverage}>
        Or <Link href="/ask">ask the Assistant</Link>, which reads this deployment&rsquo;s graph for
        you and can propose, contribute and commission work with your account.
      </p>
    </div>
  );
}
