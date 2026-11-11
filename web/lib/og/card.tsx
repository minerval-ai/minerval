import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { ImageResponse } from "next/og";
import { OWL_INK, OWL_PATH } from "@/app/Mark";
import { fmtDate } from "@/lib/format";
import { previewDate, truncateText, type ClaimPreview } from "@/lib/preview";

// The link-preview card: what Slack, X, Discord, iMessage and the like show
// when someone pastes a Minerval link. One layout serves a claim, a question,
// a quantity and a finding: the mark, the text set large, and beneath a rule
// the graph's judgment as the page gives it (lib/preview.ts).
//
// Platforms keep these images for days or longer, so every card carries the
// date its judgment was made. A card is the light theme only: it is read out
// of context, on someone else's background.

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

// The light-theme tokens of app/globals.css. The renderer takes no CSS
// variables, so the values are repeated here; keep them in step with :root.
const C = {
  paper: "#fbfaf6",
  paperSunk: "#f3f1ea",
  paperCard: "#fefdfb",
  ink: "#1a1813",
  inkSoft: "#423d33",
  muted: "#756f60",
  faint: "#9b9484",
  rule: "#e2ddd0",
  ruleStrong: "#c9c2b1",
} as const;

// --st-<status> and --st-<status>-tint, light theme.
const STATUS_COLOR: Record<string, { ink: string; tint: string }> = {
  verified: { ink: "#1f6b46", tint: "#e7f1ea" },
  supported: { ink: "#4f7d4a", tint: "#ecf2e8" },
  inconclusive: { ink: "#9a6d12", tint: "#f6efde" },
  doubtful: { ink: "#9a5f48", tint: "#f4ebe5" },
  contradicted: { ink: "#8f3a2c", tint: "#f4e6e1" },
  unknown: { ink: "#8b8576", tint: "#eeece4" },
};

// The site's type is a system stack (Charter, then Source Serif 4; Inter),
// which a server-side renderer cannot reach, so the card loads the stack's
// open-licensed members from files: Source Serif 4 for the text and the
// wordmark, Inter for labels. Subsets cover Latin, extended Latin and Greek,
// with Noto Sans Math behind them for the operators a mathematical claim
// uses; a character outside all of these draws as a blank box. Each subset
// is registered under its own family name and listed in the stacks below, so
// the renderer falls from one to the next. If the files cannot be read the
// card still renders, in the renderer's own face.
const FONT_DIR = join(process.cwd(), "lib/og/fonts");
const FONT_FILES = [
  { name: "Source Serif 4", weight: 600, file: "source-serif-4-latin-600-normal.woff" },
  { name: "Source Serif 4 Ext", weight: 600, file: "source-serif-4-latin-ext-600-normal.woff" },
  { name: "Source Serif 4 Greek", weight: 600, file: "source-serif-4-greek-600-normal.woff" },
  { name: "Inter", weight: 500, file: "inter-latin-500-normal.woff" },
  { name: "Inter Ext", weight: 500, file: "inter-latin-ext-500-normal.woff" },
  { name: "Inter", weight: 600, file: "inter-latin-600-normal.woff" },
  { name: "Noto Sans Math", weight: 400, file: "noto-sans-math-400-normal.woff" },
] as const;

type Font = { name: string; data: Buffer; weight: 400 | 500 | 600; style: "normal" };
let fontsPromise: Promise<Font[] | undefined> | null = null;

function loadFonts(): Promise<Font[] | undefined> {
  fontsPromise ??= Promise.all(
    FONT_FILES.map(async (f) => ({
      name: f.name,
      weight: f.weight,
      style: "normal" as const,
      data: await readFile(join(FONT_DIR, f.file)),
    })),
  ).catch((err) => {
    console.error("[minerval] preview card fonts unavailable, using the default face:", err);
    fontsPromise = null;
    return undefined;
  });
  return fontsPromise;
}

const SERIF = '"Source Serif 4", "Source Serif 4 Ext", "Source Serif 4 Greek", "Noto Sans Math", serif';
const SANS = 'Inter, "Inter Ext", "Noto Sans Math", sans-serif';

// The text is set as large as its length allows and never smaller than reads
// at thumbnail size; past the last step it is cut at a word, with an ellipsis.
// The line counts are what fits the card's text area at each size.
const TEXT_STEPS = [
  { upTo: 70, size: 66, lines: 3 },
  { upTo: 120, size: 56, lines: 4 },
  { upTo: 190, size: 46, lines: 5 },
  { upTo: 300, size: 38, lines: 6 },
] as const;
const TEXT_MAX = 300;

function fitText(text: string): { text: string; size: number; lines: number } {
  const t = truncateText(text, TEXT_MAX);
  const step = TEXT_STEPS.find((s) => t.length <= s.upTo) ?? TEXT_STEPS[TEXT_STEPS.length - 1]!;
  return { text: t, size: step.size, lines: step.lines };
}

function Frame({
  eyebrow, text, children,
}: { eyebrow: string; text: string; children: ReactNode }) {
  const fit = fitText(text);
  return (
    <div
      style={{
        width: "100%", height: "100%", display: "flex", flexDirection: "column",
        background: C.paper, color: C.ink, fontFamily: SANS, padding: "52px 64px 50px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <svg width={44} height={44} viewBox="0 0 24 24">
            <path d={OWL_PATH} fill={OWL_INK} fillRule="evenodd" />
          </svg>
          <div style={{ marginLeft: 12, fontFamily: SERIF, fontWeight: 600, fontSize: 36, letterSpacing: "-0.01em" }}>
            Minerval
          </div>
        </div>
        <div
          style={{
            fontSize: 22, fontWeight: 600, letterSpacing: "0.09em", textTransform: "uppercase", color: C.muted,
          }}
        >
          {eyebrow}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", alignItems: "center", overflow: "hidden", padding: "18px 0" }}>
        <div
          style={{
            display: "block", lineClamp: fit.lines, fontFamily: SERIF, fontWeight: 600,
            fontSize: fit.size, lineHeight: 1.22, letterSpacing: "-0.011em", wordBreak: "break-word",
          }}
        >
          {fit.text}
        </div>
      </div>

      <div
        style={{
          display: "flex", flexDirection: "column", flexShrink: 0, borderTop: `2px solid ${C.ruleStrong}`, paddingTop: 26,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Badge({
  label, ink, tint, round = false, dashed = false, weight = 600,
}: { label: string; ink: string; tint: string; round?: boolean; dashed?: boolean; weight?: 500 | 600 }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", flexShrink: 0,
        fontSize: 28, fontWeight: weight, letterSpacing: "0.07em", textTransform: "uppercase",
        color: ink, background: tint, border: `2px ${dashed ? "dashed" : "solid"} ${ink}`,
        borderRadius: round ? 999 : 4, padding: round ? "9px 24px" : "9px 20px",
      }}
    >
      {label}
    </div>
  );
}

// Verdict and dispute side by side and kept apart, as on the page (#524):
// the dispute label is plain text in the page's ink, never a second badge.
function Dispute({ label }: { label: string | null }) {
  if (!label) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", fontSize: 28, color: C.inkSoft, flexShrink: 0 }}>
      <div style={{ color: C.faint, margin: "0 14px" }}>·</div>
      <div style={{ fontWeight: label.startsWith("actively") ? 600 : 500 }}>{label}</div>
    </div>
  );
}

function AsOf({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div style={{ marginLeft: "auto", paddingLeft: 24, fontSize: 24, color: C.muted, flexShrink: 0 }}>
      {text}
    </div>
  );
}

const ROW = { display: "flex", alignItems: "center" } as const;
// The renderer lays out only explicit flex boxes, so stacked rows get one.
const STACK = { display: "flex", flexDirection: "column" } as const;

function Judgment({ p }: { p: ClaimPreview }) {
  const when = previewDate(p.assessedAt);
  const asOf = when ? `as of ${when}` : null;
  const v = p.verdict;

  if (!v) {
    // Not a verdict: the dashed, muted badge of the page, and the day the
    // card was drawn, since a cached card will outlast the state it shows.
    return (
      <div style={ROW}>
        <Badge label={p.unassessedLabel} ink={p.kind === "Question" ? C.muted : C.faint} tint={C.paper} round={p.kind === "Question"} dashed weight={500} />
        <Dispute label={p.dispute} />
        {p.kind !== "Quantity" && (
          <div style={{ marginLeft: 20, fontSize: 26, color: C.muted }}>Not yet assessed.</div>
        )}
        <AsOf text={`as of ${fmtDate(new Date().toISOString())}`} />
      </div>
    );
  }

  if (v.family === "estimate") {
    return (
      <div style={STACK}>
        <div style={{ display: "flex", fontSize: 30, lineHeight: 1.3, color: C.ink }}>
          {truncateText(v.words, 130)}
        </div>
        <div style={{ ...ROW, marginTop: 16 }}>
          <div style={{ fontSize: 24, color: C.muted }}>The graph&apos;s estimate</div>
          <Dispute label={p.dispute} />
          <AsOf text={asOf} />
        </div>
      </div>
    );
  }

  const badge =
    v.family === "standing" ? (
      // A question's standing: round and in ink, never a status colour.
      <Badge label={v.label} ink={v.key === "answered" ? C.ink : C.inkSoft} tint={C.paperCard} round dashed={v.key === "ill_posed"} />
    ) : (
      <Badge label={v.label} ink={(STATUS_COLOR[v.key] ?? STATUS_COLOR.unknown!).ink} tint={(STATUS_COLOR[v.key] ?? STATUS_COLOR.unknown!).tint} />
    );
  const figures = p.credence != null || p.verdictConfidence != null;
  return (
    <div style={STACK}>
      <div style={ROW}>
        {badge}
        <Dispute label={p.dispute} />
        <AsOf text={asOf} />
      </div>
      {figures && (
        <div style={{ ...ROW, marginTop: 20, fontSize: 26, color: C.inkSoft }}>
          {p.credence != null && (
            // Credence gets the meter, in neutral ink so it never reads as a
            // restatement of the verdict; verdict confidence stays a quiet
            // labelled figure (#160).
            <div style={{ ...ROW, marginRight: 40 }}>
              <div>credence</div>
              <div
                style={{
                  display: "flex", width: 150, height: 12, margin: "0 14px", borderRadius: 3,
                  background: C.paperSunk, border: `1px solid ${C.ruleStrong}`, overflow: "hidden",
                }}
              >
                <div style={{ width: `${Math.round(p.credence * 100)}%`, height: "100%", background: C.inkSoft }} />
              </div>
              <div>{p.credence.toFixed(2)}</div>
            </div>
          )}
          {p.verdictConfidence != null && (
            <div style={{ color: C.muted }}>{`verdict confidence ${p.verdictConfidence.toFixed(2)}`}</div>
          )}
        </div>
      )}
    </div>
  );
}

async function render(node: ReactElement, init?: { status?: number; cacheControl?: string }): Promise<ImageResponse> {
  const fonts = await loadFonts();
  return new ImageResponse(node, {
    ...OG_SIZE,
    ...(fonts ? { fonts } : {}),
    status: init?.status ?? 200,
    headers: {
      // The judgment changes as claims are reassessed. The renderer's default
      // marks an image immutable for a year; a shared cache may keep a card
      // ten minutes instead, and the platforms' own caches are the reason
      // each card is dated.
      "Cache-Control": init?.cacheControl ?? "public, max-age=600, s-maxage=600",
    },
  });
}

/** The card for a claim, a question or a quantity. */
export function claimCard(p: ClaimPreview): Promise<ImageResponse> {
  return render(
    <Frame eyebrow={p.state ? `${p.kind} · ${p.state}` : p.kind} text={p.text}>
      <Judgment p={p} />
    </Frame>,
  );
}

/** The card for a finding: its headline, the claim it is about, and when it was noted. */
export function findingCard(f: {
  headline: string; claimText: string | null; notedAt: string; withdrawn: boolean; stale: boolean;
}): Promise<ImageResponse> {
  const when = previewDate(f.notedAt);
  // The page's two notices, in its words: a withdrawn finding and one whose
  // cited assessment is no longer the claim's current one.
  const notice = f.withdrawn ? "Withdrawn" : f.stale ? "The graph has moved" : null;
  return render(
    <Frame eyebrow="Finding" text={f.headline}>
      {f.claimText && (
        <div style={{ ...ROW, alignItems: "flex-start", fontSize: 26, lineHeight: 1.3, color: C.inkSoft }}>
          <div style={{ flexShrink: 0, marginRight: 12, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: C.muted }}>
            On
          </div>
          <div style={{ display: "block", lineClamp: 2 }}>{truncateText(f.claimText, 150)}</div>
        </div>
      )}
      <div style={{ ...ROW, marginTop: f.claimText ? 14 : 0, minHeight: 34 }}>
        {notice && (
          <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: STATUS_COLOR.inconclusive!.ink }}>
            {notice}
          </div>
        )}
        <AsOf text={when ? `noted ${when}` : null} />
      </div>
    </Frame>,
  );
}

/**
 * The card for an address that holds nothing (or whose record could not be
 * read just now). A real image, so no preview shows a broken one, served as
 * 404 and uncached so no platform pins it to an address that may hold a
 * claim later.
 */
export function missingCard(eyebrow: string, text: string): Promise<ImageResponse> {
  return render(
    <Frame eyebrow={eyebrow} text={text}>
      <div style={{ ...ROW, fontSize: 26, color: C.muted }}>
        An open repository of claims.
      </div>
    </Frame>,
    { status: 404, cacheControl: "no-store" },
  );
}
