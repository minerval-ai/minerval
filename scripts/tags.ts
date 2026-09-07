/**
 * Operator maintenance of the tag vocabulary (#272).
 *
 * The tagger grows the vocabulary; this script tidies it. No LLM is
 * involved: every subcommand is a mechanical edit an operator has decided
 * on, recorded with created_by / source = 'operator'.
 *
 *   npx tsx scripts/tags.ts list [--q=substr] [--unused]
 *       The vocabulary with claim counts.
 *   npx tsx scripts/tags.ts show <slug>
 *       One tag and the claims carrying it.
 *   npx tsx scripts/tags.ts merge <loser-slug> <winner-slug>
 *       Move the loser's taggings to the winner and retire the loser (its
 *       slug keeps resolving to the winner).
 *   npx tsx scripts/tags.ts rename <slug> "<new name>" ["<new description>"]
 *       Rename or re-describe (re-embeds).
 *   npx tsx scripts/tags.ts create "<name>" "<description>"
 *       Mint a tag by hand (goes through the slug and meaning guards).
 *   npx tsx scripts/tags.ts retag [--all | --tag=<slug> | --claim=<id>]
 *       Return claims to the tagging queue for a fresh pass.
 *   npx tsx scripts/tags.ts queue
 *       Tagging queue depth.
 *   npx tsx scripts/tags.ts drain [--batch=N] [--model=…]
 *       Run the tagging drain now, N claims (default 20), instead of
 *       waiting for the scheduler; the backfill of an existing graph is
 *       this, repeated until `queue` reports zero pending.
 */
import "dotenv/config";
import { rawQuery, closeDb } from "../src/db/client.js";
import {
  findOrCreateTag,
  listTags,
  mergeTags,
  resetClaimTagging,
  resolveTagBySlug,
  taggingQueueHealth,
  updateTag,
} from "../src/services/tag-service.js";
import { taggingTick } from "../src/workers/tagging-pipeline.js";

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=").slice(1).join("=");
}

function positional(): string[] {
  return process.argv.slice(2).filter((a) => !a.startsWith("--"));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = positional();
  switch (cmd) {
    case "list": {
      const rows = await listTags({
        q: argValue("q"),
        limit: 500,
        includeUnused: process.argv.includes("--unused"),
      });
      for (const t of rows) {
        console.log(`${String(t.claim_count).padStart(5)}  ${t.slug.padEnd(40)}  ${t.name}`);
      }
      console.log(`\n${rows.length} tag(s)`);
      break;
    }
    case "show": {
      const tag = await resolveTagBySlug(rest[0] ?? "");
      if (!tag) throw new Error(`no tag "${rest[0]}"`);
      console.log(`${tag.name} (${tag.slug}) — ${tag.status}, by ${tag.created_by}`);
      console.log(tag.description || "(no description)");
      const claims = await rawQuery<{ id: string; text: string; source: string; confidence: number | null }>(
        `SELECT c.id, c.text, tg.source, tg.confidence
           FROM taggings tg JOIN claims c ON c.id = tg.subject_id
          WHERE tg.tag_id = $1 AND tg.subject_kind = 'claim' AND c.state = 'active'
          ORDER BY c.importance DESC LIMIT 200`,
        [tag.id]
      );
      for (const c of claims) {
        console.log(`  ${(c.confidence ?? 0).toFixed(2)} ${c.source.padEnd(8)} ${c.id}  ${c.text.slice(0, 80)}`);
      }
      console.log(`\n${claims.length} claim(s)`);
      break;
    }
    case "merge": {
      const loser = await resolveTagBySlug(rest[0] ?? "");
      const winner = await resolveTagBySlug(rest[1] ?? "");
      if (!loser || !winner) throw new Error("merge needs two existing slugs");
      const r = await mergeTags({ loserId: loser.id, winnerId: winner.id });
      console.log(`merged "${loser.name}" into "${winner.name}": ${r.moved} moved, ${r.dropped} already there`);
      break;
    }
    case "rename": {
      const tag = await resolveTagBySlug(rest[0] ?? "");
      if (!tag) throw new Error(`no tag "${rest[0]}"`);
      const updated = await updateTag(tag.id, {
        ...(rest[1] ? { name: rest[1] } : {}),
        ...(rest[2] !== undefined ? { description: rest[2] } : {}),
      });
      console.log(`now "${updated?.name}" (${updated?.slug}): ${updated?.description}`);
      break;
    }
    case "create": {
      if (!rest[0]) throw new Error("create needs a name");
      const r = await findOrCreateTag({
        name: rest[0],
        description: rest[1],
        createdBy: "operator",
      });
      console.log(`${r.resolution}: "${r.tag.name}" (${r.tag.slug})`);
      break;
    }
    case "retag": {
      let ids: string[] = [];
      if (process.argv.includes("--all")) {
        ids = (await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE state = 'active'`)).map((r) => r.id);
      } else if (argValue("tag")) {
        const tag = await resolveTagBySlug(argValue("tag")!);
        if (!tag) throw new Error(`no tag "${argValue("tag")}"`);
        ids = (
          await rawQuery<{ subject_id: string }>(
            `SELECT subject_id FROM taggings WHERE tag_id = $1 AND subject_kind = 'claim'`,
            [tag.id]
          )
        ).map((r) => r.subject_id);
      } else if (argValue("claim")) {
        ids = [argValue("claim")!];
      } else {
        throw new Error("retag needs --all, --tag=<slug>, or --claim=<id>");
      }
      const n = await resetClaimTagging(ids);
      console.log(`${n} claim(s) returned to the tagging queue`);
      break;
    }
    case "queue": {
      console.log(await taggingQueueHealth());
      break;
    }
    case "drain": {
      const batch = Number(argValue("batch") ?? "20");
      const r = await taggingTick({ batch, model: argValue("model") });
      console.log(r);
      console.log(await taggingQueueHealth());
      break;
    }
    default:
      console.log("usage: tags.ts list|show|merge|rename|create|retag|queue|drain (see file header)");
  }
  await closeDb();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
