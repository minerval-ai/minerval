/**
 * Fetch the pinned corpus posts from the LessWrong GraphQL API and cache them
 * as clean markdown (+ a metadata sidecar) under corpus/<cluster>/posts/.
 *
 * Usage:  tsx scripts/corpus/fetch.ts [cluster]    (default cluster: lethalities)
 *
 * The post IDs in the manifest are the source of truth; re-running reproduces
 * the same set. We pull contents.markdown rather than scraping HTML, so the
 * cached text is what the pipeline actually sees.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  loadManifest,
  positional,
  postsDir,
  postMarkdownPath,
  postSidecarPath,
} from "./lib.js";

const LW_GRAPHQL = "https://www.lesswrong.com/graphql";

interface LwPost {
  _id: string;
  title: string;
  slug: string;
  pageUrl: string;
  baseScore: number;
  wordCount: number;
  postedAt: string;
  user: { displayName: string } | null;
  contents: { markdown: string } | null;
}

async function fetchPost(id: string): Promise<LwPost> {
  const query = `{ post(input:{selector:{_id:"${id}"}}){ result {
    _id title slug pageUrl baseScore wordCount postedAt
    user{ displayName } contents{ markdown }
  } } }`;
  const res = await fetch(LW_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Minerval corpus fetch)",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { post?: { result?: LwPost | null } };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) throw new Error(`GraphQL: ${json.errors[0]!.message}`);
  const result = json.data?.post?.result;
  if (!result) throw new Error("no result");
  return result;
}

async function main(): Promise<void> {
  const cluster = positional(0) ?? "lethalities";
  const manifest = loadManifest(cluster);

  // `web` clusters carry curated, committed markdown from arbitrary public
  // sources — there's no single API to refetch them, and the committed `.md` is
  // the pinned source of truth. Skip rather than clobbering curated content.
  if (manifest.kind === "web") {
    console.log(
      `Cluster "${cluster}" is a curated web cluster (kind: "web").\n` +
        `Its post markdown under corpus/${cluster}/posts/ is committed and pinned; ` +
        `there is nothing to fetch.\n` +
        `Edit those files directly to update the corpus.`
    );
    return;
  }

  mkdirSync(postsDir(cluster), { recursive: true });

  console.log(`Fetching ${manifest.posts.length} posts for cluster "${cluster}"\n`);
  let ok = 0;
  let totalWords = 0;

  for (const p of manifest.posts) {
    process.stdout.write(`  ${p.id}  ${p.title.slice(0, 48).padEnd(48)} `);
    try {
      const post = await fetchPost(p.id);
      const markdown = post.contents?.markdown ?? "";
      if (!markdown.trim()) throw new Error("empty markdown");

      writeFileSync(postMarkdownPath(cluster, p.id), markdown);
      writeFileSync(
        postSidecarPath(cluster, p.id),
        JSON.stringify(
          {
            id: post._id,
            title: post.title,
            author: post.user?.displayName ?? null,
            slug: post.slug,
            url: post.pageUrl,
            baseScore: post.baseScore,
            wordCount: post.wordCount,
            postedAt: post.postedAt,
            fetchedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );

      if (post.title !== p.title) {
        console.log(`✓ ${post.wordCount}w  ⚠ title drift vs manifest`);
      } else {
        console.log(`✓ ${post.wordCount}w`);
      }
      ok++;
      totalWords += post.wordCount ?? 0;
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
    }
  }

  console.log(
    `\n${ok}/${manifest.posts.length} posts cached in ${postsDir(cluster)}` +
      `  (~${totalWords.toLocaleString()} words)`
  );
  if (ok < manifest.posts.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
