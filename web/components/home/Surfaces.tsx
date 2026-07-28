"use client";

import { useState } from "react";
import Link from "next/link";
import type { ClaimDetail } from "@/lib/types";
import type { DataSource } from "@/lib/data";
import { GraphView } from "@/components/graph/GraphView";
import { Swatch } from "@/components/Assessment";
import { AnnotatedDemo } from "./AnnotatedDemo";
import styles from "./home.module.css";

// The three-surface tabs (issue #80): the same graph served three ways. The
// graph tab embeds the live claim map (GraphView in embed mode); the extension
// tab holds the annotated-web demo; the MCP & API tab lists the real MCP tools
// (mirroring src/mcp/server.ts) with setup snippets per client.

type TabId = "graph" | "ext" | "mcp";
type SetupId = "cc" | "cursor" | "claude" | "rest";

const SETUPS: { id: SetupId; label: string; code: string }[] = [
  {
    id: "cc", label: "Claude Code",
    code: `claude mcp add --transport http minerval \\
  https://api.claimgraph.io/mcp
# Signs you in via OAuth on first use; or skip the
# browser with --header "x-api-key: YOUR_KEY"`,
  },
  {
    id: "cursor", label: "Cursor",
    code: `// ~/.cursor/mcp.json
{
  "mcpServers": {
    "minerval": {
      "url": "https://api.claimgraph.io/mcp",
      "headers": { "x-api-key": "YOUR_KEY" }
    }
  }
}`,
  },
  {
    id: "claude", label: "Claude.ai",
    code: `# Claude.ai → Settings → Connectors → Add custom connector
Name:  Minerval
URL:   https://api.claimgraph.io/mcp
# Leave the OAuth client ID/secret fields empty: the connector
# registers itself and walks you through sign-in and consent.`,
  },
  {
    id: "rest", label: "REST",
    code: `# Reads are open. Search, then walk a claim and its decomposition:
GET  https://api.claimgraph.io/claims/search/inflation
GET  https://api.claimgraph.io/claims/inflation-2022
GET  https://api.claimgraph.io/claims/inflation-2022/trajectory

# Agentic calls & writes authenticate with your key.
# Proposals are reviewed before they join the graph:
POST https://api.claimgraph.io/claims/propose
     x-api-key: YOUR_KEY

# Full OpenAPI schema & explorer: https://api.claimgraph.io/docs`,
  },
];

const TIERS: { label: string; tools: { name: string; desc: string }[] }[] = [
  {
    label: "Free reads · no LLM work",
    tools: [
      { name: "search_claims", desc: "Hybrid semantic + keyword search over Minerval’s canonical claims." },
      { name: "get_claim", desc: "Fetch a canonical claim: its form, current assessment, confidence, and reasoning." },
      { name: "get_decomposition", desc: "The recursive subclaim tree, every node with its relation and verdict." },
    ],
  },
  {
    label: "Agentic · metered, quota-gated (runs the agents)",
    tools: [
      { name: "extract_claims", desc: "Run a passage through the Extractor to pull out the claims it asserts." },
      { name: "match_claim", desc: "Run a free-text assertion through the Matcher to find its canonical claim, or learn it’s new." },
      { name: "assess_text", desc: "Fact-check a passage: extract its claims, match each, and report their standing." },
    ],
  },
  {
    label: "Writes & status",
    tools: [
      { name: "submit_contribution", desc: "File a challenge, evidence, or a merge / split / edit proposal into the review pipeline." },
      { name: "get_contribution_status", desc: "Check the review outcome of a contribution you submitted." },
    ],
  },
];

const VERDICTS = ["verified", "supported", "contested", "unsupported", "contradicted", "unknown"];

export function Surfaces({
  detail, source,
}: {
  detail: ClaimDetail | null;
  source: DataSource;
}) {
  const [tab, setTab] = useState<TabId>("graph");
  const [setup, setSetup] = useState<SetupId>("cc");

  const tabs: { id: TabId; n: string; label: string }[] = [
    { id: "graph", n: "01", label: "The graph" },
    { id: "ext", n: "02", label: "Browser extension" },
    { id: "mcp", n: "03", label: "MCP & API" },
  ];

  return (
    <section className={styles.section}>
      <div className={styles.tabs} role="tablist" aria-label="What's built on the graph" data-tour="tabs">
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
        <div className={styles.mapbox} data-tour="map">
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
            <GraphView initialDetail={detail} source={source} embed />
          ) : (
            <p style={{ padding: "2rem", color: "var(--muted)", fontFamily: "var(--sans)", fontSize: ".85rem" }}>
              The map opens once a claim is available. <Link href="/claims">Browse the claims →</Link>
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
      <div id="panel-ext" role="tabpanel" aria-labelledby="tab-ext" hidden={tab !== "ext"}>
        <h3 className={styles.panelTitle}>The web, annotated.</h3>
        <div className={styles.panelCopy}>
          <p>
            Read anything with the graph switched on. The extension recognises claims on
            the page and underlines each by its verdict; hover one to see the canonical
            claim it matches, its reasoning, and the subclaims beneath it. Pre-computed,
            not hallucinated: the decomposition is checked once and applied live.
          </p>
          <a className={styles.cta} href="https://github.com/minerval-ai/minerval/tree/main/extension">
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

      {/* ---- 03 · MCP & API ---- */}
      <div id="panel-mcp" role="tabpanel" aria-labelledby="tab-mcp" hidden={tab !== "mcp"}>
        <div className={styles.panelCopy}>
          <p>
            Point your AI at the graph. Minerval is a remote MCP server, so an agent
            grounds its answers in claims that have already been weighed instead of
            re-deriving them, with the reasoning and evidence attached. The same graph is
            a plain REST API.
          </p>
          <a className={styles.cta} href="https://api.claimgraph.io/docs">API reference →</a>
          <span style={{ color: "var(--faint)" }}> · </span>
          <Link className={styles.cta} href="/account">Get an API key</Link>
        </div>

        {TIERS.map((tier) => (
          <div className={styles.tier} key={tier.label}>
            <span className={`sc ${styles.tierLabel}`}>{tier.label}</span>
            <div className={styles.tools}>
              {tier.tools.map((tool) => (
                <div className={styles.tool} key={tool.name}>
                  <code>{tool.name}</code>
                  <p>{tool.desc}</p>
                </div>
              ))}
              {tier.tools.length % 2 === 1 && <div className={styles.tool} aria-hidden />}
            </div>
          </div>
        ))}
        <p className={styles.toolsNote}>
          Eight tools in all. The server also exposes two prompt templates
          (<code>fact_check_document</code>, <code>check_assertion</code>) and read-only
          resources (<code>claim://{"{id}"}</code> and a recently-updated feed) for
          clients that support them.
        </p>

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
            Reads are open; agentic tools are metered against your monthly grant. Keys are
            minted at <Link href="/account">/account</Link>.
          </p>
        </div>
      </div>
    </section>
  );
}
