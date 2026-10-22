/** Wire types shared with the Minerval API (see src/services/extension-service.ts). */

export type Verdict =
  | "egregious"
  | "contested"
  | "oversimplified"
  | "noteworthy"
  | "fine"
  | "unknown";

export interface AnnotationClaim {
  id: string;
  canonical_form: string;
  status: string;
  status_confidence: number;
  subclaim_count: number;
  url: string;
}

export interface PageAnnotation {
  verbatim_text: string;
  context: string | null;
  source_location: string | null;
  verdict: Verdict;
  why: string;
  confidence: number;
  stance: "affirms" | "denies";
  /** How the claim would be worded if added (unmatched claims only). */
  proposed_canonical_form?: string | null;
  claim: AnnotationClaim | null;
}

export interface PageAnalysis {
  url: string;
  content_hash: string;
  cached: boolean;
  annotations: PageAnnotation[];
  stats: { extracted: number; matched: number };
  analyzed_at: string;
  /** Served from the shared cache: another reader's analysis of this page. */
  shared?: boolean;
}

export interface ChatCitation {
  id: string;
  canonical_form: string;
  status: string | null;
  url: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  reply: string;
  citations: ChatCitation[];
}

/** Markup levels, most→least conservative. Controls which verdicts render. */
export type MarkupLevel = "off" | "conservative" | "moderate" | "aggressive";

export const LEVEL_VERDICTS: Record<MarkupLevel, Verdict[]> = {
  off: [],
  conservative: ["egregious"],
  moderate: ["egregious", "contested"],
  aggressive: ["egregious", "contested", "oversimplified", "noteworthy"],
};

export type SitePolicy = "default" | "auto" | "manual" | "disabled";

export interface Settings {
  apiBaseUrl: string;
  apiKey: string;
  markupLevel: MarkupLevel;
  /**
   * Analyze pages without being asked. Off by default: page text is sent to
   * the Minerval API, so sending is opt-in (globally or per site).
   */
  autoAnalyze: boolean;
  /** Per-host overrides of the global behavior. */
  siteOverrides: Record<string, SitePolicy>;
  /**
   * Faintly mark claims the graph doesn't hold yet, so it's visible what the
   * analysis found and that they can be added.
   */
  showNewClaims: boolean;
  /**
   * Check whether another reader already analyzed the page you're on. Sends
   * only a short prefix of the page address's hash.
   */
  sharedLookups: boolean;
  /**
   * Offer your analyses to other readers. The server keeps one only if it
   * can confirm the page is public; drafts you're editing are never offered.
   */
  shareAnalyses: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  // The hosted API, matching the popup's placeholder. This defaulted to
  // localhost, so a fresh install pointed at a port with nothing on it and
  // every call died as a bare "Failed to fetch". Developers override it in
  // the popup; users should not have to.
  apiBaseUrl: "https://api.claimgraph.io",
  apiKey: "",
  markupLevel: "conservative",
  autoAnalyze: false,
  siteOverrides: {},
  showNewClaims: true,
  sharedLookups: true,
  shareAnalyses: true,
};

// --- Adding to the graph ------------------------------------------------------

/**
 * A reader's proposal of a claim found on the page. Only the claim's neutral
 * wording (and the reader's own note) is sent: nothing else from the page,
 * not its address, title or text. It goes through governed intake: nothing
 * enters the graph until the Contribution Reviewer accepts it, and a
 * declined proposal's charge is refunded.
 */
export interface Submission {
  contribution_id: string | null;
  submitted_at: string;
}

/** The parts of GET /usage the extension shows before a paid submission. */
export interface Entitlement {
  owl_balance: number;
  caps_owls: Partial<Record<"claim_proposal", number>>;
}

// --- Messages between popup / content script / background -------------------

/**
 * Analyze is asynchronous end-to-end (#93): the API answers 202 + content
 * hash when the pipeline outlasts its grace window, and the content script
 * polls via short "check-analysis" messages (each one a quick request, so no
 * load-balancer timeout and no long-lived message channels for MV3's service
 * worker to die under).
 */
export type AnalyzeProgress =
  | { done: true; analysis: PageAnalysis }
  | { done: false; content_hash: string };

export type BackgroundRequest =
  | { type: "analyze"; url: string; title: string; content: string; share: boolean }
  | { type: "shared-lookup"; urlHash: string }
  | { type: "check-analysis"; contentHash: string }
  | {
      type: "chat";
      messages: ChatTurn[];
      page: {
        url: string | null;
        title: string | null;
        claims: Array<{
          verbatim_text: string;
          verdict: string;
          claim_id: string | null;
          canonical_form: string | null;
          status: string | null;
        }>;
      };
    }
  | { type: "claim-detail"; claimId: string }
  | { type: "badge"; count: number }
  | { type: "propose-claim"; claim: string; argument: string }
  | { type: "entitlement" };

export type ContentRequest =
  | { type: "get-page-state" }
  | { type: "run-analysis" }
  | { type: "propose-claim"; verbatimText: string; argument?: string }
  | { type: "reveal-claim"; verbatimText: string }
  | { type: "set-share"; share: boolean };

export interface PageState {
  url: string;
  title: string;
  analyzed: boolean;
  running: boolean;
  error: string | null;
  annotations: PageAnnotation[];
  /** When the shown analysis ran, and whether it was another reader's. */
  analyzedAt: string | null;
  shared: boolean;
  /** The page looks like a draft being edited: never shared. */
  isDraft: boolean;
  /** Whether analyzing this page will offer the result for sharing. */
  share: boolean;
  /** Unmatched claims proposed from this page, keyed by verbatim text. */
  claimSubmissions: Record<string, Submission>;
}

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;
