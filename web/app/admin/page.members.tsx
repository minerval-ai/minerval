import type { Metadata } from "next";
import Link from "next/link";
import { NeedsPermission, can, viewer } from "@/components/admin/access";
import { CheckAgain, HealthChecks } from "@/components/admin/HealthChecks";
import { Icon } from "@/components/work/icons";
import {
  Banner,
  ButtonLink,
  Card,
  Count,
  Empty,
  Lock,
  Pill,
  Section,
  Seg,
  Table,
  Tip,
  WorkHead,
  WorkPage,
  type Tone,
} from "@/components/work/ui";
import { AccountApiError } from "@/lib/account-api";
import { fetchSetupChecklist, type PreflightCheck, type SetupChecklist } from "@/lib/admin-api";
import { fetchGates } from "@/lib/inside-api";
import { ITEM_STATE_WORDS, preflightTitle, preflightTodo } from "@/lib/admin-words";
import {
  OWNER_WORDS,
  STATE_TONE,
  areaTiles,
  attentionItems,
  checkCounts,
  checkOwner,
  type AttentionItem,
  type Owner,
} from "@/lib/health";

export const metadata: Metadata = { title: "Health · Minerval" };
export const dynamic = "force-dynamic";

// What the deployment needs from a person now, read from the deployment
// itself (GET /setup/checklist): whether agent work runs, what needs someone
// and who puts it right, each area of the setup as a tile, and every one of
// the deployment's own checks. Nothing is ticked by hand.
//
// The checks are run once for each read of this page. Their table
// (components/admin/HealthChecks) filters and opens them in the browser over
// that one reading, so looking at it differently never runs them again.

export default async function HealthPage({ searchParams }: { searchParams: Promise<{ checks?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  if (!can(who, "administer")) return <NeedsPermission title="Health" permission="administer" />;
  const { checks: filterParam } = await searchParams;

  let checklist: SetupChecklist;
  try {
    checklist = await fetchSetupChecklist(who.externalId);
  } catch (err) {
    return (
      <WorkPage>
        <WorkHead title="Health" />
        <Banner tone="bad">
          The deployment could not be read just now{err instanceof AccountApiError ? `: ${err.message}` : "."} Try again
          in a moment.
        </Banner>
      </WorkPage>
    );
  }

  const gates = await fetchGates(who.externalId).then((g) => g.gates).catch(() => []);
  const attention = attentionItems(checklist, gates);
  const areas = areaTiles(checklist);
  const preflight = checklist.preflight;
  const checks = preflight?.checks ?? [];
  const n = checkCounts(checks);
  const checkedAt = new Date().toISOString().slice(11, 16);

  return (
    <WorkPage>
      <WorkHead
        title="Health"
        sub={`Read from the deployment itself · checked ${checkedAt} UTC`}
        actions={
          <>
            <ButtonLink href="/admin/activity" icon="log">
              Activity log
            </ButtonLink>
            <CheckAgain />
          </>
        }
      />

      {preflight ? <Status checklist={checklist} counts={n} /> : (
        <Banner>This build does not check its own configuration, so no check is reported here.</Banner>
      )}

      <Section
        title="Needs attention"
        aside={attention.length > 0 ? <Count n={attention.length} hot /> : undefined}
        actions={
          attention.length > 0 && (
            <span className="w-muted w-small w-row" style={{ gap: 6 }}>
              <Pill title={OWNER_WORDS.operator.title}>Operator</Pill> runs the deployment ·{" "}
              <Pill tone="info" title={OWNER_WORDS.admin.title}>
                Admin
              </Pill>{" "}
              works here ·{" "}
              <Pill tone="warn" title={OWNER_WORDS.organization.title}>
                Organization
              </Pill>{" "}
              grants on minerval.ai
            </span>
          )
        }
      >
        <div className="w-feed">
          {attention.length === 0 ? (
            <Empty>Nothing needs anyone right now.</Empty>
          ) : (
            attention.map((item, i) => <AttentionRow key={item.key} item={item} first={i === 0} />)
          )}
        </div>
      </Section>

      <Section title="Areas" aside={areas.length}>
        <div className="w-grid3">
          {areas.map((a) => {
            const body = (
              <>
                <div className="w-row" style={{ flexWrap: "nowrap" }}>
                  <span style={{ fontWeight: 500, color: "var(--w-ink)" }}>{a.name}</span>
                  <Pill tone={STATE_TONE[a.state]}>{ITEM_STATE_WORDS[a.state]}</Pill>
                  {a.href && (
                    <span className="w-muted w-spacer" aria-hidden>
                      →
                    </span>
                  )}
                </div>
                <div className="w-muted w-small" style={{ marginTop: 6 }}>
                  {a.fact}
                </div>
              </>
            );
            return a.href ? (
              <Link key={a.key} href={a.href} className="w-card w-card-b" title={a.detail} style={{ display: "block", color: "inherit", textDecoration: "none" }}>
                {body}
              </Link>
            ) : (
              <div key={a.key} className="w-card w-card-b" title={a.detail}>
                {body}
              </div>
            );
          })}
        </div>
      </Section>

      {preflight && (
        <HealthChecks
          checks={checks}
          owners={Object.fromEntries(checks.map((k) => [k.name, checkOwner(k, checklist)]))}
          checkedAt={checkedAt}
          initialFilter={filterParam}
        />
      )}
    </WorkPage>
  );
}

function Status({ checklist, counts }: { checklist: SetupChecklist; counts: ReturnType<typeof checkCounts> }) {
  const preflight = checklist.preflight!;
  const refused = preflight.agent_work === "refused";
  const waitsOn = preflight.checks.filter((k) => k.status === "fail" && k.blocking);
  const tone = refused ? "bad" : counts.fail > 0 ? "warn" : "ok";
  return (
    <div className="w-card">
      <div className="w-card-b w-row" style={{ gap: 14, alignItems: "center" }}>
        <span className={`w-ic w-${tone}`}>
          <Icon name={refused ? "warn" : "check"} size={15} />
        </span>
        <div style={{ minWidth: 0, flex: "1 1 260px" }}>
          <div className="w-row">
            <span style={{ fontWeight: 600, fontSize: 15, color: "var(--w-ink)" }}>
              {refused ? "Agent work is stopped" : "Agent work is running"}
            </span>
            {counts.fail > 0 && <Pill tone={refused ? "bad" : "warn"}>{counts.fail === 1 ? "1 check fails" : `${counts.fail} checks fail`}</Pill>}
          </div>
          {refused && waitsOn.length > 0 && (
            <div className="w-muted w-small w-row" style={{ marginTop: 4, gap: 6 }}>
              <Lock>Waits on</Lock>
              {waitsOn.map((k, i) => (
                <span key={k.name}>
                  <a href={`#check-${k.name}`}>{preflightTitle(k)}</a>
                  {i < waitsOn.length - 1 ? "," : ""}
                </span>
              ))}
              <Tip>A check that must pass before any agent work starts has failed. Agent work starts once it passes.</Tip>
            </div>
          )}
        </div>
        <div className="w-row" style={{ gap: 22 }}>
          {(
            [
              ["pass", "pass"],
              ["fail", "fail"],
              ["to_do", "to do"],
              ["not_applicable", "don't apply"],
            ] as const
          ).map(([k, word]) => (
            <div key={k} style={{ textAlign: "center" }}>
              <div className="w-stat-v" style={{ margin: 0, fontSize: 18 }}>
                {counts[k]}
              </div>
              <div className="w-muted w-small">{word}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function OwnerPill({ owner }: { owner: Owner }) {
  return (
    <Pill tone={owner === "admin" ? "info" : owner === "organization" ? "warn" : "neu"} title={OWNER_WORDS[owner].title}>
      {OWNER_WORDS[owner].name}
    </Pill>
  );
}

function AttentionRow({ item, first }: { item: AttentionItem; first: boolean }) {
  return (
    <div className="w-item">
      <span className={`w-ic w-${item.tone}`}>
        <Icon name="warn" size={15} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="w-item-t">{item.title}</div>
        <div className="w-item-m">
          <span>{item.consequence}</span>
          {item.blocks && (
            <>
              <span aria-hidden>·</span>
              <Lock>Blocks agent work</Lock>
            </>
          )}
          {item.detail && <Tip>{item.detail}</Tip>}
        </div>
      </div>
      <div className="w-item-r">
        <OwnerPill owner={item.owner} />
        {item.href.startsWith("/admin#") ? (
          // A check on this page: a plain link to its row, which opens it without reading the page (and running the checks) again.
          <a href={item.href.slice("/admin".length)} className={first && item.tone === "bad" ? "w-btn w-sm w-pri" : "w-btn w-sm"}>
            {item.action}
          </a>
        ) : (
          <ButtonLink href={item.href} small primary={first && item.tone === "bad"}>
            {item.action}
          </ButtonLink>
        )}
      </div>
    </div>
  );
}
