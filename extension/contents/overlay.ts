import type { PlasmoCSConfig } from "plasmo";
import {
  buildTextIndex,
  findOccurrences,
  normalizeWithMap,
  occurrenceToRange,
  type TextIndex,
} from "~lib/anchor";
import { getSettings, onSettingsChanged, resolveSitePolicy } from "~lib/settings";
import {
  LEVEL_VERDICTS,
  type AnalyzeProgress,
  type BackgroundRequest,
  type ContentRequest,
  type PageAnalysis,
  type PageAnnotation,
  type Entitlement,
  type PageState,
  type Result,
  type Settings,
  type Submission,
  type Verdict,
} from "~lib/types";

export const config: PlasmoCSConfig = {
  matches: ["http://*/*", "https://*/*"],
  run_at: "document_idle",
};

/**
 * Non-destructive page markup: highlights are absolutely-positioned overlay
 * elements sized from Range client rects — the page's DOM text is never
 * rewritten. On mutation the text index is rebuilt and annotations re-anchor.
 */

const MAX_CONTENT_CHARS = 200_000;
const MIN_CONTENT_CHARS = 80;

// Public site for contribution deep links (#174). Claim pages come back from
// the API with their full URL; contribution pages (tracking a submission)
// need a base of their own.
const WEB_BASE = "https://minerval.ai";
const MAX_QUOTE_CHARS = 300;
// POST /claims/propose limits.
const MAX_PROPOSED_CLAIM_CHARS = 2_000;
const MAX_ARGUMENT_CHARS = 5_000;

/** Claim-page contribute link, quoting the highlighted passage. */
function contributeUrl(claimUrl: string, quote: string): string {
  const q = quote.length > MAX_QUOTE_CHARS ? `${quote.slice(0, MAX_QUOTE_CHARS)}…` : quote;
  return `${claimUrl}?contribute=challenge&quote=${encodeURIComponent(q)}`;
}

function contributionUrl(sub: Submission): string | null {
  return sub.contribution_id ? `${WEB_BASE}/contributions/${sub.contribution_id}` : null;
}

/** The claim as it would be proposed: the pipeline's neutral form if it has one. */
function proposedClaimText(a: PageAnnotation): string {
  return (a.proposed_canonical_form?.trim() || a.verbatim_text).slice(
    0,
    MAX_PROPOSED_CLAIM_CHARS
  );
}

/**
 * The supporting argument when the reader adds no note of their own. It
 * deliberately carries nothing from the page (no address, title or passage):
 * a proposal keeps only the claim, which is public and canonical, never the
 * page it was read on.
 */
const DEFAULT_ARGUMENT =
  "Proposed by a reader who came across this claim while reading. It is " +
  "stated as fact in published writing and is worth mapping and assessing.";

function owls(n: number): string {
  return `${n} owl${n === 1 ? "" : "s"}`;
}

interface Anchored {
  annotation: PageAnnotation;
  ranges: Range[];
}

const state: {
  settings: Settings | null;
  analysis: PageAnalysis | null;
  anchored: Anchored[];
  running: boolean;
  error: string | null;
  lastUrl: string;
  /** Proposals made from this page, reset on navigation. */
  claimSubmissions: Record<string, Submission>;
} = {
  settings: null,
  analysis: null,
  anchored: [],
  running: false,
  error: null,
  lastUrl: location.href,
  claimSubmissions: {},
};

function sendToBackground<T>(message: BackgroundRequest): Promise<Result<T>> {
  return chrome.runtime.sendMessage(message) as Promise<Result<T>>;
}

// --- Overlay DOM -------------------------------------------------------------

const STYLE = `
.ep-box { position: absolute; pointer-events: auto; cursor: pointer; border-radius: 1px; }
.ep-box.ep-egregious { background: rgba(179, 38, 30, 0.09); border-bottom: 2px solid #b3261e; }
.ep-box.ep-contested { background: rgba(158, 124, 32, 0.09); border-bottom: 2px dotted #9e7c20; }
.ep-box.ep-oversimplified { background: rgba(110, 110, 110, 0.09); border-bottom: 2px dashed #767676; }
.ep-box.ep-noteworthy { background: rgba(62, 98, 138, 0.07); border-bottom: 1px solid #3e628a; }
/* Not in the graph yet: present but quiet, so a page full of new claims
   reads as "found, not yet checked" rather than as a wall of warnings. */
.ep-box.ep-unknown { border-bottom: 1px dashed rgba(110, 110, 110, 0.6); }
.ep-box.ep-unknown:hover { background: rgba(110, 110, 110, 0.07); }
.ep-card {
  /* Explicit width: the card lives in a zero-width overlay container, so
     shrink-to-fit (max-width alone) would collapse it to min-content. */
  position: absolute; z-index: 2147483646; width: min(340px, 80vw); padding: 10px 12px;
  box-sizing: border-box;
  background: #fffef9; color: #222; border: 1px solid #b9b5a7; border-radius: 3px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  font: 13px/1.45 Georgia, 'Times New Roman', serif; pointer-events: auto;
}
.ep-card .ep-status { font: 11px/1 -apple-system, system-ui, sans-serif; letter-spacing: 0.05em;
  text-transform: uppercase; color: #555; margin-bottom: 6px; }
.ep-card .ep-status b.ep-s-contradicted, .ep-card .ep-status b.ep-s-egregious { color: #b3261e; }
.ep-card .ep-status b.ep-s-verified { color: #2d6a2d; }
.ep-card .ep-canonical { font-style: italic; margin-bottom: 6px; }
.ep-card .ep-why { margin-bottom: 6px; }
.ep-card .ep-hint { color: #777; font-size: 11px; }
.ep-panel {
  position: fixed; top: 0; right: 0; bottom: 0; width: 400px; max-width: 92vw;
  z-index: 2147483647; background: #fffef9; color: #222; border-left: 1px solid #b9b5a7;
  box-shadow: -2px 0 12px rgba(0,0,0,0.18); overflow-y: auto; padding: 18px 20px;
  font: 14px/1.55 Georgia, 'Times New Roman', serif;
}
.ep-panel h1 { font-size: 16px; margin: 0 0 4px; }
.ep-panel h2 { font: 600 11px/1 -apple-system, system-ui, sans-serif; letter-spacing: 0.06em;
  text-transform: uppercase; color: #666; margin: 18px 0 6px; }
.ep-panel .ep-close { position: absolute; top: 10px; right: 12px; border: none; background: none;
  font-size: 20px; cursor: pointer; color: #666; }
.ep-panel a { color: #274870; }
.ep-panel ul { padding-left: 18px; margin: 4px 0; }
.ep-panel li { margin-bottom: 6px; }
.ep-panel .ep-quote { border-left: 3px solid #d5d0c2; padding-left: 10px; color: #444; font-style: italic; }
.ep-panel .ep-muted { color: #777; font-size: 12px; }
.ep-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font: 600 11px/1.6 -apple-system, system-ui, sans-serif; }
.ep-badge.ep-s-verified { background: #e2efe2; color: #2d6a2d; }
.ep-badge.ep-s-supported { background: #e9f0e9; color: #3d6a3d; }
.ep-badge.ep-s-contested { background: #f4ecd7; color: #7a5f14; }
.ep-badge.ep-s-unsupported { background: #eee; color: #555; }
.ep-badge.ep-s-contradicted { background: #f6e0de; color: #b3261e; }
.ep-badge.ep-s-unknown { background: #eee; color: #777; }
.ep-panel .ep-add { margin-top: 18px; padding: 12px; background: #f6f3ea; border: 1px solid #e2ddcd; border-radius: 3px; }
.ep-panel .ep-add p { margin: 0 0 8px; }
.ep-panel textarea { width: 100%; box-sizing: border-box; min-height: 84px; margin: 4px 0 8px;
  font: 13px/1.45 -apple-system, system-ui, sans-serif; padding: 6px; border: 1px solid #c9c4b4; border-radius: 3px; }
.ep-panel button.ep-btn { font: 600 13px/1 -apple-system, system-ui, sans-serif; padding: 8px 12px;
  border-radius: 3px; border: 1px solid #274870; background: #274870; color: #fff; cursor: pointer; }
.ep-panel button.ep-btn:disabled { opacity: 0.6; cursor: default; }
.ep-panel .ep-error { color: #b3261e; font-size: 12px; margin-top: 6px; }
.ep-panel .ep-done { color: #2d6a2d; }
`;

let container: HTMLDivElement | null = null;
let card: HTMLDivElement | null = null;
let panel: HTMLDivElement | null = null;
let cardHideTimer: number | undefined;

function ensureContainer(): HTMLDivElement {
  if (container && container.isConnected) return container;
  const style = document.createElement("style");
  style.setAttribute("data-minerval-ui", "");
  style.textContent = STYLE;
  document.documentElement.appendChild(style);

  container = document.createElement("div");
  container.setAttribute("data-minerval-ui", "");
  Object.assign(container.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: "0",
    height: "0",
    overflow: "visible",
    pointerEvents: "none",
    zIndex: "2147483645",
  });
  document.documentElement.appendChild(container);
  return container;
}

function verdictLabel(v: Verdict): string {
  switch (v) {
    case "egregious":
      return "Disputed by the claim graph";
    case "contested":
      return "Contested";
    case "oversimplified":
      return "Oversimplified";
    case "noteworthy":
      return "In the claim graph";
    case "unknown":
      return "Not in the claim graph yet";
    default:
      return "";
  }
}

function esc(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function showCard(box: HTMLElement, a: PageAnnotation): void {
  window.clearTimeout(cardHideTimer);
  if (!card) {
    card = document.createElement("div");
    card.className = "ep-card";
    card.setAttribute("data-minerval-ui", "");
    card.addEventListener("mouseenter", () => window.clearTimeout(cardHideTimer));
    card.addEventListener("mouseleave", scheduleHideCard);
    ensureContainer().appendChild(card);
  }
  if (a.claim) {
    const status = a.claim.status;
    card.innerHTML = `
      <div class="ep-status"><b class="ep-s-${esc(a.verdict)}">${esc(verdictLabel(a.verdict))}</b>
        · graph status: <b class="ep-s-${esc(status)}">${esc(status)}</b></div>
      <div class="ep-canonical">${esc(a.claim.canonical_form)}</div>
      <div class="ep-why">${esc(a.why)}</div>
      <div class="ep-hint">Click for evidence & decomposition · confidence ${Math.round(
        a.confidence * 100
      )}%</div>`;
  } else {
    const submitted = state.claimSubmissions[a.verbatim_text];
    card.innerHTML = `
      <div class="ep-status"><b>${esc(verdictLabel(a.verdict))}</b></div>
      ${a.proposed_canonical_form ? `<div class="ep-canonical">${esc(a.proposed_canonical_form)}</div>` : ""}
      <div class="ep-why">${esc(a.why)} Minerval hasn't checked it.</div>
      <div class="ep-hint">${
        submitted ? "Proposed for the graph · pending review" : "Click to add it to the graph"
      }</div>`;
  }
  const rect = box.getBoundingClientRect();
  card.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
  card.style.top = `${rect.bottom + window.scrollY + 6}px`;
  card.style.display = "block";
}

function scheduleHideCard(): void {
  window.clearTimeout(cardHideTimer);
  cardHideTimer = window.setTimeout(() => {
    if (card) card.style.display = "none";
  }, 250);
}

interface ClaimDetail {
  assessment?: { reasoning_trace?: string } | null;
  tree?: {
    subclaims?: Array<{
      claim?: { id?: string; text?: string };
      assessment?: { status?: string } | null;
      relation_type?: string;
    }>;
  } | null;
  arguments?: Array<{ stance?: string; name?: string; content?: string }>;
}

async function openPanel(a: PageAnnotation): Promise<void> {
  closePanel();
  panel = document.createElement("div");
  panel.className = "ep-panel";
  panel.setAttribute("data-minerval-ui", "");

  const status = a.claim?.status ?? "unknown";
  panel.innerHTML = a.claim
    ? `
    <button class="ep-close" title="Close">×</button>
    <div class="ep-status" style="margin-bottom:8px">
      <span class="ep-badge ep-s-${esc(status)}">${esc(status)}</span>
    </div>
    <h1>${esc(a.claim.canonical_form)}</h1>
    <div class="ep-muted">${esc(verdictLabel(a.verdict))}${
      a.stance === "denies" ? " · this page argues against the claim above" : ""
    }</div>
    <h2>On this page</h2>
    <div class="ep-quote">${esc(a.verbatim_text)}</div>
    <h2>Assessment</h2>
    <div>${esc(a.why)}</div>
    <div class="ep-detail"><p class="ep-muted">Loading decomposition & evidence…</p></div>
    <p><a href="${esc(a.claim.url)}" target="_blank" rel="noopener">Open this claim on minerval.ai →</a><br>
       <a href="${esc(contributeUrl(a.claim.url, a.verbatim_text))}" target="_blank" rel="noopener">Challenge it or add evidence →</a></p>`
    : `
    <button class="ep-close" title="Close">×</button>
    <div class="ep-status" style="margin-bottom:8px">
      <span class="ep-badge ep-s-unknown">not in the graph</span>
    </div>
    <h1>${esc(proposedClaimText(a))}</h1>
    <div class="ep-muted">${esc(a.why)} Minerval hasn't checked it.</div>
    <h2>On this page</h2>
    <div class="ep-quote">${esc(a.verbatim_text)}</div>
    <div class="ep-add"></div>`;
  panel.querySelector(".ep-close")!.addEventListener("click", closePanel);
  document.documentElement.appendChild(panel);

  if (!a.claim) {
    renderAddSection(a);
    return;
  }

  const result = await sendToBackground<ClaimDetail>({
    type: "claim-detail",
    claimId: a.claim.id,
  });
  const detail = panel?.querySelector(".ep-detail");
  if (!detail) return;
  if (!result.ok) {
    detail.innerHTML = `<p class="ep-muted">Couldn't load details (${esc(result.error)}).</p>`;
    return;
  }

  const d = result.data;
  const parts: string[] = [];
  const trace = d.assessment?.reasoning_trace;
  if (trace) {
    parts.push(`<h2>Why the graph thinks so</h2><div>${esc(trace.slice(0, 900))}${
      trace.length > 900 ? "…" : ""
    }</div>`);
  }
  const subclaims = d.tree?.subclaims ?? [];
  if (subclaims.length) {
    parts.push(
      `<h2>Decomposes into</h2><ul>` +
        subclaims
          .slice(0, 12)
          .map(
            (s) =>
              `<li>${esc(s.claim?.text ?? "")} ` +
              `<span class="ep-badge ep-s-${esc(s.assessment?.status ?? "unknown")}">${esc(
                s.assessment?.status ?? "unknown"
              )}</span></li>`
          )
          .join("") +
        `</ul>`
    );
  }
  const args = (d.arguments ?? []).filter((x) => x.content);
  if (args.length) {
    const side = (stance: string, title: string) => {
      const list = args.filter((x) => x.stance === stance).slice(0, 4);
      if (!list.length) return "";
      return (
        `<h2>${title}</h2><ul>` +
        list.map((x) => `<li>${esc((x.content ?? "").slice(0, 300))}</li>`).join("") +
        `</ul>`
      );
    };
    parts.push(side("for", "Evidence & arguments for"));
    parts.push(side("against", "Evidence & arguments against"));
  }
  detail.innerHTML = parts.join("") || "";
}

/**
 * The panel's "add to the graph" block for a claim the graph doesn't hold:
 * propose it (reviewed, then matched and assessed). Only the claim's wording
 * and the reader's optional note are sent.
 */
function renderAddSection(a: PageAnnotation, error?: string): void {
  const box = panel?.querySelector<HTMLDivElement>(".ep-add");
  if (!box) return;

  const submitted = state.claimSubmissions[a.verbatim_text];
  if (submitted) {
    const link = contributionUrl(submitted);
    box.innerHTML = `
      <p class="ep-done"><b>Proposed for the graph.</b></p>
      <p class="ep-muted">A reviewer checks it is a well-formed claim. If accepted it is
        matched against the graph (landing on an existing claim if one turns out to
        hold it) and assessed.${
          link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">Track it →</a>` : ""
        }</p>`;
    return;
  }

  box.innerHTML = `
    <h2 style="margin-top:0">Add it to the graph</h2>
    <p class="ep-muted">It would be proposed in the wording above.</p>
    <label class="ep-muted" for="ep-argument">Why it's worth checking (optional)</label>
    <textarea id="ep-argument" maxlength="${MAX_ARGUMENT_CHARS}"
      placeholder="Your own words. Don't paste from the page."></textarea>
    <button class="ep-btn" type="button">Propose this claim</button>
    <p class="ep-muted ep-cost" style="margin-top:8px">Reviewed before it's added; the
      charge is refunded if the review declines it.</p>
    <p class="ep-muted">Only the claim above and your note are sent. Nothing else from
      this page is kept: not its address, title or text.</p>
    ${error ? `<div class="ep-error">${esc(error)}</div>` : ""}`;

  const textarea = box.querySelector("textarea")!;
  const button = box.querySelector<HTMLButtonElement>("button.ep-btn")!;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Submitting…";
    const result = await proposeFromPage(a.verbatim_text, textarea.value);
    renderAddSection(a, result.ok ? undefined : result.error);
  });

  void sendToBackground<Entitlement>({ type: "entitlement" }).then((r) => {
    const cap = r.ok ? r.data.caps_owls.claim_proposal : undefined;
    const cost = box.querySelector(".ep-cost");
    if (!r.ok || cap === undefined || !cost) return;
    cost.textContent =
      `Reviewed before it's added. Costs up to ${owls(cap)} (you have ` +
      `${owls(Math.round(r.data.owl_balance * 100) / 100)}), which also buys its ` +
      `first assessment; refunded if the review declines it.`;
  });
}

function closePanel(): void {
  panel?.remove();
  panel = null;
}

// --- Anchoring + rendering ----------------------------------------------------

function clearOverlays(): void {
  if (container) {
    container.querySelectorAll(".ep-box").forEach((el) => el.remove());
  }
}

function visibleVerdicts(): Set<Verdict> {
  const level = state.settings?.markupLevel ?? "conservative";
  const show = new Set<Verdict>(LEVEL_VERDICTS[level]);
  if (level !== "off" && (state.settings?.showNewClaims ?? true)) show.add("unknown");
  return show;
}

function renderAnchored(): void {
  clearOverlays();
  const root = ensureContainer();
  for (const { annotation, ranges } of state.anchored) {
    for (const range of ranges) {
      for (const rect of range.getClientRects()) {
        if (rect.width < 2 || rect.height < 2) continue;
        const box = document.createElement("div");
        box.className = `ep-box ep-${annotation.verdict}`;
        Object.assign(box.style, {
          left: `${rect.left + window.scrollX}px`,
          top: `${rect.top + window.scrollY}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
        box.addEventListener("mouseenter", () => showCard(box, annotation));
        box.addEventListener("mouseleave", scheduleHideCard);
        box.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void openPanel(annotation);
        });
        root.appendChild(box);
      }
    }
  }
}

function anchorAnnotations(index?: TextIndex): void {
  const idx = index ?? buildTextIndex(document.body);
  const normalized = normalizeWithMap(idx.text);
  const show = visibleVerdicts();
  state.anchored = [];

  for (const annotation of state.analysis?.annotations ?? []) {
    if (!show.has(annotation.verdict)) continue;
    const occurrences = findOccurrences(normalized, annotation.verbatim_text, 3);
    const ranges = occurrences
      .map((occ) => occurrenceToRange(idx, occ))
      .filter((r): r is Range => r !== null);
    if (ranges.length) state.anchored.push({ annotation, ranges });
  }
  renderAnchored();

  void sendToBackground({
    type: "badge",
    count: state.anchored.filter((a) => a.annotation.verdict === "egregious")
      .length,
  });
}

// --- Analysis -----------------------------------------------------------------

const POLL_INTERVAL_MS = 4_000;
const POLL_DEADLINE_MS = 20 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

/** The page's readable text as sent to the API, or null if too little. */
function captureContent(): string | null {
  const content = buildTextIndex(document.body).text.slice(0, MAX_CONTENT_CHARS);
  if (content.replace(/\s+/g, " ").trim().length < MIN_CONTENT_CHARS) return null;
  return content;
}

async function runAnalysis(): Promise<void> {
  if (state.running) return;
  const settings = state.settings ?? (await getSettings());
  if (resolveSitePolicy(settings, location.hostname) === "disabled") return;

  const content = captureContent();
  if (content === null) {
    state.error = "There isn't enough readable text on this page to analyze.";
    return;
  }

  state.running = true;
  state.error = null;
  try {
    // Start (or join) the server-side run; big pages come back "not done"
    // with a content hash and we poll. Every message is short-lived, so no
    // load-balancer timeout and no long-open MV3 message channels.
    const started = await sendToBackground<AnalyzeProgress>({
      type: "analyze",
      url: location.href,
      title: document.title,
      content,
    });
    if (!started.ok) {
      state.error = started.error;
      return;
    }

    let progress = started.data;
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (!progress.done) {
      if (Date.now() > deadline) {
        state.error = "Analysis timed out; try again";
        return;
      }
      await sleep(POLL_INTERVAL_MS);
      const poll = await sendToBackground<AnalyzeProgress>({
        type: "check-analysis",
        contentHash: progress.content_hash,
      });
      if (!poll.ok) {
        state.error = poll.error;
        return;
      }
      progress = poll.data;
    }

    state.analysis = progress.analysis;
    anchorAnnotations();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.running = false;
  }
}

// --- Adding to the graph --------------------------------------------------------

async function proposeFromPage(
  verbatimText: string,
  argument?: string
): Promise<Result<Submission>> {
  const a = state.analysis?.annotations.find(
    (x) => x.verbatim_text === verbatimText && !x.claim
  );
  if (!a) return { ok: false, error: "That claim is no longer on this page's analysis." };
  const existing = state.claimSubmissions[verbatimText];
  if (existing) return { ok: true, data: existing };

  const body = (argument?.trim() || DEFAULT_ARGUMENT).slice(0, MAX_ARGUMENT_CHARS);
  const result = await sendToBackground<Submission>({
    type: "propose-claim",
    claim: proposedClaimText(a),
    argument: body,
  });
  if (result.ok) state.claimSubmissions[verbatimText] = result.data;
  return result;
}

/** Scroll a claim into view and open its panel (from the popup's list). */
function revealClaim(verbatimText: string): boolean {
  const hit = state.anchored.find((x) => x.annotation.verbatim_text === verbatimText);
  const range = hit?.ranges[0];
  if (!hit || !range) return false;
  const rect = range.getBoundingClientRect();
  window.scrollTo({
    top: rect.top + window.scrollY - window.innerHeight / 3,
    behavior: "smooth",
  });
  void openPanel(hit.annotation);
  return true;
}

// --- Reactivity ----------------------------------------------------------------

function debounce(fn: () => void, ms: number): () => void {
  let timer: number | undefined;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, ms);
  };
}

const reanchor = debounce(() => {
  if (state.analysis) anchorAnnotations();
}, 1200);

function watchPage(): void {
  const observer = new MutationObserver((mutations) => {
    // Ignore mutations we caused ourselves (overlay boxes, card, panel).
    if (
      mutations.every((m) =>
        m.target instanceof Element
          ? m.target.closest("[data-minerval-ui]") !== null
          : false
      )
    ) {
      return;
    }
    reanchor();
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  window.addEventListener("resize", reanchor);

  // SPA navigation: poll for URL changes (pushState isn't observable from the
  // isolated world without page-script injection).
  const autoRerun = debounce(() => {
    state.analysis = null;
    state.error = null;
    state.claimSubmissions = {};
    clearOverlays();
    closePanel();
    const settings = state.settings;
    if (
      settings &&
      resolveSitePolicy(settings, location.hostname) === "auto"
    ) {
      void runAnalysis();
    }
  }, 2000);
  window.setInterval(() => {
    if (location.href !== state.lastUrl) {
      state.lastUrl = location.href;
      autoRerun();
    }
  }, 1500);
}

// --- Messages from the popup -----------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: ContentRequest, _sender, sendResponse) => {
    if (message.type === "get-page-state") {
      const pageState: PageState = {
        url: location.href,
        title: document.title,
        analyzed: state.analysis !== null,
        running: state.running,
        error: state.error,
        annotations: state.analysis?.annotations ?? [],
        claimSubmissions: state.claimSubmissions,
      };
      sendResponse({ ok: true, data: pageState });
      return;
    }
    if (message.type === "propose-claim") {
      void proposeFromPage(message.verbatimText, message.argument).then((r) => {
        if (r.ok) anchorAnnotations();
        sendResponse(r);
      });
      return true;
    }
    if (message.type === "reveal-claim") {
      sendResponse({ ok: true, data: revealClaim(message.verbatimText) });
      return;
    }
    if (message.type === "run-analysis") {
      void runAnalysis().then(() => {
        sendResponse({
          ok: state.error === null,
          data: null,
          error: state.error ?? undefined,
        });
      });
      return true; // async response
    }
  }
);

// --- Boot -------------------------------------------------------------------------

void (async () => {
  state.settings = await getSettings();
  onSettingsChanged((s) => {
    state.settings = s;
    if (state.analysis) anchorAnnotations();
  });
  watchPage();
  if (resolveSitePolicy(state.settings, location.hostname) === "auto") {
    window.setTimeout(() => void runAnalysis(), 1500);
  }
})();
