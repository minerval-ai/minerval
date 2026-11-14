import Link from "next/link";
import type { ReactNode } from "react";
import type {
  MandateCorrespondentView,
  MandateDetailView,
  MandateLookoutView,
} from "@/lib/account-api";
import type { MandateAllocationView } from "@/lib/api";
import { dateish, owls } from "@/lib/account-format";
import { AGENTS_FIRST } from "@/lib/mandate-page";
import { Term } from "../Term";
import { Markdown } from "../Markdown";
import { Sheet } from "./Sheet";

// The agents a mandate has of its own, each with the instructions it works
// under one click away. What a role is, is a glossary matter: the name
// carries a short definition and a link to the role's page, and the page
// does not write it out again for every mandate.

const ROLE: Record<string, { gloss: string; href: string }> = {
  grantmaker: {
    gloss:
      "The agent that drafts a mandate with its funder, writes its plan and operating policy, and oversees the work. It decides which work is paid for and writes no verdict.",
    href: "/docs/agents/grantmaker",
  },
  officer: {
    gloss:
      "An agent that carries the mandate out day to day under the operating policy: commissions work, answers petitions from running work, and sends its Grantmaker what the policy does not settle.",
    href: "/docs/agents/program-officer",
  },
  lookout: {
    gloss:
      "A standing watch with a brief. Woken on a heartbeat or a trigger, it raises candidates for the mandate to fund. It writes no assessment and moves no money.",
    href: "/docs/agents/lookout",
  },
  correspondent: {
    gloss:
      "An agent with a brief and an audience. It reads the graph and publishes updates to a feed anyone can subscribe to. It reports the graph's judgment and writes no assessment.",
    href: "/docs/agents/correspondent",
  },
};

function RoleHead({
  role,
  name,
  count,
  record,
}: {
  role: keyof typeof ROLE;
  name: string;
  count?: number;
  record?: ReactNode;
}) {
  const r = ROLE[role]!;
  return (
    <div className="mnd-role-head">
      <h3 className="mnd-h3">
        <Term gloss={r.gloss} href={r.href} source="About this role" align="start" className="mnd-term">
          {name}
        </Term>
        {count != null && <span className="acct-detail acct-num">{count}</span>}
      </h3>
      {record && <span className="acct-note">{record}</span>}
    </div>
  );
}

/** One agent: a line of facts, and its instructions folded under it as a sheet. */
function Agent({
  state,
  title,
  record,
  label,
  sheetLabel,
  sheetBy,
  children,
}: {
  state?: string;
  title: ReactNode;
  record: ReactNode;
  label: string;
  sheetLabel: string;
  sheetBy?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="mnd-agent">
      <summary>
        {state && (
          <span className="mnd-chip" data-standing={state === "active" ? "running" : "planned"}>
            {state}
          </span>
        )}
        <span className="mnd-agent-title">{title}</span>
        <span className="acct-detail">{record}</span>
        <span className="mnd-agent-open">{label}</span>
      </summary>
      <Sheet label={sheetLabel} by={sheetBy}>
        {children}
      </Sheet>
    </details>
  );
}

/** The first ten of a role's agents, and the rest behind one fold. */
function Folded({ children, noun }: { children: ReactNode[]; noun: string }) {
  const head = children.slice(0, AGENTS_FIRST);
  const rest = children.slice(AGENTS_FIRST);
  return (
    <>
      {head}
      {rest.length > 0 && (
        <details className="mnd-more mnd-more-list">
          <summary>
            Show the other {rest.length} {noun}
          </summary>
          {rest}
        </details>
      )}
    </>
  );
}

const TRIGGER_LABEL: Record<string, string> = {
  retraction: "retraction poll",
  manual: "pokes",
  feed: "feeds",
  graph_change: "changes in scope",
};

function lookoutRecord(l: MandateLookoutView): string {
  return [
    l.heartbeat_hours > 0 ? `every ${l.heartbeat_hours}h` : "event-driven",
    l.triggers.length > 0 ? l.triggers.map((t) => TRIGGER_LABEL[t] ?? t).join(", ") : null,
    `${l.runs} run${l.runs === 1 ? "" : "s"}`,
    l.precision.ran > 0 ? `${l.precision.moved} of ${l.precision.ran} passes it asked for moved a verdict` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function correspondentRecord(c: MandateCorrespondentView): string {
  return [
    `for ${c.audience}`,
    c.heartbeat_hours > 0 ? `every ${c.heartbeat_hours}h` : "event-driven",
    `${c.updates} update${c.updates === 1 ? "" : "s"}`,
  ].join(" · ");
}

export function AgentsSection({
  mandate,
  allocation,
}: {
  mandate: MandateDetailView;
  allocation: MandateAllocationView | null;
}) {
  const lookouts = mandate.lookouts ?? [];
  const correspondents = mandate.correspondents ?? [];
  const runsOf = (kind: string) =>
    (allocation?.kinds ?? []).filter((k) => k.kind === kind).reduce((n, k) => n + k.runs, 0);
  const sittings = runsOf("mandate_review") + runsOf("grant_planning");
  const officerRuns = runsOf("officer_run");
  const skills = mandate.skills ?? [];

  return (
    <section className="acct-section" id="agents">
      <div className="acct-head">
        <h2>Agents</h2>
        <span className="acct-note">the mandate&rsquo;s own, each with the instructions it works under</span>
      </div>

      <div className="mnd-role">
        <RoleHead
          role="grantmaker"
          name="Grantmaker"
          record={
            allocation
              ? `${sittings} sitting${sittings === 1 ? "" : "s"} in the last ${allocation.window_days} days`
              : undefined
          }
        />
        <Agent
          title="This mandate&rsquo;s Grantmaker"
          record={
            mandate.grantmaker?.state === "working"
              ? "at work now"
              : mandate.grantmaker?.state === "waiting"
                ? "waiting to be woken"
                : mandate.status === "active"
                  ? "between sittings"
                  : "no longer at work"
          }
          label="What it works under"
          sheetLabel="What its Grantmaker works under"
        >
          <ul className="mnd-under">
            <li>
              <a href="#mandate">The mandate above</a>: its objective and strategy, which the funder approved.
            </li>
            <li>
              <Link href="/docs/constitution">The constitution</Link>, which every agent of the graph works under.
            </li>
            <li>
              <Link href="/docs/agents/grantmaker">The Grantmaker&rsquo;s role instructions</Link>, the same for
              every mandate.
            </li>
            {skills.length > 0 && (
              <li>
                The skill{skills.length === 1 ? "" : "s"} it carries:{" "}
                {skills.map((s, i) => (
                  <span key={s}>
                    {i > 0 && ", "}
                    <Link href={`/docs/skills/${s}`}>{s}</Link>
                  </span>
                ))}
                .
              </li>
            )}
            <li>
              What its funder tells it in conversation. A funder can redirect the work; no one can ask it
              for a conclusion.
            </li>
          </ul>
        </Agent>
      </div>

      {allocation && (
        <div className="mnd-role">
          <RoleHead
            role="officer"
            name="Program officers"
            record={
              `${officerRuns} sitting${officerRuns === 1 ? "" : "s"} in the last ${allocation.window_days} days` +
              ` · decide up to ${owls(allocation.officer_limit.owls)} owls` +
              (allocation.inbox_waiting > 0 ? ` · ${allocation.inbox_waiting} waiting in their inbox` : "")
            }
          />
          <Agent
            title="The operating policy"
            record="what every officer of this mandate is given"
            label="Read it"
            sheetLabel="Operating policy"
            sheetBy="written by its Grantmaker"
          >
            <Markdown>{allocation.operating_policy}</Markdown>
            <p className="acct-note">Officers&rsquo; limit: {allocation.officer_limit.reason}</p>
          </Agent>
        </div>
      )}

      {lookouts.length > 0 && (
        <div className="mnd-role">
          <RoleHead role="lookout" name="Lookouts" count={lookouts.length} />
          <Folded noun="lookouts">
            {lookouts.map((l) => (
              <Agent
                key={l.id}
                state={l.status}
                title={l.title}
                record={lookoutRecord(l)}
                label="Its brief"
                sheetLabel="Lookout&rsquo;s brief"
                sheetBy={`written by ${l.created_by ? l.created_by.replace(/_/g, " ") : "its Grantmaker"} · ${dateish(l.created_at)}`}
              >
                <p>{l.brief}</p>
                {l.feeds && l.feeds.length > 0 && (
                  <p className="acct-note">
                    Follows{" "}
                    {l.feeds.map((f, i) => (
                      <span key={f.feed_id}>
                        {i > 0 && ", "}
                        <a href={f.url} rel="nofollow noopener">
                          {f.title ?? f.url}
                        </a>
                      </span>
                    ))}
                    .
                  </p>
                )}
                {l.last_note && (
                  <p className="acct-note">
                    Its last note{l.last_run_at ? `, ${dateish(l.last_run_at)}` : ""}: {l.last_note}
                  </p>
                )}
              </Agent>
            ))}
          </Folded>
        </div>
      )}

      {correspondents.length > 0 && (
        <div className="mnd-role">
          <RoleHead role="correspondent" name="Correspondents" count={correspondents.length} />
          <Folded noun="correspondents">
            {correspondents.map((c) => (
              <Agent
                key={c.id}
                state={c.status}
                title={c.title}
                record={correspondentRecord(c)}
                label="Its brief"
                sheetLabel="Correspondent&rsquo;s brief"
                sheetBy={<Link href={`/correspondents/${c.id}/feed`}>its feed →</Link>}
              >
                <p>{c.brief}</p>
                {c.last_note && (
                  <p className="acct-note">
                    Its last note{c.last_run_at ? `, ${dateish(c.last_run_at)}` : ""}: {c.last_note}
                  </p>
                )}
              </Agent>
            ))}
          </Folded>
        </div>
      )}
    </section>
  );
}
