/**
 * The shapes of the identifiers a run may turn into an address where it
 * reads material that is not public (services/given-addresses.ts,
 * llm/tools/identifier-tool.ts). Each is checked so that an identifier
 * cannot be a sentence: what a run sends a resolver is then an identifier
 * and nothing it was told to add.
 */

/** The longest DOI suffix taken. Registered DOIs are far shorter; the bound is on what a suffix could be made to say. */
export const DOI_SUFFIX_MAX_CHARS = 80;

/**
 * A DOI in the shape taken here, lower case and without a resolver's
 * address in front, or null. The suffix is letters, digits and the marks
 * DOIs use, with no "//", so it cannot be read as an address.
 */
export function parseDoi(raw: string): string | null {
  const s = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
  const match = s.match(/^(10\.\d{4,9})\/([a-z0-9][a-z0-9._;()\/:-]*)$/);
  if (!match) return null;
  const suffix = match[2]!;
  if (suffix.length > DOI_SUFFIX_MAX_CHARS || suffix.includes("//")) return null;
  return s;
}

/** A PubMed id: one to nine digits. */
export function parsePmid(raw: string): string | null {
  const s = raw.trim().replace(/^pmid:\s*/i, "");
  return /^[1-9]\d{0,8}$/.test(s) ? s : null;
}

/** A PubMed Central id, as `PMC` and its digits. */
export function parsePmcid(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  const digits = s.replace(/^PMC/, "");
  return /^[1-9]\d{0,8}$/.test(digits) ? `PMC${digits}` : null;
}

/** An ISBN-10 or ISBN-13 with a correct check digit, without its hyphens, or null. */
export function parseIsbn(raw: string): string | null {
  const s = raw.trim().replace(/^isbn(-1[03])?:?\s*/i, "").replace(/[-\s]/g, "").toUpperCase();
  if (/^\d{13}$/.test(s)) {
    const sum = [...s].reduce((acc, c, i) => acc + Number(c) * (i % 2 === 0 ? 1 : 3), 0);
    return sum % 10 === 0 ? s : null;
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((acc, c, i) => acc + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    return sum % 11 === 0 ? s : null;
  }
  return null;
}

/**
 * The subject archives arXiv used in identifiers before April 2007. A fixed
 * list, so that the archive part of an old identifier cannot be other text.
 */
const ARXIV_OLD_ARCHIVES = new Set([
  "acc-phys", "adap-org", "alg-geom", "ao-sci", "astro-ph", "atom-ph", "bayes-an", "chao-dyn", "chem-ph",
  "cmp-lg", "comp-gas", "cond-mat", "cs", "dg-ga", "funct-an", "gr-qc", "hep-ex", "hep-lat", "hep-ph",
  "hep-th", "math", "math-ph", "mtrl-th", "nlin", "nucl-ex", "nucl-th", "patt-sol", "physics", "plasm-ph",
  "q-alg", "q-bio", "quant-ph", "solv-int", "supr-con",
]);

/**
 * An arXiv identifier and nothing else: `2401.01234`, `2401.01234v2`, or an
 * old one whose archive is one arXiv had (`hep-th/9901001`, `math.AG/0601001`).
 * Not an address, and not an archive name of the caller's making.
 */
export function parseArxivIdStrict(raw: string): string | null {
  const s = raw.trim().replace(/^arxiv:\s*/i, "");
  if (/^\d{4}\.\d{4,5}(v\d{1,3})?$/.test(s)) return s;
  const old = s.match(/^([a-z][a-z-]*)(\.[A-Z]{2})?\/\d{7}(v\d{1,3})?$/);
  return old && ARXIV_OLD_ARCHIVES.has(old[1]!) ? s : null;
}
