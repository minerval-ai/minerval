import { useEffect, useMemo, useRef, useState } from "react";
import "./popup.css";
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
  PageState,
  Result,
  Settings,
  SitePolicy,
} from "~lib/types";

/**
 * Toolbar popup: the chat panel (talk to the extension agent about the page,
 * grounded in the claim graph) plus the markup/privacy settings.
 */

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

function Chat({ settings }: { settings: Settings }) {
  const [page, setPage] = useState<PageState | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void getPageState().then(setPage);
  }, []);
  // A page analysis can run for minutes (async flow, #93); keep the status
  // line live while one is in flight.
  useEffect(() => {
    if (!page?.running && !analyzing) return;
    const timer = window.setInterval(
      () => void getPageState().then(setPage),
      3000
    );
    return () => window.clearInterval(timer);
  }, [page?.running, analyzing]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  const flagged = useMemo(
    () =>
      (page?.annotations ?? []).filter(
        (a) => a.verdict !== "fine" && a.verdict !== "unknown"
      ),
    [page]
  );

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
      setPage(await getPageState());
    }
  };

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
            original_text: a.original_text.slice(0, 2000),
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

  const host = page ? new URL(page.url).hostname : null;
  const disabled = host
    ? resolveSitePolicy(settings, host) === "disabled"
    : false;

  return (
    <div className="chat">
      <div className="page-status">
        {!page && <span className="muted">Extension can't run on this page.</span>}
        {page && disabled && (
          <span className="muted">Minerval is disabled on {host}.</span>
        )}
        {page && !disabled && !page.analyzed && (page.running || analyzing) && (
          <span className="muted">
            Analyzing… large pages can take a few minutes.
          </span>
        )}
        {page && !disabled && !page.analyzed && !page.running && !analyzing && (
          <>
            <span className="muted">Page not analyzed yet.</span>
            <button onClick={() => void analyze()}>Analyze page</button>
          </>
        )}
        {page && page.analyzed && (
          <span className="muted">
            {page.annotations.length} claims checked ·{" "}
            {flagged.length === 0
              ? "nothing flagged"
              : `${flagged.length} flagged`}
          </span>
        )}
      </div>

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
          <option value="moderate">Moderate — also contested claims</option>
          <option value="aggressive">
            Aggressive — also oversimplified & noteworthy
          </option>
        </select>
      </label>

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
  const [tab, setTab] = useState<"chat" | "settings">("chat");
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void getSettings().then(setSettings);
  }, []);

  if (!settings) return <div className="popup" />;

  return (
    <div className="popup">
      <header>
        <span className="brand">Minerval</span>
        <nav>
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
      {tab === "chat" ? (
        <Chat settings={settings} />
      ) : (
        <SettingsPane settings={settings} onChange={setSettings} />
      )}
    </div>
  );
}
