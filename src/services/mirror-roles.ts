/**
 * Which side of the mirror feed this deployment is on (docs/mirror.md).
 *
 * One codebase serves both sides. A deployment publishes the feed, applies
 * one, does both, or does neither, and it does neither unless its
 * configuration says otherwise: with nothing set, no mirror route is
 * mounted (src/server/app.ts), no mirror worker starts (src/index.ts), and
 * nothing reads or writes the mirror's tables.
 */
import { loadConfig, type Config } from "../config.js";
import { parsePublicKey, parseSigningKey } from "./mirror-batch.js";

export type MirrorConfig = Pick<
  Config,
  "mirrorPublish" | "mirrorSigningKey" | "mirrorFeedUrl" | "mirrorFeedDir" | "mirrorFeedPublicKeys"
>;

export interface MirrorRoles {
  /** Cuts signed batches of its public rows and serves them at /mirror/feed. */
  publisher: boolean;
  /** Keeps a mirror of another graph, fed from an address or a directory. */
  applier: boolean;
}

export function mirrorRoles(config: Partial<MirrorConfig> = loadConfig()): MirrorRoles {
  return {
    publisher: config.mirrorPublish === true,
    applier: Boolean(config.mirrorFeedUrl) || Boolean(config.mirrorFeedDir),
  };
}

/**
 * What is wrong with the mirror's configuration, one plain sentence each;
 * empty when it can run as configured. Checked at start, so that a
 * publisher without a key or an applier that could verify nothing does not
 * come up looking healthy.
 */
export function mirrorConfigProblems(config: Partial<MirrorConfig> = loadConfig()): string[] {
  const roles = mirrorRoles(config);
  const problems: string[] = [];
  if (roles.publisher) {
    if (!config.mirrorSigningKey) {
      problems.push(
        "MIRROR_PUBLISH is true and MIRROR_SIGNING_KEY is empty: a feed cannot be published unsigned. " +
          "Set MIRROR_SIGNING_KEY to an Ed25519 private key in PEM form (`npx tsx scripts/mirror.ts keygen` makes one)."
      );
    } else {
      try {
        parseSigningKey(config.mirrorSigningKey);
      } catch (err) {
        problems.push(`MIRROR_PUBLISH is true and ${err instanceof Error ? err.message : String(err)}.`);
      }
    }
  }
  if (roles.applier) {
    if (config.mirrorFeedUrl && config.mirrorFeedDir) {
      problems.push(
        "MIRROR_FEED_URL and MIRROR_FEED_DIR are both set: a mirror follows one source. Unset one of them."
      );
    }
    const keys = config.mirrorFeedPublicKeys ?? [];
    if (keys.length === 0) {
      problems.push(
        "A mirror feed is configured and MIRROR_FEED_PUBLIC_KEYS is empty: no batch could be checked, so none " +
          "would be applied. Set it to the feed's public key, as GET /mirror/feed/key on the publisher gives it, " +
          "confirmed with the publisher by another route."
      );
    }
    for (const key of keys) {
      try {
        parsePublicKey(key);
      } catch (err) {
        problems.push(`MIRROR_FEED_PUBLIC_KEYS: ${err instanceof Error ? err.message : String(err)}.`);
      }
    }
  }
  return problems;
}
