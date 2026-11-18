import type { Metadata } from "next";
import Link from "next/link";
import { can, viewer } from "@/components/admin/access";
import { Icon } from "@/components/work/icons";
import {
  Boundary,
  ButtonLink,
  Card,
  Dot,
  Empty,
  Party,
  Pill,
  Seg,
  WorkHead,
  WorkPage,
  age,
  owls,
  plural,
  shortWhen,
} from "@/components/work/ui";
import { fetchPermissionLog } from "@/lib/admin-api";
import { logSentence } from "@/lib/admin-words";
import { loadInbox, type InboxGroup, type InboxItem } from "@/lib/inbox";
import { fetchPublicAccount } from "@/lib/outside-api";

export const metadata: Metadata = { title: "Inbox · Minerval" };
export const dynamic = "force-dynamic";

// What waits on the person, from every part of the deployment, each with the
// act that answers it (lib/inbox.ts). Beside it, the deployment's state in
// three lines, its owls, and the newest acts of the log.

const GROUPS: Array<{ key: InboxGroup | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "decisions", label: "Decisions" },
  { key: "setup", label: "Setup" },
  { key: "sharing", label: "Sharing" },
  { key: "public", label: "Public graph" },
];

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { show } = await searchParams;
  const filter = GROUPS.some((g) => g.key === show) ? (show as InboxGroup | "all") : "all";

  const outward = can(who, "direct") || can(who, "consent");
  const [inbox, account, log] = await Promise.all([
    loadInbox(who.externalId, who.mine),
    outward ? fetchPublicAccount(who.externalId).catch(() => null) : null,
    fetchPermissionLog(who.externalId, 6).catch(() => []),
  ]);
  const shown = filter === "all" ? inbox.items : inbox.items.filter((i) => i.group === filter);
  const groups = GROUPS.filter((g) => g.key === "all" || inbox.items.some((i) => i.group === g.key));
  const checklist = inbox.checklist;
  const checks = checklist?.preflight?.checks ?? [];
  const passing = checks.filter((c) => c.status === "pass").length;

  return (
    <WorkPage>
      <WorkHead
        title="Inbox"
        sub={inbox.items.length === 0 ? "Nothing waits on you" : `${plural(inbox.items.length, "thing")} wait on you`}
        actions={
          can(who, "direct") && (
            <>
              <ButtonLink href="/releases/new" icon="plus">New release</ButtonLink>
              <ButtonLink href="/sources?drawer=add" icon="plus">Add source</ButtonLink>
            </>
          )
        }
      />

      <div className="w-grid2">
        <div className="w-col">
          {groups.length > 2 && (
            <div className="w-toolbar">
              <Seg
                current={filter}
                options={groups.map((g) => ({
                  key: g.key,
                  href: g.key === "all" ? "/inbox" : `/inbox?show=${g.key}`,
                  label: `${g.label} ${g.key === "all" ? inbox.items.length : inbox.items.filter((i) => i.group === g.key).length}`,
                }))}
              />
            </div>
          )}
          <div className="w-feed">
            {shown.length === 0 ? (
              <Empty>Nothing waits on you{filter === "all" ? "" : " here"}.</Empty>
            ) : (
              shown.map((item) => <Row key={item.key} item={item} first={item === shown[0]} />)
            )}
          </div>
        </div>

        <aside className="w-col">
          {(checklist || account) && (
            <Card title="Deployment" link={checklist ? { href: "/admin", label: "Health" } : undefined}>
              <div className="w-col" style={{ gap: 10 }}>
                {checklist?.preflight && (
                  <div className="w-row" style={{ flexWrap: "nowrap" }}>
                    <Dot tone={checklist.preflight.agent_work === "refused" ? "bad" : passing === checks.length ? "ok" : "warn"} />
                    <span>{checklist.preflight.agent_work === "refused" ? "Agent work stopped" : "Agent work running"}</span>
                    <span className="w-muted w-small w-spacer">
                      {passing} of {checks.length} checks pass
                    </span>
                  </div>
                )}
                {account && (
                  <div className="w-row" style={{ flexWrap: "nowrap" }}>
                    <Dot tone={account.connected ? "ok" : "warn"} />
                    <span>{account.connected ? "Public graph connected" : "Public graph not connected"}</span>
                    <Link className="w-small w-spacer" href="/admin/outside">
                      Overview
                    </Link>
                  </div>
                )}
                {checklist && checklist.connections.failing.length > 0 && (
                  <div className="w-row" style={{ flexWrap: "nowrap" }}>
                    <Dot tone="warn" />
                    <span>{plural(checklist.connections.failing.length, "connection")} not answering</span>
                    <Link className="w-small w-spacer" href="/admin/connections">
                      View
                    </Link>
                  </div>
                )}
              </div>
            </Card>
          )}

          {(checklist?.owls.created_here || account?.public_owls !== undefined) && (
            <Card title="Owls" link={checklist ? { href: "/admin/budget", label: "Budget" } : undefined}>
              <div className="w-col" style={{ gap: 10 }}>
                {checklist?.owls.created_here && checklist.owls.created_total_owls !== null && (
                  <>
                    <div className="w-row" style={{ alignItems: "baseline" }}>
                      <span className="w-stat-v" style={{ margin: 0 }}>
                        {owls(checklist.owls.created_total_owls - (checklist.owls.spent_total_owls ?? 0))}
                      </span>
                      <span className="w-muted w-small">unspent of {owls(checklist.owls.created_total_owls)} created</span>
                    </div>
                    <div className="w-bar">
                      <i
                        style={{
                          width: `${Math.min(100, Math.round(((checklist.owls.spent_total_owls ?? 0) / Math.max(1, checklist.owls.created_total_owls)) * 100))}%`,
                        }}
                      />
                    </div>
                  </>
                )}
                <div className="w-row w-muted w-small" style={{ justifyContent: "space-between" }}>
                  {checklist?.owls.spent_total_owls !== null && checklist?.owls.spent_total_owls !== undefined && (
                    <span>{owls(checklist.owls.spent_total_owls)} spent by runs</span>
                  )}
                  {account?.public_owls !== undefined && <span>{owls(account.public_owls)} public owls</span>}
                </div>
              </div>
            </Card>
          )}

          {log.length > 0 && (
            <Card title="Recent" link={can(who, "administer") ? { href: "/admin/activity", label: "Activity log" } : undefined}>
              <div>
                {log.slice(0, 6).map((entry, i) => (
                  <div className="w-line" key={i}>
                    <time dateTime={entry.at}>{shortWhen(entry.at).replace(/^\d+ \w+ /, "")}</time>
                    <span>{logSentence(entry)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </aside>
      </div>
    </WorkPage>
  );
}

const ICONS = { review: "review", warn: "warn", money: "money", globe: "globe", replies: "replies", outbox: "outbox", file: "file" } as const;

function Row({ item, first }: { item: InboxItem; first: boolean }) {
  return (
    <div className="w-item">
      <span className={item.tone === "plain" ? "w-ic" : `w-ic w-${item.tone}`}>
        <Icon name={ICONS[item.icon]} size={15} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="w-item-t">{item.title}</div>
        {(item.party || item.boundary || item.node || item.facts.length > 0 || item.pill) && (
          <div className="w-item-m">
            {item.party && <Party name={item.party} />}
            {item.boundary && <Boundary from={item.boundary.from} to={item.boundary.to} />}
            {item.node && <span className="w-node w-sm">{item.node}</span>}
            {item.facts.map((f) => (
              <span key={f}>{f}</span>
            ))}
            {item.pill && <Pill tone={item.pill.tone}>{item.pill.text}</Pill>}
          </div>
        )}
      </div>
      <div className="w-item-r">
        <span className="w-age">{age(item.since)}</span>
        <ButtonLink href={item.action.href} small primary={first && item.group === "decisions"}>
          {item.action.label}
        </ButtonLink>
      </div>
    </div>
  );
}
