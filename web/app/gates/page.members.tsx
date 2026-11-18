import type { Metadata } from "next";
import Link from "next/link";
import { viewer } from "@/components/admin/access";
import {
  Boundary,
  ButtonLink,
  Empty,
  Lbl,
  Pill,
  Section,
  Seg,
  Table,
  Tip,
  WorkHead,
  WorkPage,
  owls,
  plural,
  shortDay,
} from "@/components/work/ui";
import { hoursShort, loadBoundaries, oldestHours, waitingGroups, waitingOn, type BoundaryRow } from "./boundaries";
import "./gates.css";

export const metadata: Metadata = { title: "Boundaries · Minerval" };
export const dynamic = "force-dynamic";

// The boundaries the person can see (docs/the-gate.md). Anything that goes
// from a label to people who do not read it passes a boundary's gate, and
// the Redactor works there under the boundary's policy. Every member is
// shown, in counts, how much waits at the boundaries toward a label they
// read; a person with a say over a gate is shown its settings as well; a
// reader of either side reads its policy. Each is one row, opened on its own
// page (gates/[id]).

const FILTERS = [
  { key: "all", label: "All" },
  { key: "inside", label: "Inside" },
  { key: "outside", label: "To outside" },
] as const;

export default async function BoundariesPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const who = await viewer();
  if (!who) return null;
  const { show } = await searchParams;
  const { rows, backlog } = await loadBoundaries(who.externalId);
  const filter = show === "inside" || show === "outside" ? show : "all";
  const shown = rows.filter((r) => filter === "all" || (filter === "outside") === r.outside);
  const waiting = rows.reduce((n, r) => n + (r.backlog?.items_waiting ?? 0), 0);
  const forPeople = rows.reduce((n, r) => n + waitingOn(r.backlog?.waiting ?? [], "people"), 0);
  const asked = backlog?.asked_from_here ?? [];
  const insideCount = rows.filter((r) => !r.outside).length;

  return (
    <WorkPage wide>
      <WorkHead
        title="Boundaries"
        sub={
          <>
            {plural(rows.length, "boundary", "boundaries")} · {plural(waiting, "item")} waiting{" "}
            <Tip>
              A boundary is a label and where its material goes: another label, or outside. Each has one gate and one redaction policy. A
              boundary appears the first time something is sent across it.
            </Tip>
          </>
        }
        actions={forPeople > 0 && <ButtonLink href="/gate" primary>{`Review ${forPeople}`}</ButtonLink>}
      />

      {rows.length === 0 ? (
        <Empty>No boundary leads to a label you read, and you have a say over none.</Empty>
      ) : (
        <>
          {insideCount > 0 && insideCount < rows.length && (
            <div className="w-toolbar">
              <Seg
                current={filter}
                options={FILTERS.map((f) => ({
                  key: f.key,
                  href: f.key === "all" ? "/gates" : `/gates?show=${f.key}`,
                  label: `${f.label} ${f.key === "all" ? rows.length : f.key === "inside" ? insideCount : rows.length - insideCount}`,
                }))}
              />
            </div>
          )}
          <Table label="Boundaries">
            <thead>
              <tr>
                <th>Boundary</th>
                <th>
                  Flow{" "}
                  <Tip>
                    Asked for: only what someone asked for, or set to flow on Releases, goes to the gate. Everything: every finished page
                    and every mandate&apos;s terms go, each paid for by the work that produced it.
                  </Tip>
                </th>
                <th>Waiting {backlog?.note && <Tip>{backlog.note}</Tip>}</th>
                <th className="w-num">Oldest</th>
                <th>Policy</th>
                <th>
                  Rules{" "}
                  <Tip>
                    Rules change how the gate treats a kind of thing, for a party or a scope. Without rules every kind is at its starting
                    position.
                  </Tip>
                </th>
                <th>
                  Sending{" "}
                  <Tip>
                    Outside only. Automatic: what is released is sent to the public graph as it is released. By a person: someone sends each
                    package.
                  </Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <BoundaryLine key={r.id} row={r} />
              ))}
            </tbody>
          </Table>
        </>
      )}

      {asked.length > 0 && (
        <Section
          title="Asked from here"
          aside={
            <>
              <Tip>
                Requests made at a label you read of a label above it, which you may not read. Each is paid for when it is asked; what comes
                back passes that boundary&apos;s gate.
              </Tip>{" "}
              {plural(asked.length, "label")} asked ·{" "}
              {plural(
                asked.reduce((n, a) => n + a.requests, 0),
                "request"
              )}
            </>
          }
        >
          <Table label="Asked from here">
            <thead>
              <tr>
                <th>Asked of</th>
                <th className="w-num">Requests</th>
                <th className="w-num">Owls behind them</th>
                <th className="w-num">Taken up</th>
                <th className="w-num">Answered</th>
                <th className="w-num">At gate</th>
                <th className="w-num">Nothing back</th>
              </tr>
            </thead>
            <tbody>
              {asked.map((a, i) => (
                <tr key={i}>
                  <td>
                    <span className="w-row" style={{ gap: 6 }}>
                      <Lbl name={a.asked_of} />
                      <span className="w-faint w-small">from</span>
                      <Lbl name={a.asked_at} />
                    </span>
                  </td>
                  <td className="w-num">{a.requests}</td>
                  <td className="w-num">{owls(a.owls_put_behind_them)}</td>
                  <td className="w-num">{a.told_they_were_taken_up}</td>
                  <td className="w-num">{a.answer_through_the_gate}</td>
                  <td className="w-num">{a.answer_waiting_at_the_gate}</td>
                  <td className="w-num">{a.nothing_back_yet}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Section>
      )}
    </WorkPage>
  );
}

function BoundaryLine({ row }: { row: BoundaryRow }) {
  const href = `/gates/${row.id}`;
  const lines = row.backlog?.waiting ?? [];
  const gate = row.gate;
  return (
    <tr>
      <td>
        <Link href={href} className="w-gates-name" aria-label={`Open ${row.from ?? "a label you do not read"} to ${row.to}`}>
          <Boundary from={row.from} to={row.to} />
        </Link>
      </td>
      <td>{gate ? gate.flow === "everything" ? "Everything" : "Asked for" : <span className="w-faint">—</span>}</td>
      <td>
        {row.backlog ? (
          <span className="w-row" style={{ gap: 6 }}>
            <b className="w-gates-total">{row.backlog.items_waiting}</b>
            {waitingGroups(lines).map((g) => (
              <Pill key={g.key} tone={g.tone}>{`${g.label} ${g.items}`}</Pill>
            ))}
          </span>
        ) : (
          <span className="w-faint">—</span>
        )}
      </td>
      <td className="w-num">{row.backlog ? hoursShort(oldestHours(lines)) : <span className="w-faint">—</span>}</td>
      <td>
        {row.policy ? (
          <>
            <Link href={`${href}?tab=policy`}>v{row.policy.version}</Link>{" "}
            <span className="w-faint w-small">· {row.policy.starting_text ? "starting text" : shortDay(row.policy.saved_at)}</span>
          </>
        ) : (
          <span className="w-faint">—</span>
        )}
      </td>
      <td>
        {!gate ? (
          <span className="w-faint">—</span>
        ) : gate.settings.length > 0 ? (
          <Link href={`${href}?tab=rules`}>{gate.settings.length}</Link>
        ) : (
          <span className="w-muted">Starting positions</span>
        )}
      </td>
      <td>
        {row.outside && gate && gate.send_as_released !== undefined ? (
          gate.send_as_released ? (
            <Pill tone="ok">Automatic</Pill>
          ) : (
            <Pill>By a person</Pill>
          )
        ) : (
          <span className="w-faint">—</span>
        )}
      </td>
    </tr>
  );
}
