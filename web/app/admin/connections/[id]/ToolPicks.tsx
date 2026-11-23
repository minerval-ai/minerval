"use client";

import { Fragment, useActionState, useState } from "react";
import { Icon } from "@/components/work/icons";
import { Count, Pill, Tip } from "@/components/work/ui";
import type { FormAction } from "@/components/admin/ActionForm";
import type { ConnectionTool, ConnectionToolPick } from "@/lib/admin-api";

// The tools a connection's server lists, each with a switch that offers it to
// agents and, when opened, the terms it is offered on: as a tool that reads,
// or under a write grant (an acknowledgement and a reason); whether a write
// waits for an administrator; and what a call costs a run. Nothing is sent
// until the bar at the foot is used: it submits the whole set of switched-on
// tools to the offer action (PUT /connections/:id/tools, which replaces what
// is offered), each as its name, the hash of the definition shown here, which
// is what a pick is of, and its terms.

export interface ToolRow {
  tool: ConnectionTool;
  /** When it was seen and when withdrawn, already written out by the page. */
  seen: string;
  withdrawnWhen: string | null;
  withdrawnWhy: string | null;
  /** When its write grant was made, written out by the page; null when it has none. */
  grantedWhen: string | null;
}

/** The terms a tool is offered on, as the page holds them while they are edited. */
interface Terms {
  writes: boolean;
  reason: string;
  acknowledged: boolean;
  held: boolean;
  owls: string;
}

/** A tool's terms as they stand: what a saved pick of it would restate. */
function termsOf(tool: ConnectionTool): Terms {
  const granted = tool.offered ? tool.write_grant : null;
  return {
    writes: granted !== null,
    reason: granted?.reason ?? "",
    // A grant that stands was acknowledged when it was made; restating it is not a new one.
    acknowledged: granted !== null,
    held: granted?.held ?? false,
    owls: tool.offered && tool.owls_per_call > 0 ? String(tool.owls_per_call) : "",
  };
}

const sameTerms = (a: Terms, b: Terms) =>
  a.writes === b.writes && a.reason.trim() === b.reason.trim() && a.held === b.held && Number(a.owls || 0) === Number(b.owls || 0);

function pickOf(tool: ConnectionTool, terms: Terms): ConnectionToolPick {
  const owls = Number(terms.owls || 0);
  return {
    name: tool.name,
    definition_hash: tool.definition_hash,
    ...(terms.writes ? { writes: { acknowledged: terms.acknowledged, reason: terms.reason.trim() }, held: terms.held } : {}),
    ...(owls > 0 ? { owls_per_call: owls } : {}),
  };
}

/** What stops a tool's terms from being saved, in a few words; null when nothing does. */
function termsProblem(tool: ConnectionTool, terms: Terms): string | null {
  if (tool.marked_as_writing && !terms.writes) return "the server marks it as writing, so it needs a write grant";
  if (terms.writes && !terms.reason.trim()) return "its write grant needs your reason";
  if (terms.writes && !terms.acknowledged) return "its write grant needs your acknowledgement";
  if (terms.owls && !(Number(terms.owls) >= 0)) return "its price is not a number";
  return null;
}

export function ToolPicks({
  connectionId,
  rows,
  action,
  acknowledgement,
}: {
  connectionId: string;
  rows: ToolRow[];
  action: FormAction;
  /** What a write grant acknowledges, in the API's words. */
  acknowledgement: string;
}) {
  const initial = new Set(rows.filter((r) => r.tool.offered).map((r) => r.tool.name));
  const initialTerms = new Map(rows.map((r) => [r.tool.name, termsOf(r.tool)]));
  const [on, setOn] = useState<Set<string>>(initial);
  const [terms, setTerms] = useState<Map<string, Terms>>(initialTerms);
  const [open, setOpen] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(action, {});

  const termsFor = (name: string) => terms.get(name) ?? initialTerms.get(name)!;
  const added = rows.filter((r) => on.has(r.tool.name) && !initial.has(r.tool.name)).map((r) => r.tool.name);
  const removed = rows.filter((r) => !on.has(r.tool.name) && initial.has(r.tool.name)).map((r) => r.tool.name);
  const reterm = rows
    .filter((r) => on.has(r.tool.name) && initial.has(r.tool.name) && !sameTerms(termsFor(r.tool.name), initialTerms.get(r.tool.name)!))
    .map((r) => r.tool.name);
  const changes = added.length + removed.length + reterm.length;
  const picked = rows.filter((r) => on.has(r.tool.name));
  const problems = picked
    .map((r) => [r.tool.name, termsProblem(r.tool, termsFor(r.tool.name))] as const)
    .filter((p): p is readonly [string, string] => p[1] !== null);
  const writing = picked.filter((r) => termsFor(r.tool.name).writes).length;

  const edit = (name: string, change: Partial<Terms>) =>
    setTerms((prev) => {
      const next = new Map(prev);
      const was = termsFor(name);
      const now = { ...was, ...change };
      // A grant that stands was acknowledged with the reason it has. A
      // reason changed away from it is a new grant, to be acknowledged
      // again; changed back, it is the grant that stands.
      if (change.reason !== undefined) {
        const first = initialTerms.get(name)!;
        const standing = (reason: string) => first.writes && reason.trim() === first.reason.trim();
        if (standing(now.reason)) now.acknowledged = true;
        else if (standing(was.reason)) now.acknowledged = false;
      }
      if (!now.writes) now.held = false;
      next.set(name, now);
      return next;
    });

  const toggle = (tool: ConnectionTool) => {
    const turningOn = !on.has(tool.name);
    setOn((prev) => {
      const next = new Set(prev);
      if (turningOn) next.add(tool.name);
      else next.delete(tool.name);
      return next;
    });
    // A tool the server marks as writing is offered only under a write
    // grant, so switching it on opens the grant to be filled in.
    if (turningOn && tool.marked_as_writing) {
      edit(tool.name, { writes: true });
      setOpen(tool.name);
    }
  };

  const discard = () => {
    setOn(new Set(initial));
    setTerms(new Map(initialTerms));
  };

  return (
    <form action={formAction} className="w-col" style={{ gap: 12 }}>
      <input type="hidden" name="connection_id" value={connectionId} />
      {picked.map((r) => (
        <input key={r.tool.name} type="hidden" name="offer" value={JSON.stringify(pickOf(r.tool, termsFor(r.tool.name)))} />
      ))}
      <div className="w-tbox">
        <table className="w-t" aria-label="Tools">
          <thead>
            <tr>
              <th>Offered</th>
              <th>Tool</th>
              <th>Description</th>
              <th>
                <span className="w-row" style={{ gap: 6 }}>
                  Marking <Tip>A server&rsquo;s marking is a hint, not a proof</Tip>
                </span>
              </th>
              <th>
                <span className="w-row" style={{ gap: 6 }}>
                  Offered as <Tip>A tool is offered as one that reads unless you grant it to write. Open a tool to change that.</Tip>
                </span>
              </th>
              <th className="w-num">Calls</th>
              <th className="w-num">Kept</th>
              <th className="w-act" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ tool, seen, withdrawnWhen, withdrawnWhy, grantedWhen }) => {
              const isOn = on.has(tool.name);
              const t = termsFor(tool.name);
              const termsChanged = isOn && initial.has(tool.name) && !sameTerms(t, initialTerms.get(tool.name)!);
              const changed = isOn !== initial.has(tool.name) || termsChanged;
              const expanded = open === tool.name;
              const problem = isOn ? termsProblem(tool, t) : null;
              const cls = [changed && "w-conn-chg", tool.withdrawn && "w-conn-wd", expanded && "w-conn-open"].filter(Boolean).join(" ");
              const granted = tool.offered ? tool.write_grant : null;
              return (
                <Fragment key={tool.name}>
                  <tr className={cls || undefined}>
                    <td style={{ width: 54 }}>
                      <label
                        className="w-conn-tg"
                        title={
                          tool.withdrawn
                            ? "Read the tool as it now is before offering it again"
                            : tool.marked_as_writing
                              ? "The server marks this tool as writing: it is offered only under a write grant"
                              : undefined
                        }
                      >
                        <input type="checkbox" checked={isOn} disabled={pending} onChange={() => toggle(tool)} aria-label={`Offer ${tool.name}`} />
                        <span />
                      </label>
                    </td>
                    <td className="w-mono" style={{ whiteSpace: "nowrap" }}>
                      {tool.name}
                      {(changed || tool.withdrawn || problem) && (
                        <div className="w-conn-tagline">
                          {isOn !== initial.has(tool.name) && <Pill tone={isOn ? "info" : "neu"}>{isOn ? "Will be offered" : "Will stop being offered"}</Pill>}
                          {termsChanged && <Pill tone="info">Terms will change</Pill>}
                          {problem && <Pill tone="bad">Needs: {problem}</Pill>}
                          {tool.withdrawn && (
                            <Pill tone="warn" title={`Withdrawn ${withdrawnWhen}: ${withdrawnWhy}`}>
                              Withdrawn · {withdrawnWhy}
                            </Pill>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <div className="w-conn-trunc w-muted" title={tool.description}>
                        {tool.description || <span className="w-faint">No description</span>}
                      </div>
                    </td>
                    <td>
                      {tool.marked_as_writing ? (
                        <Pill tone="bad" title="The server marks it as changing things. It can be offered only under a write grant.">
                          Marked as writing
                        </Pill>
                      ) : tool.read_only_hint === true ? (
                        <Pill tone="ok" title="The server marks it read-only. That is the server's own word, a hint.">
                          Read-only hint
                        </Pill>
                      ) : (
                        <Pill tone="neu" title="The server gives no marking. Whether it only reads is your judgment of the system.">
                          No marking
                        </Pill>
                      )}
                    </td>
                    <td>
                      {!isOn ? (
                        <span className="w-faint">Not offered</span>
                      ) : t.writes ? (
                        <span className="w-row" style={{ gap: 6, flexWrap: "wrap" }}>
                          <Pill tone="warn" title={t.reason || "No reason given yet"}>
                            Writes
                          </Pill>
                          {t.held && <Pill tone="info">Held</Pill>}
                        </span>
                      ) : (
                        <span className="w-muted">Reads</span>
                      )}
                      {isOn && Number(t.owls || 0) > 0 && <div className="w-faint w-small">{Number(t.owls)} owls a call</div>}
                    </td>
                    <td className="w-num">{tool.calls.toLocaleString("en-GB")}</td>
                    <td className="w-num">{tool.readings_kept.toLocaleString("en-GB")}</td>
                    <td className="w-act">
                      <button
                        type="button"
                        className="w-conn-icon"
                        aria-label={expanded ? `Hide ${tool.name}'s definition and terms` : `Show ${tool.name}'s definition and terms`}
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : tool.name)}
                      >
                        <Icon name="chevron" size={14} />
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="w-conn-det">
                      <td colSpan={8}>
                        <div className="w-conn-detail">
                          <div className="w-col" style={{ gap: 6 }}>
                            {tool.description && <div style={{ whiteSpace: "pre-wrap" }}>{tool.description}</div>}
                            <div className="w-faint w-small">Input schema</div>
                            <pre className="w-code">{JSON.stringify(tool.input_schema, null, 2)}</pre>
                          </div>
                          <dl className="w-kv">
                            <dt>Offered as</dt>
                            <dd className="w-mono">{tool.offered_as}</dd>
                            <dt>Markings</dt>
                            <dd className="w-mono">{tool.annotations ? JSON.stringify(tool.annotations) : "none"}</dd>
                            <dt>Definition</dt>
                            <dd>
                              <span className="w-mono" title={tool.definition_hash}>
                                {tool.definition_hash.slice(0, 16)}…
                              </span>
                            </dd>
                            <dt>Seen</dt>
                            <dd>{seen}</dd>
                            {tool.withdrawn && (
                              <>
                                <dt>Withdrawn</dt>
                                <dd>
                                  {withdrawnWhen}, because {withdrawnWhy}. Shown as the server had it when last looked at.
                                </dd>
                              </>
                            )}
                            {granted && (
                              <>
                                <dt>Write grant</dt>
                                <dd>
                                  {granted.granted_by?.name ? `${granted.granted_by.name}, ` : ""}
                                  {grantedWhen}. Acknowledged then: &ldquo;{granted.acknowledgement}&rdquo;
                                </dd>
                              </>
                            )}
                          </dl>
                        </div>
                        {isOn ? (
                          <fieldset className="w-conn-terms" disabled={pending}>
                            <legend>How agents are offered {tool.name}</legend>
                            <label className="w-conn-check">
                              <input type="checkbox" checked={t.writes} onChange={(e) => edit(tool.name, { writes: e.target.checked })} />
                              <span>
                                Grant it to write
                                <span className="w-faint w-small">
                                  {tool.marked_as_writing
                                    ? " · the server marks it as writing, so it can be offered no other way"
                                    : " · left off, agents are told it reads"}
                                </span>
                              </span>
                            </label>
                            {t.writes && (
                              <div className="w-col" style={{ gap: 10, marginLeft: 24 }}>
                                <div className="w-field">
                                  <label htmlFor={`reason-${tool.name}`}>
                                    Your reason <span className="w-faint w-small">· every agent offered the tool is told it, and it is kept and shown here</span>
                                  </label>
                                  <textarea
                                    id={`reason-${tool.name}`}
                                    className="w-input"
                                    rows={2}
                                    maxLength={1000}
                                    value={t.reason}
                                    onChange={(e) => edit(tool.name, { reason: e.target.value })}
                                    placeholder="Why agents should be able to write to this system through it"
                                  />
                                </div>
                                <label className="w-conn-check">
                                  <input type="checkbox" checked={t.acknowledged} onChange={(e) => edit(tool.name, { acknowledged: e.target.checked })} />
                                  <span>{acknowledgement}</span>
                                </label>
                                <label className="w-conn-check">
                                  <input type="checkbox" checked={t.held} onChange={(e) => edit(tool.name, { held: e.target.checked })} />
                                  <span>
                                    Hold each call for an administrator
                                    <span className="w-faint w-small"> · a call is recorded and not sent until one of you approves it under Writes</span>
                                  </span>
                                </label>
                                <div className="w-faint w-small">
                                  Offered only to runs that work at this connection&rsquo;s own label, and never to the Assistant. Grant the connection the narrowest credential at the system that allows this.
                                </div>
                              </div>
                            )}
                            <div className="w-field" style={{ maxWidth: 260 }}>
                              <label htmlFor={`owls-${tool.name}`}>
                                Owls a call <span className="w-faint w-small">· charged to the run&rsquo;s budget; empty for none</span>
                              </label>
                              <input
                                id={`owls-${tool.name}`}
                                className="w-input"
                                type="number"
                                min={0}
                                step="any"
                                value={t.owls}
                                onChange={(e) => edit(tool.name, { owls: e.target.value })}
                                placeholder="0"
                              />
                            </div>
                          </fieldset>
                        ) : (
                          <div className="w-faint w-small" style={{ marginTop: 10 }}>
                            Switch the tool on to set how agents are offered it.
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {(changes > 0 || pending || state.error || state.notice) && (
        <div className="w-savebar" role="region" aria-label="Unsaved picks">
          {changes > 0 && <Count n={changes} hot />}
          <span>
            {changes > 0 ? (
              <>
                <b style={{ fontWeight: 500 }}>
                  {changes} change{changes === 1 ? "" : "s"}
                </b>{" "}
                <span className="w-muted">· {[...added.map((n) => `+${n}`), ...removed.map((n) => `−${n}`), ...reterm.map((n) => `~${n}`)].join(", ")}</span>
              </>
            ) : state.error ? (
              <span className="w-said w-error" role="alert">
                {state.error}
              </span>
            ) : (
              <span className="w-said" role="status">
                {state.notice}
              </span>
            )}
          </span>
          {changes > 0 && (state.error || problems.length > 0) && (
            <span className="w-said w-error" role="alert">
              {state.error ?? `${problems[0]![0]}: ${problems[0]![1]}.`}
            </span>
          )}
          <span className="w-spacer w-row">
            {changes > 0 && (
              <button type="button" className="w-btn w-ghost" onClick={discard} disabled={pending}>
                Discard
              </button>
            )}
            {changes > 0 && (
              <button type="submit" className="w-btn w-pri" disabled={pending || problems.length > 0}>
                {pending
                  ? "Working…"
                  : `Offer ${on.size} tool${on.size === 1 ? "" : "s"} to agents${writing > 0 ? `, ${writing} to write` : ""}`}
              </button>
            )}
          </span>
        </div>
      )}
    </form>
  );
}
