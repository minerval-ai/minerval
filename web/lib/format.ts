// Shared formatting for money and dates. Every prize and bounty amount on
// the site renders through formatOwls (docs/mathematics.md §8.1, §11.1): a
// bounty is denominated in owls, held against the posting mandate's escrow,
// and never shown as dollars. formatUsd remains for metered compute costs
// on surfaces that are not prize surfaces.

// micro-USD at cost → "2,500 owls", "250 owls", "12.5 owls" (a fraction only
// when the amount has one), "1 owl". One owl is one dollar of metered work.
export function formatOwls(micro: number): string {
  const owls = Math.round((micro / 1_000_000) * 100) / 100;
  const body = Math.abs(owls).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const sign = owls < 0 ? "−" : "";
  return `${sign}${body} ${Math.abs(owls) === 1 ? "owl" : "owls"}`;
}

// micro-USD → "$2,500", "$84", "$0.42". Whole dollars carry no cents; anything
// else shows two places. Negative amounts take a real minus sign.
export function formatUsd(micro: number): string {
  const sign = micro < 0 ? "−" : "";
  const dollars = Math.abs(micro) / 1_000_000;
  const whole = Number.isInteger(dollars);
  const body = dollars.toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${body}`;
}

// The short date the site's meta lines use ("Mar 12, 2026").
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "–"
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// The long date running prose uses ("12 March 2026").
export function fmtDateLong(iso: string | null | undefined): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "–";
  const month = d.toLocaleDateString("en-US", { month: "long" });
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

// Days from now to an ISO instant, floored at zero; null when unparseable.
export function daysUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 86_400_000));
}
