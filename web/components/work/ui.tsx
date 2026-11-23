import { PUBLIC_GRAPH_LABEL } from "@/lib/label-layers";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHead } from "../PageHead";
import { Icon, type IconName } from "./icons";

// The pieces every page of the members' workspace is made of. A page is a
// tool, not an article: its head says what it is in a noun and the state in a
// line, the primary action sits at the head's end, entities are rows of a
// table, and a form opens in a drawer from the button that asks for it. Each
// piece here is drawn by app/workspace.css.

/** A workspace page: the column every page of the workspace is drawn in. */
export function WorkPage({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={wide ? "w-page w-wide" : "w-page"}>{children}</div>;
}

/** The head of a workspace page: crumbs, title, one line of state, chips, and actions. */
export function WorkHead({
  title,
  sub,
  crumbs,
  tags,
  actions,
  statement = false,
}: {
  title: ReactNode;
  /** One line under the title: counts, state. Never a paragraph. */
  sub?: ReactNode;
  crumbs?: Array<{ href: string; label: ReactNode }>;
  tags?: ReactNode;
  actions?: ReactNode;
  /** The title is node text (a claim): set in the serif. */
  statement?: boolean;
}) {
  return (
    <PageHead
      tool
      variant={statement ? "statement" : "page"}
      title={title}
      meta={sub}
      tags={tags}
      actions={actions}
      crumbs={
        crumbs && crumbs.length > 0 ? (
          <>
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: "contents" }}>
                <Link href={c.href}>{c.label}</Link>
                <span aria-hidden>/</span>
              </span>
            ))}
          </>
        ) : undefined
      }
    />
  );
}

export type Tone = "ok" | "warn" | "bad" | "info" | "neu";

export function Pill({ tone = "neu", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`w-pill w-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone, title }: { tone: "ok" | "warn" | "bad" | "neu"; title?: string }) {
  return <span className={tone === "neu" ? "w-dot" : `w-dot w-${tone}`} title={title} aria-label={title} />;
}

export function Count({ n, hot = false }: { n: number; hot?: boolean }) {
  return <span className={hot ? "w-count w-hot" : "w-count"}>{n.toLocaleString("en-GB")}</span>;
}

// A label's colour: labels are named by each deployment, so each gets one of a
// fixed set of hues from its name, the same wherever it appears. The public
// graph's label is grey.
const LABEL_HUES = ["#6aa2e6", "#d9a441", "#a993e8", "#e88aa6", "#5fb39a", "#e0875a", "#7fa7c9", "#b9a35a"];
export function labelColour(name: string): string {
  if (name === PUBLIC_GRAPH_LABEL) return "#8b8d88";
  // FNV-1a: spreads short names across the hues better than a plain sum.
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return LABEL_HUES[h % LABEL_HUES.length];
}

/** A label, in its colour. "outside" (the public graph) is drawn as a dashed square. */
export function Lbl({ name, title }: { name: string; title?: string }) {
  if (name === "outside") {
    return (
      <span className="w-lbl w-out" title={title ?? "Outside this deployment: the public graph"}>
        outside
      </span>
    );
  }
  return (
    <span className="w-lbl" style={{ ["--w-lbl" as string]: labelColour(name) }} title={title}>
      {name}
    </span>
  );
}

/** A boundary: the label a thing is written at, and the label (or outside) it goes to. */
export function Boundary({ from, to }: { from: string | null | undefined; to: string }) {
  return (
    <span className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
      {from ? <Lbl name={from} /> : <span className="w-faint">a label you do not read</span>}
      <span className="w-arrow" aria-label="to">→</span>
      <Lbl name={to} />
    </span>
  );
}

export function Party({ name, own = false }: { name: string; own?: boolean }) {
  return (
    <span className="w-party" title={own ? `${name}: the organisation that runs this deployment` : name}>
      <i aria-hidden>{name.replace(/^the\s+/i, "").charAt(0).toUpperCase()}</i>
      {name}
    </span>
  );
}

/** A concept's one-line explanation, on hover: the page itself carries no paragraph about it. */
export function Tip({ children }: { children: string }) {
  return (
    <span className="w-tip" title={children} aria-label={children} role="img">
      i
    </span>
  );
}

/** Marks an act that cannot be undone. */
export function Lock({ children = "Can't be undone" }: { children?: ReactNode }) {
  return (
    <span className="w-lock">
      <Icon name="lock" size={13} />
      {children}
    </span>
  );
}

/** Tabs of one page, each an address (`?tab=`), so a tab can be linked to and the page stays a server page. */
export function Tabs({
  tabs,
  current,
}: {
  tabs: Array<{ key: string; label: ReactNode; href: string; count?: number }>;
  current: string;
}) {
  return (
    <nav className="w-tabs" aria-label="Views of this page">
      {tabs.map((t) => (
        <Link key={t.key} className="w-tab" href={t.href} aria-current={t.key === current ? "page" : undefined}>
          {t.label}
          {t.count !== undefined && <Count n={t.count} />}
        </Link>
      ))}
    </nav>
  );
}

/** A row of linked choices, one current: a filter on a list. */
export function Seg({
  options,
  current,
}: {
  options: Array<{ key: string; label: ReactNode; href: string }>;
  current: string;
}) {
  return (
    <nav className="w-seg" aria-label="Filter">
      {options.map((o) => (
        <Link key={o.key} href={o.href} aria-current={o.key === current ? "page" : undefined}>
          {o.label}
        </Link>
      ))}
    </nav>
  );
}

export function Stats({ children }: { children: ReactNode }) {
  return <div className="w-stats">{children}</div>;
}

export function Stat({ k, v, s }: { k: ReactNode; v: ReactNode; s?: ReactNode }) {
  return (
    <div className="w-stat">
      <div className="w-stat-k">{k}</div>
      <div className="w-stat-v">{v}</div>
      {s && <div className="w-stat-s">{s}</div>}
    </div>
  );
}

/** Facts about one thing, as key and value. */
export function Kv({ rows }: { rows: Array<[ReactNode, ReactNode] | null | false> }) {
  return (
    <dl className="w-kv">
      {rows.filter((r): r is [ReactNode, ReactNode] => !!r).map(([k, v], i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The same facts in one horizontal band, under a page's head. */
export function Strip({ rows }: { rows: Array<[ReactNode, ReactNode] | null | false> }) {
  return (
    <dl className="w-strip">
      {rows.filter((r): r is [ReactNode, ReactNode] => !!r).map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd style={{ margin: 0 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Card({
  title,
  link,
  children,
  flush = false,
}: {
  title?: ReactNode;
  link?: { href: string; label: ReactNode };
  children: ReactNode;
  /** No padding: the card holds a table or a list that draws its own. */
  flush?: boolean;
}) {
  return (
    <section className="w-card">
      {(title || link) && (
        <div className="w-card-h">
          {title}
          {link && <Link href={link.href}>{link.label}</Link>}
        </div>
      )}
      {flush ? children : <div className="w-card-b">{children}</div>}
    </section>
  );
}

/** A section of a page: a noun for its heading, a count or state beside it, actions at the end. */
export function Section({
  title,
  aside,
  actions,
  id,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section className="w-sec" id={id}>
      <div className="w-sec-h">
        <h2>{title}</h2>
        {aside && <span className="w-muted">{aside}</span>}
        {actions && <div className="w-spacer w-row">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A table in its box. The caller gives <thead> and <tbody>. */
export function Table({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="w-tbox">
      <table className="w-t" aria-label={label}>
        {children}
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="w-empty">{children}</div>;
}

export function Banner({ tone = "neu", children }: { tone?: "neu" | "warn" | "bad" | "ok"; children: ReactNode }) {
  return (
    <div className={tone === "neu" ? "w-banner" : `w-banner w-${tone}`} role={tone === "bad" ? "alert" : undefined}>
      {tone !== "neu" && tone !== "ok" && <Icon name="warn" size={15} />}
      {children}
    </div>
  );
}

/** A link styled as a button. `href` may carry `?drawer=…` to open a drawer on the same page. */
export function ButtonLink({
  href,
  children,
  primary = false,
  danger = false,
  small = false,
  icon,
  title,
}: {
  href: string;
  children: ReactNode;
  primary?: boolean;
  danger?: boolean;
  small?: boolean;
  icon?: IconName;
  title?: string;
}) {
  const cls = ["w-btn", primary && "w-pri", danger && "w-dng", small && "w-sm"].filter(Boolean).join(" ");
  return (
    <Link className={cls} href={href} title={title}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </Link>
  );
}

/**
 * A drawer over the page, holding a form or the detail of a row. It is open
 * when the page's address asks for it (a `?drawer=` the page reads), so it
 * needs no script, can be linked to, and closes by going back to the address
 * without it.
 */
export function Drawer({
  title,
  close,
  children,
  wide = false,
}: {
  title: ReactNode;
  /** The address of the page without the drawer. */
  close: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <>
      <Link className="w-scrim" href={close} aria-label="Close" scroll={false} />
      <aside className={wide ? "w-drawer w-wide" : "w-drawer"} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <div className="w-drawer-h">
          <h2>{title}</h2>
          <Link className="w-btn w-ghost w-sm w-close" href={close} aria-label="Close" scroll={false}>
            <Icon name="close" size={14} />
          </Link>
        </div>
        <div className="w-drawer-b">{children}</div>
      </aside>
    </>
  );
}

/** A small menu of acts on a row, opened from its "…" button with no script. */
export function RowMenu({ children, label = "More" }: { children: ReactNode; label?: string }) {
  return (
    <details className="w-menu">
      <summary className="w-btn w-ghost w-sm" aria-label={label}>
        ⋯
      </summary>
      <div className="w-pop">{children}</div>
    </details>
  );
}

// ---- time --------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A day as the workspace writes it: "17 Nov" this year, "17 Nov 2025" before. UTC. */
export function shortDay(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? day : `${day} ${d.getUTCFullYear()}`;
}

/** A day and the time: "17 Nov 14:05". UTC. */
export function shortWhen(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${shortDay(iso, now)} ${iso.slice(11, 16)}`;
}

/** How long something has waited, short: "40m", "6h", "2d". */
export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** An owl amount: up to two decimals, grouped. */
export function owls(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Number(n.toFixed(2)).toLocaleString("en-GB", { maximumFractionDigits: 2 });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}
