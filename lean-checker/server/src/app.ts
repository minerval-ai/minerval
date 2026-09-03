/**
 * The HTTP surface of design sections 5.3 and 6.1.
 *
 *   GET  /health            open; the pin, the lane, the queue depth
 *   GET  /v1/pins           the live pin and its image digest
 *   POST /v1/elaborate      a statement file in; errors with positions, or
 *                           {pp_type, expr_hash, source_hash, constants,
 *                            definitions_axioms, witness_present, warnings}
 *   POST /v1/scratch        semi-trusted iteration: diagnostics, never a verdict
 *   POST /v1/search         a proxy to the configured Loogle
 *   POST /v1/check          static policy, then a queued job: 202 {check_id};
 *                           a static rejection is a finished record: 200
 *   GET  /v1/checks/:id     the record
 *
 * Bearer-token auth on everything but /health. No route ever calls out to
 * the API: results are polled.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { clampLimits, type ServerConfig } from "./config.js";
import { exprHash, sourceHash, submissionSha256 } from "./hashes.js";
import type { PinInfo } from "./pins.js";
import { CapExceededError, CheckQueue, newCheckId, type CheckMode, type CheckRecord } from "./queue.js";
import type { Diagnostic, LeanRunner, Limits } from "./runner.js";
import { searchLoogle, type FetchLike } from "./search.js";
import { assembleScratch, assembleSubmission, parseStatement, targetName } from "./statement.js";
import { scanStaticPolicy } from "./static-policy.js";
import { capList, DIAGNOSTICS_CAP } from "./truncate.js";

export interface AppOptions {
  config: ServerConfig;
  runner: LeanRunner;
  pins: PinInfo;
  queue?: CheckQueue;
  fetchImpl?: FetchLike;
  logger?: boolean;
  /** Cold lane: called once the configured number of records were fetched. */
  onColdComplete?: () => void;
  now?: () => number;
}

export interface ElaborateResponse {
  ok: boolean;
  namespace: string | null;
  errors: Array<{ message: string; line: number; column: number }>;
  diagnostics: Diagnostic[];
  truncated: boolean;
  pp_type?: string;
  expr_hash?: string;
  source_hash: string;
  constants?: string[];
  definitions?: string[];
  definitions_axioms?: Record<string, string[]>;
  statement_axioms?: string[];
  witness_present: boolean;
  warnings: string[];
  resource?: unknown;
  pin: PinInfo;
  timed_out?: boolean;
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length).trim();
  // Compare digests so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const LIMITS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    timeout_s: { type: "number" },
    memory_mb: { type: "number" },
    max_heartbeats: { type: "number" },
  },
} as const;

export function buildApp(opts: AppOptions): FastifyInstance {
  const { config, runner, pins } = opts;
  if (!config.token) {
    throw new Error("LEAN_CHECKER_TOKEN is not set; the checker refuses to start without a bearer token");
  }
  const now = opts.now ?? Date.now;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: config.bodyLimitBytes });
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const queue =
    opts.queue ??
    new CheckQueue({
      runner,
      lane: config.lane,
      pins,
      concurrency: config.maxConcurrentChecks,
      dailyCpuHours: config.dailyCpuHours,
      recordTtlMs: config.recordTtlHours * 3_600_000,
      now,
      log: (message, fields) => app.log.warn({ ...fields }, message),
    });
  const startedAt = now();

  // Warm-lane concurrency for elaborate/scratch: a small semaphore.
  let elaborating = 0;
  const waiters: Array<() => void> = [];
  const acquire = async () => {
    if (elaborating < config.maxConcurrentElaborations) {
      elaborating++;
      return;
    }
    await new Promise<void>((r) => waiters.push(r));
    elaborating++;
  };
  const release = () => {
    elaborating--;
    waiters.shift()?.();
  };

  // Cold lane bookkeeping: exit after the records were fetched, or after
  // an idle period so a task whose launcher died does not run forever.
  let fetchedDone = 0;
  let lastActivity = now();
  let idleTimer: NodeJS.Timeout | null = null;
  const touch = () => {
    lastActivity = now();
  };
  if (config.lane === "cold" && opts.onColdComplete) {
    idleTimer = setInterval(() => {
      if (now() - lastActivity >= config.coldIdleS * 1000) opts.onColdComplete?.();
    }, 5000);
    idleTimer.unref();
    app.addHook("onClose", async () => {
      if (idleTimer) clearInterval(idleTimer);
    });
  }

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    touch();
    if (req.url === "/health" || req.url.startsWith("/health?")) return;
    if (!tokenMatches(config.token, req.headers.authorization)) {
      reply.code(401).send({ error: "unauthorized", message: "a valid bearer token is required" });
    }
  });

  app.get("/health", async () => ({
    status: "ok",
    lane: config.lane,
    pin: pins,
    queue: queue.stats(),
    uptime_s: Math.round((now() - startedAt) / 1000),
  }));

  app.get("/v1/pins", async () => ({
    platform_pin: pins.pin_id,
    pins: [pins],
  }));

  app.post<{ Body: { statement_source: string; limits?: Partial<Limits> } }>(
    "/v1/elaborate",
    {
      schema: {
        body: {
          type: "object",
          required: ["statement_source"],
          additionalProperties: false,
          properties: { statement_source: { type: "string" }, limits: LIMITS_SCHEMA },
        },
      },
    },
    async (req, reply) => {
      const source = req.body.statement_source;
      const parsed = parseStatement(source);
      const source_hash = sourceHash(source, pins.pin_id);
      const base: ElaborateResponse = {
        ok: false,
        namespace: parsed.namespace,
        errors: [...parsed.errors],
        diagnostics: [],
        truncated: false,
        source_hash,
        witness_present: parsed.witness_present,
        warnings: [],
        pin: pins,
      };
      for (const v of parsed.policy.violations) {
        base.errors.push({ message: `${v.token}: ${v.reason}`, line: v.line, column: v.column });
      }
      if (!parsed.ok || !parsed.namespace) return reply.code(200).send(base);

      const limits = clampLimits(config.elaborateLimits, req.body.limits);
      await acquire();
      let raw;
      try {
        raw = await runner.elaborate({ kind: "statement", source, namespace: parsed.namespace, header_lines: 0, limits });
      } catch (e) {
        return reply.code(503).send({ ...base, errors: [{ message: `elaboration failed to run: ${e instanceof Error ? e.message : String(e)}`, line: 1, column: 0 }] });
      } finally {
        release();
      }
      const diag = capList(raw.compile.diagnostics, DIAGNOSTICS_CAP);
      base.diagnostics = diag.items;
      base.truncated = raw.compile.truncated || raw.compile.diagnostics_truncated || diag.truncated;
      base.resource = raw.compile.resource;
      if (raw.compile.timed_out || raw.compile.killed || raw.compile.spawn_error) {
        base.timed_out = raw.compile.timed_out;
        base.errors.push({ message: raw.compile.spawn_error ?? (raw.compile.timed_out ? `elaboration timed out after ${limits.timeout_s} s` : "elaboration was killed (memory limit)"), line: 1, column: 0 });
        return reply.code(200).send(base);
      }
      if (raw.compile.error_count > 0) {
        for (const d of raw.compile.diagnostics) if (d.severity === "error") base.errors.push({ message: d.message, line: d.line, column: d.column });
        return reply.code(200).send(base);
      }
      if (!raw.analysis || raw.analysis.ok === false) {
        base.errors.push({ message: `the statement compiled but could not be analysed: ${raw.analysis && raw.analysis.ok === false ? raw.analysis.error : "no analysis"}`, line: 1, column: 0 });
        return reply.code(200).send(base);
      }
      const a = raw.analysis;
      const warnings: string[] = raw.compile.diagnostics.filter((d) => d.severity === "warning").map((d) => `line ${d.line}: ${d.message.split("\n")[0]}`);
      if (!parsed.witness_present) warnings.push("no witness `example` is present; if the hypotheses could be vacuous, add one (section 5.4)");
      if (a.definitions.length > 0) warnings.push(`the statement introduces its own definitions (${a.definitions.join(", ")}); prefer Mathlib's, and explain any in the correspondence note`);
      for (const [name, axioms] of Object.entries(a.definitions_axioms)) {
        if (axioms.length > 0) warnings.push(`definition ${name} depends on axioms ${axioms.join(", ")}`);
      }
      if (/^True$/.test(a.pp_type.trim())) warnings.push("the statement is `True`");
      return reply.code(200).send({
        ...base,
        ok: true,
        pp_type: a.pp_type,
        expr_hash: exprHash(a.pp_all),
        constants: a.constants,
        definitions: a.definitions,
        definitions_axioms: a.definitions_axioms,
        statement_axioms: a.statement_axioms,
        warnings,
      });
    }
  );

  app.post<{ Body: { source: string; statement_source?: string; limits?: Partial<Limits> } }>(
    "/v1/scratch",
    {
      schema: {
        body: {
          type: "object",
          required: ["source"],
          additionalProperties: false,
          properties: { source: { type: "string" }, statement_source: { type: "string" }, limits: LIMITS_SCHEMA },
        },
      },
    },
    async (req, reply) => {
      const policy = scanStaticPolicy(req.body.source, "scratch");
      if (!policy.ok) {
        return reply.code(200).send({ ok: false, verdict: null, policy_violations: policy.violations, diagnostics: [], truncated: false, pin: pins });
      }
      let namespace: string | undefined;
      if (req.body.statement_source !== undefined) {
        const parsed = parseStatement(req.body.statement_source);
        if (!parsed.ok || !parsed.namespace) {
          return reply.code(200).send({ ok: false, verdict: null, statement_errors: parsed.errors, diagnostics: [], truncated: false, pin: pins });
        }
        namespace = parsed.namespace;
      }
      const { file, headerLines } = assembleScratch(req.body.source, req.body.statement_source !== undefined);
      const limits = clampLimits(config.elaborateLimits, req.body.limits);
      await acquire();
      let raw;
      try {
        raw = await runner.elaborate({
          kind: "scratch",
          source: file,
          header_lines: headerLines,
          limits,
          ...(namespace ? { namespace } : {}),
          ...(req.body.statement_source !== undefined ? { statement_source: req.body.statement_source } : {}),
        });
      } catch (e) {
        return reply.code(503).send({ ok: false, error: `scratch failed to run: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        release();
      }
      const diag = capList(raw.compile.diagnostics, DIAGNOSTICS_CAP);
      const statementFailed = raw.statement_compile && raw.statement_compile.error_count > 0;
      return reply.code(200).send({
        // Warm-lane results are never a verdict (section 5.3): `verdict` is
        // always null here so a caller cannot mistake `ok` for acceptance.
        ok: !statementFailed && raw.compile.error_count === 0 && raw.compile.exit_code === 0 && !raw.compile.timed_out,
        verdict: null,
        statement_errors: statementFailed ? raw.statement_compile!.diagnostics : [],
        diagnostics: diag.items,
        error_count: raw.compile.error_count,
        truncated: raw.compile.truncated || raw.compile.diagnostics_truncated || diag.truncated,
        timed_out: raw.compile.timed_out,
        killed: raw.compile.killed,
        resource: raw.compile.resource,
        pin: pins,
      });
    }
  );

  app.post<{ Body: { query: string; backend?: "pattern" | "natural"; limit?: number } }>(
    "/v1/search",
    {
      schema: {
        body: {
          type: "object",
          required: ["query"],
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 2000 },
            backend: { type: "string", enum: ["pattern", "natural"] },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      const backend = req.body.backend ?? "pattern";
      const limit = req.body.limit ?? 20;
      if (backend === "natural") {
        if (!config.naturalSearchUrl) {
          return reply.code(503).send({ error: "search_unconfigured", backend, message: "no natural-language search backend is configured (LEAN_SEARCH_NATURAL_URL); use backend \"pattern\" or lean_elaborate to confirm a name" });
        }
        const result = await searchLoogle(fetchImpl, config.naturalSearchUrl, req.body.query, limit, 20_000);
        return reply.code(200).send({ ...result, backend, note: "a hosted index may run ahead of the pin; lean_elaborate confirms whether a name exists at it" });
      }
      if (!config.loogleUrl) {
        return reply.code(503).send({ error: "search_unconfigured", backend, message: "no Loogle mirror is configured (LOOGLE_URL); Mathlib search is unavailable on this checker" });
      }
      const result = await searchLoogle(fetchImpl, config.loogleUrl, req.body.query, limit, 20_000);
      return reply.code(result.ok || result.hits.length > 0 ? 200 : 502).send({ ...result, pin_id: pins.pin_id });
    }
  );

  app.post<{
    Body: {
      mode: CheckMode;
      kind: "proof" | "disproof";
      statement_source: string;
      submission_source: string;
      replay?: "module" | "fresh";
      force?: boolean;
      limits?: Partial<Limits>;
    };
  }>(
    "/v1/check",
    {
      schema: {
        body: {
          type: "object",
          required: ["mode", "kind", "statement_source", "submission_source"],
          additionalProperties: false,
          properties: {
            mode: { type: "string", enum: ["prize", "attempt", "steward"] },
            kind: { type: "string", enum: ["proof", "disproof"] },
            statement_source: { type: "string" },
            submission_source: { type: "string" },
            replay: { type: "string", enum: ["module", "fresh"] },
            force: { type: "boolean" },
            limits: LIMITS_SCHEMA,
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (body.mode === "prize" && config.lane === "warm" && config.refusePrizeOnWarm) {
        return reply.code(403).send({ error: "prize_requires_cold_lane", message: "prize verdicts come from the cold lane; this instance is the warm lane" });
      }
      const parsed = parseStatement(body.statement_source);
      if (!parsed.ok || !parsed.namespace) {
        return reply.code(400).send({ error: "invalid_statement", message: "the statement does not follow the convention; it is the server's, not the submission's, so this is not a verdict", errors: parsed.errors, policy_violations: parsed.policy.violations });
      }
      const namespace = parsed.namespace;
      const target = targetName(namespace, body.kind);
      const replay = body.replay ?? "module";
      const limits = clampLimits(config.jobLimits, body.limits);
      const { file, headerLines } = assembleSubmission(namespace, body.submission_source);
      const job = {
        input: {
          check_id: newCheckId(),
          statement_source: body.statement_source,
          namespace,
          submission_file: file,
          header_lines: headerLines,
          kind: body.kind,
          target,
          replay,
          limits,
        },
        mode: body.mode,
        submission_sha256: submissionSha256(body.submission_source),
        statement_source_hash: sourceHash(body.statement_source, pins.pin_id),
        force: body.force ?? false,
      };
      const policy = scanStaticPolicy(body.submission_source, "submission");
      if (!policy.ok) {
        const record = queue.recordStaticRejection(job, policy.violations);
        return reply.code(200).send(record);
      }
      try {
        const { record, deduplicated } = queue.submit(job);
        if (record.status === "done") return reply.code(200).send({ ...record, deduplicated });
        return reply.code(202).send({ ...record, deduplicated });
      } catch (e) {
        if (e instanceof CapExceededError) {
          return reply.code(429).send({ error: "daily_cpu_cap", message: e.message, cpu_ms_today: e.usedMs, cpu_cap_ms: e.capMs });
        }
        throw e;
      }
    }
  );

  app.get<{ Params: { id: string } }>("/v1/checks/:id", async (req, reply) => {
    const record: CheckRecord | undefined = queue.get(req.params.id);
    if (!record) return reply.code(404).send({ error: "not_found", message: `no check ${req.params.id} (records expire after ${config.recordTtlHours} h)` });
    if (record.status === "done" && config.lane === "cold" && opts.onColdComplete) {
      fetchedDone++;
      if (fetchedDone >= config.coldMaxChecks) setImmediate(() => opts.onColdComplete?.());
    }
    return reply.code(200).send(record);
  });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; validation?: unknown; message: string };
    if (e.validation) return reply.code(400).send({ error: "bad_request", message: e.message });
    if (e.statusCode === 413) return reply.code(413).send({ error: "too_large", message: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: "internal", message: "the checker hit an internal error" });
  });

  return app;
}
