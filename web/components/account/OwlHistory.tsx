import type { ReactNode } from "react";
import type { OwlLedgerEntry } from "../../lib/account-api";
import { clip, dateish, owls, signedOwls, words } from "../../lib/account-format";
import {
  foldDay,
  groupOwlHistory,
  isFold,
  type HistoryLine,
} from "../../lib/owl-history";

// The owl history on the account page. Two readings of one ledger: by piece
// of work (lib/owl-history.ts: each hold with what came back from it, as one
// line and its cost), and entry by entry as recorded. The second is always a
// click away, because the first is a reading and the ledger is the record.

/** What a job is called and where it is shown. */
export type JobName = { name: string; href: string; grant: boolean };

// A priced operation as a heading, and as a counted plural.
const OPS: Record<string, [one: string, many: string]> = {
  assessment: ["Claim assessment", "claim assessments"],
  claim_proposal: ["Claim proposal", "claim proposals"],
  source_ingest: ["Source submission", "source submissions"],
  extension_analysis: ["Page analysis", "page analyses"],
  extension_chat: ["Extension chat", "extension chats"],
  text_analysis: ["Text analysis", "text analyses"],
  assistant: ["Assistant", "Assistant charges"],
};

function opName(op: string | null): [string, string] {
  if (!op) return ["Work", "pieces of work"];
  const known = OPS[op];
  if (known) return known;
  const w = words(op);
  return [w.charAt(0).toUpperCase() + w.slice(1), `${w} charges`];
}

const REASONS: Record<string, string> = {
  purchase: "Owls purchased",
  signup_grant: "Signup grant",
  monthly_grant: "Monthly grant",
  contribution_award: "Earned by contribution",
  prize_award: "Prize, one owl per dollar",
  owl_prize: "Prize, one owl per dollar",
  refund: "Refunded",
  escrow_hold: "Escrowed for funded work",
  claim_contribution: "Put toward a claim’s assessment",
  request_contribution: "Put toward the work on a request",
  escrow_refund: "Unspent escrow returned",
  admin_adjust: "Adjustment",
};

function reasonName(reason: string): string {
  const w = words(reason);
  return REASONS[reason] ?? w.charAt(0).toUpperCase() + w.slice(1);
}

type Names = {
  owlCost: number;
  claimTexts: Map<string, string>;
  jobNames: Map<string, JobName>;
};

function linked(line: HistoryLine, text: ReactNode): ReactNode {
  if (line.claimId) return <a href={`/claims/${line.claimId}`}>{text}</a>;
  if (line.contributionId) return <a href={`/contributions/${line.contributionId}`}>{text}</a>;
  return text;
}

/** A line's heading and the small print beside it. */
function describe(line: HistoryLine, names: Names): { what: ReactNode; detail: string | null } {
  const o = (micro: number) => owls(micro / names.owlCost);
  const claim = line.claimId ? names.claimTexts.get(line.claimId) : undefined;
  const job = line.jobId ? names.jobNames.get(line.jobId) : undefined;
  const [one, many] = opName(line.op);

  if (line.reason === "charge") {
    const returned =
      line.returnedMicroUsd > 0
        ? `held ${o(line.heldMicroUsd)} · ${o(line.returnedMicroUsd)} returned`
        : null;
    if (line.count > 1) {
      return {
        what: line.op === "assistant" ? `Assistant, ${line.count} charges` : `${line.count} ${many}`,
        detail: returned ?? (line.op === "assistant" ? "charged as it worked" : null),
      };
    }
    return {
      what: linked(line, claim ? `${one}: ${clip(claim)}` : one),
      detail: returned ?? (line.op === "assistant" ? "charged as it worked" : null),
    };
  }

  if (line.reason === "meter_settlement") {
    return {
      what: linked(line, claim ? `${one}: ${clip(claim)}` : one),
      detail: "unused part returned; its hold is earlier than this list",
    };
  }

  if (line.reason === "escrow_hold" || line.reason === "escrow_refund") {
    const hold = line.reason === "escrow_hold";
    const label = hold ? (job?.grant ? "Grant funded" : "Funded") : "Unspent escrow returned";
    return {
      what: job ? (
        <>
          {label}: <a href={job.href}>{clip(job.name)}</a>
        </>
      ) : (
        reasonName(line.reason)
      ),
      detail: hold ? (line.count > 1 ? `into escrow, in ${line.count} parts` : "into escrow") : null,
    };
  }

  const reason = reasonName(line.reason);
  const what = line.op ? `${reason}: ${one.toLowerCase()}` : reason;
  return { what: linked(line, claim ? `${what}: ${clip(claim)}` : what), detail: null };
}

function Line({ line, names }: { line: HistoryLine; names: Names }) {
  const { what, detail } = describe(line, names);
  return (
    <div className="acct-line">
      <div>
        {what}
        {detail && <span className="acct-detail">{detail}</span>}
      </div>
      <div className="acct-amount">{signedOwls(line.netMicroUsd / names.owlCost)}</div>
    </div>
  );
}

/** The ledger's own wording for one entry, as the page has always had it. */
function entryLabel(e: OwlLedgerEntry): string {
  const op = e.op ? opName(e.op)[0].toLowerCase() : null;
  if (e.reason === "charge") {
    if (e.op === "assistant") return "charged for the Assistant";
    return op ? `held for ${op}` : "held";
  }
  if (e.reason === "meter_settlement") {
    return op ? `unused part returned from ${op}` : "unused part returned";
  }
  const reason = reasonName(e.reason).toLowerCase();
  return op ? `${reason} · ${op}` : reason;
}

export function OwlHistory({
  entries,
  view,
  limit,
  ...names
}: Names & {
  entries: OwlLedgerEntry[];
  view: "work" | "entries";
  /** How many entries were asked for; reaching it means there are older ones. */
  limit: number;
}) {
  const days = view === "work" ? groupOwlHistory(entries) : [];
  const o = (micro: number) => owls(micro / names.owlCost);

  return (
    <>
      <div className="acct-head">
        <h2>Owl history</h2>
        <nav className="acct-switch" aria-label="How to list the history">
          <a href="/account#owls" aria-current={view === "work" ? "true" : undefined}>
            By piece of work
          </a>
          <a href="/account?history=entries#owls" aria-current={view === "entries" ? "true" : undefined}>
            Every entry
          </a>
        </nav>
      </div>

      {view === "work" ? (
        <>
          <p className="acct-note acct-lede">
            Each line is one piece of work and what it cost in the end: the ceiling that was
            held, less the unused part that came back.
          </p>
          {days.map((day) => (
            <div key={day.date}>
              <div className="acct-day sc">{day.date}</div>
              {foldDay(day.lines).map((item) =>
                isFold(item) ? (
                  <details className="acct-fold" key={`fold-${item.op}`}>
                    <summary className="acct-line">
                      <div>
                        {item.lines.length} {opName(item.op)[1]}
                        <span className="acct-detail">
                          held {o(item.heldMicroUsd)}
                          {item.returnedMicroUsd > 0 && ` · ${o(item.returnedMicroUsd)} returned`}
                        </span>
                      </div>
                      <div className="acct-amount">
                        {signedOwls(item.netMicroUsd / names.owlCost)}
                      </div>
                    </summary>
                    {item.lines.map((line) => (
                      <Line key={line.key} line={line} names={names} />
                    ))}
                  </details>
                ) : (
                  <Line key={item.key} line={item} names={names} />
                )
              )}
            </div>
          ))}
        </>
      ) : (
        <>
          <p className="acct-note acct-lede">
            The ledger as recorded: every hold, return and escrow, newest first.
          </p>
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>date</th>
                  <th>what</th>
                  <th className="acct-num">owls</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="acct-num-left">{dateish(e.created_at)}</td>
                    <td>
                      {e.claim_id ? (
                        <a href={`/claims/${e.claim_id}`}>{entryLabel(e)}</a>
                      ) : e.contribution_id ? (
                        <a href={`/contributions/${e.contribution_id}`}>{entryLabel(e)}</a>
                      ) : (
                        entryLabel(e)
                      )}
                    </td>
                    <td className="acct-num">{signedOwls(e.amount_micro_usd / names.owlCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {entries.length >= limit && (
        <p className="acct-note">
          These are the latest {limit} entries. Older ones are on the ledger, which the API
          returns in full (<code>GET /billing/ledger</code>).
        </p>
      )}
    </>
  );
}
