import type { Metadata } from "next";
import Link from "next/link";
import { can, viewer } from "@/components/admin/access";
import { WorkForm } from "@/components/work/WorkForm";
import { ButtonLink, Empty, Pill, Section, Table, Tabs, Tip, WorkHead, WorkPage, plural, shortDay, shortWhen, type Tone } from "@/components/work/ui";
import { fetchOutbound, type OutboundNode, type OutboundPackage, type OutboundSend } from "@/lib/inside-api";
import { british, fetchReportsForSending, type ReportForSending } from "@/lib/outside-api";
import { HeadSub, Note, loadAccount, tryRead } from "../admin/outside/parts";
import { sendOutsideAction, writeProposalAction } from "../releases/actions";

export const metadata: Metadata = { title: "Outbox · Minerval" };
export const dynamic = "force-dynamic";

// Everything leaving this deployment for the public graph. Pages: where each
// node released outside stands on its way out (GET /outbound; docs/published-pages.md,
// "Inside the deployment"): the node on the public graph or its proposal there,
// each signed package built, and each time one was sent or taken as a file,
// with what the public graph answered. A person who directs sends. Reports:
// the agents' reports of problems, kept inside, and where each one about
// Minerval's machinery stands at the gate to outside (docs/outward-acts.md).

const STATE_WORDS: Record<string, string> = {
  not_yet_assessed: "Says the node is not yet assessed, and carries no page",
  released_whole: "Carries the page released whole",
  released_in_part: "Carries the page released in part, with each held part named in its place",
  held: "Says the node's latest assessment is held, and gives none of its text; where an earlier assessment was released, it still carries that page",
};

const STATE_SHORT: Record<string, string> = {
  not_yet_assessed: "not yet assessed",
  released_whole: "released whole",
  released_in_part: "released in part",
  held: "held",
};

const PROPOSAL: Record<string, { tone: Tone; text: string }> = {
  // The state is stored as waiting_for_consent: the words wait for each party's consent.
  waiting_for_consent: { tone: "warn", text: "At the gate, waiting for consent" },
  ready: { tone: "ok", text: "Ready" },
  sent: { tone: "info", text: "Under review outside" },
  on_the_public_graph: { tone: "ok", text: "Admitted" },
  not_admitted: { tone: "bad", text: "Not admitted" },
  replaced: { tone: "neu", text: "Replaced" },
};

const BY_HAND = "sent to the public graph";

function taken(p: OutboundPackage): boolean {
  return p.sends.some((s) => s.result === "admitted");
}

/** One send, as a pill: taken, refused, not arrived, or carried by hand as a file. */
function sendPill(s: OutboundSend): { tone: Tone; text: string } {
  if (s.how !== BY_HAND) return { tone: "neu", text: "Taken as a file" };
  if (s.result === "admitted") return { tone: "ok", text: "Taken" };
  if (s.result === "refused") return { tone: "bad", text: "Refused" };
  return { tone: "warn", text: "Not sent" };
}

function chipOf(p: OutboundPackage): { cls: string; text: string } {
  if (taken(p)) return { cls: "w-ok", text: "taken" };
  const last = p.sends[p.sends.length - 1];
  if (!last) return { cls: "w-warn", text: "waiting" };
  if (last.how !== BY_HAND) return { cls: "", text: "as file" };
  if (last.result === "refused") return { cls: "w-bad", text: "refused" };
  return { cls: "w-warn", text: "not sent" };
}

export default async function OutboxPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { tab } = await searchParams;
  const current = tab === "reports" ? "reports" : "pages";
  const [{ data: account, problem: accountProblem }, { data: overview, problem: pagesProblem }, { data: reports, problem: reportsProblem }] =
    await Promise.all([
      loadAccount(who.externalId),
      tryRead(() => fetchOutbound(who.externalId), "The pages on their way out could not be read"),
      tryRead(() => fetchReportsForSending(who.externalId), "The agents' reports could not be read"),
    ]);
  const mayDirect = can(who, "direct");
  const nodes = overview?.nodes ?? [];
  const waiting = nodes.reduce((n, node) => n + node.packages.filter((p) => !taken(p) && p.sends.length === 0).length, 0);
  const offered = (reports?.reports ?? []).filter((r) => r.offered_to_the_gate);

  return (
    <WorkPage>
      <WorkHead
        title="Outbox"
        sub={<HeadSub account={account} problem={accountProblem}>Everything leaving for the public graph</HeadSub>}
        actions={
          <>
            {can(who, "administer") && (
              <ButtonLink href="/admin/outside?drawer=key" title="Registering the signing key is on the Public graph overview">
                Register key
              </ButtonLink>
            )}
            <ButtonLink href="/gates">Gate settings</ButtonLink>
          </>
        }
      />

      {accountProblem && <Note tone="bad">{accountProblem}</Note>}

      <Tabs
        current={current}
        tabs={[
          { key: "pages", label: <span title="Packages waiting to be sent">Pages</span>, href: "/outbound", count: waiting },
          { key: "reports", label: "Reports", href: "/outbound?tab=reports", count: reports?.reports.length ?? 0 },
        ]}
      />

      {current === "pages" ? (
        <Pages overview={overview} problem={pagesProblem} mayDirect={mayDirect} />
      ) : (
        <Reports listed={reports} problem={reportsProblem} />
      )}
    </WorkPage>
  );
}

// ---- pages ------------------------------------------------------------------------

function Pages({
  overview,
  problem,
  mayDirect,
}: {
  overview: { nodes: OutboundNode[]; how_sending_works: Record<string, string> } | null;
  problem: string | null;
  mayDirect: boolean;
}) {
  if (problem) return <Note tone="bad">{problem}</Note>;
  if (!overview) return null;
  const releases = [...new Set(overview.nodes.map((n) => n.release_id))];
  const how = overview.how_sending_works;

  return (
    <>
      {releases.length === 0 && (
        <div className="w-tbox">
          <Empty>No page has been asked to be released outside this deployment.</Empty>
        </div>
      )}

      {releases.map((releaseId) => {
        const nodes = overview.nodes.filter((n) => n.release_id === releaseId);
        const head = nodes[0]!;
        const waiting = nodes.reduce((n, node) => n + node.packages.filter((p) => !taken(p)).length, 0);
        const ready = nodes.filter((n) => n.proposal?.state === "ready").length;
        const standing = head.sent === "as_released";
        const lastTaken = nodes
          .flatMap((n) => n.packages.flatMap((p) => p.sends.filter((s) => s.result === "admitted").map((s) => s.at)))
          .sort()
          .pop();
        return (
          <section className="w-tbox" key={releaseId} id={`release-${releaseId}`} style={{ scrollMarginTop: 16 }}>
            <div className="w-pub-grp">
              <span className="w-node">{head.node ?? "A node you do not read"}</span>
              {nodes.length > 1 && <span className="w-muted w-small">and {nodes.length - 1} under it</span>}
              <Link className="w-small" href={`/releases/${releaseId}`}>
                Release
              </Link>
              <span className="w-row" style={{ gap: 4 }}>
                <Pill tone="neu">{standing ? "Sent as released" : "Sent by a person"}</Pill>
                {how[head.sent] && <Tip>{british(how[head.sent]!)}</Tip>}
              </span>
              <div className="w-spacer w-row">
                {waiting + ready === 0 ? (
                  <span className="w-muted w-small">
                    {plural(nodes.length, "node")} · nothing waiting{lastTaken ? ` · last taken ${shortDay(lastTaken)}` : ""}
                  </span>
                ) : (
                  mayDirect && (
                    <WorkForm action={sendOutsideAction} submit={`Send ${waiting + ready} waiting`} primary inline lock="Can't be taken back">
                      <input type="hidden" name="release_id" value={releaseId} />
                    </WorkForm>
                  )
                )}
                {waiting + ready > 0 && !mayDirect && <span className="w-muted w-small">{waiting + ready} waiting for a person who directs</span>}
              </div>
            </div>
            <table className="w-t" aria-label="Nodes under this release">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Public node</th>
                  <th>Packages</th>
                  <th>Last send</th>
                  <th className="w-act" />
                </tr>
              </thead>
              {nodes.map((node) => (
                <NodeRows key={node.node_id} node={node} releaseId={releaseId} mayDirect={mayDirect} />
              ))}
            </table>
          </section>
        );
      })}

      <details className="w-pub-more">
        <summary>What a send shows outside</summary>
        <ul className="w-pub-list">
          <li>
            The text of each part that every party it rests on has consented to, with each removal marked, and for each held part its kind, who holds
            it, any reason given and since when. Nothing else of the page.
          </li>
          <li>
            The verdict with any credence, what kinds of evidence it was made on, that each source exists, how the page was made, and the
            redaction policy in full.
          </li>
          <li>
            The record of the release: when it was asked for and whether that was before the node was first assessed, every act on it with the
            permissions the person held, and every assessment made while it stood, the held ones as held. People are numbered, and no
            person&apos;s name is sent. Parties&apos; names are.
          </li>
          <li>
            That this organisation is attending to this node, and when. A package that says only &ldquo;held&rdquo; or &ldquo;not yet
            assessed&rdquo; still says that.
          </li>
          {how.by_a_person_each_time && <li>{british(how.by_a_person_each_time)}</li>}
          <li>
            Where the network does not join this deployment to the public graph, a person takes a package as a file and submits it there by hand;
            the public graph checks it the same way. Taking a file is recorded here with who took it. What became of a package carried by hand is
            read on the public graph.
          </li>
        </ul>
      </details>
    </>
  );
}

function NodeRows({ node, releaseId, mayDirect }: { node: OutboundNode; releaseId: string; mayDirect: boolean }) {
  const packages = [...node.packages].sort((a, b) => a.sequence - b.sequence);
  const latest = packages[packages.length - 1];
  const sends = packages
    .flatMap((p) => p.sends.map((s) => ({ ...s, sequence: p.sequence })))
    .sort((a, b) => (a.at < b.at ? -1 : 1));
  const last = sends[sends.length - 1];
  const earlierMiss = last && sendPill(last).tone === "ok" ? sends.slice(0, -1).filter((s) => sendPill(s).tone !== "ok" && s.how === BY_HAND).pop() : undefined;
  const proposal = node.proposal ? (PROPOSAL[node.proposal.state] ?? { tone: "neu" as Tone, text: node.proposal.state.replace(/_/g, " ") }) : null;
  const mayWord = !node.public_node_id && mayDirect && node.proposal?.state !== "sent" && node.proposal?.state !== "on_the_public_graph";

  return (
    <tbody className="w-pub-xg">
      <tr>
        <td style={{ maxWidth: 320 }}>
          <Link className="w-node w-sm" href={`/claims/${node.node_id}`}>
            {node.node ?? "A node you do not read"}
          </Link>
        </td>
        <td>
          {node.public_node_id ? (
            <span className="w-mono">{node.public_node_id.slice(0, 8)}</span>
          ) : (
            <div className="w-col" style={{ gap: 4 }}>
              <span className="w-small w-muted">
                Not on the public graph yet{node.waiting && <> <Tip>{british(node.waiting)}</Tip></>}
              </span>
              <span className="w-row" style={{ gap: 6 }}>
                {proposal && <Pill tone={proposal.tone}>Proposal: {proposal.text}</Pill>}
                {mayWord && (
                  <details className="w-pub-tg">
                    <summary className="w-linkbtn w-small">{node.proposal ? "Edit wording" : "Write wording"}</summary>
                  </details>
                )}
              </span>
            </div>
          )}
        </td>
        <td>
          {packages.length === 0 ? (
            <span className="w-faint w-small">{node.public_node_id ? "None built yet" : "Goes after the proposal is admitted"}</span>
          ) : (
            <>
              <div className="w-pub-seq">
                {packages.map((p, i) => {
                  const chip = chipOf(p);
                  return (
                    <span key={p.package_id} style={{ display: "contents" }}>
                      {i > 0 && <em aria-hidden />}
                      <span className={chip.cls} title={`Package ${p.sequence}: ${STATE_WORDS[p.state] ?? p.state.replace(/_/g, " ")}`}>
                        #{p.sequence} {chip.text}
                      </span>
                    </span>
                  );
                })}
              </div>
              {latest && (
                <div className="w-faint w-small" style={{ marginTop: 4 }}>
                  #{latest.sequence} built {shortDay(latest.built_at)} · {STATE_SHORT[latest.state] ?? latest.state.replace(/_/g, " ")}
                </div>
              )}
            </>
          )}
        </td>
        <td className="w-small">
          {last ? (
            <>
              <Pill tone={sendPill(last).tone}>{sendPill(last).text}</Pill>{" "}
              <span className="w-muted">
                #{last.sequence} · {shortDay(last.at)}
              </span>
              {earlierMiss && <div className="w-faint">after #{earlierMiss.sequence} {sendPill(earlierMiss).text.toLowerCase()}, {shortDay(earlierMiss.at)}</div>}
            </>
          ) : (
            <span className="w-faint">Never sent</span>
          )}
        </td>
        <td className="w-act">
          <div className="w-row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
            {mayDirect && latest && (
              <form method="post" action={`/api/outbound/packages/${latest.package_id}/file`}>
                <button className="w-btn w-ghost w-sm" type="submit" title="Take it as a file to submit by hand · recorded with your name">
                  Download package
                </button>
              </form>
            )}
            {(sends.length > 0 || packages.length > 1 || node.proposal) && (
              <details className="w-pub-tg">
                <summary className="w-btn w-ghost w-sm" aria-label="Show every package and send">
                  More
                </summary>
              </details>
            )}
          </div>
        </td>
      </tr>
      <tr className="w-detail w-pub-xrow">
        <td colSpan={5}>
          <div className="w-col" style={{ gap: 12, padding: "4px 0" }}>
            {node.proposal && (
              <div>
                <span className="w-pub-k">
                  Proposed in these words, written {shortDay(node.proposal.written_at)}
                  {node.proposal.waits_on.length > 0 && ` · waits on ${node.proposal.waits_on.map((p) => p.name).join(", ")}`}
                </span>
                <p className="w-pub-quote">{node.proposal.text}</p>
                {node.proposal.state === "waiting_for_consent" && (
                  <span className="w-help">
                    At the gate to outside as an item of its own. Where a person decides as well, it is approved on <Link href="/gate">Review</Link>.
                  </span>
                )}
              </div>
            )}
            {mayWord && (
              <WorkForm action={writeProposalAction} submit="Record these words" small>
                <input type="hidden" name="release_id" value={releaseId} />
                <input type="hidden" name="node_id" value={node.node_id} />
                <div className="w-field">
                  <label htmlFor={`words-${node.node_id}`}>
                    The node as it is to be proposed to the public graph{" "}
                    <Tip>
                      Left blank, the node&apos;s own wording is used. These words are public once sent: they go to the public graph as a
                      proposal under the organisation&apos;s account, reviewed there like anyone&apos;s. They go through the gate to outside
                      first, unless they are word for word a wording that already went through it with the node&apos;s page.
                    </Tip>
                  </label>
                  <textarea id={`words-${node.node_id}`} className="w-input" name="text" rows={3} defaultValue={node.proposal?.text} />
                </div>
              </WorkForm>
            )}
            {packages.length > 0 && (
              <table className="w-t" aria-label="Packages" style={{ background: "var(--w-panel)", border: "1px solid var(--w-rule)" }}>
                <thead>
                  <tr>
                    <th>Package</th>
                    <th>What it tells the outside</th>
                    <th>Sent, or carried</th>
                    <th className="w-act" />
                  </tr>
                </thead>
                <tbody>
                  {packages.map((p) => (
                    <tr key={p.package_id}>
                      <td className="w-small" style={{ whiteSpace: "nowrap" }}>
                        #{p.sequence} <span className="w-faint">built {shortDay(p.built_at)}</span>
                      </td>
                      <td className="w-small">{STATE_WORDS[p.state] ?? `Gives the node's state as ${p.state.replace(/_/g, " ")}`}.</td>
                      <td className="w-small">
                        {p.sends.length === 0 ? (
                          <span className="w-faint">Not sent. It waits here.</span>
                        ) : (
                          p.sends.map((s, i) => (
                            <div key={i}>
                              <Pill tone={sendPill(s).tone}>{sendPill(s).text}</Pill> {shortWhen(s.at)}
                              {s.by ? ` by ${s.by}` : ""}
                              {s.holding.length > 0 && <> <Tip>{`Holding ${s.holding.join(", ")}`}</Tip></>}
                              {s.the_public_graph_said && <div className="w-faint">The public graph answered: {s.the_public_graph_said}</div>}
                            </div>
                          ))
                        )}
                      </td>
                      <td className="w-act">
                        {mayDirect && (
                          <form method="post" action={`/api/outbound/packages/${p.package_id}/file`}>
                            <button className="w-btn w-ghost w-sm" type="submit" title="Take it as a file to submit by hand · recorded with your name">
                              Download
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </td>
      </tr>
    </tbody>
  );
}

// ---- reports ----------------------------------------------------------------------

function severityTone(s: string): Tone {
  if (/critical|high|severe/i.test(s)) return "bad";
  if (/medium|moderate/i.test(s)) return "warn";
  return "neu";
}

function Reports({ listed, problem }: { listed: Awaited<ReturnType<typeof fetchReportsForSending>> | null; problem: string | null }) {
  if (problem) return <Note tone="bad">{problem}</Note>;
  if (!listed) return null;
  const offered = listed.reports.filter((r) => r.offered_to_the_gate);
  const kept = listed.reports.filter((r) => !r.offered_to_the_gate);
  return (
    <>
      <Section
        title="At the gate to outside"
        aside={
          <>
            reports about Minerval&apos;s machinery go to its maintainers <Tip>{british(listed.how_a_report_goes)}</Tip>
          </>
        }
      >
        {offered.length === 0 ? (
          <div className="w-tbox">
            <Empty>No report at a label you read is about Minerval&apos;s machinery.</Empty>
          </div>
        ) : (
          <Table label="Reports at the gate to outside">
            <thead>
              <tr>
                <th>Report</th>
                <th>Filed by</th>
                <th>Kind</th>
                <th>At the gate</th>
                <th>What came back</th>
                <th className="w-act" />
              </tr>
            </thead>
            {offered.map((r) => (
              <ReportRow key={r.report_id} r={r} />
            ))}
          </Table>
        )}
      </Section>

      <Section title="Kept inside" aside={british(listed.listed)}>
        {kept.length === 0 ? (
          <div className="w-tbox">
            <Empty>No other report at a label you read.</Empty>
          </div>
        ) : (
          <Table label="Reports kept inside">
            <thead>
              <tr>
                <th>Report</th>
                <th>Filed by</th>
                <th>What it is about</th>
                <th>Audit&apos;s note</th>
              </tr>
            </thead>
            <tbody>
              {kept.map((r) => (
                <tr key={r.report_id}>
                  <td style={{ fontWeight: 500 }}>{r.as_written.title}</td>
                  <td className="w-small">{r.filed_by}</td>
                  <td className="w-small">{r.about ?? <span className="w-faint">—</span>}</td>
                  <td className="w-small w-muted">{r.audit_note ?? <span className="w-faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </>
  );
}

function ReportRow({ r }: { r: ReportForSending }) {
  const back = r.sent?.came_back;
  const waiting = !!r.at_the_gate && !r.sent;
  return (
    <tbody className="w-pub-xg">
      <tr>
        <td style={{ fontWeight: 500, maxWidth: 300 }}>{r.as_written.title}</td>
        <td className="w-small">{r.filed_by}</td>
        <td>
          <span className="w-row" style={{ gap: 4 }}>
            <Pill tone="neu">{r.facts.kind.replace(/_/g, " ")}</Pill>
            <Pill tone={severityTone(r.facts.severity)}>{r.facts.severity}</Pill>
          </span>
        </td>
        <td className="w-small">
          {r.sent ? (
            <>
              <Pill tone="ok">Sent</Pill> <span className="w-muted">{shortDay(r.sent.at)}</span>
            </>
          ) : r.at_the_gate ? (
            <>
              <span>{british(r.at_the_gate.stands)}</span>
              {waiting && (
                <>
                  {" "}
                  <Link href="/gate">Review</Link>
                </>
              )}
            </>
          ) : (
            <span className="w-faint">Not yet offered</span>
          )}
        </td>
        <td className="w-small">
          {back ? (
            <>
              <Pill tone="info">{back.status.replace(/_/g, " ")}</Pill>
              {back.issue_url && (
                <>
                  {" "}
                  <a href={back.issue_url} target="_blank" rel="noreferrer">
                    Issue ↗
                  </a>
                </>
              )}
              {back.maintainers_note && <div className="w-muted">{back.maintainers_note}</div>}
            </>
          ) : (
            <span className="w-faint">{r.sent ? "Nothing yet" : "—"}</span>
          )}
        </td>
        <td className="w-act">
          <details className="w-pub-tg">
            <summary className="w-btn w-ghost w-sm" aria-label="Show the report">
              More
            </summary>
          </details>
        </td>
      </tr>
      <tr className="w-detail w-pub-xrow">
        <td colSpan={6}>
          <div className="w-col" style={{ gap: 10, padding: "4px 0" }}>
            <span className="w-small w-muted">
              The facts, in fixed words: {r.facts.tool ? <code className="w-mono">{r.facts.tool}</code> : "no tool of Minerval's own named"} · seen{" "}
              {plural(r.facts.seen, "time")}, {r.facts.first_seen} to {r.facts.last_seen} · Minerval at migration {r.facts.minerval.migration},
              prompt set <span className="w-mono">{r.facts.minerval.prompt_set.slice(0, 12)}…</span> · triage: {r.triage.replace(/_/g, " ")}
              {r.audit_note ? ` · Audit: ${r.audit_note}` : ""}
            </span>
            <div>
              <span className="w-pub-k">
                As written. What goes is what the gate lets through, each removal marked and each held part named.
              </span>
              <pre className="w-code" style={{ whiteSpace: "pre-wrap" }}>
                {r.as_written.title}
                {"\n\n"}
                {r.as_written.body}
              </pre>
            </div>
            {r.sent && (
              <span className="w-small w-muted">
                Sent {shortWhen(r.sent.at)}, filed with Minerval&apos;s maintainers as private
                {r.sent.on_the_public_graph ? ` (${r.sent.on_the_public_graph})` : ""}.
                {back && ` What came back as of ${shortWhen(back.asked_at)}: ${back.status}. ${back.maintainers_note ?? "They have left no note."}`}
              </span>
            )}
          </div>
        </td>
      </tr>
    </tbody>
  );
}
