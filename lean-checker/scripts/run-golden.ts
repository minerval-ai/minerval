/**
 * Run the golden checker fixture (docs/mathematics.md section 12.2) against
 * a live checker and exit non-zero on any mismatch.
 *
 *   cd lean-checker/server && npx tsx ../scripts/run-golden.ts \
 *     --url http://localhost:8080 --token "$LEAN_CHECKER_TOKEN" [--only name,name] [--poll-s 5] [--timeout-s 900]
 *
 * Grading is exact match on the verdict and the deciding gate for `check`
 * cases, and on `elaborates`, `witness_present`, `definitions`, and the
 * presence of named constants and warnings for `elaborate` cases. The
 * checker must be a cold-lane instance or one with
 * LEAN_CHECKER_REFUSE_PRIZE_ON_WARM=0, since the fixture submits in `prize`
 * mode. Node's built-in fetch is the only dependency.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

interface CheckCase {
  name: string;
  kind: "check";
  mode: "prize" | "attempt" | "steward";
  check_kind: "proof" | "disproof";
  replay: "module" | "fresh";
  statement_source: string;
  submission_source: string;
  expected: { verdict: string; failing_gate: string | null; static_token?: string };
  note: string;
}

interface ElaborateCase {
  name: string;
  kind: "elaborate";
  statement_source: string;
  expected: {
    elaborates: boolean;
    convention_ok?: boolean;
    witness_present?: boolean;
    definitions?: string[];
    warnings_include?: string;
    constants_include?: string[];
  };
  note: string;
}

type Case = CheckCase | ElaborateCase;

interface Fixture {
  version: number;
  cases: Case[];
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const url = (arg("url", process.env.LEAN_CHECKER_URL) ?? "").replace(/\/$/, "");
const token = arg("token", process.env.LEAN_CHECKER_TOKEN) ?? "";
const only = arg("only")?.split(",").filter(Boolean);
const pollS = Number(arg("poll-s", "5"));
const timeoutS = Number(arg("timeout-s", "900"));

if (!url || !token) {
  console.error("usage: run-golden.ts --url <checker> --token <bearer> [--only a,b] [--poll-s 5] [--timeout-s 900]");
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "..", "golden", "lean-checks.json"), "utf8")) as Fixture;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}

async function runCheck(c: CheckCase): Promise<Result> {
  const submitted = await call("POST", "/v1/check", {
    mode: c.mode,
    kind: c.check_kind,
    replay: c.replay,
    statement_source: c.statement_source,
    submission_source: c.submission_source,
    force: true,
  });
  if (submitted.status !== 200 && submitted.status !== 202) {
    return { name: c.name, pass: false, detail: `POST /v1/check answered ${submitted.status}: ${JSON.stringify(submitted.json)}` };
  }
  let record = submitted.json;
  const deadline = Date.now() + timeoutS * 1000;
  while (record.status !== "done") {
    if (Date.now() > deadline) return { name: c.name, pass: false, detail: `still ${String(record.status)} after ${timeoutS} s` };
    await new Promise((r) => setTimeout(r, pollS * 1000));
    record = (await call("GET", `/v1/checks/${String(record.check_id)}`)).json;
  }
  const verdict = String(record.verdict);
  const gate = (record.failed_gate ?? null) as string | null;
  const pass = verdict === c.expected.verdict && gate === c.expected.failing_gate;
  const checks = record.checks as Record<string, { status: string; detail: string }> | undefined;
  const summary = checks ? Object.entries(checks).map(([g, r]) => `${g}=${r.status}`).join(" ") : "";
  const reason = record.error_reason ? ` error_reason=${String(record.error_reason)}` : "";
  return {
    name: c.name,
    pass,
    detail: `${verdict}/${gate ?? "-"} (expected ${c.expected.verdict}/${c.expected.failing_gate ?? "-"}) ${summary}${reason}`,
  };
}

async function runElaborate(c: ElaborateCase): Promise<Result> {
  const res = await call("POST", "/v1/elaborate", { statement_source: c.statement_source });
  if (res.status !== 200) return { name: c.name, pass: false, detail: `POST /v1/elaborate answered ${res.status}: ${JSON.stringify(res.json)}` };
  const body = res.json;
  const problems: string[] = [];
  if (Boolean(body.ok) !== c.expected.elaborates) problems.push(`ok=${String(body.ok)} expected ${c.expected.elaborates}: ${JSON.stringify(body.errors)}`);
  if (c.expected.witness_present !== undefined && body.witness_present !== c.expected.witness_present) {
    problems.push(`witness_present=${String(body.witness_present)} expected ${c.expected.witness_present}`);
  }
  if (c.expected.definitions !== undefined && c.expected.elaborates) {
    const defs = (body.definitions as string[] | undefined) ?? [];
    if (JSON.stringify([...defs].sort()) !== JSON.stringify([...c.expected.definitions].sort())) {
      problems.push(`definitions=${JSON.stringify(defs)} expected ${JSON.stringify(c.expected.definitions)}`);
    }
  }
  if (c.expected.warnings_include) {
    const warnings = (body.warnings as string[] | undefined) ?? [];
    if (!warnings.some((w) => w.includes(c.expected.warnings_include!))) problems.push(`no warning containing "${c.expected.warnings_include}" in ${JSON.stringify(warnings)}`);
  }
  if (c.expected.constants_include) {
    const constants = (body.constants as string[] | undefined) ?? [];
    for (const k of c.expected.constants_include) if (!constants.includes(k)) problems.push(`constants lack ${k}`);
  }
  return { name: c.name, pass: problems.length === 0, detail: problems.length ? problems.join("; ") : `ok pp_type=${String(body.pp_type ?? "")}` };
}

async function main(): Promise<void> {
  const health = await fetch(`${url}/health`).then((r) => r.json() as Promise<Record<string, unknown>>);
  const pin = health.pin as Record<string, unknown> | undefined;
  console.log(`checker ${url} lane=${String(health.lane)} pin=${String(pin?.pin_id)} image=${String(pin?.image_digest)}`);
  const cases = fixture.cases.filter((c) => !only || only.includes(c.name));
  const results: Result[] = [];
  for (const c of cases) {
    const started = Date.now();
    const r = c.kind === "check" ? await runCheck(c) : await runElaborate(c);
    results.push(r);
    console.log(`${r.pass ? "PASS" : "FAIL"} ${c.name.padEnd(32)} ${r.detail} [${Math.round((Date.now() - started) / 1000)} s]`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((f) => f.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
