/**
 * A line diff of two texts (longest common subsequence), for showing what a
 * new version of a prompt changed. Prompts run to a few thousand lines, so
 * the quadratic table is fine; past that, the caller gets null and shows the
 * texts without a diff.
 */
export type DiffLine = { op: "same" | "add" | "del"; text: string };

const MAX_CELLS = 25_000_000;

export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > MAX_CELLS) return null;
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..], stored flat.
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * (m + 1) + j + 1]! + 1
          : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!) {
      out.push({ op: "del", text: a[i++]! });
    } else {
      out.push({ op: "add", text: b[j++]! });
    }
  }
  while (i < n) out.push({ op: "del", text: a[i++]! });
  while (j < m) out.push({ op: "add", text: b[j++]! });
  return out;
}
