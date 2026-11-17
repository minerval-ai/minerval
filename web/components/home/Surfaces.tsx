"use client";

import { useState } from "react";
import Link from "next/link";
import type { ClaimDetail } from "@/lib/types";
import type { DataSource } from "@/lib/data";
import { ALL_FEATURES_ON, featureOn, type Features } from "@/lib/features";
import { GraphView } from "@/components/graph/GraphView";
import { Swatch } from "@/components/Assessment";
import { AnnotatedDemo } from "./AnnotatedDemo";
import styles from "./home.module.css";

// The three-surface tabs (issue #80): the same graph served three ways. The
// graph tab embeds the live claim map (GraphView in embed mode); the extension
// tab holds the annotated-web demo; the MCP & API tab says what an agent can
// do and what it costs, with a setup snippet per client, and leaves the tools
// themselves to /docs/tools, which reads them from the server.

type TabId = "graph" | "ext" | "mcp";
type SetupId = "cc" | "cursor" | "claude" | "rest";

const SETUPS: { id: SetupId; label: string; code: string; note: string }[] = [
  {
    id: "cc", label: "Claude Code",
    code: `claude mcp add --transport http minerval https://api.claimgraph.io/mcp`,
    note: "Then run /mcp in Claude Code to sign in through the browser.",
  },
  {
    id: "claude", label: "Claude.ai",
    code: `Settings → Connectors → Add custom connector
  Name  Minerval
  URL   https://api.claimgraph.io/mcp`,
    note: "Leave the OAuth client ID and secret empty: the connector registers itself and opens the sign-in page.",
  },
  {
    id: "cursor", label: "Cursor",
    code: `// ~/.cursor/mcp.json
{
  "mcpServers": {
    "minerval": {
      "url": "https://api.claimgraph.io/mcp",
      "headers": { "x-api-key": "<your key>" }
    }
  }
}`,
    note: "Uses an API key from your account page.",
  },
  {
    id: "rest", label: "REST",
    code: `# Reads need no key. One claim's judgment, whole:
curl https://api.claimgraph.io/claims/dc02e01f-ce69-4dbe-ba36-ed0e2e90d071/card`,
    note: "Every route an account can call is also an MCP tool.",
  },
];

// What an agent can do with the graph, and what each kind of call costs. The
// tools themselves are listed on /docs/tools, read from the server, so this
// tab names none it would have to keep current.
const CAPABILITIES: { title: string; what: string; cost: string; href: string }[] = [
  { title: "Read the graph", what: "search, cards, decomposition, dependents", cost: "free", href: "/docs/reading" },
  { title: "Check text", what: "match, extract, assess", cost: "capped per call, settled to metered cost", href: "/docs/fact-checking" },
  { title: "Follow changes", what: "the change stream and Correspondents' updates", cost: "free to read", href: "/docs/following" },
  { title: "Contribute", what: "challenges, evidence, stated views", cost: "free, reviewed", href: "/docs/contributing" },
  { title: "Commission work", what: "assessments, mandates, requests", cost: "a budget you set; what is not spent comes back", href: "/docs/commissioning" },
  { title: "Verify", what: "run logs, setups, prompt hashes", cost: "free", href: "/docs/verifying" },
];

const VERDICTS = ["verified", "supported", "inconclusive", "doubtful", "contradicted", "unknown"];

export function Surfaces({
  detail, source, features = ALL_FEATURES_ON, emptyMapNote,
}: {
  detail: ClaimDetail | null;
  source: DataSource;
  features?: Features;
  // What the map's place says when there is no claim to open on: a
  // members-only deployment says why in its own terms (#1092).
  emptyMapNote?: string;
}) {
  const [tab, setTab] = useState<TabId>("graph");
  const [setup, setSetup] = useState<SetupId>("cc");

  // A deployment with the extension switched off has no extension tab: the
  // tab's demo and its install link would promise an API that is not there.
  // The tabs are numbered as shown, so the row never skips a number.
  const extensionOn = featureOn(features, "extension");
  const tabs: { id: TabId; n: string; label: string }[] = [
    { id: "graph" as const, label: "The graph" },
    ...(extensionOn ? [{ id: "ext" as const, label: "Browser extension" }] : []),
    { id: "mcp" as const, label: "MCP & API" },
  ].map((t, i) => ({ ...t, n: String(i + 1).padStart(2, "0") }));

  return (
    <section className={styles.section}>
      <div className={styles.tabs} role="tablist" aria-label="What's built on the graph">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={styles.tab}
            role="tab"
            id={`tab-${t.id}`}
            aria-controls={`panel-${t.id}`}
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            <span className={styles.n}>{t.n}</span>{t.label}
          </button>
        ))}
      </div>

      {/* ---- 01 · the graph: the live claim map ---- */}
      <div id="panel-graph" role="tabpanel" aria-labelledby="tab-graph" hidden={tab !== "graph"}>
        <div className={styles.mapbox}>
          <div className={styles.mapbar}>
            <span className="sc">
              Claim map · {source === "live" ? "click a claim to open it full-screen" : "click a claim to focus on it"}
            </span>
            {/* only claim "live" when the data actually is; the fixture
                fallback owns up to being a sample */}
            {source === "live" ? (
              <span className={styles.live}>
                <span className={styles.pulse} aria-hidden />live · interactive
              </span>
            ) : (
              <span className={styles.live}>sample · interactive</span>
            )}
          </div>
          {detail ? (
            <GraphView initialDetail={detail} source={source} embed features={features} />
          ) : (
            <p style={{ padding: "2rem", color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".85rem" }}>
              {emptyMapNote ?? "The map opens once a claim is available."}{" "}
              <Link href="/claims">Browse the claims →</Link>
            </p>
          )}
        </div>
        <p className={styles.mapLinks}>
          {/* full-screen opens the claim the embedded map is showing (#252) */}
          {detail && (
            <>
              <Link className={styles.cta} href={`/claims/${detail.claim.id}/map`}>Open the map full-screen →</Link>
              <span style={{ color: "var(--faint)" }}> · </span>
            </>
          )}
          <Link className={styles.cta} href="/claims">Browse all claims</Link>
        </p>
      </div>

      {/* ---- 02 · the browser extension: the web, annotated ---- */}
      {extensionOn && (
      <div id="panel-ext" role="tabpanel" aria-labelledby="tab-ext" hidden={tab !== "ext"}>
        <h3 className={styles.panelTitle}>The web, annotated.</h3>
        <div className={styles.panelCopy}>
          <p>
            Read anything with the graph switched on. The extension recognises claims on
            the page and underlines each by its verdict; hover one to see the canonical
            claim it matches, its reasoning, and the subclaims beneath it.
          </p>
          <a className={styles.cta} href="https://chromewebstore.google.com/detail/minerval/ojpdkgmlbffliefddfendfakpiiopkci">
            Get the extension →
          </a>
        </div>
        <AnnotatedDemo />
        <div className={styles.legend} aria-label="Verdict legend">
          {VERDICTS.map((v) => (
            <span key={v}><Swatch status={v} />{v}</span>
          ))}
          <span><i className={`${styles.sw} ${styles.swDashed}`} />pending</span>
          <span className={styles.legendCap}>six verdicts, one non-verdict</span>
        </div>
      </div>
      )}

      {/* ---- 03 · MCP & API ---- */}
      <div id="panel-mcp" role="tabpanel" aria-labelledby="tab-mcp" hidden={tab !== "mcp"}>
        <div className={styles.panelCopy}>
          <p>
            Point your agent at the graph. It grounds its answers in claims already weighed,
            with the reasoning and evidence attached, and reports them as the graph states
            them. The same graph is a plain REST API.
          </p>
          <Link className={styles.cta} href="/docs/connect">Connect in two minutes →</Link>
          <span style={{ color: "var(--faint)" }}> · </span>
          <Link className={styles.cta} href="/docs/tools">Every tool →</Link>
          <span style={{ color: "var(--faint)" }}> · </span>
          <Link className={styles.cta} href="/docs/api">REST API →</Link>
        </div>

        <div className={styles.tools}>
          {CAPABILITIES.map((c) => (
            <Link className={styles.tool} key={c.title} href={c.href}>
              <strong>{c.title}</strong>
              <p>{c.what} · {c.cost}</p>
            </Link>
          ))}
        </div>

        <div className={styles.setup}>
          <div className={styles.setupTabs} role="tablist" aria-label="Set up the MCP server">
            {SETUPS.map((s) => (
              <button
                key={s.id}
                className={styles.setupTab}
                role="tab"
                aria-selected={setup === s.id}
                onClick={() => setSetup(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <pre className={styles.code}>{SETUPS.find((s) => s.id === setup)!.code}</pre>
          <p className={styles.setupNote}>
            {SETUPS.find((s) => s.id === setup)!.note} Reading the graph is free;{" "}
            <Link href="/docs/owls">owls and pricing</Link> has the rest.
          </p>
        </div>
      </div>
    </section>
  );
}
