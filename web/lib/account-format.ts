// How the account pages write amounts and dates.

/** Dollars from micro-USD: two places from a dollar up, four below. */
export function usd(micro: number): string {
  const dollars = micro / 1_000_000;
  return dollars >= 1 || dollars === 0
    ? `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${dollars.toFixed(4)}`;
}

/** Owls, trimmed: 5 → "5", 0.75 → "0.75", -0.1 → "−0.1", 1717.1 → "1,717.1". */
export function owls(n: number): string {
  const s = Number(n.toFixed(3)).toLocaleString("en-US", { maximumFractionDigits: 3 });
  return s.startsWith("-") ? s.replace("-", "−") : s;
}

/**
 * An amount of owls in two parts, for a headline figure: the whole owls and
 * the fraction. Set at one size, "1,717.114" reads at a glance as a number in
 * the millions (the comma and the point look alike); the page sets the
 * fraction smaller and quieter so the whole owls are what is read.
 */
export function owlParts(n: number): { whole: string; fraction: string } {
  const s = owls(n);
  const point = s.indexOf(".");
  return point === -1
    ? { whole: s, fraction: "" }
    : { whole: s.slice(0, point), fraction: s.slice(point) };
}

/** A change to a balance: "+1.443", "−0.557", "0". */
export function signedOwls(n: number): string {
  const s = owls(n);
  if (s === "0" || s === "−0") return "0";
  return n > 0 ? `+${s}` : s;
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  return n.toLocaleString("en-US");
}

export function dateish(iso: string | null, whenAbsent = ""): string {
  if (!iso) return whenAbsent;
  return iso.slice(0, 10);
}

/** "claim_proposal" → "claim proposal". */
export function words(s: string): string {
  return s.replace(/_/g, " ");
}

/** A claim's wording at list length, cut at a word. */
export function clip(text: string, max = 110): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > max * 0.6 ? space : max).replace(/[\s,;:.]+$/, "")}…`;
}
