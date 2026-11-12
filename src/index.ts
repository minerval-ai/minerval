import "./load-env.js";
import { join } from "path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { buildApp } from "./server/app.js";
import { loadConfig } from "./config.js";
import { featureOn } from "./features.js";
import { assertSkillToolsRegistered } from "./llm/tools/skill-tools.js";
import { getDb, closeDb, rawQuery } from "./db/client.js";
import { ensureSqlRoles, hasSqlRoleCredentials } from "./db/sql-roles.js";
import { startPoller } from "./workers/poller.js";
import { startLocalRunner } from "./workers/local-runner.js";
import { startAuditScheduler } from "./workers/audit-scheduler.js";
import { startMonitorScheduler } from "./workers/monitor-scheduler.js";
import { startAllocationScheduler } from "./workers/allocation-scheduler.js";
import { startQueueDepthSampler } from "./workers/queue-depth-sampler.js";
import { startTraceRetention } from "./workers/trace-retention.js";
import { startRecoverySweep } from "./workers/recovery-sweep.js";
import { startTaggingScheduler } from "./workers/tagging-pipeline.js";
import { startLookoutTriggers } from "./workers/lookout-triggers.js";
import { startCorrespondentTriggers } from "./workers/correspondent-triggers.js";
import { startGithubIssueSync } from "./workers/github-issue-sync.js";
import { fillSourcePageHashes } from "./services/source-service.js";
import { startReportEmbeddingBackfill } from "./workers/report-embedding-backfill.js";
import { startSourceBackfill } from "./workers/source-backfill.js";
import { handleClaimPipeline } from "./workers/claim-pipeline.js";
import { handleUrlExtraction } from "./workers/url-extraction.js";
import { handleContributionMessage } from "./workers/contribution-pipeline.js";
import { handleArbitrationMessage } from "./workers/arbitration-pipeline.js";
import { abandonStewardLeases } from "./services/steward-lease.js";
import { startGatedWork } from "./workers/agent-work-gate.js";
import { ConfigFileError } from "./config-file.js";
import type {
  QueuedClaimPipelineMessage,
  UrlExtractionMessage,
  ContributionMessage,
  ArbitrationMessage,
} from "./services/queue-service.js";

type WorkLogger = {
  info: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/**
 * Start everything that takes work: the queue pollers, the in-process
 * runner, and the schedulers and sweeps around them. Called by the gate
 * (workers/agent-work-gate.ts) and by nothing else, so that there is one
 * place agent work begins.
 */
function startWork(
  app: Awaited<ReturnType<typeof buildApp>>,
  config: ReturnType<typeof loadConfig>,
  logger: WorkLogger
): Array<{ stop: () => void }> {
  const pollers: Array<{ stop: () => void }> = [];

  // Start queue pollers for configured queues
  if (config.sqsClaimPipelineQueue) {
    // The queue may still hold messages from before the label field
    // (workers/claim-pipeline.ts), so the poller hands over either shape.
    pollers.push(startPoller<QueuedClaimPipelineMessage>({
      queueUrl: config.sqsClaimPipelineQueue,
      handler: handleClaimPipeline,
      logger,
    }));
  }

  if (config.sqsUrlExtractionQueue) {
    pollers.push(startPoller<UrlExtractionMessage>({
      queueUrl: config.sqsUrlExtractionQueue,
      handler: handleUrlExtraction,
      logger,
    }));
  }

  if (config.sqsContributionQueue) {
    pollers.push(startPoller<ContributionMessage>({
      queueUrl: config.sqsContributionQueue,
      handler: handleContributionMessage,
      logger,
    }));
  }

  if (config.sqsArbitrationQueue) {
    pollers.push(startPoller<ArbitrationMessage>({
      queueUrl: config.sqsArbitrationQueue,
      handler: handleArbitrationMessage,
      logger,
    }));
  }

  // ALWAYS run the in-process drainer. It owns the DB-backed Steward queue
  // (importance-prioritized, the same in dev and prod), the engine executor
  // over the action ledger (where Curator and Audit runs now live, #363), and
  // drains any in-memory queues that have no SQS poller configured. Queues
  // that DO have an SQS poller route through SQS, so their in-memory arrays
  // stay empty and this is a no-op for them (no double processing).
  pollers.push(startLocalRunner({ logger }));

  // The audit scheduler (#180) requests audits on a cadence: periodic
  // decision sweeps and stale-suspension re-reviews. Its dedupe keys live in
  // the DB, so running it in every task is safe — exactly one request wins.
  pollers.push(startAuditScheduler({ logger }));

  // The monitor scheduler (#334 S9) hands the candidate detectors' hits
  // (performed settling, empty chairs) to the Audit Agent as input, deduped
  // per claim per reflag period in the DB. Off unless
  // MONITOR_SWEEP_INTERVAL_HOURS > 0; safe in every task when on.
  pollers.push(startMonitorScheduler({ logger }));

  // The allocation scheduler refreshes composite queue priorities and feeds
  // the cadence-based staleness_check re-enqueues (#283), with a bounded
  // per-sweep inflow (#295). Both jobs are idempotent, so running it in
  // every task is safe.
  pollers.push(startAllocationScheduler({ logger }));

  // The queue-depth sampler (#217) persists a periodic snapshot of the
  // steward lane + action ledger. Period-keyed, so every task can run it and
  // exactly one snapshot lands per period.
  pollers.push(startQueueDepthSampler({ logger }));

  // The trace retention sweep (#334 L0) deletes agent runs older than
  // TRACE_RETENTION_DAYS, steps cascading, so production can trace by default
  // without the tables growing without bound. Idempotent; every task may run it.
  pollers.push(startTraceRetention({ logger }));

  // The recovery sweep (#218) re-enqueues review/arbitration work whose
  // in-memory message was lost (restart, dropped on error). The pipeline
  // handlers' atomic claims dedupe, so running it in every task is safe.
  pollers.push(startRecoverySweep({ logger }));

  // The tagging drain (#272) labels untagged claims a few at a time, most
  // important first — new claims as they land and the backfill of the rest
  // through the same queue. Row leases make it safe in every task.
  pollers.push(startTaggingScheduler({ logger }));

  // The GitHub issue sync (#366) files the agents' reports that have no
  // issue yet — the backlog from before the sync, and raise-time filings
  // that failed — a bounded batch per tick. The row records the issue
  // number, so every task may run it. Silent no-op unless configured.
  pollers.push(startGithubIssueSync({ logger }));

  // The report embedding backfill (#432) gives a vector to every report
  // recorded without one, so the match-before-write search and
  // search_issues can see it. The update lands only where the embedding
  // is still null, so every task may run it.
  pollers.push(startReportEmbeddingBackfill({ logger }));

  // Sources from before sources.page_url_hash existed get their hash, so the
  // browser extension can find the pages the graph already read. Detached:
  // nothing waits on it, and a failure only leaves those pages unfound.
  // Only the extension's lookups read the hash, so the fill does not run
  // while the extension feature is off (src/features.ts).
  if (featureOn("extension", config)) {
    void fillSourcePageHashes()
      .then((n) => n > 0 && app.log.info(`Filled page hashes for ${n} sources`))
      .catch((err) => app.log.error({ err }, "filling source page hashes failed"));
  }

  // The source backfill (#507) fills the facts and segments of sources
  // that lack them, fetching the page of a source an agent cited without
  // opening: one pass over what is stored, then a standing sweep of what is
  // cited afterwards. The pass claims its batch by moving a cursor under a
  // row lock and the sweep runs under a lease, so every task may run it.
  pollers.push(startSourceBackfill({ logger }));

  // Lookout triggers (docs/allocation.md, "Lookouts"): the daily Crossref
  // retraction poll that queues inputs for the mandates' standing watches.
  // High-water-marked in platform_flags, so every task may run it.
  pollers.push(startLookoutTriggers({ logger }));
  pollers.push(startCorrespondentTriggers({ logger }));

  return pollers;
}

async function main() {
  const config = loadConfig();
  // Every tool a domain skill declares must have an executor and a name
  // that collides with nothing; a defective skill fails the process here,
  // not mid-run inside a Steward's toolset.
  assertSkillToolsRegistered();

  if (config.env === "production") {
    console.log("Running database migrations...");
    const db = getDb();
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    await migrate(db, {
      migrationsFolder: join(process.cwd(), "drizzle-migrations"),
    });
    console.log("Migrations complete.");

    // Read-only SQL's login roles live in the database, not in the stack, so
    // a deployment that never made them answers every query UNAVAILABLE.
    // Made here, after migrations (which create the group role they join),
    // and set again on every start, which also applies a rotated secret.
    // A failure is logged, not fatal: SQL is one feature, and the rest of
    // the API should still serve.
    const roles = {
      agentUser: config.sqlAgentDbUser,
      agentPassword: config.sqlAgentDbPassword,
      callerUser: config.sqlCallerDbUser,
      callerPassword: config.sqlCallerDbPassword,
    };
    if (hasSqlRoleCredentials(roles)) {
      try {
        for (const line of await ensureSqlRoles((text, params) => rawQuery(text, params), roles)) {
          console.log(`[sql] ${line}`);
        }
      } catch (err) {
        console.error("[sql] could not ensure the read-only SQL roles; SQL will answer UNAVAILABLE:", err);
      }
    }
  }

  const app = await buildApp();

  const logger = {
    info: (...args: unknown[]) => app.log.info(args),
    error: (...args: unknown[]) => app.log.error(args),
  };

  // Agent work starts behind the preflight's gate and nowhere else
  // (workers/agent-work-gate.ts): a deployment that holds private material
  // starts none until its blocking checks pass, and says which failed. A
  // deployment that holds only public material is asked nothing further and
  // starts as it always has. The API listens either way, so the checks can
  // be read at GET /setup/preflight while work is held.
  const work = startGatedWork({ start: () => startWork(app, config, logger), logger });
  const pollers: Array<{ stop: () => void }> = [work];

  // Graceful shutdown. ECS kills the task 30s after SIGTERM, so the HTTP
  // close gets a bounded wait; then any Steward run still in flight hands
  // its claim back (#482) as the last DB write before exit, so the next
  // task picks it up now rather than after the lease runs out.
  const shutdown = async () => {
    app.log.info("Shutting down...");
    for (const poller of pollers) poller.stop();
    await Promise.race([
      app.close(),
      new Promise((r) => setTimeout(r, 20_000).unref()),
    ]);
    const abandoned = await abandonStewardLeases().catch((err) => {
      app.log.error(err, "Releasing in-flight Steward claims failed");
      return 0;
    });
    if (abandoned > 0) {
      app.log.info(`Handed back ${abandoned} in-flight Steward claim(s)`);
    }
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  // A config file that cannot be used is the installer's to fix, and its
  // message says how; a stack trace under it would bury that.
  if (err instanceof ConfigFileError) console.error(err.message);
  else console.error("Fatal error:", err);
  process.exit(1);
});
