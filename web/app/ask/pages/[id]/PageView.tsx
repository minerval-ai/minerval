"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StandingBadge, StatusBadge } from "../../../../components/Assessment";
import { STATUS_ORDER, normalizeStatus, statusMeta } from "../../../../lib/ontology";
import { describeEstimate } from "../../../../lib/quantity";
import { fmtDate } from "../../../../lib/format";
import type { QuantityEstimate, QuantityUnit } from "../../../../lib/types";
import type {
  AssistantCitationView,
  PageHeld,
  PageNodeView,
  PageView as Page,
} from "../../../../lib/account-api";
import { Prose } from "../../prose";

// A page: markdown an agent saved for the user, with embeds that show nodes
// of the graph as they stand now. Where a node has moved since the page was
// saved, the page says what it was. Nothing in a page runs: an embed is a
// reference this component renders.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BLOCK_RE = new RegExp(
  `^[ \\t]*\\{\\{\\s*(node|nodes|decomposition)\\s+((?:${UUID}[\\s,]*)+)\\}\\}[ \\t]*$`,
  "i"
);
const INLINE_RE = new RegExp(`\\[claim:(${UUID})\\]`, "gi");

type Segment =
  | { type: "prose"; text: string }
  | { type: "node" | "nodes" | "decomposition"; ids: string[] };

function segments(body: string): Segment[] {
  const out: Segment[] = [];
  let prose: string[] = [];
  const flush = () => {
    if (prose.join("\n").trim()) out.push({ type: "prose", text: prose.join("\n") });
    prose = [];
  };
  for (const line of body.split("\n")) {
    const m = BLOCK_RE.exec(line);
    if (!m) {
      prose.push(line);
      continue;
    }
    flush();
    out.push({
      type: m[1]!.toLowerCase() as "node" | "nodes" | "decomposition",
      ids: (m[2]!.match(new RegExp(UUID, "gi")) ?? []).map((id) => id.toLowerCase()),
    });
  }
  flush();
  return out;
}

/** A node's judgment in words, for the export and for "was …". */
function heldWords(node: { kind: string; unit?: unknown }, held: PageHeld): string {
  if (node.kind === "question") return held.standing ? held.standing.replace(/_/g, " ") : "unassessed";
  if (node.kind === "quantity") {
    return held.estimate && node.unit
      ? describeEstimate(held.estimate as QuantityEstimate, node.unit as QuantityUnit).words
      : "no estimate";
  }
  return statusMeta(held.status).label.toLowerCase();
}

function nowHeld(node: PageNodeView): PageHeld {
  return { status: node.assessment_status, standing: node.standing, estimate: node.estimate };
}

function Judgment({ node }: { node: PageNodeView }) {
  if (node.kind === "question") return <StandingBadge standing={node.standing} />;
  if (node.kind === "quantity") {
    return <span className="kept-estimate">{heldWords(node, nowHeld(node))}</span>;
  }
  return <StatusBadge status={node.assessment_status} />;
}

function Moved({ node }: { node: PageNodeView }) {
  if (!node.saved) return null;
  return <span className="kept-moved">was {heldWords(node, node.saved)} when this page was saved</span>;
}

function Missing({ id }: { id: string }) {
  return (
    <p className="kept-missing">
      The graph holds no node with the id <code>{id}</code>.
    </p>
  );
}

function pct(n: number | null): string {
  return typeof n === "number" ? n.toFixed(2) : "–";
}

function NodeCard({ node }: { node: PageNodeView }) {
  return (
    <div className="card kept-card">
      <Link href={`/claims/${node.id}`} className="card-link">
        <div className="card-claim">{node.text}</div>
      </Link>
      <div className="card-foot">
        <Judgment node={node} />
        {node.kind !== "claim" && <span className="tag kind">{node.kind}</span>}
        {typeof node.assessment_confidence === "number" && (
          <span className="kept-fact">confidence {pct(node.assessment_confidence)}</span>
        )}
        {typeof node.contestation === "number" && (
          <span className="kept-fact">contestation {pct(node.contestation)}</span>
        )}
        {node.assessed_at && <span className="kept-fact">assessed {fmtDate(node.assessed_at)}</span>}
        <Moved node={node} />
      </div>
    </div>
  );
}

type SortKey = "page" | "status" | "confidence" | "contestation";

function statusRank(node: PageNodeView): number {
  if (node.kind !== "claim" || !node.assessment_status) return STATUS_ORDER.length;
  const i = STATUS_ORDER.indexOf(normalizeStatus(node.assessment_status));
  return i === -1 ? STATUS_ORDER.length : i;
}

function NodesTable({ ids, nodes }: { ids: string[]; nodes: Page["nodes"] }) {
  const [sort, setSort] = useState<SortKey>("page");
  const [down, setDown] = useState(true);
  const rows = useMemo(() => {
    const held = ids.map((id) => nodes[id]).filter((n): n is PageNodeView => !!n);
    if (sort === "page") return held;
    const value = (n: PageNodeView) =>
      sort === "status"
        ? -statusRank(n)
        : sort === "confidence"
          ? (n.assessment_confidence ?? -1)
          : (n.contestation ?? -1);
    return [...held].sort((a, b) => (down ? value(b) - value(a) : value(a) - value(b)));
  }, [ids, nodes, sort, down]);
  const missing = ids.filter((id) => !nodes[id]);

  const head = (key: SortKey, label: string) => (
    <th aria-sort={sort === key ? (down ? "descending" : "ascending") : "none"}>
      <button
        className="kept-sort"
        onClick={() => {
          if (sort === key) setDown(!down);
          else {
            setSort(key);
            setDown(true);
          }
        }}
      >
        {label}
        {sort === key ? (down ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );

  return (
    <div className="kept-table-wrap">
      <table className="account-table kept-table">
        <thead>
          <tr>
            {head("page", "Node")}
            {head("status", "Judgment")}
            {head("confidence", "Confidence")}
            {head("contestation", "Contestation")}
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.id}>
              <td>
                <Link href={`/claims/${n.id}`}>{n.text}</Link>
                {n.kind !== "claim" && <span className="tag kind"> {n.kind}</span>}
              </td>
              <td>
                <Judgment node={n} />
                <Moved node={n} />
              </td>
              <td>{pct(n.assessment_confidence)}</td>
              <td>{pct(n.contestation)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {missing.map((id) => (
        <Missing key={id} id={id} />
      ))}
    </div>
  );
}

function Decomposition({ id, page }: { id: string; page: Page }) {
  const node = page.nodes[id];
  if (!node) return <Missing id={id} />;
  const parts = page.decompositions[id] ?? [];
  return (
    <div className="kept-decomposition">
      <NodeCard node={node} />
      {parts.length === 0 ? (
        <p className="order-caption">The graph has not decomposed this node.</p>
      ) : (
        <ul>
          {parts.map((part) => {
            const child = page.nodes[part.id];
            if (!child) return null;
            return (
              <li key={`${part.id}-${part.relation}`}>
                {part.relation && <span className="tag">{part.relation.replace(/_/g, " ")}</span>}{" "}
                <Link href={`/claims/${child.id}`}>{child.text}</Link> <Judgment node={child} />
                <Moved node={child} />
              </li>
            );
          })}
        </ul>
      )}
      <p className="order-caption">
        <Link href={`/claims/${id}/map`}>The whole decomposition, as a map</Link>
      </p>
    </div>
  );
}

/** The page as plain markdown, the graph read as it stands today. */
function exportMarkdown(page: Page): string {
  const cited: string[] = [];
  const line = (n: PageNodeView) =>
    `[${n.text}](${n.page_url}) (${heldWords(n, nowHeld(n))})`;
  const body = page.body
    .split("\n")
    .map((raw) => {
      const m = BLOCK_RE.exec(raw);
      if (!m) {
        return raw.replace(INLINE_RE, (_all, id: string) => {
          const key = id.toLowerCase();
          if (!page.nodes[key]) return "";
          if (!cited.includes(key)) cited.push(key);
          return `[${cited.indexOf(key) + 1}]`;
        });
      }
      const ids = (m[2]!.match(new RegExp(UUID, "gi")) ?? []).map((id) => id.toLowerCase());
      const kind = m[1]!.toLowerCase();
      if (kind === "decomposition") {
        const root = page.nodes[ids[0]!];
        if (!root) return "";
        const parts = (page.decompositions[ids[0]!] ?? [])
          .map((p) => (page.nodes[p.id] ? `  - ${p.relation ?? "part"}: ${line(page.nodes[p.id]!)}` : ""))
          .filter(Boolean);
        return [`- ${line(root)}`, ...parts].join("\n");
      }
      return ids
        .map((id) => (page.nodes[id] ? `- ${line(page.nodes[id]!)}` : ""))
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
  const notes = cited.map((id, i) => `[${i + 1}] ${line(page.nodes[id]!)}`);
  return [
    `# ${page.title}`,
    "",
    `From the Minerval graph as it stood on ${new Date().toISOString().slice(0, 10)}. Statuses change; each link shows the current one.`,
    "",
    body.trim(),
    ...(notes.length > 0 ? ["", "---", "", ...notes] : []),
    "",
  ].join("\n");
}

export function PageView({ page }: { page: Page }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(page.title);
  const [body, setBody] = useState(page.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parts = useMemo(() => segments(page.body), [page.body]);
  // One numbering for the whole page, in order of first citation.
  const citations = useMemo(() => {
    const out: AssistantCitationView[] = [];
    for (const m of page.body.matchAll(INLINE_RE)) {
      const node = page.nodes[m[1]!.toLowerCase()];
      if (!node || out.some((c) => c.id === node.id)) continue;
      out.push({
        id: node.id,
        kind: node.kind,
        text: node.text,
        status: node.assessment_status,
        standing: node.standing,
        contestation: node.contestation,
        url: node.page_url,
      });
    }
    return out;
  }, [page]);
  const moved = Object.values(page.nodes).filter((n) => n.saved).length;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/assistant/pages/${page.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "The page was not saved.");
      else {
        setEditing(false);
        router.refresh();
      }
    } catch {
      setError("The page was not saved.");
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    const blob = new Blob([exportMarkdown(page)], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${page.title.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page"}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const remove = async () => {
    if (!window.confirm("Delete this page? This cannot be undone.")) return;
    const res = await fetch(`/api/assistant/pages/${page.id}`, { method: "DELETE" });
    if (res.ok) router.push("/ask");
    else setError("The page was not deleted.");
  };

  if (editing) {
    return (
      <div className="ask kept-edit">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Title"
          maxLength={200}
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={24}
          aria-label="The page, in markdown"
        />
        <span className="order-caption">
          Markdown. <code>[claim:id]</code> cites a node inline; on a line of its own,{" "}
          <code>{"{{node id}}"}</code>, <code>{"{{nodes id id …}}"}</code> and{" "}
          <code>{"{{decomposition id}}"}</code> show nodes as the graph holds them. The text you
          are replacing is kept as an earlier version.
        </span>
        <p className="ask-manage">
          <button className="order-button" onClick={() => void save()} disabled={busy}>
            {busy ? "saving…" : "Save"}
          </button>
          <button
            className="linklike"
            onClick={() => {
              setEditing(false);
              setTitle(page.title);
              setBody(page.body);
            }}
            disabled={busy}
          >
            Cancel
          </button>
        </p>
        {error && <p className="form-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="kept-view">
      {moved > 0 && (
        <p className="ask-notice">
          {moved === 1 ? "One node has" : `${moved} nodes have`} moved since this page was saved on{" "}
          {fmtDate(page.saved_at)}. Each is shown as the graph holds it now, with what it was. The
          text around them was written before the change.
        </p>
      )}
      {parts.map((part, i) =>
        part.type === "prose" ? (
          <Prose key={i} content={part.text} citations={citations} />
        ) : part.type === "nodes" ? (
          <NodesTable key={i} ids={part.ids} nodes={page.nodes} />
        ) : part.type === "decomposition" ? (
          <Decomposition key={i} id={part.ids[0]!} page={page} />
        ) : page.nodes[part.ids[0]!] ? (
          <NodeCard key={i} node={page.nodes[part.ids[0]!]!} />
        ) : (
          <Missing key={i} id={part.ids[0]!} />
        )
      )}
      <p className="ask-manage kept-manage">
        <button className="linklike" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button className="linklike" onClick={download}>
          Export as markdown
        </button>
        <button className="linklike danger" onClick={() => void remove()}>
          Delete this page
        </button>
      </p>
      <p className="order-caption">
        Private to you. Embedded nodes are read from the graph each time the page is opened.
        {page.versions.length > 0 &&
          ` ${page.versions.length} earlier ${page.versions.length === 1 ? "version is" : "versions are"} kept.`}
      </p>
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
