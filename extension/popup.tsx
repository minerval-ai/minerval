import { useEffect, useRef, useState } from "react";
import "./popup.css";
import { Mark } from "~lib/mark";
import {
  getSettings,
  saveSettings,
  setSitePolicy,
  resolveSitePolicy,
} from "~lib/settings";
import type {
  ChatCitation,
  ChatResponse,
  ChatTurn,
  Entitlement,
  PageAnnotation,
  PageState,
  Result,
  Settings,
  SitePolicy,
  Submission,
} from "~lib/types";

/**
 * Toolbar popup: the page view (what the analysis found, which claims the
 * graph holds, and proposing the ones it doesn't), the chat panel (talk to
 * the extension agent about the page, grounded in the claim graph), and the
 * markup/privacy settings.
 */

const WEB_BASE = "https://minerval.ai";

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function getPageState(): Promise<PageState | null> {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try {
    const result = (await chrome.tabs.sendMessage(tab.id, {
      type: "get-page-state",
    })) as Result<PageState>;
    return result.ok ? result.data : null;
  } catch {
    return null; // no content script on this page (chrome://, store, etc.)
  }
}

interface Message extends ChatTurn {
  citations?: ChatCitation[];
}

/** Render a reply, linkifying [claim:<uuid>] markers via the citation list. */
function ReplyText({ text, citations }: { text: string; citations: ChatCitation[] }) {
  const parts = text.split(/(\[claim:[0-9a-f-]{36}\])/gi);
  const byId = new Map(citations.map((c) => [c.id.toLowerCase(), c]));
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\[claim:([0-9a-f-]{36})\]$/i.exec(part);
        if (!m) return <span key={i}>{part}</span>;
        const cite = byId.get(m[1]!.toLowerCase());
        if (!cite) return null; // uncited marker: drop rather than dead-link
        const n = citations.indexOf(cite) + 1;
        return (
          <a key={i} href={cite.url} target="_blank" rel="noopener noreferrer"
             title={cite.canonical_form}>
            [{n}]
          </a>
        );
      })}
    </>
  );
}

/** Page state from the content script, kept live while an analysis runs. */
function usePage() {
  const [page, setPage] = useState<PageState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setPage(await getPageState());
    setLoaded(true);
  };

  useEffect(() => {
    void refresh();
  }, []);
  // A page analysis can run for minutes (async flow, #93); keep the status
  // line live while one is in flight.
  useEffect(() => {
    if (!page?.running && !analyzing) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [page?.running, analyzing]);

  const analyze = async () => {
    const tab = await activeTab();
    if (!tab?.id) return;
    setAnalyzing(true);
    setError(null);
    try {
      const result = (await chrome.tabs.sendMessage(tab.id, {
        type: "run-analysis",
      })) as Result<null> & { error?: string };
      if (!result.ok) setError(result.error ?? "Analysis failed");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
      await refresh();
    }
  };

  return { page, loaded, analyzing, error: error ?? page?.error ?? null, analyze, refresh };
}

type PageHook = ReturnType<typeof usePage>;

function isFlagged(a: PageAnnotation): boolean {
  return a.verdict !== "fine" && a.verdict !== "unknown";
}

/**
 * One line saying plainly where the page stands: not analyzed (and nothing
 * sent), analyzing, failed, or what the analysis found and how much of it the
 * graph holds.
 */
function PageStatus({ settings, hook }: { settings: Settings; hook: PageHook }) {
  const { page, loaded, analyzing, error, analyze } = hook;
  if (!loaded) return <div className="page-status" />;
  if (!page) {
    return (
      <div className="page-status">
        <span className="muted">Minerval can't run on this page.</span>
      </div>
    );
  }
  const host = new URL(page.url).hostname;
  if (resolveSitePolicy(settings, host) === "disabled") {
    return (
      <div className="page-status">
        <span className="muted">Minerval is turned off on {host}.</span>
      </div>
    );
  }
  if (page.running || analyzing) {
    return (
      <div className="page-status">
        <span className="muted">
          Finding the claims on this page and checking them against the
          graph… large pages can take a few minutes.
        </span>
      </div>
    );
  }
  if (!page.analyzed) {
    return (
      <div className="page-status">
        <span className={error ? "error" : "muted"}>
          {error ??
            (settings.sharedLookups && !page.isDraft
              ? "Not analyzed yet, and no other reader has shared a check of this page."
              : "Not analyzed yet. Nothing from this page has been sent.")}
        </span>
        <button onClick={() => void analyze()}>
          {error ? "Try again" : "Analyze page"}
        </button>
      </div>
    );
  }

  const total = page.annotations.length;
  const inGraph = page.annotations.filter((a) => a.claim).length;
  const flagged = page.annotations.filter(isFlagged).length;
  return (
    <div className="page-status">
      <span className="muted">
        {page.shared && (
          <>
            Checked by another reader
            {page.analyzedAt ? ` on ${new Date(page.analyzedAt).toLocaleDateString()}` : ""}
            , statuses current.{" "}
          </>
        )}
        {total === 0
          ? "Analyzed: no checkable claims found on this page."
          : `${total} claim${total === 1 ? "" : "s"} found · ${inGraph} in the graph` +
            ` · ${total - inGraph} new` +
            (inGraph > 0 ? ` · ${flagged === 0 ? "nothing flagged" : `${flagged} flagged`}` : "")}
      </span>
      {page.shared && (
        <button onClick={() => void analyze()} title="Run a fresh analysis of the page as it is now">
          Re-analyze
        </button>
      )}
    </div>
  );
}

/**
 * Whether analyzing this page offers the result to other readers: on by
 * default for public pages, never for a draft, and the reader's to switch
 * off for this page.
 */
function ShareChoice({ settings, hook }: { settings: Settings; hook: PageHook }) {
  const { page, refresh } = hook;
  if (!page || page.running || (page.analyzed && !page.shared)) return null;
  if (page.isDraft) {
    return (
      <p className="muted pad-x">
        This looks like a draft you're editing, so its analysis stays private:
        it is never shared with other readers.
      </p>
    );
  }
  if (!settings.shareAnalyses) return null;
  return (
    <label className="row muted pad-x share-choice">
      <input
        type="checkbox"
        checked={page.share}
        onChange={async (e) => {
          await sendToTab({ type: "set-share", share: e.target.checked });
          await refresh();
        }}
      />
      Share the results with other readers of this page, if it's public
    </label>
  );
}

async function sendToTab<T>(message: unknown): Promise<Result<T>> {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, error: "No active tab" };
  try {
    return (await chrome.tabs.sendMessage(tab.id, message)) as Result<T>;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function contributionLink(sub: Submission) {
  if (!sub.contribution_id) return null;
  return (
    <a href={`${WEB_BASE}/contributions/${sub.contribution_id}`}
       target="_blank" rel="noopener noreferrer">
      track
    </a>
  );
}

function owls(n: number): string {
  const r = Math.round(n * 100) / 100;
  return `${r} owl${r === 1 ? "" : "s"}`;
}

/**
 * The page view: every claim the analysis found, split by whether the graph
 * holds it. Claims it doesn't hold can be proposed, one or several at once;
 * a proposal sends only the claim's neutral wording, nothing else from the
 * page.
 */
function PageView({ settings, hook }: { settings: Settings; hook: PageHook }) {
  const { page, refresh } = hook;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [proposing, setProposing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);

  const annotations = page?.analyzed ? page.annotations : [];
  const known = annotations.filter((a) => a.claim);
  const unknown = annotations.filter((a) => !a.claim);
  const submissions = page?.claimSubmissions ?? {};
  const open = unknown.filter((a) => !submissions[a.verbatim_text]);

  useEffect(() => {
    if (unknown.length === 0 || entitlement) return;
    void chrome.runtime
      .sendMessage({ type: "entitlement" })
      .then((r: Result<Entitlement>) => r.ok && setEntitlement(r.data))
      .catch(() => {});
  }, [unknown.length]);

  if (!page?.analyzed) {
    return (
      <div className="page-view">
        <PageStatus settings={settings} hook={hook} />
        <ShareChoice settings={settings} hook={hook} />
        <p className="hint pad">
          Analyzing finds the claims on this page and checks each against the
          Minerval claim graph. Claims the graph doesn't hold yet are listed
          here, and you can propose them for the graph. If the page is public,
          the next reader sees the results without re-running them.
        </p>
      </div>
    );
  }

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const propose = async () => {
    setProposing(true);
    const failed: Record<string, string> = {};
    // One at a time: each is its own charge and review, and a quota denial
    // part-way through should stop the rest rather than repeat N times.
    for (const key of open.map((a) => a.verbatim_text).filter((k) => selected.has(k))) {
      const r = await sendToTab<Submission>({ type: "propose-claim", verbatimText: key });
      if (!r.ok) {
        failed[key] = r.error;
        if (/allowance|owl|quota|rate limit|402|429/i.test(r.error)) break;
      }
    }
    setErrors(failed);
    setSelected(new Set());
    setProposing(false);
    await refresh();
  };

  const cap = entitlement?.caps_owls.claim_proposal;
  const count = open.filter((a) => selected.has(a.verbatim_text)).length;

  return (
    <div className="page-view">
      <PageStatus settings={settings} hook={hook} />
      <ShareChoice settings={settings} hook={hook} />
      <div className="claims">
        {unknown.length > 0 && (
          <section>
            <h3>Not in the graph yet ({unknown.length})</h3>
            <p className="muted">
              Found on this page but unchecked: the graph has nothing on
              them. Propose the ones worth checking. Each is reviewed, then
              added and assessed. Only the claim's wording is sent, nothing
              else from the page.
              {page.isDraft &&
                " Proposing a claim makes it public, even before your piece is."}
            </p>
            <ul>
              {unknown.map((a) => {
                const sub = submissions[a.verbatim_text];
                return (
                  <li key={a.verbatim_text} className="claim-row">
                    {sub ? (
                      <span className="done" title="Proposed">✓</span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={selected.has(a.verbatim_text)}
                        onChange={() => toggle(a.verbatim_text)}
                        disabled={proposing}
                      />
                    )}
                    <div>
                      <a href="#" onClick={(e) => {
                        e.preventDefault();
                        void sendToTab({ type: "reveal-claim", verbatimText: a.verbatim_text });
                      }}>
                        {a.proposed_canonical_form || a.verbatim_text}
                      </a>
                      {sub && (
                        <div className="muted">
                          Proposed · pending review {contributionLink(sub)}
                        </div>
                      )}
                      {errors[a.verbatim_text] && (
                        <div className="error">{errors[a.verbatim_text]}</div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {open.length > 0 && (
              <div className="propose-bar">
                <label className="row muted">
                  <input
                    type="checkbox"
                    checked={count === open.length}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked ? new Set(open.map((a) => a.verbatim_text)) : new Set()
                      )
                    }
                    disabled={proposing}
                  />
                  Select all
                </label>
                <button onClick={() => void propose()} disabled={proposing || count === 0}>
                  {proposing
                    ? "Proposing…"
                    : count === 0
                      ? "Propose selected"
                      : `Propose ${count} claim${count === 1 ? "" : "s"}`}
                </button>
              </div>
            )}
            {open.length > 0 && (
              <p className="muted">
                {cap !== undefined && entitlement
                  ? `Up to ${owls(cap)} each, which also buys its first assessment` +
                    `${count > 1 ? ` (up to ${owls(cap * count)} for ${count})` : ""}; ` +
                    `you have ${owls(entitlement.owl_balance)}. `
                  : ""}
                Refunded for any the review declines.
              </p>
            )}
          </section>
        )}

        {known.length > 0 && (
          <section>
            <h3>In the graph ({known.length})</h3>
            <ul>
              {known.map((a) => (
                <li key={a.verbatim_text} className="claim-row">
                  <span className={`badge s-${a.claim!.status}`}>{a.claim!.status}</span>
                  <a href={a.claim!.url} target="_blank" rel="noopener noreferrer">
                    {a.claim!.canonical_form}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function Chat({ settings, hook }: { settings: Settings; hook: PageHook }) {
  const { page } = hook;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  const send = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput("");
    setError(null);
    const history: Message[] = [...messages, { role: "user", content: question }];
    setMessages(history);
    setBusy(true);
    try {
      const result = (await chrome.runtime.sendMessage({
        type: "chat",
        messages: history.map(({ role, content }) => ({ role, content })),
        page: {
          url: page?.url ?? null,
          title: page?.title ?? null,
          claims: (page?.annotations ?? []).slice(0, 50).map((a) => ({
            verbatim_text: a.verbatim_text.slice(0, 2000),
            verdict: a.verdict,
            claim_id: a.claim?.id ?? null,
            canonical_form: a.claim?.canonical_form?.slice(0, 2000) ?? null,
            status: a.claim?.status ?? null,
          })),
        },
      })) as Result<ChatResponse>;
      if (!result.ok) {
        setError(result.error);
      } else {
        setMessages([
          ...history,
          {
            role: "assistant",
            content: result.data.reply,
            citations: result.data.citations,
          },
        ]);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="chat">
      <PageStatus settings={settings} hook={hook} />

      <div className="messages">
        {messages.length === 0 && (
          <div className="hint">
            Ask about this page — “is the highlighted claim true?”, “what's the
            strongest counter-argument here?” Answers are grounded in the
            Minerval claim graph.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === "assistant" ? (
              <>
                <ReplyText text={m.content} citations={m.citations ?? []} />
                {(m.citations?.length ?? 0) > 0 && (
                  <ol className="citations">
                    {m.citations!.map((c) => (
                      <li key={c.id}>
                        <a href={c.url} target="_blank" rel="noopener noreferrer">
                          {c.canonical_form}
                        </a>{" "}
                        {c.status && <em>({c.status})</em>}
                      </li>
                    ))}
                  </ol>
                )}
              </>
            ) : (
              m.content
            )}
          </div>
        ))}
        {busy && <div className="msg assistant muted">Consulting the graph…</div>}
        {error && <div className="error">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about this page…"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function SettingsPane({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => {
    void activeTab().then((tab) => {
      try {
        setHost(tab?.url ? new URL(tab.url).hostname : null);
      } catch {
        setHost(null);
      }
    });
  }, []);

  const update = async (patch: Partial<Settings>) => {
    onChange(await saveSettings(patch));
  };

  const sitePolicy: SitePolicy = host
    ? (settings.siteOverrides[host] ?? "default")
    : "default";

  return (
    <div className="settings">
      <label>
        Markup level
        <select
          value={settings.markupLevel}
          onChange={(e) =>
            void update({ markupLevel: e.target.value as Settings["markupLevel"] })
          }
        >
          <option value="off">Off — never mark up the page</option>
          <option value="conservative">
            Conservative — only egregiously wrong claims (red)
          </option>
          <option value="moderate">Moderate — also unsettled claims</option>
          <option value="aggressive">
            Aggressive — also oversimplified & noteworthy
          </option>
        </select>
      </label>

      <label className="row">
        <input
          type="checkbox"
          checked={settings.showNewClaims}
          onChange={(e) => void update({ showNewClaims: e.target.checked })}
        />
        Faintly underline claims not in the graph yet
      </label>

      <label className="row">
        <input
          type="checkbox"
          checked={settings.sharedLookups}
          onChange={(e) => void update({ sharedLookups: e.target.checked })}
        />
        Show checks other readers already ran
      </label>
      <p className="muted">
        On each page, sends only a short prefix of a hash of its address, shared
        by thousands of addresses, and fetches results only if this page has some.
      </p>

      <label className="row">
        <input
          type="checkbox"
          checked={settings.shareAnalyses}
          onChange={(e) => void update({ shareAnalyses: e.target.checked })}
        />
        Share my analyses of public pages
      </label>
      <p className="muted">
        Minerval keeps an analysis for other readers only after fetching the page
        itself, signed out, and finding the same text: so never inboxes,
        logged-in pages, or drafts. It keeps the address and the claims, not the
        page's text or who analyzed it.
      </p>

      <label className="row">
        <input
          type="checkbox"
          checked={settings.autoAnalyze}
          onChange={(e) => void update({ autoAnalyze: e.target.checked })}
        />
        Analyze pages automatically
      </label>
      <p className="muted">
        Analyzing sends the page's readable text to your Minerval API for
        claim extraction. When off, pages are only analyzed when you click
        “Analyze page”.
      </p>

      {host && (
        <label>
          On {host}
          <select
            value={sitePolicy}
            onChange={async (e) => {
              await setSitePolicy(host, e.target.value as SitePolicy);
              onChange(await getSettings());
            }}
          >
            <option value="default">Use global setting</option>
            <option value="auto">Analyze automatically</option>
            <option value="manual">Only when I ask</option>
            <option value="disabled">Never (disable here)</option>
          </select>
        </label>
      )}

      <label>
        API base URL
        <input
          value={settings.apiBaseUrl}
          onChange={(e) => void update({ apiBaseUrl: e.target.value })}
          placeholder="https://api.claimgraph.io"
        />
      </label>
      <label>
        API key
        <input
          type="password"
          value={settings.apiKey}
          onChange={(e) => void update({ apiKey: e.target.value })}
          placeholder="epk_…"
        />
      </label>
      <p className="muted">
        Create a key in your Minerval dashboard. Analysis and chat are
        LLM-backed and metered against your account's monthly allowance.
      </p>
    </div>
  );
}

export default function Popup() {
  const [tab, setTab] = useState<"page" | "chat" | "settings">("page");
  const [settings, setSettings] = useState<Settings | null>(null);
  const hook = usePage();

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  if (!settings) return <div className="popup" />;

  return (
    <div className="popup">
      <header>
        <span className="brand">
          <Mark size="0.95em" /> Minerval
        </span>
        <nav>
          <button
            className={tab === "page" ? "active" : ""}
            onClick={() => setTab("page")}
          >
            Page
          </button>
          <button
            className={tab === "chat" ? "active" : ""}
            onClick={() => setTab("chat")}
          >
            Chat
          </button>
          <button
            className={tab === "settings" ? "active" : ""}
            onClick={() => setTab("settings")}
          >
            Settings
          </button>
        </nav>
      </header>
      {tab === "page" && <PageView settings={settings} hook={hook} />}
      {tab === "chat" && <Chat settings={settings} hook={hook} />}
      {tab === "settings" && (
        <SettingsPane settings={settings} onChange={setSettings} />
      )}
    </div>
  );
}
