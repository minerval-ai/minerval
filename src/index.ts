import "dotenv/config";
import { join } from "path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { buildApp } from "./server/app.js";
import { loadConfig } from "./config.js";
import { getDb, closeDb } from "./db/client.js";
import { startPoller } from "./workers/poller.js";
import { startLocalRunner } from "./workers/local-runner.js";
import { startAuditScheduler } from "./workers/audit-scheduler.js";
import { startAllocationScheduler } from "./workers/allocation-scheduler.js";
import { startRecoverySweep } from "./workers/recovery-sweep.js";
import { handleClaimPipeline } from "./workers/claim-pipeline.js";
import { handleUrlExtraction } from "./workers/url-extraction.js";
import { handleContributionMessage } from "./workers/contribution-pipeline.js";
import { handleArbitrationMessage } from "./workers/arbitration-pipeline.js";
import { handleCuratorMessage } from "./workers/curator-pipeline.js";
import { handleAuditMessage } from "./workers/audit-pipeline.js";
import type {
  ClaimPipelineMessage,
  UrlExtractionMessage,
  ContributionMessage,
  ArbitrationMessage,
  CuratorMessage,
  AuditMessage,
} from "./services/queue-service.js";

async function main() {
  const config = loadConfig();

  if (config.env === "production") {
    console.log("Running database migrations...");
    const db = getDb();
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    await migrate(db, {
      migrationsFolder: join(process.cwd(), "drizzle-migrations"),
    });
    console.log("Migrations complete.");
  }

  const app = await buildApp();
  const pollers: Array<{ stop: () => void }> = [];

  // Start queue pollers for configured queues
  const logger = {
    info: (...args: unknown[]) => app.log.info(args),
    error: (...args: unknown[]) => app.log.error(args),
  };

  if (config.sqsClaimPipelineQueue) {
    pollers.push(startPoller<ClaimPipelineMessage>({
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

  if (config.sqsCuratorQueue) {
    pollers.push(startPoller<CuratorMessage>({
      queueUrl: config.sqsCuratorQueue,
      handler: handleCuratorMessage,
      logger,
    }));
  }

  if (config.sqsAuditQueue) {
    pollers.push(startPoller<AuditMessage>({
      queueUrl: config.sqsAuditQueue,
      handler: handleAuditMessage,
      logger,
    }));
  }

  // ALWAYS run the in-process drainer. It owns the DB-backed Steward queue
  // (importance-prioritized, the same in dev and prod) and drains any in-memory
  // queues that have no SQS poller configured — in prod that's the Curator and
  // the rest, which were previously enqueued but never drained. Queues that DO
  // have an SQS poller route through SQS, so their in-memory arrays stay empty
  // and this is a no-op for them (no double processing).
  pollers.push(startLocalRunner({ logger }));

  // The audit scheduler (#180) feeds the audit queue on a cadence: periodic
  // decision sweeps and stale-suspension re-reviews. Its dedupe keys live in
  // the DB, so running it in every task is safe — exactly one request wins.
  pollers.push(startAuditScheduler({ logger }));

  // The allocation scheduler refreshes composite queue priorities and feeds
  // the cadence-based staleness_check re-enqueues (#283), with a bounded
  // per-sweep inflow (#295). Both jobs are idempotent, so running it in
  // every task is safe.
  pollers.push(startAllocationScheduler({ logger }));

  // The recovery sweep (#218) re-enqueues review/arbitration work whose
  // in-memory message was lost (restart, dropped on error). The pipeline
  // handlers' atomic claims dedupe, so running it in every task is safe.
  pollers.push(startRecoverySweep({ logger }));

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info("Shutting down...");
    for (const poller of pollers) poller.stop();
    await app.close();
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
