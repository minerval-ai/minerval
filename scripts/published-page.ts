/**
 * Pages shown outside, by hand (docs/published-pages.md).
 *
 * For anyone, with no database and no network:
 *   npx tsx scripts/published-page.ts verify <file> [--key=<publisher's public key>]
 *       Check a published page's package: the signature, the released text
 *       against the page's fingerprint, the held parts' places and kinds,
 *       and the record's form. Prints what it confirmed, what failed, and
 *       what a check of this kind cannot show. Exits 1 if anything failed.
 *       --key is the publisher's key as the public graph's record of the
 *       publisher gives it; without it the check says the package is signed
 *       by the key it carries, and not whose key that is.
 *
 * In a deployment that shows pages outside:
 *   npx tsx scripts/published-page.ts keygen
 *       A new Ed25519 signing key. Prints the private key (for
 *       PUBLISH_SIGNING_KEY, a secret) and the public key. Writes nothing.
 *   npx tsx scripts/published-page.ts key
 *       The public half of the configured key, and where the deployment
 *       says it runs.
 *   npx tsx scripts/published-page.ts registration <account>
 *       The signed statement that registers the key to the organization's
 *       account on the public graph (its sign-in identity there). Send it
 *       to the public graph's POST /publishers under that account.
 *   npx tsx scripts/published-page.ts build
 *       Build a package for every node shown outside whose outside state
 *       has changed. Sends nothing.
 *   npx tsx scripts/published-page.ts export <dir>
 *       Write every package to a directory as files, for a deployment the
 *       network does not join to the public graph. A person submits each
 *       on the public graph under the organization's account.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTING_WORDS, verifyPublishedPage } from "../src/published-page/verify.js";

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=").slice(1).join("=");
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));

async function verify(file: string | undefined): Promise<number> {
  if (!file) {
    console.error("Give the package's file: npx tsx scripts/published-page.ts verify <file>");
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.error(`${file} could not be read.`);
    return 2;
  }
  // A file may be the package itself or the public graph's answer that wraps it ({ package, publisher_key }).
  let input: unknown = text;
  let key = argValue("key") ?? null;
  try {
    const parsed = JSON.parse(text) as { package?: unknown; publisher_key?: string | null };
    if (parsed && typeof parsed === "object" && parsed.package && typeof parsed.package === "object") {
      input = parsed.package;
      key = key ?? parsed.publisher_key ?? null;
    }
  } catch {
    // Left as text: the check says it is not JSON.
  }
  const check = await verifyPublishedPage(input, { publisherKey: key });
  const list = (title: string, lines: string[]) => {
    if (lines.length === 0) return;
    console.log(`\n${title}`);
    for (const line of lines) console.log(`  - ${line}`);
  };
  console.log(check.ok ? "This package checks out." : "This package does not check out.");
  list("Confirmed:", check.confirmed);
  list("Failed:", check.failed);
  list("What this check cannot show:", check.cannot_show);
  return check.ok ? 0 : 1;
}

async function main(): Promise<number> {
  const [command, arg] = positional;
  if (command === "verify") return verify(arg);
  if (command === "keygen") {
    const { generateSigningKey } = await import("../src/services/mirror-batch.js");
    const key = generateSigningKey();
    console.log("Private key, for PUBLISH_SIGNING_KEY. Keep it secret:\n");
    console.log(key.privateKeyPem);
    console.log(`Public key: ${key.publicKey}`);
    console.log(`Key id:     ${key.keyId}`);
    console.log("\nSet DEPLOYMENT_HOSTING to where this deployment runs, then register the key on the public graph with `registration`.");
    return 0;
  }
  await import("../src/load-env.js");
  const { OutboundError, buildOutboundPackages, publisherIdentity, signedRegistration } = await import("../src/services/outbound-service.js");
  const { closeDb, rawQuery } = await import("../src/db/client.js");
  try {
    if (command === "key") {
      const id = publisherIdentity();
      console.log(`Public key: ${id.public_key}`);
      console.log(`Key id:     ${id.key_id}`);
      console.log(`Runs on:    ${HOSTING_WORDS[id.hosting as keyof typeof HOSTING_WORDS]} (${id.hosting})`);
      return 0;
    }
    if (command === "registration") {
      if (!arg) {
        console.error("Give the sign-in identity of the organization's account on the public graph, for example github:12345.");
        return 2;
      }
      console.log(JSON.stringify(signedRegistration(arg), null, 2));
      return 0;
    }
    if (command === "build" || command === "export") {
      const built = await buildOutboundPackages();
      console.log(`${built} package${built === 1 ? "" : "s"} built.`);
      if (command === "export") {
        if (!arg) {
          console.error("Give a directory to write the packages to.");
          return 2;
        }
        const { withSystemClearance } = await import("../src/db/clearance.js");
        const rows = await withSystemClearance("An operator exports the packages of pages shown outside, which are at `public`.", () =>
          rawQuery<{ public_node_id: string; sequence: number; package: unknown }>(
            `SELECT public_node_id, sequence, package FROM outbound_packages ORDER BY showing_id, node_id, sequence`
          )
        );
        mkdirSync(arg, { recursive: true });
        for (const r of rows) {
          writeFileSync(join(arg, `published-page-${r.public_node_id}-${String(r.sequence).padStart(6, "0")}.json`), `${JSON.stringify(r.package, null, 2)}\n`);
        }
        console.log(`${rows.length} package${rows.length === 1 ? "" : "s"} written to ${arg}.`);
      }
      return 0;
    }
    console.error("Commands: verify <file>, keygen, key, registration <account>, build, export <dir>.");
    return 2;
  } catch (err) {
    if (err instanceof OutboundError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
