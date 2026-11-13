/**
 * The preflight's checks of what a private deployment adds
 * (src/preflight-deployment.ts): each over facts made up here. What they
 * read from a real database is in tests/db/preflight.test.ts.
 */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { loadConfig, type Config } from "../../src/config.js";
import {
  DEPLOYMENT_CHECKS,
  isEd25519PrivateKey,
  noDeploymentFacts,
  type DeploymentCheckFacts,
  type DeploymentFacts,
  type DeploymentTables,
} from "../../src/preflight-deployment.js";
import { MODELS } from "../../src/llm/models.js";

// Public Minerval's own settings with no key of any kind, then what a test sets.
const BARE = { stripeSecretKey: "", stripeWebhookSecret: "", publishSigningKey: "", publicGraphApiUrl: "", publicGraphApiKey: "", sandboxUrl: "", sandboxToken: "", fileSetStoreDir: "", fileSetDirectoryRoot: "", usageReportUrl: "", usageReportDir: "", usageReportApiKey: "", databaseTls: undefined, databaseCaFile: undefined, deploymentHosting: "", modelPrices: [], owls: "sold", reads: "open", env: "development" };
const config = (over: Record<string, unknown> = {}): Config => ({ ...loadConfig(), ...BARE, ...over }) as Config;
const members = (over: Record<string, unknown> = {}) => config({ reads: "members", ...over });

function facts(
  over: {
    config?: Config;
    holdsPrivate?: boolean | null;
    reachable?: boolean;
    tables?: Partial<DeploymentTables> | null;
    deployment?: Partial<DeploymentFacts>;
  } = {}
): DeploymentCheckFacts {
  const none = noDeploymentFacts();
  return {
    config: over.config ?? config(),
    holdsPrivate: over.holdsPrivate === undefined ? true : over.holdsPrivate,
    database: { reachable: over.reachable ?? true },
    deployment: {
      ...none,
      ...over.deployment,
      tables: over.tables === null ? null : { ...none.tables!, ...over.tables },
      ...(over.tables === null ? { tablesError: "permission denied" } : {}),
    },
  };
}

const run = (name: string, f: DeploymentCheckFacts) => DEPLOYMENT_CHECKS.find((c) => c.name === name)!.run(f);
const ED25519 = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const RSA = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("the checks as a list", () => {
  it("names each once, and blocks agent work on two, each for a reason written beside it", () => {
    expect(DEPLOYMENT_CHECKS.map((c) => c.name)).toEqual([
      "database_tls", "database_owner", "owls", "model_prices", "usage_report", "standing_mandates", "own_organization",
      "publishing", "public_graph", "public_acts", "private_run_fetches", "connections", "file_sets", "sandbox", "sandbox_confinement",
    ]);
    expect(DEPLOYMENT_CHECKS.filter((c) => c.blocking).map((c) => c.name)).toEqual(["model_prices", "sandbox_confinement"]);
  });

  it("asks nothing of a deployment that uses none of it: no check fails on public Minerval's settings", () => {
    const open = facts({ holdsPrivate: false });
    for (const check of DEPLOYMENT_CHECKS) expect(check.run(open).status, check.name).not.toBe("fail");
  });

  it("says so, and fails, where the deployment's tables could not be read", () => {
    const unread = facts({ config: members(), tables: null });
    for (const name of ["standing_mandates", "own_organization", "public_acts", "connections", "database_owner"]) {
      const out = run(name, unread);
      expect(out.status, name).toBe("fail");
      expect(out.message, name).toContain("could not be read (permission denied)");
    }
  });
});

describe("publishing and the public graph", () => {
  it("does not apply where nothing is shown outside and nothing is set", () => {
    expect(run("publishing", facts()).status).toBe("not_applicable");
  });

  it("fails an open showing outside with no key, a key that is not Ed25519, and a key with no hosting, and never prints the key", () => {
    expect(run("publishing", facts({ tables: { showingsOutside: 2 } })).message).toMatch(/2 showings to readers outside are open and PUBLISH_SIGNING_KEY is not set/);
    const rsa = run("publishing", facts({ config: config({ publishSigningKey: RSA, deploymentHosting: "own_machines" }) }));
    expect(rsa).toMatchObject({ status: "fail" });
    expect(rsa.message).toContain("is not an Ed25519 private key");
    const noHosting = run("publishing", facts({ config: config({ publishSigningKey: ED25519 }) }));
    expect(noHosting.message).toContain("Set it to own_machines, minerval or third_party.");
    const ok = run("publishing", facts({ config: config({ publishSigningKey: ED25519, deploymentHosting: "third_party" }) }));
    expect(ok).toMatchObject({ status: "pass" });
    for (const out of [rsa, noHosting, ok]) expect(out.message).not.toContain("PRIVATE KEY");
    expect(isEd25519PrivateKey(ED25519)).toBe(true);
    expect(isEd25519PrivateKey("not a key")).toBe(false);
  });

  it("wants an https address with its key, and passes a signing key with no address as carried by file", () => {
    expect(run("public_graph", facts()).status).toBe("not_applicable");
    expect(run("public_graph", facts({ config: config({ publishSigningKey: ED25519 }) })).message).toContain("carried as files");
    expect(run("public_graph", facts({ config: config({ publicGraphApiUrl: "http://api.minerval.ai" }) })).message).toContain("not an https address");
    expect(run("public_graph", facts({ config: config({ publicGraphApiUrl: "https://api.minerval.ai" }) })).message).toContain("PUBLIC_GRAPH_API_KEY is not");
    const ok = run("public_graph", facts({ config: config({ publicGraphApiUrl: "https://api.minerval.ai", publicGraphApiKey: "mk_secret" }) }));
    expect(ok.status).toBe("pass");
    expect(ok.message).not.toContain("mk_secret");
    expect(ok.message).toContain("nothing is sent to the public graph by this check");
  });

  it("says who may act on the public graph, and when nobody can", () => {
    expect(run("public_acts", facts()).status).toBe("not_applicable");
    expect(run("public_acts", facts({ config: members({ publicActsBy: "fund" }), tables: { publicActsHolders: 0 } })).message).toMatch(
      /acts_by is "fund".*nobody holds it now, so nobody can act on the public graph from here/
    );
    expect(run("public_acts", facts({ config: members(), tables: { publicActsHolders: 3 } })).message).toContain("3 grants of it are live.");
  });

  it("fails a members-only deployment with no party marked as the organization", () => {
    expect(run("own_organization", facts({ config: members() })).status).toBe("fail");
    expect(run("own_organization", facts({ config: members(), tables: { ownOrganization: true } })).status).toBe("pass");
    expect(run("own_organization", facts()).status).toBe("not_applicable");
  });
});

describe("owls, prices and the usage report", () => {
  it("fails settings that disagree in the sentence the load would give", () => {
    const out = run("owls", facts({ config: config({ owls: "created" }) }));
    expect(out.status).toBe("fail");
    expect(out.message).toContain("OWLS=created needs READS=members.");
    const grant = run("owls", facts({ config: members({ owls: "created" }), deployment: { grantsSet: { signup: 5, monthly: 0 } } }));
    expect(grant.message).toContain("OWLS=created and SIGNUP_GRANT_OWLS are both set.");
  });

  it("fails a members-only deployment that sells owls with payments off, where no account could get one", () => {
    const out = run("owls", facts({ config: members() }));
    expect(out.status).toBe("fail");
    expect(out.message).toContain("no account can get an owl and no mandate can be given a budget");
    expect(run("owls", facts({ config: members({ owls: "created" }) })).status).toBe("pass");
    expect(run("owls", facts({ config: members({ stripeSecretKey: "sk_test_x" }) })).status).toBe("pass");
    expect(run("owls", facts()).status).toBe("pass");
  });

  it("where owls are created, fails naming each configured model that has no price", () => {
    const unpriced = members({ owls: "created", stewardModel: "claude-unlisted-9" });
    const out = run("model_prices", facts({ config: unpriced }));
    expect(out.status).toBe("fail");
    expect(out.message).toContain("STEWARD_MODEL (claude-unlisted-9)");
    // Where owls are sold, an unpriced model is the rate table's to fall back on, and nothing is refused.
    expect(run("model_prices", facts({ config: config({ stewardModel: "claude-unlisted-9" }) })).status).toBe("pass");
    expect(run("model_prices", facts({ config: members({ owls: "created", stewardModel: MODELS.sonnet }) })).message).toMatch(/^No model price is stated/);
  });

  it("reports on the metered price only, to an address with its key or a directory that can be written", () => {
    expect(run("usage_report", facts()).status).toBe("not_applicable");
    expect(run("usage_report", facts({ config: members({ publicGraphPrice: "flat" }) })).status).toBe("not_applicable");
    expect(run("usage_report", facts({ config: members() })).message).toContain("reports are prepared and kept until one is");
    expect(run("usage_report", facts({ config: members({ usageReportUrl: "https://api.minerval.ai/usage-reports" }) })).message).toContain("USAGE_REPORT_API_KEY is not");
    const sent = run("usage_report", facts({ config: members({ usageReportUrl: "https://api.minerval.ai/usage-reports", usageReportApiKey: "mk_x", usageReportFrom: "2026-11-01" }) }));
    expect(sent).toMatchObject({ status: "pass" });
    expect(sent.message).toContain("The first day reported is 2026-11-01.");
    const dir = members({ usageReportDir: "/reports" });
    expect(run("usage_report", facts({ config: dir })).message).toContain("is not a directory this process can find");
    const there = { exists: true, directory: true, readable: true, writable: false };
    expect(run("usage_report", facts({ config: dir, deployment: { paths: { USAGE_REPORT_DIR: there } } })).message).toContain("cannot write to");
    expect(run("usage_report", facts({ config: dir, deployment: { paths: { USAGE_REPORT_DIR: { ...there, writable: true } } } })).status).toBe("pass");
  });
});

describe("a General mandate at each label", () => {
  it("fails naming the labels that hold material and have none, and passes naming the labels that have one", () => {
    const labels = [
      { label: "public", material: true, general: true },
      { label: "internal", material: true, general: false },
      { label: "restricted", material: false, general: false },
    ];
    const out = run("standing_mandates", facts({ config: members(), tables: { labels } }));
    expect(out.status).toBe("fail");
    expect(out.message).toContain('Material is held at "internal" and no General mandate is set up there');
    expect(out.message).not.toContain("restricted");
    labels[1]!.general = true;
    expect(run("standing_mandates", facts({ config: members(), tables: { labels } })).message).toContain('A General mandate is set up at "public", "internal"');
    expect(run("standing_mandates", facts({ config: members(), tables: { labels: [] } })).message).toContain("No General mandate is set up");
    expect(run("standing_mandates", facts()).status).toBe("not_applicable");
  });
});

describe("connections, file sets and the sandbox", () => {
  it("counts the connections whose credential variable is not set, by label, and names none", () => {
    expect(run("connections", facts({ config: members() })).status).toBe("not_applicable");
    const out = run(
      "connections",
      facts({ config: members(), tables: { connections: [{ label: "public", on: 1, credentialUnset: 0 }, { label: "internal", on: 3, credentialUnset: 2 }] } })
    );
    expect(out.status).toBe("fail");
    expect(out.message).toContain('4 connections are on, and 2 at "internal" name a credential variable (CONNECTION_...) that is not set');
    expect(out.message).toContain("this check calls no server");
  });

  it("wants the store writable and the registered root readable, and says the root carries no label", () => {
    expect(run("file_sets", facts()).status).toBe("not_applicable");
    const c = config({ fileSetStoreDir: "/store", fileSetDirectoryRoot: "/srv/registered" });
    const ok = { exists: true, directory: true, readable: true, writable: true };
    expect(run("file_sets", facts({ config: c })).message).toContain('file_sets.store_dir is "/store", which is not a directory');
    expect(run("file_sets", facts({ config: c, deployment: { paths: { FILE_SET_STORE_DIR: { ...ok, writable: false } } } })).message).toContain("cannot write to");
    const out = run("file_sets", facts({ config: c, deployment: { paths: { FILE_SET_STORE_DIR: ok, FILE_SET_DIRECTORY_ROOT: { ...ok, writable: false } } } }));
    expect(out.status).toBe("pass");
    expect(out.message).toContain("That directory carries no label of its own");
  });

  const answering = { configured: true, answers: true, failure: null, version: "1.2", image: "minerval-sandbox", limits: null, ok: true, checks: [
    { check: "commands_are_confined", ok: true, detail: "" },
    { check: "sets_are_read_only", ok: true, detail: "" },
    { check: "no_route_out", ok: true, detail: "" },
  ] };

  it("says file sets with no sandbox cannot be explored, and fails a sandbox with no token or no answer", () => {
    expect(run("sandbox", facts()).status).toBe("not_applicable");
    expect(run("sandbox", facts({ tables: { fileSets: 2 } }))).toMatchObject({ status: "pass" });
    expect(run("sandbox", facts({ tables: { fileSets: 2 } })).message).toContain("the 2 file sets this deployment holds cannot be explored by agents");
    const set = config({ sandboxUrl: "http://sandbox:8080" });
    expect(run("sandbox", facts({ config: set })).message).toContain("SANDBOX_TOKEN is not");
    const token = config({ sandboxUrl: "http://sandbox:8080", sandboxToken: "t", sandboxHourCostMicroUsd: 0 });
    expect(run("sandbox", facts({ config: token })).message).toContain("does not answer");
    const out = run("sandbox", facts({ config: token, deployment: { sandbox: answering } }));
    expect(out.status).toBe("pass");
    expect(out.message).toContain("Sandbox time is not charged to a run, and each run is told so.");
    expect(out.message).not.toContain('"t"');
  });

  it("fails, blocking, a probe check that failed, and does not apply to a sandbox that is absent or silent", () => {
    const token = config({ sandboxUrl: "http://sandbox:8080", sandboxToken: "t" });
    expect(run("sandbox_confinement", facts()).status).toBe("not_applicable");
    expect(run("sandbox_confinement", facts({ config: token })).status).toBe("not_applicable");
    expect(run("sandbox_confinement", facts({ config: token, deployment: { sandbox: answering } })).status).toBe("pass");
    const open = { ...answering, ok: false, checks: [answering.checks[0]!, { check: "no_route_out", ok: false, detail: "connected to 1.1.1.1:443" }] };
    const out = run("sandbox_confinement", facts({ config: token, deployment: { sandbox: open } }));
    expect(out.status).toBe("fail");
    expect(out.message).toContain("no_route_out (connected to 1.1.1.1:443)");
  });
});

describe("the addresses a private run's tools take", () => {
  it("says which it is, what turning it on guards against and costs, and fails neither way", () => {
    expect(run("private_run_fetches", facts({ holdsPrivate: false })).status).toBe("not_applicable");
    const off = run("private_run_fetches", facts());
    expect(off.status).toBe("pass");
    expect(off.message).toContain('private_runs.fetches is "any", the starting value');
    const on = run("private_run_fetches", facts({ config: config({ privateRunFetches: "given" }) }));
    expect(on.status).toBe("pass");
    expect(on.message).toContain("It narrows that way out and does not close it");
    expect(on.message).toContain("It costs research");
  });
});

describe("the database's connection and owner", () => {
  it("passes tls off with when that is right, and wants a ca_file that holds a certificate", () => {
    expect(run("database_tls", facts({ config: config({ databaseTls: "off" }) })).message).toContain("right only where the database is on a network of the deployment's own");
    const ca = config({ databaseCaFile: "/etc/ca.pem" });
    expect(run("database_tls", facts({ config: ca })).message).toContain("cannot read");
    const there = { exists: true, directory: false, readable: true, writable: false };
    expect(run("database_tls", facts({ config: ca, deployment: { paths: { DATABASE_CA_FILE: there }, caFileIsCertificate: false } })).message).toContain("does not hold a certificate");
    expect(run("database_tls", facts({ config: ca, deployment: { paths: { DATABASE_CA_FILE: there }, caFileIsCertificate: true } })).status).toBe("pass");
  });

  it("in production, names the two settings when a database that is not on RDS cannot be reached", () => {
    const own = config({ env: "production", dbHost: "db.internal" });
    const out = run("database_tls", facts({ config: own, reachable: false }));
    expect(out.status).toBe("fail");
    expect(out.message).toContain("database.ca_file (DATABASE_CA_FILE)");
    expect(out.message).toContain('database.tls = "off" (DATABASE_TLS=off)');
    expect(run("database_tls", facts({ config: config({ env: "production", dbHost: "x.abc.us-east-1.rds.amazonaws.com" }), reachable: false })).status).toBe("pass");
  });

  it("fails an owner that is a superuser where a second label exists, and asks nothing where public is the only one", () => {
    expect(run("database_owner", facts({ holdsPrivate: false })).status).toBe("not_applicable");
    expect(run("database_owner", facts()).status).toBe("pass");
    const out = run("database_owner", facts({ tables: { owner: { role: "postgres", superuser: true } } }));
    expect(out.status).toBe("fail");
    expect(out.message).toContain("The role in DATABASE_URL (postgres) is a superuser.");
  });
});
