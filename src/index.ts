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
import { withSystemClearance } from "./db/clearance.js";
import { enforcementFacts, enforcementProblems, ensureEnforcement } from "./db/enforcement.js";
import { startPoller } from "./workers/poller.js";
import { startLocalRunner } from "./workers/local-runner.js";
import { startAuditScheduler } from "./workers/audit-scheduler.js";
import { startMonitorScheduler } from "./workers/monitor-scheduler.js";
import { startAllocationScheduler } from "./workers/allocation-scheduler.js";
import { startQueueDepthSampler } from "./workers/queue-depth-sampler.js";
import { startTraceRetention } from "./workers/trace-retention.js";
import { startUsageReports } from "./workers/usage-reports.js";
import { usageReporting } from "./services/usage-report-service.js";
import { startRecoverySweep } from "./workers/recovery-sweep.js";
import { startTaggingScheduler } from "./workers/tagging-pipeline.js";
import { startLookoutTriggers } from "./workers/lookout-triggers.js";
import { startCorrespondentTriggers } from "./workers/correspondent-triggers.js";
import { startGithubIssueSync } from "./workers/github-issue-sync.js";
import { fillSourcePageHashes } from "./services/source-service.js";
import { startReportEmbeddingBackfill } from "./workers/report-embedding-backfill.js";
import { startSourceBackfill } from "./workers/source-backfill.js";
import { startMirrorPublisher } from "./workers/mirror-publisher.js";
import { startMirrorApplier } from "./workers/mirror-applier.js";
import { mirrorConfigProblems, mirrorRoles } from "./services/mirror-roles.js";
import { handleClaimPipeline } from "./workers/claim-pipeline.js";
import { handleUrlExtraction } from "./workers/url-extraction.js";
import { handleContributionMessage } from "./workers/contribution-pipeline.js";
import { handleArbitrationMessage } from "./workers/arbitration-pipeline.js";
import { abandonStewardLeases } from "./services/steward-lease.js";
import type {
  QueuedClaimPipelineMessage,
  UrlExtractionMessage,
  ContributionMessage,
  ArbitrationMessage,
} from "./services/queue-service.js";

async function main() {
  const config = loadConfig();
  // Every tool a domain skill declares must have an executor and a name
  // that collides with nothing; a defective skill fails the process here,
  // not mid-run inside a Steward's toolset.
  assertSkillToolsRegistered();
  // A deployment set to publish the mirror feed without a signing key, or
  // to apply one without the key to check it against, stops here with the
  // reason, not later with a feed nobody can use.
  const mirrorProblems = mirrorConfigProblems(config);
  if (mirrorProblems.length > 0) {
    throw new Error(`The mirror is misconfigured:\n- ${mirrorProblems.join("\n- ")}`);
  }

  if (config.env === "production") {
    console.log("Running database migrations...");
    // As the tables' owner, seeing every row: a migration that updates rows
    // must reach all of them, whatever their labels.
    await withSystemClearance(
      "Migrations change tables, which only their owner may do, and a migration that updates rows must see every one.",
      async () => {
        const db = getDb();
        await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
        await migrate(db, {
          migrationsFolder: join(process.cwd(), "drizzle-migrations"),
        });
      }
    );
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
        const lines = await withSystemClearance(
          "Creating and updating read-only SQL's login roles is the owner's to do.",
          () => ensureSqlRoles((text, params) => rawQuery(text, params), roles)
        );
        for (const line of lines) console.log(`[sql] ${line}`);
      } catch (err) {
        console.error("[sql] could not ensure the read-only SQL roles; SQL will answer UNAVAILABLE:", err);
      }
    }
  }

  // Where the deployment has more than one label, the database holds every
  // read and write to a clearance (db/clearance.ts). The step that covers
  // each labelled table runs here, after migrations, so a table a migration
  // just added is covered before anything is served. On the public graph it
  // finds nothing to do. A failure stops the start where a second label
  // exists, since a table could be left uncovered; where `public` is the
  // only label there is nothing to hold, and the API starts.
  try {
    const { on, changes } = await ensureEnforcement();
    for (const line of changes) console.log(`[labels] ${line}`);
    if (on) {
      // The step has run; now look at what is really there, a live cleared
      // connection included. Anything wrong (a table without its policy, a
      // view that reads as the owner, a materialized view, a cleared role
      // nothing binds) stops the start: the catch below lets a failure pass
      // only where `public` is the only label, and here it is not.
      const problems = enforcementProblems(await enforcementFacts());
      for (const problem of problems) console.error(`[labels] ${problem}`);
      if (problems.length > 0) {
        throw new Error(`The database is not holding reads to a clearance as it should: ${problems.length} problem(s), listed above.`);
      }
      console.log("[labels] reads and writes are held to a clearance in the database");
    }
  } catch (err) {
    const others = await withSystemClearance(
      "Deciding whether a failed enforcement check may be passed over reads the label table as the owner.",
      () => rawQuery(`SELECT 1 FROM labels WHERE name <> 'public' LIMIT 1`)
    ).catch(() => null);
    if (others === null || others.length > 0) throw err;
    console.error("[labels] the enforcement step failed; public is the only label, so nothing is held:", err);
  }

  const app = await buildApp();
  const pollers: Array<{ stop: () => void }> = [];

  // Start queue pollers for configured queues
  const logger = {
    info: (...args: unknown[]) => app.log.info(args),
    error: (...args: unknown[]) => app.log.error(args),
  };

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
    void withSystemClearance(
      "The page-hash fill writes a hash into every source's own row, whatever its label.",
      () => fillSourcePageHashes()
    )
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

  // The mirror feed (docs/mirror.md). Neither worker starts unless this
  // deployment is configured for that side: a publisher cuts signed batches
  // of its public rows on a cadence, an applier brings its mirror of the
  // public graph up to its feed. Each takes a lock for its work, so every
  // task may run it.
  const mirror = mirrorRoles(config);
  if (mirror.publisher) pollers.push(startMirrorPublisher({ logger }));
  if (mirror.applier) pollers.push(startMirrorApplier({ logger }));
  // The usage report (docs/usage-report.md): a members-only deployment on
  // the metered price reports the owls its runs spent each closed UTC day,
  // one total. Not started on the public graph, which reports to no one,
  // or on the flat price. Preparing takes a database lock and a report is
  // recorded once, so every task may run it.
  if (usageReporting(config)) pollers.push(startUsageReports({ logger }));

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
    const abandoned = await withSystemClearance(
      "Shutdown hands back every claim this process holds a lease on, whatever its label.",
      () => abandonStewardLeases()
    ).catch((err) => {
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
  console.error("Fatal error:", err);
  process.exit(1);
});
