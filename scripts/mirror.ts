/**
 * The mirror feed by hand (docs/mirror.md): what the two workers do on a
 * cadence, for an operator who wants it now, and the two things only an
 * operator does (make a key, carry batches as files).
 *
 * On a deployment that publishes:
 *   npx tsx scripts/mirror.ts keygen
 *       A new Ed25519 signing key. Prints the private key (for
 *       MIRROR_SIGNING_KEY, a secret) and the public key (which mirrors put
 *       in MIRROR_FEED_PUBLIC_KEYS). Writes nothing anywhere.
 *   npx tsx scripts/mirror.ts key
 *       The public key of the configured signing key, and the feed's id.
 *   npx tsx scripts/mirror.ts cut [--snapshot]
 *       Cut now. --snapshot sends every public row, which gives a new
 *       mirror a recent place to start from.
 *   npx tsx scripts/mirror.ts list [--after=N]
 *       The batches the feed holds.
 *   npx tsx scripts/mirror.ts export <dir> [--from=N]
 *       Write batches to a directory as files, for a deployment the network
 *       does not reach.
 *
 * On a deployment that mirrors:
 *   npx tsx scripts/mirror.ts sync
 *       Bring the mirror up to its configured feed (MIRROR_FEED_URL or
 *       MIRROR_FEED_DIR).
 *   npx tsx scripts/mirror.ts apply <file-or-dir>
 *       Apply one batch file, or everything a directory of them holds that
 *       comes next. The same checks as a fetched batch.
 *   npx tsx scripts/mirror.ts status
 *       How current the mirror is, the last batches applied, and the last
 *       refused.
 *
 * A batch that is refused prints the reason and exits 1; nothing of it was
 * written.
 */
import "../src/load-env.js";
import { statSync, readFileSync } from "node:fs";
import { closeDb, rawQuery } from "../src/db/client.js";
import { MirrorRefusal, generateSigningKey } from "../src/services/mirror-batch.js";
import {
  MirrorConfigError,
  applyBatch,
  configuredSource,
  directorySource,
  mirrorStatus,
  syncMirror,
  type SyncResult,
} from "../src/services/mirror-apply-service.js";
import { MirrorPublishError, cutBatches, exportBatches, feedKey, listBatches } from "../src/services/mirror-feed-service.js";
import { describeCut } from "../src/workers/mirror-publisher.js";

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=").slice(1).join("=");
}

function positional(): string[] {
  return process.argv.slice(2).filter((a) => !a.startsWith("--"));
}

function reportSync(result: SyncResult): void {
  for (const applied of result.applied) {
    const rows = Object.values(applied.counts).reduce((n, c) => n + c.inserted + c.updated, 0);
    const removed = Object.values(applied.counts).reduce((n, c) => n + c.removed, 0);
    console.log(
      applied.status === "applied"
        ? `Applied batch ${applied.sequence} (${applied.kind}): ${rows} rows written, ${removed} removed. The public graph as of ${applied.cut_at}.`
        : `Batch ${applied.sequence} was already applied; nothing changed.`
    );
    const notes = applied.notes;
    if (notes.merged_with_local_rows) {
      console.log(`  ${notes.merged_with_local_rows.count} claim(s) the public graph merged away still have local rows pointing to them; they were left as they are.`);
    }
    if (notes.kept_claims) {
      console.log(`  ${notes.kept_claims.count} claim(s) the public graph withdrew were kept as deprecated, because local rows point to them.`);
    }
    for (const followed of notes.local_rows_followed ?? []) {
      const n = followed.local_rows.reduce((sum, r) => sum + r.rows, 0);
      console.log(`  ${n} local row(s) pointed to ${followed.table} rows this batch removed, and followed their foreign keys.`);
    }
  }
  if (result.applied.length === 0 && !result.refusal) console.log("The mirror is up to date with its source.");
  if (result.refusal) throw result.refusal;
}

async function main(): Promise<void> {
  const [cmd, target] = positional();
  switch (cmd) {
    case "keygen": {
      const key = generateSigningKey();
      console.log("Private key, for MIRROR_SIGNING_KEY on the publisher. Keep it secret:\n");
      console.log(key.privateKeyPem);
      console.log("Public key, for MIRROR_FEED_PUBLIC_KEYS on every deployment that mirrors this one:\n");
      console.log(`  ${key.publicKey}\n`);
      console.log(`Key id (how batches name it): ${key.keyId}`);
      return;
    }
    case "key": {
      console.log(JSON.stringify(await feedKey(), null, 2));
      return;
    }
    case "cut": {
      const result = await cutBatches({ snapshot: process.argv.includes("--snapshot") });
      console.log(describeCut(result) ?? "Nothing has changed since the last batch; no batch was cut.");
      return;
    }
    case "list": {
      const listing = await listBatches({ after: Number(argValue("after") ?? 0), limit: 500 });
      console.log(`Feed ${listing.feed_id ?? "(no batch cut yet)"}; newest batch ${listing.head ?? "none"}; latest snapshot begins at ${listing.latest_snapshot ?? "none"}.`);
      for (const b of listing.batches) {
        console.log(
          `${String(b.sequence).padStart(8)}  ${b.kind.padEnd(8)}  ${b.cut_at}  migration ${b.migration.number}  ` +
            `${String(b.rows).padStart(7)} rows  ${String(b.removals).padStart(5)} removals  ${String(b.bytes).padStart(10)} bytes  ${b.hash.slice(0, 16)}`
        );
      }
      return;
    }
    case "export": {
      if (!target) throw new Error("export needs a directory to write to");
      const { written } = await exportBatches(target, { from: Number(argValue("from") ?? 1) });
      console.log(written.length > 0 ? `Wrote batches ${written[0]} to ${written.at(-1)} to ${target}.` : "The feed has no batches from there on.");
      return;
    }
    case "sync": {
      const source = configuredSource();
      if (!source) {
        throw new MirrorConfigError("This deployment has no mirror feed configured. Set MIRROR_FEED_URL or MIRROR_FEED_DIR.");
      }
      reportSync(await syncMirror(source));
      return;
    }
    case "apply": {
      if (!target) throw new Error("apply needs a batch file or a directory of them");
      if (statSync(target).isDirectory()) {
        reportSync(await syncMirror(directorySource(target)));
      } else {
        reportSync({ applied: [await applyBatch(readFileSync(target, "utf8"), { receivedFrom: target })], refusal: null });
      }
      return;
    }
    case "status": {
      const status = await mirrorStatus();
      if (!status.applied) {
        console.log("This mirror has applied no batch yet.");
      } else {
        console.log(
          `The public graph as of ${status.public_graph_as_of} (batch ${status.sequence}, applied ${status.applied_at})` +
            (status.complete ? "." : "; a snapshot is only partly applied, so the mirror is not yet whole.")
        );
        console.log(`Feed ${status.feed_id}, signed with key ${status.key_id}. ${status.searchable_claims} mirrored claims can be searched.`);
      }
      const recent = await rawQuery<{ sequence: string; kind: string; cut_at: Date; applied_at: Date; received_from: string | null }>(
        `SELECT sequence, kind, cut_at, applied_at, received_from FROM mirror_applied_batches ORDER BY sequence DESC LIMIT 10`
      );
      for (const r of recent) {
        console.log(`  applied ${String(r.sequence).padStart(8)}  ${r.kind.padEnd(8)}  cut ${r.cut_at.toISOString()}  applied ${r.applied_at.toISOString()}  from ${r.received_from ?? "?"}`);
      }
      if (status.last_refusal) {
        console.log(`Refused since (${status.last_refusal.refused_at}): ${status.last_refusal.message}`);
      }
      return;
    }
    default:
      console.log("Usage: npx tsx scripts/mirror.ts keygen | key | cut [--snapshot] | list | export <dir> | sync | apply <file-or-dir> | status");
      process.exitCode = cmd ? 1 : 0;
  }
}

main()
  .catch((err) => {
    if (err instanceof MirrorRefusal || err instanceof MirrorPublishError || err instanceof MirrorConfigError) {
      console.error(err.message);
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  })
  .finally(() => closeDb());
