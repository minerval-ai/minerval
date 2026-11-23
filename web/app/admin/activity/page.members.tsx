import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { viewer } from "@/components/admin/access";
import { Icon } from "@/components/work/icons";
import {
  Banner,
  ButtonLink,
  Empty,
  Lbl,
  Party,
  Pill,
  Table,
  Tip,
  WorkHead,
  WorkPage,
  owls,
  shortDay,
} from "@/components/work/ui";
import { fetchLogPage } from "@/lib/activity-log";
import type { LogEntry, Withheld } from "@/lib/admin-api";
import { LOG_TYPES, logActor, logSentence, logType, permissionShort } from "@/lib/admin-words";

export const metadata: Metadata = { title: "Activity log · Minerval" };
export const dynamic = "force-dynamic";

// Every administrative act, newest first, grouped by day: grants and
// removals, labels, parties, connections, file sets, owls created and
// standing mandates set up. Any member may read it, as on the People page before it: who holds
// power over a graph is part of what its readers weigh. A name the reader is
// not entitled to is withheld, and the act, who and when are still shown.
//
// The filters are the API's (GET /permissions/log: type, by, q), applied
// before its limit, and older entries are read from where a page ends
// (`next_before`). A text is matched against what the reader is shown, so a
// withheld name is never found by it.

type Params = { type?: string; who?: string; q?: string; before?: string };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayHeading(iso: string, now: Date): ReactNode {
  const day = iso.slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const weekday = WEEKDAYS[new Date(iso).getUTCDay()];
  const date = `${weekday} ${shortDay(iso, now)}`;
  if (day === today) return <>Today <span className="w-faint">· {date}</span></>;
  if (day === yesterday) return <>Yesterday <span className="w-faint">· {date}</span></>;
  return date;
}

export default async function ActivityLogPage({ searchParams }: { searchParams: Promise<Params> }) {
  const who = await viewer();
  if (!who) return null;
  const params = await searchParams;
  const before = params.before && !Number.isNaN(Date.parse(params.before)) ? params.before : null;
  const type = LOG_TYPES.find((t) => t === params.type) ?? null;
  const q = (params.q ?? "").trim().slice(0, 200);
  const actor = (params.who ?? "").trim().slice(0, 64);
  const filtered = !!(type || q || actor);

  // The people to filter by are those who acted in the newest page of the
  // whole log, read again unfiltered when a filter is on.
  let page: Awaited<ReturnType<typeof fetchLogPage>> | null;
  let newest: LogEntry[];
  try {
    const [read, unfiltered] = await Promise.all([
      fetchLogPage(who.externalId, { type, by: actor || null, q: q || null, before }),
      filtered || before ? fetchLogPage(who.externalId).then((p) => p.entries).catch(() => []) : null,
    ]);
    page = read;
    newest = unfiltered ?? read.entries;
  } catch {
    page = null;
    newest = [];
  }

  const head = (
    <WorkHead
      title="Activity log"
      sub="Every administrative act · nothing is deleted"
      actions={
        <ButtonLink href="/admin/outside" icon="globe">
          Public graph activity →
        </ButtonLink>
      }
    />
  );
  if (page === null) {
    return (
      <WorkPage>
        {head}
        <Banner tone="bad">The log could not be read just now. Try again in a moment.</Banner>
      </WorkPage>
    );
  }

  const shown = page.entries;
  const actors = [...new Map([...newest, ...shown].map((e) => logActor(e)).map((a) => [a.key, a])).values()]
    // A person is filtered by their account's id; an entry from an API that gave none cannot be.
    .filter((a) => !a.key.startsWith("name:"))
    .sort((a, b) => Number(b.person) - Number(a.person) || a.name.localeCompare(b.name));
  if (actor && !actors.some((a) => a.key === actor)) actors.push({ key: actor, name: "The person chosen", person: true });

  const href = (over: Partial<Params>) => {
    const next = new URLSearchParams();
    const merged = { type: type ?? undefined, who: actor || undefined, q: q || undefined, before: before ?? undefined, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const s = next.toString();
    return s ? `/admin/activity?${s}` : "/admin/activity";
  };

  const now = new Date();
  const rows: ReactNode[] = [];
  let lastDay = "";
  shown.forEach((entry, i) => {
    const day = entry.at.slice(0, 10);
    if (day !== lastDay) {
      lastDay = day;
      rows.push(
        <tr key={`day-${day}`} className="w-group">
          <td colSpan={4}>{dayHeading(entry.at, now)}</td>
        </tr>,
      );
    }
    rows.push(<Row key={`${entry.at}-${i}`} entry={entry} />);
  });
  const older = page.next_before;

  return (
    <WorkPage>
      {head}

      <div className="w-col" style={{ gap: 10 }}>
        <form className="w-toolbar" action="/admin/activity" method="get">
          <label className="w-search" style={{ width: 260 }}>
            <Icon name="search" size={14} />
            <input type="search" name="q" defaultValue={q} placeholder="Search the log" aria-label="Search the log" />
          </label>
          <select className="w-select" name="who" defaultValue={actor} aria-label="Who" style={{ width: "auto" }}>
            <option value="">Anyone</option>
            {actors.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name}
              </option>
            ))}
          </select>
          {type && <input type="hidden" name="type" value={type} />}
          <button className="w-btn w-sm" type="submit">
            Filter
          </button>
          {filtered && (
            <Link className="w-small" href={href({ type: undefined, who: undefined, q: undefined, before: undefined })}>
              Clear
            </Link>
          )}
          <span className="w-muted w-small w-spacer">
            {`${shown.length} ${shown.length === 1 ? "entry" : "entries"}${filtered ? (shown.length === 1 ? " matches" : " match") : ""}${older ? " on this page" : ""}`}
            {before && <> · before {shortDay(before)}</>}
          </span>
        </form>
        <nav className="w-toolbar" aria-label="Type">
          <TypeChip href={href({ type: undefined, before: undefined })} on={!type}>
            All
          </TypeChip>
          {LOG_TYPES.map((t) => (
            <TypeChip key={t} href={href({ type: t, before: undefined })} on={type === t}>
              {logType({ type: t })}
            </TypeChip>
          ))}
        </nav>
      </div>

      <Table label="Activity log">
        <thead>
          <tr>
            <th style={{ width: 70 }}>When</th>
            <th style={{ width: 220 }}>Who</th>
            <th>
              <span className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
                What
                <Tip>Where an entry names a label you aren&apos;t cleared to read, a party you aren&apos;t entitled to know of, or a source at a label you don&apos;t read, the name is withheld, and searching never finds it. That the act happened, who did it and when are always shown.</Tip>
              </span>
            </th>
            <th style={{ width: 110 }}>Type</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4}>
                <Empty>{filtered ? "No entry matches." : before ? "Nothing older is logged." : "Nothing has been logged yet."}</Empty>
              </td>
            </tr>
          ) : (
            rows
          )}
        </tbody>
      </Table>

      {(older || before) && (
        <div className="w-toolbar">
          {before && (
            <Link className="w-small" href={href({ before: undefined })}>
              ← Newest
            </Link>
          )}
          {older && (
            <ButtonLink small href={href({ before: older })}>
              Older entries
            </ButtonLink>
          )}
        </div>
      )}
    </WorkPage>
  );
}

function TypeChip({ href, on, children }: { href: string; on: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="w-chip"
      aria-current={on ? "page" : undefined}
      style={on ? { borderColor: "var(--w-accent)", background: "var(--w-accent-wash)", color: "var(--w-ink)" } : { color: "var(--w-soft)" }}
    >
      {children}
    </Link>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? ""))).toUpperCase();
}

const ACTOR_TITLES: Record<string, string> = {
  "via:operator": "OPERATOR_KEY: whoever runs the deployment",
  "via:first_administrator": "The deployment's first-administrator setting",
  deployment: "Done by the deployment itself, not a person",
};

function Row({ entry }: { entry: LogEntry }) {
  const actor = logActor(entry);
  return (
    <tr>
      <td className="w-muted w-small" style={{ fontVariantNumeric: "tabular-nums" }}>
        <time dateTime={entry.at} title={`${entry.at.slice(0, 16).replace("T", " ")} UTC`}>
          {entry.at.slice(11, 16)}
        </time>
      </td>
      <td>
        {actor.person ? (
          <span className="w-row" style={{ flexWrap: "nowrap", gap: 8 }}>
            <span className="w-avatar w-sm" aria-hidden>
              {initials(actor.name)}
            </span>
            {actor.name}
          </span>
        ) : (
          <Pill title={ACTOR_TITLES[actor.key]}>{actor.name}</Pill>
        )}
      </td>
      <td title={logSentence(entry)}>
        <span className="w-row" style={{ gap: 6 }}>
          <What entry={entry} />
        </span>
      </td>
      <td>
        <Pill>{logType(entry)}</Pill>
      </td>
    </tr>
  );
}

// --- what was done, with its labels and parties drawn as they are elsewhere ---------

const withheld = (v: unknown): v is Withheld => typeof v === "object" && v !== null && (v as Withheld).withheld === true;
const WITHHELD_TITLE = "Withheld: you aren't entitled to its name. The act, who and when are always shown.";

function LabelOf({ v }: { v: string | Withheld | undefined }) {
  if (v === undefined) return <span className="w-faint">a label</span>;
  if (withheld(v)) return <span className="w-chip" title={WITHHELD_TITLE}>a label you don&apos;t read</span>;
  return <Lbl name={v} />;
}

function PartyOf({ v }: { v: string | Withheld | null | undefined }) {
  if (v === undefined || v === null) return <span className="w-faint">no party</span>;
  if (withheld(v)) return <span className="w-chip" title={WITHHELD_TITLE}>a party you don&apos;t know of</span>;
  return <Party name={v} />;
}

function ConnectionOf({ v }: { v: string | Withheld | undefined }) {
  if (v === undefined || withheld(v)) return <span className="w-chip" title={WITHHELD_TITLE}>a connection you don&apos;t see</span>;
  return <span className="w-chip">{v}</span>;
}

function FileSetOf({ v }: { v: string | Withheld | undefined }) {
  if (v === undefined || withheld(v)) return <span className="w-chip" title={WITHHELD_TITLE}>a file set you don&apos;t see</span>;
  return <span className="w-chip">{v}</span>;
}

const Chips = ({ items, mono = false }: { items: string[]; mono?: boolean }) => (
  <>
    {items.map((t) => (
      <span key={t} className={mono ? "w-chip w-mono" : "w-chip"}>
        {t}
      </span>
    ))}
  </>
);

function Grant({ entry }: { entry: LogEntry }) {
  const p = entry.permission ?? "";
  return (
    <>
      {permissionShort(p)}
      {(p === "read" || p === "read_sources") && (
        <>
          {" · "}
          <LabelOf v={entry.label} />
        </>
      )}
      {p === "consent" && (
        <>
          {" · "}
          <PartyOf v={entry.party} />
        </>
      )}
    </>
  );
}

function To({ entry }: { entry: LogEntry }) {
  if (entry.account) return <span className="w-chip">{entry.account}</span>;
  if (entry.group) return <span className="w-chip w-mono" title="A group your identity provider names">{entry.group}</span>;
  return <span className="w-faint">an account</span>;
}

const PROVIDER_WORDS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", embeddings: "Embeddings" };
const provider = (p: string) => PROVIDER_WORDS[p] ?? p.replace(/_/g, " ");

function What({ entry }: { entry: LogEntry }) {
  switch (entry.event) {
    case "granted":
      return (
        <>
          granted <To entry={entry} /> <Grant entry={entry} />
        </>
      );
    case "removed":
      return (
        <>
          removed <Grant entry={entry} /> from <To entry={entry} />
        </>
      );
    case "labels_split":
      return (
        <>
          split public into the public graph&rsquo;s own, <span className="w-chip w-mono">{entry.published ?? "published"}</span> and{" "}
          <LabelOf v={entry.label} />
        </>
      );
    case "label_defined":
      return (
        <>
          defined {withheld(entry.label) ? "" : "label "}
          <LabelOf v={entry.label} />
        </>
      );
    case "label_read_added":
    case "label_read_removed":
      return (
        <>
          {entry.event === "label_read_added" ? "recorded that" : "took back that"} <LabelOf v={entry.label} /> reads{" "}
          <LabelOf v={entry.reads} />
        </>
      );
    case "provider_clearance_set":
      return (
        <>
          {entry.cleared && entry.cleared.length > 0 && (
            <>
              cleared <Chips items={entry.cleared.map(provider)} />
            </>
          )}
          {entry.no_longer_cleared && entry.no_longer_cleared.length > 0 && (
            <>
              {entry.cleared && entry.cleared.length > 0 ? " and " : ""}took back <Chips items={entry.no_longer_cleared.map(provider)} />
            </>
          )}
          {!entry.cleared?.length && !entry.no_longer_cleared?.length && "changed which providers are cleared"} for{" "}
          <LabelOf v={entry.label} />
        </>
      );
    case "party_added":
      return (
        <>
          added {withheld(entry.party) ? "" : "party "}
          <PartyOf v={entry.party} />
        </>
      );
    case "source_party_set":
      return (
        <>
          set the party of{" "}
          {entry.source_title === undefined ? (
            "a source"
          ) : withheld(entry.source_title) ? (
            <span className="w-chip" title="Withheld: you don't read the source's label. The act, who and when are always shown.">
              a source you don&apos;t read
            </span>
          ) : (
            <span className="w-chip">{entry.source_title}</span>
          )}{" "}
          to <PartyOf v={entry.party} />{" "}
          <span className="w-faint w-small">
            (was {entry.previous_party === null || entry.previous_party === undefined ? "none" : withheld(entry.previous_party) ? "withheld" : entry.previous_party})
          </span>
          {entry.source_id && (
            <Link className="w-small" href={`/sources/${encodeURIComponent(entry.source_id)}`}>
              Source
            </Link>
          )}
        </>
      );
    case "file_set_added":
      return (
        <>
          added <FileSetOf v={entry.file_set} />
          {entry.party !== undefined && (
            <>
              {" "}
              of <PartyOf v={entry.party} />
            </>
          )}
          {entry.label !== undefined && (
            <>
              {" "}
              at <LabelOf v={entry.label} />
            </>
          )}
        </>
      );
    case "file_set_closed":
      return (
        <>
          closed <FileSetOf v={entry.file_set} />
          {entry.files !== undefined && (
            <span className="w-faint w-small">
              · {entry.files} {entry.files === 1 ? "file" : "files"}, fixed by their hash
            </span>
          )}
        </>
      );
    case "file_set_changed":
      return (
        <>
          {entry.enabled === undefined ? "changed" : entry.enabled ? "switched on" : "switched off"} <FileSetOf v={entry.file_set} />
        </>
      );
    case "connection_added":
      return (
        <>
          added <ConnectionOf v={entry.connection} />
        </>
      );
    case "connection_changed":
      return (
        <>
          changed <ConnectionOf v={entry.connection} />
          {entry.changed && entry.changed.length > 0 && (
            <span className="w-faint w-small">· {entry.changed.map((c) => c.replace(/_/g, " ")).join(", ")}</span>
          )}
        </>
      );
    case "connection_tools_offered":
      return (
        <>
          {entry.offered && entry.offered.length > 0 && (
            <>
              offered agents <Chips items={entry.offered} mono />
            </>
          )}
          {entry.no_longer_offered && entry.no_longer_offered.length > 0 && (
            <>
              {entry.offered && entry.offered.length > 0 ? " and " : ""}stopped offering <Chips items={entry.no_longer_offered} mono />
            </>
          )}
          {!entry.offered?.length && !entry.no_longer_offered?.length && "changed which tools agents are offered"} on{" "}
          <ConnectionOf v={entry.connection} />
        </>
      );
    case "connection_tool_withdrawn":
      return (
        <>
          withdrew {entry.tool ? <span className="w-chip w-mono">{entry.tool}</span> : "a tool"} on <ConnectionOf v={entry.connection} /> from
          agents
          {entry.reason && <span className="w-faint w-small">· {logSentence(entry).split(", because ")[1]?.replace(/\.$/, "") ?? entry.reason.replace(/_/g, " ")}</span>}
        </>
      );
    case "owls_created":
      return (
        <>
          created <span className="w-num">{owls(entry.amount_owls ?? 0)}</span> owls into{" "}
          {entry.account ? (
            <>
              the balance of <span className="w-chip">{entry.account}</span>
            </>
          ) : entry.mandate ? (
            <span className="w-chip">{entry.mandate.title || "(untitled)"}</span>
          ) : (
            "a budget"
          )}
          {entry.note && <span className="w-faint w-small">· {entry.note}</span>}
        </>
      );
    case "standing_mandate_created":
      return (
        <>
          set up <span className="w-chip">{entry.mandate?.title || "(untitled)"}</span>
          {entry.amount_owls ? (
            <>
              with <span className="w-num">{owls(entry.amount_owls)}</span> owls
            </>
          ) : null}
        </>
      );
    default: {
      // An act this page has no drawing for: the log's own sentence, without its subject (shown beside it).
      const sentence = logSentence(entry);
      const name = logActor(entry).name;
      return <>{sentence.startsWith(`${name}: `) ? sentence.slice(name.length + 2) : sentence.startsWith(name) ? sentence.slice(name.length + 1) : sentence}</>;
    }
  }
}
