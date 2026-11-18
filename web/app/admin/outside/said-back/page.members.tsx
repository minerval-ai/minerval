import type { Metadata } from "next";
import Link from "next/link";
import { can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import { Empty, Kv, Pill, Seg, Table, Tip, WorkHead, WorkPage, shortDay, shortWhen, type Tone } from "@/components/work/ui";
import { fetchMyLabels, type MyLabels } from "@/lib/admin-api";
import { british, fetchSaidBack, type ReceivedContribution } from "@/lib/outside-api";
import { assessHereAction } from "../actions";
import { HeadSub, Note, loadAccount, tryRead } from "../parts";

export const metadata: Metadata = { title: "Replies · Minerval" };
export const dynamic = "force-dynamic";

// What readers on the public graph said about the pages this deployment
// published (docs/outward-acts.md): challenges and proposals, each as it was
// written there, which is what the node's Steward is given, and where the
// reassessment it opened stands. A repeat (the same text as an earlier one on
// the node) is counted with its original and opened nothing, so it is shown
// folded under it. A reassessment that is not paid for can be paid for here:
// an assessment of the node ordered at the label the page came from, which the
// API names with each reply (page_label) or withholds from a reader who does
// not read it (POST /claims/:claim_id/order).

type Stand = "not_paid" | "paid" | "made" | "none";

/** Where a reassessment stands, from the API's fixed words (inbound-service.ts, REASSESSMENT_WORDS). */
function standOf(c: ReceivedContribution): Stand {
  const r = c.reassessment ?? "";
  if (!r) return "none";
  if (r === "made") return "made";
  if (r.startsWith("paid for")) return "paid";
  return "not_paid";
}

const STAND: Record<Stand, { tone: Tone; text: string }> = {
  not_paid: { tone: "warn", text: "Not paid for" },
  paid: { tone: "info", text: "Paid · pending" },
  made: { tone: "ok", text: "Made" },
  none: { tone: "neu", text: "Not opened" },
};

const FILTERS: Array<{ key: Stand | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "not_paid", label: "Not paid for" },
  { key: "paid", label: "Paid · pending" },
  { key: "made", label: "Made" },
];

function typeTone(type: string): Tone {
  if (/challenge|dispute|contest/i.test(type)) return "warn";
  if (/propos/i.test(type)) return "info";
  return "neu";
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default async function RepliesPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { show } = await searchParams;
  const filter = FILTERS.some((f) => f.key === show) ? (show as Stand | "all") : "all";
  const mayFund = can(who, "fund");
  const [{ data: account, problem: accountProblem }, { data: said, problem }, { data: labels }] = await Promise.all([
    loadAccount(who.externalId),
    tryRead(() => fetchSaidBack(who.externalId), "What readers said back could not be read"),
    mayFund ? tryRead(() => fetchMyLabels(who.externalId), "Your labels could not be read") : Promise.resolve({ data: null, problem: null }),
  ]);

  const all = said?.contributions ?? [];
  const ids = new Set(all.map((c) => c.id));
  // A repeat whose original is listed folds under it; one whose original is not listed stands as its own row.
  const originals = all.filter((c) => !c.repeats || !ids.has(c.repeats));
  const repeatsOf = new Map<string, ReceivedContribution[]>();
  for (const c of all) {
    if (c.repeats && ids.has(c.repeats)) repeatsOf.set(c.repeats, [...(repeatsOf.get(c.repeats) ?? []), c]);
  }
  const counted = originals.filter((c) => !c.repeats);
  const count = (s: Stand) => counted.filter((c) => standOf(c) === s).length;
  const shown = filter === "all" ? originals : originals.filter((c) => !c.repeats && standOf(c) === filter);

  return (
    <WorkPage>
      <WorkHead
        title="Replies"
        sub={<HeadSub account={account} problem={accountProblem}>Challenges and proposals made on pages you published</HeadSub>}
      />

      {accountProblem && <Note tone="bad">{accountProblem}</Note>}
      {problem && <Note tone="bad">{problem}</Note>}

      <div className="w-toolbar">
        <Seg
          current={filter}
          options={FILTERS.map((f) => ({
            key: f.key,
            href: f.key === "all" ? "/admin/outside/said-back" : `/admin/outside/said-back?show=${f.key}`,
            label: `${f.label} ${f.key === "all" ? counted.length : count(f.key)}`,
          }))}
        />
        <span className="w-faint w-small">
          Repeats count once{" "}
          <Tip>
            A reply whose text is the same as an earlier one on the node is recorded as a repeat of it and opens nothing. It is folded under the
            one it repeats.
          </Tip>{" "}
          · each opens a reassessment at the page&apos;s label{" "}
          {said && <Tip>{british(said.how_it_works)}</Tip>}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="w-tbox">
          <Empty>
            {all.length === 0 ? "Nothing has been said on the public graph through a page this graph published." : "No reply stands this way."}
          </Empty>
        </div>
      ) : (
        <Table label="Replies">
          <thead>
            <tr>
              <th>Type</th>
              <th>Node</th>
              <th>Excerpt</th>
              <th>Cites</th>
              <th>Received</th>
              <th>Reassessment</th>
              <th className="w-act" />
            </tr>
          </thead>
          {shown.map((c) => (
            <Reply key={c.id} c={c} repeats={repeatsOf.get(c.id) ?? []} mayFund={mayFund} labels={labels} />
          ))}
        </Table>
      )}
    </WorkPage>
  );
}

function Reply({
  c,
  repeats,
  mayFund,
  labels,
}: {
  c: ReceivedContribution;
  repeats: ReceivedContribution[];
  mayFund: boolean;
  labels: MyLabels | null;
}) {
  const stand = c.repeats ? null : standOf(c);
  const at = pageLabelOf(c);
  const fund = mayFund && stand === "not_paid" ? fundingAt(at, labels) : null;
  const cites = c.addresses_it_cites ?? [];
  const text = c.text_written_outside_this_deployment;
  return (
    <tbody className="w-pub-xg">
      <tr>
        <td>
          <Pill tone={typeTone(c.type)}>{cap(c.type.replace(/_/g, " "))}</Pill>
        </td>
        <td style={{ maxWidth: 280 }}>
          <Link className="w-node w-sm" href={`/claims/${c.node_id}`}>
            {c.node ?? "A node you do not read"}
          </Link>
        </td>
        <td>{text !== undefined ? <div className="w-pub-clamp">“{text}”</div> : <span className="w-faint w-small">Not readable here</span>}</td>
        <td className="w-small w-muted" style={{ whiteSpace: "nowrap" }}>
          {cites.length === 0 ? <span className="w-faint">none</span> : `${cites.length} · ${host(cites[0]!)}`}
        </td>
        <td className="w-muted" style={{ whiteSpace: "nowrap" }}>
          {shortDay(c.received_at)}
        </td>
        <td>{stand ? <Pill tone={STAND[stand].tone}>{STAND[stand].text}</Pill> : <Pill tone="neu">Repeat · opened nothing</Pill>}</td>
        <td className="w-act">
          <div className="w-row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
            {fund && fund.kind !== "none" && (
              <details className="w-pub-tgf">
                <summary className="w-btn w-sm w-pri">Fund reassessment</summary>
              </details>
            )}
            {fund?.kind === "none" && !at.withheld && (
              <Link className="w-btn w-sm w-pri" href={`/claims/${c.node_id}`}>
                Assess
              </Link>
            )}
            {fund?.kind === "none" && at.withheld && (
              <span className="w-faint w-small" title="The page was written at a label you do not read, so its reassessment is paid for by someone who reads it.">
                At a label you don&apos;t read
              </span>
            )}
            {stand !== "not_paid" && (
              <Link className="w-btn w-sm" href={`/claims/${c.node_id}`}>
                View
              </Link>
            )}
            <details className="w-pub-tg">
              <summary className="w-btn w-ghost w-sm" aria-label="Show the full text">
                More
              </summary>
            </details>
          </div>
        </td>
      </tr>
      {fund && fund.kind !== "none" && (
        <tr className="w-detail w-pub-frow">
          <td />
          <td colSpan={6}>
            <FundReassessment nodeId={c.node_id} fund={fund} />
          </td>
        </tr>
      )}
      <tr className="w-detail w-pub-xrow">
        <td />
        <td colSpan={6}>
          <div className="w-pub-xb w-pub-kv" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(0, 360px)" }}>
            <div>
              <span className="w-pub-k">As written on the public graph, outside this deployment</span>
              {text !== undefined ? <p className="w-pub-quote">{text}</p> : <span className="w-faint w-small">The text is not readable here.</span>}
              {cites.length > 0 && (
                <div className="w-col" style={{ gap: 4, marginTop: 10 }}>
                  {cites.map((u) => (
                    <a key={u} className="w-mono" href={u} target="_blank" rel="noreferrer nofollow" style={{ overflowWrap: "anywhere" }}>
                      {u} ↗
                    </a>
                  ))}
                </div>
              )}
            </div>
            <Kv
              rows={[
                ["Made", shortWhen(c.submitted_at)],
                ["Received", shortWhen(c.received_at)],
                !!c.given_to_the_steward_at && ["To the Steward", shortWhen(c.given_to_the_steward_at)],
                ["Public id", <span className="w-mono" key="id">{c.on_the_public_graph}</span>],
                at.label !== null && ["Page written at", <span className="w-chip" key="label">{at.label}</span>],
                at.withheld && ["Page written at", <span className="w-faint" key="label">a label you don&apos;t read</span>],
                !!c.reassessment && [
                  "Outside sees",
                  `Reassessment ${c.reassessment}${c.reassessment_as_of ? `, as of ${shortWhen(c.reassessment_as_of)}` : ""}`,
                ],
              ]}
            />
          </div>
        </td>
      </tr>
      {repeats.length > 0 && (
        <tr className="w-detail">
          <td />
          <td colSpan={6} className="w-small w-muted">
            <span className="w-chip">+{repeats.length} repeat{repeats.length === 1 ? "" : "s"}</span>{" "}
            Same text · {repeats.map((r) => `${shortDay(r.received_at)} (${r.on_the_public_graph.slice(0, 8)})`).join(", ")} · opened nothing
          </td>
        </tr>
      )}
    </tbody>
  );
}

/** The label the page a reply was made through was written at: named, withheld from this reader, or not said (an older API). */
function pageLabelOf(c: ReceivedContribution): { label: string | null; withheld: boolean } {
  if (typeof c.page_label === "string") return { label: c.page_label, withheld: false };
  return { label: null, withheld: !!c.page_label?.withheld };
}

type Funding = { kind: "at"; label: string } | { kind: "choose"; labels: MyLabels["labels"] } | { kind: "none" };

/**
 * Where the reassessment can be paid for. It is opened at the label the page
 * came from, so that is the label it is ordered at, without asking. Only
 * where the API does not say which label that is does the person choose.
 */
function fundingAt(at: { label: string | null; withheld: boolean }, labels: MyLabels | null): Funding {
  if (at.withheld) return { kind: "none" };
  if (at.label !== null) return labels && labels.labels.some((l) => l.name === at.label) ? { kind: "at", label: at.label } : { kind: "none" };
  if (!labels) return { kind: "none" };
  if (labels.must_choose) return labels.labels.length > 0 ? { kind: "choose", labels: labels.labels } : { kind: "none" };
  const only = labels.works_at ?? labels.labels[0]?.name;
  return only ? { kind: "at", label: only } : { kind: "none" };
}

/** Pay for the node's reassessment: an assessment ordered at the label the page came from, from your own owls. Nothing is sent outside. */
function FundReassessment({ nodeId, fund }: { nodeId: string; fund: Exclude<Funding, { kind: "none" }> }) {
  return (
    <WorkForm action={assessHereAction} submit="Order the assessment" primary inline>
      <input type="hidden" name="node_id" value={nodeId} />
      {fund.kind === "at" ? (
        <input type="hidden" name="label" value={fund.label} />
      ) : (
        <select className="w-select" name="label" required defaultValue="" aria-label="Label" style={{ width: 200 }}>
          <option value="" disabled>
            Choose a label
          </option>
          {fund.labels.map((l) => (
            <option key={l.name} value={l.name} title={l.who_reads}>
              {l.name}
            </option>
          ))}
        </select>
      )}
      <span className="w-help">
        {fund.kind === "at" ? (
          <>
            At <span className="w-chip">{fund.label}</span>, the label the page came from{" "}
          </>
        ) : (
          <>At the label the page came from </>
        )}
        <Tip>
          The node is assessed again at that label, on what it reads, and the reply counts as paid for. It is paid from your owls; what the run
          does not spend comes back. Nothing is sent outside.
        </Tip>
      </span>
    </WorkForm>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
