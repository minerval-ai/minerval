"use client";

import { Fragment, useActionState, useState } from "react";
import { Icon } from "@/components/work/icons";
import { Count, Pill, Tip } from "@/components/work/ui";
import type { FormAction } from "@/components/admin/ActionForm";
import type { ConnectionTool } from "@/lib/admin-api";

// The tools a connection's server lists, each with a switch that offers it to
// agents. Nothing is sent until the bar at the foot is used: it submits the
// whole set of switched-on tools to the offer action (PUT
// /connections/:id/tools, which replaces what is offered), each as its name
// and the hash of the definition shown here, which is what a pick is of.

export interface ToolRow {
  tool: ConnectionTool;
  /** When it was seen and when withdrawn, already written out by the page. */
  seen: string;
  withdrawnWhen: string | null;
  withdrawnWhy: string | null;
}

export function ToolPicks({ connectionId, rows, action }: { connectionId: string; rows: ToolRow[]; action: FormAction }) {
  const initial = new Set(rows.filter((r) => r.tool.offered).map((r) => r.tool.name));
  const [on, setOn] = useState<Set<string>>(initial);
  const [open, setOpen] = useState<string | null>(null);
  const [state, formAction, pending] = useActionState(action, {});

  const added = rows.filter((r) => on.has(r.tool.name) && !initial.has(r.tool.name)).map((r) => r.tool.name);
  const removed = rows.filter((r) => !on.has(r.tool.name) && initial.has(r.tool.name)).map((r) => r.tool.name);
  const changes = added.length + removed.length;

  const toggle = (name: string) =>
    setOn((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <form action={formAction} className="w-col" style={{ gap: 12 }}>
      <input type="hidden" name="connection_id" value={connectionId} />
      {rows
        .filter((r) => on.has(r.tool.name))
        .map((r) => (
          <input key={r.tool.name} type="hidden" name="offer" value={JSON.stringify({ name: r.tool.name, definition_hash: r.tool.definition_hash })} />
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
              <th className="w-num">Calls</th>
              <th className="w-num">Kept</th>
              <th className="w-act" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ tool, seen, withdrawnWhen, withdrawnWhy }) => {
              const isOn = on.has(tool.name);
              const changed = isOn !== initial.has(tool.name);
              const expanded = open === tool.name;
              const cls = [changed && "w-conn-chg", tool.withdrawn && "w-conn-wd", expanded && "w-conn-open"].filter(Boolean).join(" ");
              return (
                <Fragment key={tool.name}>
                  <tr className={cls || undefined}>
                    <td style={{ width: 54 }}>
                      <label
                        className="w-conn-tg"
                        title={
                          tool.marked_as_writing
                            ? "The server marks this tool as writing, so it can't be offered"
                            : tool.withdrawn
                              ? "Read the tool as it now is before offering it again"
                              : undefined
                        }
                      >
                        <input
                          type="checkbox"
                          checked={isOn}
                          disabled={tool.marked_as_writing || pending}
                          onChange={() => toggle(tool.name)}
                          aria-label={`Offer ${tool.name}`}
                        />
                        <span />
                      </label>
                    </td>
                    <td className="w-mono" style={{ whiteSpace: "nowrap" }}>
                      {tool.marked_as_writing && (
                        <span className="w-lock" style={{ marginRight: 6, verticalAlign: -2 }}>
                          <Icon name="lock" size={13} />
                        </span>
                      )}
                      {tool.name}
                      {(changed || tool.withdrawn) && (
                        <div className="w-conn-tagline">
                          {changed && <Pill tone={isOn ? "info" : "neu"}>{isOn ? "Will be offered" : "Will stop being offered"}</Pill>}
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
                        <Pill tone="bad" title="The server marks it as changing things">
                          Writes — locked off
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
                    <td className="w-num">{tool.calls.toLocaleString("en-GB")}</td>
                    <td className="w-num">{tool.readings_kept.toLocaleString("en-GB")}</td>
                    <td className="w-act">
                      <button
                        type="button"
                        className="w-conn-icon"
                        aria-label={expanded ? `Hide ${tool.name}'s definition` : `Show ${tool.name}'s definition`}
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : tool.name)}
                      >
                        <Icon name="chevron" size={14} />
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="w-conn-det">
                      <td colSpan={7}>
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
                          </dl>
                        </div>
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
                <span className="w-muted">
                  · {[...added.map((n) => `+${n}`), ...removed.map((n) => `−${n}`)].join(", ")}
                </span>
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
          {changes > 0 && state.error && (
            <span className="w-said w-error" role="alert">
              {state.error}
            </span>
          )}
          <span className="w-spacer w-row">
            {changes > 0 && (
              <button type="button" className="w-btn w-ghost" onClick={() => setOn(new Set(initial))} disabled={pending}>
                Discard
              </button>
            )}
            {changes > 0 && (
              <button type="submit" className="w-btn w-pri" disabled={pending}>
                {pending ? "Working…" : `Offer ${on.size} tool${on.size === 1 ? "" : "s"} to agents`}
              </button>
            )}
          </span>
        </div>
      )}
    </form>
  );
}
