"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/work/icons";
import { Empty, Kv, Lock, Pill, Section, Table, Tip, type Tone } from "@/components/work/ui";
import type { PreflightCheck } from "@/lib/admin-api";
import { preflightTitle, preflightTodo } from "@/lib/admin-words";
import { OWNER_WORDS, checkCounts, firstLine, type Owner } from "@/lib/health";

// The deployment's own checks, as one reading of them (app/admin). The page
// reads the checks once and hands them here; filtering them and opening one
// happen in the browser over that reading, so two looks at the same table
// never disagree. Only "Check again" asks the deployment to run them anew.
// (Several checks call a live service, the sandbox among them, so a reading
// taken a second later can differ.)

type Status = PreflightCheck["status"];

const FILTERS: Array<{ key: string; label: string; status: Status | null }> = [
  { key: "all", label: "All", status: null },
  { key: "failing", label: "Failing", status: "fail" },
  { key: "to_do", label: "To do", status: "to_do" },
  { key: "passing", label: "Passing", status: "pass" },
  { key: "na", label: "Don't apply", status: "not_applicable" },
];

const CHECK_STATUS: Record<Status, { text: string; tone: Tone; found: string }> = {
  fail: { text: "Fails", tone: "bad", found: "What it found" },
  to_do: { text: "To do", tone: "warn", found: "What is left to do" },
  pass: { text: "Passes", tone: "ok", found: "What it found" },
  not_applicable: { text: "Doesn't apply", tone: "neu", found: "Why it doesn't apply" },
};

const ORDER: Record<Status, number> = { fail: 0, to_do: 1, pass: 2, not_applicable: 3 };

const HASH = /^#check-(.+)$/;

function blockingWords(check: PreflightCheck): string {
  if (!check.blocking) return "No. Agent work runs whether or not this passes.";
  if (check.status === "fail") return "Yes, and it is failing: agent work waits until it passes.";
  if (check.status === "not_applicable") return "It would if it applied and failed. It doesn't apply, so nothing waits on it.";
  return "It would if it failed. It doesn't, so nothing waits on it.";
}

/** Ask the deployment to run its checks again, and say so while it does: the sandbox's alone can take seconds. */
export function CheckAgain() {
  const router = useRouter();
  const [checking, start] = useTransition();
  return (
    <button type="button" className="w-btn" disabled={checking} aria-busy={checking} onClick={() => start(() => router.refresh())}>
      {checking ? "Checking…" : "Check again"}
    </button>
  );
}

export function HealthChecks({
  checks,
  owners,
  checkedAt,
  initialFilter,
}: {
  checks: PreflightCheck[];
  /** Who puts each check right, by the check's name. */
  owners: Record<string, Owner>;
  /** When this reading was taken, as the page shows it. */
  checkedAt: string;
  initialFilter?: string;
}) {
  const [filterKey, setFilterKey] = useState(FILTERS.some((f) => f.key === initialFilter) ? initialFilter! : "all");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const filter = FILTERS.find((f) => f.key === filterKey) ?? FILTERS[0];
  const n = checkCounts(checks);

  // A link to one check (#check-name, from "Waits on" and "Needs attention")
  // shows it whatever filter is on, opens it and brings it into view.
  const followHash = useCallback(() => {
    const name = HASH.exec(window.location.hash)?.[1];
    if (!name || !checks.some((k) => k.name === name)) return;
    setFilterKey("all");
    const url = new URL(window.location.href);
    if (url.searchParams.has("checks")) {
      url.searchParams.delete("checks");
      window.history.replaceState(null, "", url);
    }
    setOpen((was) => new Set(was).add(name));
    requestAnimationFrame(() => document.getElementById(`check-${name}`)?.scrollIntoView({ block: "center" }));
  }, [checks]);

  useEffect(() => {
    followHash();
    window.addEventListener("hashchange", followHash);
    return () => window.removeEventListener("hashchange", followHash);
    // Once, and on a later link: not on every new reading of the checks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (key: string) => {
    setFilterKey(key);
    // The address keeps the filter, so a reload or a shared link shows the same rows, without reading the page again.
    const url = new URL(window.location.href);
    if (key === "all") url.searchParams.delete("checks");
    else url.searchParams.set("checks", key);
    url.hash = "";
    window.history.replaceState(null, "", url);
  };

  const toggle = (name: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const shown = checks
    .filter((k) => !filter.status || k.status === filter.status)
    .sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const allOpen = shown.length > 0 && shown.every((k) => open.has(k.name));

  return (
    <Section
      title="Checks"
      aside={
        <span className="w-row" style={{ gap: 6 }}>
          {checks.length}
          <Tip>The deployment&apos;s own preflight: its config file, environment, database and the services it calls. Run when this page is read and when you choose Check again; filtering and opening a check do not run them again.</Tip>
        </span>
      }
      actions={
        <span className="w-row" style={{ gap: 12 }}>
          <button type="button" className="w-linkbtn w-small" onClick={() => setOpen(allOpen ? new Set() : new Set(shown.map((k) => k.name)))}>
            {allOpen ? "Close all" : "Open all"}
          </button>
          <div className="w-seg" role="radiogroup" aria-label="Filter the checks">
            {FILTERS.map((f) => (
              <label key={f.key}>
                <input type="radio" name="checks-filter" checked={f.key === filter.key} onChange={() => choose(f.key)} />
                {f.label} {f.status ? n[f.status] : checks.length}
              </label>
            ))}
          </div>
        </span>
      }
      id="checks"
    >
      <Table label="The deployment's checks">
        <thead>
          <tr>
            <th>Check</th>
            <th>Status</th>
            <th>
              <span className="w-row" style={{ gap: 6, flexWrap: "nowrap" }}>
                Blocks agent work <Tip>A failure here stops all agent work on the deployment.</Tip>
              </span>
            </th>
            <th style={{ width: "100%" }}>Message</th>
            <th>Fix</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td colSpan={5}>
                <Empty>No check is {filter.label.toLowerCase()}.</Empty>
              </td>
            </tr>
          ) : (
            shown.map((k) => (
              <CheckRows
                key={k.name}
                check={k}
                owner={owners[k.name] ?? "operator"}
                checkedAt={checkedAt}
                open={open.has(k.name)}
                toggle={() => toggle(k.name)}
              />
            ))
          )}
        </tbody>
      </Table>
    </Section>
  );
}

function CheckRows({
  check,
  owner,
  checkedAt,
  open,
  toggle,
}: {
  check: PreflightCheck;
  owner: Owner;
  checkedAt: string;
  open: boolean;
  toggle: () => void;
}) {
  const status = CHECK_STATUS[check.status];
  const todo = preflightTodo(check);
  const needsSomeone = check.status === "fail" || check.status === "to_do";
  const ownerPill = (
    <Pill tone={owner === "admin" ? "info" : owner === "organization" ? "warn" : "neu"} title={OWNER_WORDS[owner].title}>
      {OWNER_WORDS[owner].name}
    </Pill>
  );
  const detailId = `check-${check.name}-detail`;
  return (
    <>
      <tr
        id={`check-${check.name}`}
        className={check.status === "not_applicable" ? "w-muted-row" : undefined}
        onClick={(e) => {
          // A click anywhere on the row opens it, except one that is selecting its text.
          if (window.getSelection()?.toString()) return;
          if ((e.target as HTMLElement).closest("button, a")) return;
          toggle();
        }}
        style={{ cursor: "pointer" }}
      >
        <td style={{ whiteSpace: "nowrap" }}>
          <button
            type="button"
            className="w-linkbtn"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={toggle}
            style={{ color: "inherit", display: "inline-flex", alignItems: "center", gap: 6, textAlign: "left" }}
          >
            <span aria-hidden style={{ display: "inline-flex", transform: open ? "rotate(90deg)" : undefined, transition: "transform .12s" }}>
              <Icon name="chevron" size={12} />
            </span>
            {preflightTitle(check)}
          </button>
        </td>
        <td style={{ whiteSpace: "nowrap" }}>
          <Pill tone={status.tone}>{status.text}</Pill>
        </td>
        <td>
          {check.blocking ? (
            check.status === "fail" ? (
              <Lock>Blocking</Lock>
            ) : (
              <span className="w-faint" title="Would stop agent work if it failed">
                <Icon name="lock" size={13} />
              </span>
            )
          ) : (
            <span className="w-faint">—</span>
          )}
        </td>
        <td className="w-muted w-small">{open ? null : firstLine(check.message, 140)}</td>
        <td className="w-small" style={{ whiteSpace: "nowrap" }}>
          {needsSomeone && ownerPill}
        </td>
      </tr>
      {open && (
        <tr className="w-detail" id={detailId}>
          <td colSpan={5} style={{ padding: "14px 18px 16px 30px" }}>
            <Kv
              rows={[
                [status.found, <span key="m" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{check.message}</span>],
                needsSomeone && [
                  "Who puts it right",
                  <span key="o">
                    {ownerPill} <span className="w-muted">{OWNER_WORDS[owner].title}.</span>
                  </span>,
                ],
                todo ? ["How", todo] : null,
                ["Blocks agent work", blockingWords(check)],
                ["Checked", `${checkedAt} UTC, with every other check on this page`],
                [
                  "Its name",
                  <span key="n">
                    <code className="w-mono">{check.name}</code>{" "}
                    <span className="w-muted">in GET /setup/preflight and npm run preflight</span>
                  </span>,
                ],
              ]}
            />
          </td>
        </tr>
      )}
    </>
  );
}
