// Gitignored/untracked preview page for issue #207 — logo mark candidates.
// Same workflow as the issue #42 margin previews: draft here, pick one, then
// sync app/Mark.tsx, app/icon.svg, and app/apple-icon.tsx. Never commit.
import { candidates, current, type Candidate } from "./candidates";

const DIRECTION_LABELS: Record<string, string> = {
  current: "Current mark (baseline)",
  traced: "Traced SVG of the uploaded owl",
  "o3-coin-face": "Round 3 · tetradrachm face (no critique pass ran)",
  "o3-figure-silhouette": "Round 3 · tetradrachm whole figure",
  "o2-nodes-refined": "Round 2 · owl-nodes refined",
  "o2-diarch-refined": "Round 2 · owl-diarch refined",
  "o2-vigil-refined": "Round 2 · owl-vigil refined",
  "o2-primitives": "Round 2 · owl from graph primitives",
  "owl-geometric": "Abstract geometric owl",
  "owl-classical": "Owl of Athena (classical)",
  "node-refined": "Claim node, cleaned up",
  "graph-structure": "Graph structure",
  "typographic-greek": "Typographic / Greek",
  emblems: "Emblems & hybrids",
};

function Glyph({ svg, px }: { svg: string; px: number }) {
  return (
    <span
      style={{ display: "inline-block", width: px, height: px, lineHeight: 0 }}
      dangerouslySetInnerHTML={{
        __html: svg.replace("<svg ", `<svg width="${px}" height="${px}" `),
      }}
    />
  );
}

function MastheadSim({ svg }: { svg: string }) {
  // Mirrors .masthead / .wordmark: serif 1.12rem (≈21px), glyph at 0.82em ≈ 17px.
  return (
    <div
      style={{
        border: "1px solid var(--rule)",
        borderRadius: 3,
        background: "var(--paper)",
        padding: "0.7rem 1.2rem",
        display: "flex",
        alignItems: "baseline",
        gap: "1.6rem",
      }}
    >
      <span className="wordmark" style={{ display: "inline-flex", alignItems: "center" }}>
        <span style={{ marginRight: "0.4rem", display: "inline-flex" }}>
          <Glyph svg={svg} px={17} />
        </span>
        Minerval
      </span>
      <nav
        style={{
          display: "flex",
          gap: "1.15rem",
          marginLeft: "auto",
          fontFamily: "var(--sans)",
          fontSize: "0.78rem",
          color: "var(--ink-soft)",
        }}
      >
        <span>claims</span>
        <span>docs</span>
        <span>about</span>
      </nav>
    </div>
  );
}

function TabSim({ svg, dark }: { svg: string; dark?: boolean }) {
  // A 16px favicon in a browser-tab-shaped chip, light and dark.
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 12px 4px 8px",
        borderRadius: "8px 8px 0 0",
        background: dark ? "#3c3f43" : "#dee1e6",
        color: dark ? "#e8eaed" : "#202124",
        fontFamily: "var(--sans)",
        fontSize: 11,
      }}
    >
      <Glyph svg={svg} px={16} />
      Minerval · an open repos…
    </span>
  );
}

function Tile({ svg }: { svg: string }) {
  // The apple-touch-icon: mark at 104/180 of the tile on warm paper.
  return (
    <span
      style={{
        display: "inline-flex",
        width: 90,
        height: 90,
        alignItems: "center",
        justifyContent: "center",
        background: "#fbfaf6",
        border: "1px solid var(--rule)",
        borderRadius: 20,
      }}
    >
      <Glyph svg={svg} px={52} />
    </span>
  );
}

function Card({ c }: { c: Candidate }) {
  return (
    <div
      id={c.name}
      style={{
        border: "1px solid var(--rule)",
        borderRadius: 4,
        background: "var(--paper-card)",
        padding: "1.1rem 1.2rem",
        marginBottom: "1.2rem",
        opacity: c.keep ? 1 : 0.55,
      }}
    >
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: "0.78rem",
          color: "var(--ink-soft)",
          marginBottom: "0.7rem",
        }}
      >
        {c.name}
        {!c.keep && "  · dropped by critique"}
      </div>
      <MastheadSim svg={c.svg} />
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: "1.6rem",
          margin: "1rem 0 0.4rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-end", gap: "0.9rem" }}>
          {[14, 16, 24, 48].map((px) => (
            <span key={px} style={{ textAlign: "center" }}>
              <Glyph svg={c.svg} px={px} />
              <span
                style={{
                  display: "block",
                  fontFamily: "var(--sans)",
                  fontSize: "0.62rem",
                  color: "var(--faint)",
                }}
              >
                {px}px
              </span>
            </span>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <TabSim svg={c.svg} />
          <TabSim svg={c.svg} dark />
        </div>
        <Tile svg={c.svg} />
      </div>
      <p
        style={{
          fontFamily: "var(--sans)",
          fontSize: "0.8rem",
          color: "var(--ink-soft)",
          margin: "0.6rem 0 0",
          maxWidth: "46rem",
        }}
      >
        {c.rationale}
      </p>
      {c.issues && c.issues !== "none" && (
        <p
          style={{
            fontFamily: "var(--sans)",
            fontSize: "0.72rem",
            color: "var(--muted)",
            margin: "0.35rem 0 0",
            maxWidth: "46rem",
          }}
        >
          critique: {c.issues}
        </p>
      )}
    </div>
  );
}

function BitmapGlyph({ base, px }: { base: string; px: number }) {
  // Uses the pre-scaled LANCZOS file when one exists for the target size.
  const sized = [14, 16, 24, 32, 48, 180];
  const file = sized.includes(px) ? `${base}-${px}.png` : `${base}-180.png`;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/episteme-logo/${file}`} width={px} height={px} alt="" style={{ display: "block" }} />;
}

function BitmapCard({ base, title, note }: { base: string; title: string; note: string }) {
  return (
    <div
      id={base}
      style={{
        border: "1px solid var(--rule)",
        borderRadius: 4,
        background: "var(--paper-card)",
        padding: "1.1rem 1.2rem",
        marginBottom: "1.2rem",
      }}
    >
      <div style={{ fontFamily: "var(--mono)", fontSize: "0.78rem", color: "var(--ink-soft)", marginBottom: "0.7rem" }}>
        {title}
      </div>
      <div
        style={{
          border: "1px solid var(--rule)",
          borderRadius: 3,
          background: "var(--paper)",
          padding: "0.7rem 1.2rem",
          display: "flex",
          alignItems: "center",
          gap: "1.6rem",
        }}
      >
        <span className="wordmark" style={{ display: "inline-flex", alignItems: "center" }}>
          <span style={{ marginRight: "0.4rem", display: "inline-flex" }}>
            <BitmapGlyph base={base} px={17} />
          </span>
          Minerval
        </span>
        <nav style={{ display: "flex", gap: "1.15rem", marginLeft: "auto", fontFamily: "var(--sans)", fontSize: "0.78rem", color: "var(--ink-soft)" }}>
          <span>claims</span>
          <span>docs</span>
          <span>about</span>
        </nav>
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "1.6rem", margin: "1rem 0 0.4rem", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: "0.9rem" }}>
          {[14, 16, 24, 48].map((px) => (
            <span key={px} style={{ textAlign: "center" }}>
              <BitmapGlyph base={base} px={px} />
              <span style={{ display: "block", fontFamily: "var(--sans)", fontSize: "0.62rem", color: "var(--faint)" }}>
                {px}px
              </span>
            </span>
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {[false, true].map((dark) => (
            <span
              key={String(dark)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 12px 4px 8px",
                borderRadius: "8px 8px 0 0",
                background: dark ? "#3c3f43" : "#dee1e6",
                color: dark ? "#e8eaed" : "#202124",
                fontFamily: "var(--sans)",
                fontSize: 11,
              }}
            >
              <BitmapGlyph base={base} px={16} />
              Minerval · an open repos…
            </span>
          ))}
        </div>
        <span
          style={{
            display: "inline-flex",
            width: 90,
            height: 90,
            alignItems: "center",
            justifyContent: "center",
            background: "#fbfaf6",
            border: "1px solid var(--rule)",
            borderRadius: 20,
          }}
        >
          <BitmapGlyph base={base} px={52} />
        </span>
        <BitmapGlyph base={base} px={180} />
      </div>
      <p style={{ fontFamily: "var(--sans)", fontSize: "0.8rem", color: "var(--ink-soft)", margin: "0.6rem 0 0", maxWidth: "46rem" }}>
        {note}
      </p>
    </div>
  );
}

function DarkModeSection() {
  const traced = candidates.find((c) => c.name === "svg-owlonly-ink");
  if (!traced) return null;
  const recolor = (fill: string) => traced.svg.replace('fill="#063f1d"', `fill="${fill}"`);
  const inks: [string, string][] = [
    ["#063f1d", "original ink"],
    ["#1f6b46", "brand green"],
    ["#4f7d4a", "light green (palette)"],
    ["#fbfaf6", "paper (dark-mode swap)"],
  ];
  const bgs: [string, string][] = [
    ["#000000", "pure black"],
    ["#202124", "Chrome dark UI"],
    ["#3c3f43", "Chrome dark tab"],
    ["#1e1e1e", "editor dark"],
  ];
  return (
    <section id="sec-darkmode">
      <h2 style={{ fontSize: "1.05rem", marginTop: "2rem" }}>
        Dark-background check · owl-only favicon
      </h2>
      <div
        style={{
          border: "1px solid var(--rule)",
          borderRadius: 4,
          background: "var(--paper-card)",
          padding: "1.1rem 1.2rem",
          marginBottom: "1.2rem",
        }}
      >
        <table style={{ borderCollapse: "collapse", fontFamily: "var(--sans)", fontSize: "0.72rem" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "0.3rem 0.8rem 0.3rem 0", color: "var(--ink-soft)", fontWeight: 500 }}>
                background
              </th>
              {inks.map(([fill, label]) => (
                <th key={fill} style={{ textAlign: "center", padding: "0.3rem 0.8rem", color: "var(--ink-soft)", fontWeight: 500 }}>
                  {label}
                  <br />
                  <span style={{ fontFamily: "var(--mono)", color: "var(--faint)" }}>{fill}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bgs.map(([bg, bgLabel]) => (
              <tr key={bg}>
                <td style={{ padding: "0.4rem 0.8rem 0.4rem 0", color: "var(--ink-soft)" }}>
                  {bgLabel}
                  <br />
                  <span style={{ fontFamily: "var(--mono)", color: "var(--faint)" }}>{bg}</span>
                </td>
                {inks.map(([fill]) => (
                  <td key={fill} style={{ padding: 0 }}>
                    <div
                      style={{
                        background: bg,
                        padding: "10px 16px",
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                      }}
                    >
                      <Glyph svg={recolor(fill)} px={16} />
                      <Glyph svg={recolor(fill)} px={32} />
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "3px 10px 3px 7px",
                          borderRadius: "7px 7px 0 0",
                          background: "rgba(255,255,255,0.08)",
                          color: "#e8eaed",
                          fontSize: 10,
                        }}
                      >
                        <Glyph svg={recolor(fill)} px={16} />
                        Minerval…
                      </span>
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ fontFamily: "var(--sans)", fontSize: "0.8rem", color: "var(--ink-soft)", margin: "0.8rem 0 0", maxWidth: "46rem" }}>
          Approximate contrast against pure black: original ink 1.7:1, brand green 3.3:1,
          light green 5.0:1, paper 15:1. An SVG favicon can carry a prefers-color-scheme
          media query, so the shipped icon can be the dark ink in light mode and swap to
          paper (or light green) in dark mode; Safari ignores SVG favicons and uses the
          touch icon, which has its own opaque paper tile.
        </p>
      </div>
    </section>
  );
}

export default function LogoPreview() {
  const directions = [
    "traced",
    "o3-coin-face",
    "o3-figure-silhouette",
    "o2-nodes-refined",
    "o2-diarch-refined",
    "o2-vigil-refined",
    "o2-primitives",
    "owl-geometric",
    "owl-classical",
    "node-refined",
    "graph-structure",
    "typographic-greek",
    "emblems",
  ];
  return (
    <div style={{ maxWidth: "52rem" }}>
      <h1 style={{ fontSize: "1.35rem" }}>Logo candidates · issue #207</h1>
      <p style={{ fontFamily: "var(--sans)", fontSize: "0.85rem", color: "var(--ink-soft)" }}>
        Each card shows the mark in the masthead context, at raw sizes, as a light/dark
        browser-tab favicon, and as the touch-icon tile. This page is untracked and never
        ships.
      </p>
      <section id="sec-bitmap">
        <h2 style={{ fontSize: "1.05rem", marginTop: "2rem" }}>Uploaded bitmap · Minerval Logo.png</h2>
        <BitmapCard
          base="owl-ink"
          title="owl-ink (original color #063f1d, white removed)"
          note="The uploaded image un-matted against its own ink color, so anti-aliased edges keep clean alpha instead of white halos, then trimmed and scaled with Lanczos to each target size."
        />
        <BitmapCard
          base="owl-brand"
          title="owl-brand (recolored to brand green #1f6b46)"
          note="Same alpha mask, but the ink is replaced with the site's primary green. The original ink is darker and colder than the palette used everywhere else on the site."
        />
        <BitmapCard
          base="owlonly-ink"
          title="owlonly-ink (frame and sprig removed, original color)"
          note="The owl figure isolated by erasing the rounded-square frame and the olive sprig, then re-trimmed. This is the small-size variant: the full composition has too much detail to survive 16px."
        />
        <BitmapCard
          base="owlonly-brand"
          title="owlonly-brand (owl only, brand green #1f6b46)"
          note="Owl-only mask recolored to the site's primary green."
        />
      </section>
      <DarkModeSection />
      <h2 style={{ fontSize: "1.05rem", marginTop: "2rem" }}>{DIRECTION_LABELS.current}</h2>
      <Card c={current} />
      {directions.map((d) => {
        const group = candidates.filter((c) => c.direction === d);
        if (group.length === 0) return null;
        return (
          <section key={d} id={`sec-${d}`}>
            <h2 style={{ fontSize: "1.05rem", marginTop: "2rem" }}>{DIRECTION_LABELS[d] ?? d}</h2>
            {group.map((c) => (
              <Card key={c.name} c={c} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
