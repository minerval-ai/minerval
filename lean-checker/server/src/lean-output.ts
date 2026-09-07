/**
 * Parsing what the Lean tools print, kept pure so it is testable without
 * them.
 */
import type { Diagnostic } from "./runner.js";

/**
 * `lean --json` prints one JSON object per message:
 * `{"severity":"error","pos":{"line":3,"column":2},"endPos":{...},
 *   "fileName":"...","data":"unknown identifier 'foo'", ...}`.
 * Older or non-JSON output uses `file:line:col: severity: message` with
 * continuation lines; both are accepted. Positions are shifted by the
 * checker header's line count so they refer to the file the client sent;
 * a diagnostic inside the header keeps line 0 and is flagged.
 */
export function parseLeanMessages(
  stdout: string,
  stderr: string,
  file: Diagnostic["file"],
  headerLines: number
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const shift = (line: number): { line: number; in_header: boolean } =>
    line <= headerLines ? { line: 0, in_header: true } : { line: line - headerLines, in_header: false };

  const text = `${stdout}\n${stderr}`;
  let current: Diagnostic | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("{")) {
      try {
        const j = JSON.parse(line) as {
          severity?: string;
          pos?: { line?: number; column?: number };
          endPos?: { line?: number; column?: number } | null;
          data?: string;
        };
        const severity = normalizeSeverity(j.severity);
        if (!severity) continue;
        const pos = shift(j.pos?.line ?? 1);
        const d: Diagnostic = {
          severity,
          message: String(j.data ?? ""),
          line: pos.line,
          column: j.pos?.column ?? 0,
          file,
        };
        if (pos.in_header) d.in_header = true;
        if (j.endPos && typeof j.endPos.line === "number") {
          d.end_line = shift(j.endPos.line).line;
          d.end_column = j.endPos.column ?? 0;
        }
        out.push(d);
        current = null;
        continue;
      } catch {
        // Not a message; fall through to the text form.
      }
    }
    const m = /^(.*?):(\d+):(\d+): (error|warning|info(?:rmation)?): ?(.*)$/.exec(line);
    if (m) {
      const severity = normalizeSeverity(m[4]) ?? "info";
      const pos = shift(Number(m[2]));
      current = { severity, message: m[5] ?? "", line: pos.line, column: Number(m[3]), file };
      if (pos.in_header) current.in_header = true;
      out.push(current);
    } else if (current && line.length > 0) {
      current.message += `\n${line}`;
    } else {
      current = null;
    }
  }
  return out;
}

function normalizeSeverity(s: string | undefined): Diagnostic["severity"] | null {
  if (s === "error") return "error";
  if (s === "warning") return "warning";
  if (s === "info" || s === "information") return "info";
  return null;
}

/**
 * `minerval_check` prints one JSON object as its last line; anything before
 * it (a stray print from an initialiser, say) is ignored.
 */
export function parseCheckerJson<T extends { ok: boolean }>(stdout: string): T | { ok: false; error: string } {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]!) as T;
      if (typeof j === "object" && j !== null && "ok" in j) return j;
    } catch {
      // keep looking
    }
  }
  return { ok: false, error: "minerval_check printed no JSON result" };
}

/** The four numbers `/usr/bin/time -f "%e %U %S %M"` writes. */
export function parseTimeOutput(text: string): { cpu_ms: number | null; max_rss_mb: number | null } {
  const lines = text.trim().split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return { cpu_ms: null, max_rss_mb: null };
  const parts = last.trim().split(/\s+/).map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return { cpu_ms: null, max_rss_mb: null };
  const [, user, sys, rssKb] = parts as [number, number, number, number];
  return { cpu_ms: Math.round((user + sys) * 1000), max_rss_mb: Math.round(rssKb / 1024) };
}
