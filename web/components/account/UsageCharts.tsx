import type { UsageSummary } from "../../lib/account-api";
import { tokens, usd } from "../../lib/account-format";

// The account page's usage, drawn: cost by day on a true calendar axis (a day
// with no metered work is a gap, not a missing row), and cost by agent as
// ranked bars. Both are one series in one ink, so nothing is told by colour;
// each bar names its figures on hover, and the per-day table the page used to
// show is kept beneath for anyone who wants the numbers themselves.

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The smallest 1, 2 or 5 times a power of ten that is at least `n`. */
function niceCeiling(n: number): number {
  if (n <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 5, 10]) if (m * pow >= n) return m * pow;
  return 10 * pow;
}

function axisDollars(micro: number): string {
  const d = micro / 1_000_000;
  return d >= 1 ? `$${d.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : `$${d.toPrecision(1)}`;
}

/** How many of the top agents get a bar; the rest are summed in a sentence. */
const AGENT_BARS = 9;

export function UsageCharts({ usage, today }: { usage: UsageSummary; today: Date }) {
  // The window is the trailing `days` × 24h, so it touches days + 1 dates.
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const byDate = new Map(usage.by_day.map((d) => [d.date, d]));
  const days = Array.from({ length: usage.days + 1 }, (_, i) => {
    const at = new Date(end - (usage.days - i) * DAY_MS);
    const date = at.toISOString().slice(0, 10);
    return { date, at, bucket: byDate.get(date) ?? null };
  });
  const peak = usage.by_day.reduce((m, d) => Math.max(m, d.cost_micro_usd), 0);
  const top = niceCeiling(peak / 1_000_000) * 1_000_000;
  // Gridlines at a quarter, a half and three quarters of the scale's top.
  const grid = [0.25, 0.5, 0.75].map((f) => ({ pct: f * 100, label: axisDollars(f * top) }));
  const peakDay = usage.by_day.find((d) => d.cost_micro_usd === peak) ?? null;
  const activeDays = usage.by_day.length;

  const agents = usage.by_agent.slice(0, AGENT_BARS);
  const rest = usage.by_agent.slice(AGENT_BARS);
  const agentTop = agents[0]?.cost_micro_usd ?? 0;

  return (
    <div className="acct-cols">
      <div className="acct-main">
        <div className="acct-sub">
          <h3>Cost by day</h3>
          <span className="acct-note">
            {usd(usage.totals.cost_micro_usd)} over {activeDays} active day{activeDays === 1 ? "" : "s"}
          </span>
        </div>
        <div className="acct-chart" role="img" aria-label="Metered cost for each day; the figures are in the table below.">
          {grid.map((g) => (
            <div key={g.pct} className="acct-grid" style={{ bottom: `${g.pct}%` }}>
              <span>{g.label}</span>
            </div>
          ))}
          <div className="acct-bars">
            {days.map((d, i) => {
              const cost = d.bucket?.cost_micro_usd ?? 0;
              const pct = top > 0 ? (cost / top) * 100 : 0;
              const isPeak = peakDay !== null && d.date === peakDay.date && cost > 0;
              const nearEnd = i > days.length - 4;
              return (
                <div
                  key={d.date}
                  className="acct-barcol"
                  title={
                    d.bucket
                      ? `${d.date} · ${usd(cost)} · ${d.bucket.calls.toLocaleString("en-US")} calls · ` +
                        `${tokens(d.bucket.input_tokens)} in / ${tokens(d.bucket.output_tokens)} out`
                      : `${d.date} · no metered work`
                  }
                >
                  {isPeak && (
                    <span
                      className="acct-barlabel"
                      style={{
                        bottom: `calc(${pct}% + 0.2rem)`,
                        ...(nearEnd ? { right: 0 } : { left: "50%", transform: "translateX(-50%)" }),
                      }}
                    >
                      {usd(cost)}
                    </span>
                  )}
                  {d.bucket && <div className="acct-bar" style={{ height: `${pct}%` }} />}
                </div>
              );
            })}
          </div>
        </div>
        <div className="acct-ticks" aria-hidden>
          {days.map((d, i) => (
            // A date every seventh day, counted back from today, and never
            // so near the right edge that it would run off it.
            <div key={d.date}>
              {(days.length - 1 - i) % 7 === 1
                ? `${MONTHS[d.at.getUTCMonth()]} ${d.at.getUTCDate()}`
                : ""}
            </div>
          ))}
        </div>
        <details className="acct-asTable">
          <summary>The same days as a table</summary>
          <div className="acct-scroll">
            <table className="account-table acct-table">
              <thead>
                <tr>
                  <th>day</th>
                  <th className="acct-num">calls</th>
                  <th className="acct-num">input</th>
                  <th className="acct-num">output</th>
                  <th className="acct-num">cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.by_day.map((d) => (
                  <tr key={d.date}>
                    <td className="acct-num-left">{d.date}</td>
                    <td className="acct-num">{d.calls.toLocaleString("en-US")}</td>
                    <td className="acct-num">{tokens(d.input_tokens)}</td>
                    <td className="acct-num">{tokens(d.output_tokens)}</td>
                    <td className="acct-num">{usd(d.cost_micro_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      <div className="acct-side acct-side-wide">
        <div className="acct-sub">
          <h3>Cost by agent</h3>
          <span className="acct-note">calls</span>
        </div>
        <div className="acct-agents">
          {agents.map((a) => (
            <div
              key={a.agent}
              className="acct-agent"
              title={`${a.agent} · ${usd(a.cost_micro_usd)} · ${a.calls.toLocaleString("en-US")} calls · ${tokens(a.input_tokens)} in / ${tokens(a.output_tokens)} out`}
            >
              <div className="acct-agent-name">{a.agent}</div>
              <div>
                <div
                  className="acct-agent-bar"
                  style={{ width: `${agentTop > 0 ? (a.cost_micro_usd / agentTop) * 100 : 0}%` }}
                />
              </div>
              <div className="acct-num">{usd(a.cost_micro_usd)}</div>
              <div className="acct-num acct-quiet">{a.calls.toLocaleString("en-US")}</div>
            </div>
          ))}
        </div>
        {rest.length > 0 && (
          <p className="acct-note">
            {rest.length} more agent{rest.length === 1 ? "" : "s"} cost{" "}
            {usd(rest.reduce((n, a) => n + a.cost_micro_usd, 0))} between them:{" "}
            {rest.map((a) => a.agent).join(", ")}.
          </p>
        )}
      </div>
    </div>
  );
}
