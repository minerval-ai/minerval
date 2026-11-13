/**
 * The preflight's checks of what a private deployment adds to public
 * Minerval's settings (src/preflight.ts runs them with the rest;
 * docs/deployment.md lists them): the key and hosting a shown page is
 * signed under, the public graph the deployment acts on, owls it creates
 * and the prices it states, the usage report, the General mandate at each
 * label, connections, file sets, the sandbox, who may act outside, and how
 * the database is reached.
 *
 * They are written as the others are: plain functions of facts gathered
 * first, each answering pass, fail or not applicable with a sentence for
 * whoever is installing. A setting a deployment has not used is not
 * applicable, never a failure: nothing here asks a deployment to turn
 * something on.
 *
 * Three things differ from the checks beside them, each for its reason.
 *
 *  - Some facts are counted over every label (gatherDeploymentFacts): how
 *    many pages are shown outside, whether a General mandate is set up at
 *    each label that holds material, how many connections name a credential
 *    that is not set. The preflight is read by whoever holds the operator
 *    key and by administrators, neither of whom reads every label, and the
 *    question is about the whole deployment. So it is read under system
 *    clearance and reduced, before it leaves this module, to counts and the
 *    names of labels. No row's text is read.
 *  - The sandbox is asked. No other check calls anything, but the sandbox
 *    is the deployment's own service, on a network of its own, and what
 *    matters about it (that a command cannot reach out, that the sets
 *    cannot be written) is true or false of the running container and of
 *    nothing in the configuration.
 *  - Connections are not asked. A connection's server is the organization's
 *    own system, a check of it calls out and can withdraw a tool it finds
 *    changed, and that belongs to the administrators' own check
 *    (checkConnections, services/connection-service.ts). Here only what the
 *    environment holds is looked at: whether the variable a connection
 *    names is set.
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { settingsThatDisagree, type Config } from "./config.js";
import { rawQuery } from "./db/client.js";
import { withSystemClearance } from "./db/clearance.js";
import { PUBLIC_LABEL } from "./labels.js";
import { unpricedConfiguredModels } from "./llm/pricing.js";
import { checkSandbox, type SandboxCheck } from "./services/sandbox-client.js";

export type DeploymentOutcome = { status: "pass" | "fail" | "not_applicable"; message: string };

/** What a path a setting names is, as this process finds it. */
export interface PathFacts {
  exists: boolean;
  directory: boolean;
  readable: boolean;
  writable: boolean;
}

/** What the deployment's own tables say, over every label, as counts and label names. */
export interface DeploymentTables {
  /** Standing or single showings to readers outside that have not ended. */
  showingsOutside: number;
  /** Whether a party is marked as the organization itself. */
  ownOrganization: boolean;
  /** Live grants of the permission PUBLIC_ACTS_BY names, to accounts and groups. */
  publicActsHolders: number;
  /** The role the tables' owner connects as, and whether it is a superuser. */
  owner: { role: string; superuser: boolean };
  /** For each label: whether it holds material of the deployment's own, and whether a General mandate is set up there. */
  labels: Array<{ label: string; material: boolean; general: boolean }>;
  /** For each label with a connection that is on: how many, and how many name a credential variable that is not set. */
  connections: Array<{ label: string; on: number; credentialUnset: number }>;
  /** File sets that are on. */
  fileSets: number;
}

export interface DeploymentFacts {
  /** Null when the tables could not be read; `tablesError` then says why. */
  tables: DeploymentTables | null;
  tablesError: string | null;
  /** The sandbox as it answers now; null where the deployment names none. */
  sandbox: SandboxCheck | null;
  /** The paths the settings name, by setting; absent where the setting is empty. */
  paths: Partial<Record<"FILE_SET_STORE_DIR" | "FILE_SET_DIRECTORY_ROOT" | "USAGE_REPORT_DIR" | "DATABASE_CA_FILE", PathFacts>>;
  /** Whether DATABASE_CA_FILE holds a certificate; null where it is not set or cannot be read. */
  caFileIsCertificate: boolean | null;
  /** The free grants the deployment's own settings ask for, in owls. */
  grantsSet: { signup: number; monthly: number };
}

export interface DeploymentCheckFacts {
  config: Config;
  holdsPrivate: boolean | null;
  database: { reachable: boolean; error?: string };
  deployment: DeploymentFacts;
}

const pass = (message: string): DeploymentOutcome => ({ status: "pass", message });
const fail = (message: string): DeploymentOutcome => ({ status: "fail", message });
const notApplicable = (message: string): DeploymentOutcome => ({ status: "not_applicable", message });

const members = (config: Config) => config.reads === "members";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quoted = (labels: readonly string[]) => labels.map((l) => `"${l}"`).join(", ");

const NOT_MEMBERS = "This deployment is open to anyone to read (READS=open), where this setting is not used.";
const tablesUnread = (facts: DeploymentCheckFacts) =>
  `This could not be checked: the deployment's tables could not be read (${facts.deployment.tablesError ?? "no reason given"}).`;

/** Whether `pem` is an Ed25519 private key. Never returns or logs the key. */
export function isEd25519PrivateKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

function httpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Showing pages outside, and the public graph
// ---------------------------------------------------------------------------

const HOSTINGS = "own_machines, minerval or third_party";

function checkPublishing(facts: DeploymentCheckFacts): DeploymentOutcome {
  const { config } = facts;
  const tables = facts.deployment.tables;
  const key = config.publishSigningKey.trim();
  const hosting = config.deploymentHosting;
  const shown = tables?.showingsOutside ?? 0;
  if (!(config.publishedPageMaxBytes > 0)) {
    return fail(`PUBLISHED_PAGE_MAX_BYTES is ${config.publishedPageMaxBytes}; it is the largest package built or admitted, in bytes, and must be above zero.`);
  }
  if (!key && !hosting && shown === 0) {
    if (!tables) return fail(tablesUnread(facts));
    return notApplicable("No page is shown outside this deployment and no signing key or hosting is set, so nothing is signed.");
  }
  if (!key) {
    return fail(
      (shown > 0
        ? `${plural(shown, "showing")} to readers outside ${shown === 1 ? "is" : "are"} open`
        : `deployment_hosting is "${hosting}"`) +
        " and PUBLISH_SIGNING_KEY is not set, so no package of a shown page can be built. Set it in the environment: " +
        "an Ed25519 private key in PEM form. It is a secret and is not kept in the config file."
    );
  }
  if (!isEd25519PrivateKey(key)) {
    return fail("PUBLISH_SIGNING_KEY is set but is not an Ed25519 private key in PEM form, so no package can be signed with it.");
  }
  if (!hosting) {
    return fail(
      `PUBLISH_SIGNING_KEY is set and publishing.hosting (DEPLOYMENT_HOSTING) is not, so no package is built: every package states where the deployment runs. Set it to ${HOSTINGS}.`
    );
  }
  return pass(
    `Packages of shown pages are signed with the deployment's Ed25519 key and state that it runs on ${hosting.replace(/_/g, " ")}.` +
      (shown > 0 ? ` ${plural(shown, "showing")} to readers outside ${shown === 1 ? "is" : "are"} open.` : "")
  );
}

function checkPublicGraph({ config }: DeploymentCheckFacts): DeploymentOutcome {
  const url = config.publicGraphApiUrl.trim();
  const key = config.publicGraphApiKey.trim();
  const signs = config.publishSigningKey.trim().length > 0;
  if (!url) {
    if (key) return fail("PUBLIC_GRAPH_API_KEY is set but public_graph.api_url (PUBLIC_GRAPH_API_URL) is not, so the key is used for nothing.");
    return signs
      ? pass("No address of the public graph is set, so packages of shown pages are carried as files and nothing is sent or done there from here.")
      : notApplicable("No address of the public graph is set, so this deployment sends nothing to it and does nothing there.");
  }
  if (!httpsUrl(url)) {
    return fail(`public_graph.api_url is "${url}", which is not an https address; it is the public graph's API, for example "https://api.minerval.ai".`);
  }
  if (!key) {
    return fail(
      "public_graph.api_url is set and PUBLIC_GRAPH_API_KEY is not, so nothing can be sent or done on the public graph: every act there is made under the organization's own account. Set the key in the environment; it is a secret."
    );
  }
  return pass(`The public graph is reached at ${url} under the organization's own account key. The key is not tried here: nothing is sent to the public graph by this check.`);
}

function checkOwnOrganization(facts: DeploymentCheckFacts): DeploymentOutcome {
  if (!members(facts.config)) return notApplicable(NOT_MEMBERS.replace("this setting is", "parties are"));
  const tables = facts.deployment.tables;
  if (!tables) return fail(tablesUnread(facts));
  if (tables.ownOrganization) return pass("A party is marked as the organization itself.");
  return fail(
    "No party is marked as the organization itself, so a request to show a page is refused: a page's parts are released party by party, and the organization's own material has nobody to release it. " +
      "It is made at the first administrator's sign-in; where that came before this version, an administrator adds the organization as a party and marks it (the labels and parties page)."
  );
}

function checkPublicActs(facts: DeploymentCheckFacts): DeploymentOutcome {
  const { config } = facts;
  if (!members(config)) return notApplicable(NOT_MEMBERS);
  const tables = facts.deployment.tables;
  if (!tables) return fail(tablesUnread(facts));
  const who = `public_graph.acts_by is "${config.publicActsBy}": holders of that permission may act on the public graph in the organization's name`;
  if (tables.publicActsHolders > 0) {
    return pass(`${who}. ${plural(tables.publicActsHolders, "grant")} of it ${tables.publicActsHolders === 1 ? "is" : "are"} live.`);
  }
  return pass(`${who}, and nobody holds it now, so nobody can act on the public graph from here until an administrator grants it.`);
}

// ---------------------------------------------------------------------------
// Owls, prices and the usage report
// ---------------------------------------------------------------------------

function checkOwls(facts: DeploymentCheckFacts): DeploymentOutcome {
  const { config } = facts;
  const disagree = settingsThatDisagree(config, facts.deployment.grantsSet);
  if (disagree) return fail(disagree);
  if (config.owls === "created") {
    return pass("This deployment creates its own owls: an administrator creates them, each act is logged, and nothing is sold.");
  }
  const stripe = config.stripeSecretKey.startsWith("sk_") || config.stripeSecretKey.startsWith("rk_");
  if (!members(config)) return pass(stripe ? "Owls are sold through Stripe." : "Owls are sold, and no Stripe key is set, so none can be bought.");
  if (stripe && config.paymentsEnabled !== "false") return pass("Owls are sold to this deployment's members through Stripe.");
  const granted = facts.deployment.grantsSet.signup > 0 || facts.deployment.grantsSet.monthly > 0;
  return fail(
    "Owls are sold here (pricing.owls is \"sold\") and payments are off, so " +
      (granted
        ? "the only owls an account gets are the grants this deployment sets, and a mandate cannot be given a budget beyond them. "
        : "no account can get an owl and no mandate can be given a budget, and no agent work runs without one. ") +
      'Set pricing.owls = "created" (OWLS=created) for the deployment to create its own, or configure payments.'
  );
}

function checkModelPrices({ config }: DeploymentCheckFacts): DeploymentOutcome {
  const stated = config.modelPrices.length;
  const said = stated > 0 ? `${plural(stated, "model price")} ${stated === 1 ? "is" : "are"} stated (pricing.model_prices).` : "No model price is stated; the rate table prices every call.";
  if (config.owls !== "created") return pass(said);
  const unpriced = unpricedConfiguredModels(config);
  if (unpriced.length === 0) return pass(`${said} Every model a role is set to has a price.`);
  return fail(
    `This deployment creates its own owls, where a run on a model with no price is refused, and ${plural(unpriced.length, "configured model has", "configured models have")} none: ` +
      `${unpriced.map((u) => `${u.setting} (${u.model})`).join(", ")}. State a price for each in pricing.model_prices (MODEL_PRICES), 0 for a model you count as free.`
  );
}

function checkUsageReport(facts: DeploymentCheckFacts): DeploymentOutcome {
  const { config } = facts;
  if (!members(config)) return notApplicable("The public graph reports its usage to no one.");
  if (config.publicGraphPrice === "flat") {
    return notApplicable('public_graph.price is "flat": this deployment pays a flat price for the feed and reports no usage.');
  }
  if (!(config.usageReportIntervalSeconds > 0)) {
    return fail(`USAGE_REPORT_INTERVAL_SECONDS is ${config.usageReportIntervalSeconds}; it is how often reports are prepared and sent, in seconds, and must be above zero.`);
  }
  const from = config.usageReportFrom ? ` The first day reported is ${config.usageReportFrom}.` : "";
  if (config.usageReportUrl && config.usageReportDir) return fail(settingsThatDisagree(config, { signup: 0, monthly: 0 }) ?? "USAGE_REPORT_URL and USAGE_REPORT_DIR are both set. Set one of them.");
  if (config.usageReportDir) {
    const dir = facts.deployment.paths.USAGE_REPORT_DIR;
    if (!dir?.exists || !dir.directory) return fail(`usage_report.dir is "${config.usageReportDir}", which is not a directory this process can find, so no report can be written there.`);
    if (!dir.writable) return fail(`usage_report.dir is "${config.usageReportDir}", which this process cannot write to, so no report can be written there.`);
    return pass(`Usage is reported as files written to ${config.usageReportDir}, to be handed over: one total of owls spent for each day, and nothing about what the work was on.${from}`);
  }
  if (config.usageReportUrl) {
    if (!config.usageReportApiKey) {
      return fail("usage_report.url is set and USAGE_REPORT_API_KEY is not, so reports are prepared and none can be sent. Set the key in the environment: an API key of the organization's account on the public graph.");
    }
    return pass(`Usage is reported to ${config.usageReportUrl}: one total of owls spent for each day, and nothing about what the work was on.${from}`);
  }
  return pass(`Usage is metered and no destination is set (usage_report.url or usage_report.dir), so reports are prepared and kept until one is.${from}`);
}

// ---------------------------------------------------------------------------
// Attention at each label
// ---------------------------------------------------------------------------

function checkStandingMandates(facts: DeploymentCheckFacts): DeploymentOutcome {
  if (!members(facts.config)) return notApplicable("The public graph's General mandate is set up by its seed script, not here.");
  const tables = facts.deployment.tables;
  if (!tables) return fail(tablesUnread(facts));
  const holding = tables.labels.filter((l) => l.material);
  const without = holding.filter((l) => !l.general).map((l) => l.label);
  const withOne = tables.labels.filter((l) => l.general).map((l) => l.label);
  if (without.length > 0) {
    return fail(
      `Material is held at ${quoted(without)} and no General mandate is set up there, so nobody pays for its upkeep or its audits: a mandate's work runs at its label. An administrator who reads the label sets one up (the owls page).`
    );
  }
  if (withOne.length === 0) {
    return fail("No General mandate is set up, so upkeep and audits have no mandate to pay for them. An administrator sets one up (the owls page).");
  }
  return pass(`A General mandate is set up at ${quoted(withOne)}${holding.length > 0 ? ", which is every label that holds material of this deployment's own" : ""}.`);
}

// ---------------------------------------------------------------------------
// Connections, file sets and the sandbox
// ---------------------------------------------------------------------------

function checkConnections(facts: DeploymentCheckFacts): DeploymentOutcome {
  if (!members(facts.config)) return notApplicable(NOT_MEMBERS.replace("this setting is", "connections are"));
  const tables = facts.deployment.tables;
  if (!tables) return fail(tablesUnread(facts));
  const on = tables.connections.reduce((n, c) => n + c.on, 0);
  if (on === 0) return notApplicable("No connection is on.");
  const unset = tables.connections.filter((c) => c.credentialUnset > 0);
  const note = " Whether each server answers, and which of its tools are offered, is on the connections page; this check calls no server.";
  if (unset.length === 0) return pass(`${plural(on, "connection is", "connections are")} on, and every credential variable they name is set.${note}`);
  return fail(
    `${plural(on, "connection is", "connections are")} on, and ${unset
      .map((c) => `${c.credentialUnset} at "${c.label}"`)
      .join(", ")} name a credential variable (CONNECTION_...) that is not set in the environment, so their calls would go without a credential.${note}`
  );
}

function checkFileSets(facts: DeploymentCheckFacts): DeploymentOutcome {
  const { config } = facts;
  if (!(config.fileSetUploadMaxBytes >= 1)) {
    return fail(`FILE_SET_UPLOAD_MAX_BYTES is ${config.fileSetUploadMaxBytes}; it is the most an uploaded set may hold, in bytes, and must be a whole number above zero.`);
  }
  const store = config.fileSetStoreDir.trim();
  const root = config.fileSetDirectoryRoot.trim();
  if (!store && !root) return notApplicable("Neither file_sets.store_dir nor file_sets.directory_root is set, so no set of files can be added.");
  const said: string[] = [];
  if (store) {
    const at = facts.deployment.paths.FILE_SET_STORE_DIR;
    if (!at?.exists || !at.directory) return fail(`file_sets.store_dir is "${store}", which is not a directory this process can find, so an uploaded set has nowhere to be kept.`);
    if (!at.writable) return fail(`file_sets.store_dir is "${store}", which this process cannot write to, so an uploaded set cannot be kept.`);
    said.push(`Uploaded sets are kept in ${store}.`);
  } else {
    said.push("file_sets.store_dir is not set, so sets cannot be uploaded.");
  }
  if (root) {
    const at = facts.deployment.paths.FILE_SET_DIRECTORY_ROOT;
    if (!at?.exists || !at.directory) return fail(`file_sets.directory_root is "${root}", which is not a directory this process can find, so no directory can be registered from it.`);
    if (!at.readable) return fail(`file_sets.directory_root is "${root}", which this process cannot read, so no directory can be registered from it.`);
    said.push(
      `Directories are registered from ${root}. That directory carries no label of its own: the administrator who registers a directory under it says which label its files get.`
    );
  }
  return pass(said.join(" "));
}

function checkSandboxService(facts: DeploymentCheckFacts): DeploymentOutcome {
  const { config } = facts;
  if (!(config.sandboxHourCostMicroUsd >= 0)) {
    return fail(`sandbox.hour_cost_micro_usd is ${config.sandboxHourCostMicroUsd}; it is what an hour of sandbox time is charged to a run, and cannot be below zero.`);
  }
  const sandbox = facts.deployment.sandbox;
  const sets = facts.deployment.tables?.fileSets ?? 0;
  if (!config.sandboxUrl.trim()) {
    if (config.sandboxToken.trim()) return fail("SANDBOX_TOKEN is set but sandbox.url (SANDBOX_URL) is not, so there is no sandbox to use it with.");
    return sets > 0
      ? pass(`No sandbox is configured (sandbox.url), so the ${plural(sets, "file set")} this deployment holds cannot be explored by agents. Everything else works.`)
      : notApplicable("No sandbox is configured (sandbox.url), and no file set is held.");
  }
  if (!config.sandboxToken.trim()) {
    return fail("sandbox.url is set and SANDBOX_TOKEN is not, so the sandbox would refuse every request. Set the token in the environment, the same one the sandbox service is given; it is a secret.");
  }
  if (!sandbox || !sandbox.answers) {
    return fail(`The sandbox at ${config.sandboxUrl} does not answer${sandbox?.failure ? ` (${sandbox.failure.message})` : ""}, so no agent can run a command over a file set.`);
  }
  const charged =
    config.sandboxHourCostMicroUsd === 0
      ? "Sandbox time is not charged to a run, and each run is told so."
      : `An hour of sandbox time is charged to a run at ${config.sandboxHourCostMicroUsd / 1_000_000} USD.`;
  return pass(
    `The sandbox answers${sandbox.version ? `, version ${sandbox.version}` : ""}${sandbox.image ? `, image ${sandbox.image}` : ""}. ${charged}`
  );
}

function checkSandboxConfinement(facts: DeploymentCheckFacts): DeploymentOutcome {
  const sandbox = facts.deployment.sandbox;
  if (!facts.config.sandboxUrl.trim()) return notApplicable("No sandbox is configured, so no command is run over a file set.");
  if (!sandbox || !sandbox.answers) return notApplicable("The sandbox does not answer (see the sandbox check), so its own checks could not be run and no command runs in it.");
  const failed = sandbox.checks.filter((c) => !c.ok);
  if (sandbox.checks.length === 0) {
    return fail(`The sandbox answered but its own checks could not be run${sandbox.failure ? ` (${sandbox.failure.message})` : ""}, so it is not known whether a command in it is confined.`);
  }
  if (failed.length === 0) {
    return pass(`The sandbox's own checks pass (${sandbox.checks.map((c) => c.check).join(", ")}): a command is held to its run's file sets, the sets cannot be written, and nothing in it reaches a network.`);
  }
  return fail(
    `The sandbox's own checks fail: ${failed.map((c) => `${c.check} (${c.detail})`).join("; ")}. ` +
      "That the files never leave rests on these, so agent work is held where the deployment holds private material until they pass (sandbox/README.md says what each needs)."
  );
}

// ---------------------------------------------------------------------------
// The database's connection and its owner
// ---------------------------------------------------------------------------

function isRdsHost(host: string): boolean {
  return /\.rds\.amazonaws\.com(\.cn)?$/i.test(host.trim());
}

function checkDatabaseTls(facts: DeploymentCheckFacts): DeploymentOutcome {
  const { config } = facts;
  if (config.databaseTls === "off") {
    return pass(
      "database.tls is \"off\": connections to the database are not encrypted. That is right only where the database is on a network of the deployment's own that nothing else can reach."
    );
  }
  if (config.databaseCaFile) {
    const at = facts.deployment.paths.DATABASE_CA_FILE;
    if (!at?.exists || !at.readable) return fail(`database.ca_file is "${config.databaseCaFile}", which this process cannot read, so the database's certificate cannot be checked against it.`);
    if (facts.deployment.caFileIsCertificate === false) return fail(`database.ca_file is "${config.databaseCaFile}", which does not hold a certificate in PEM form.`);
    return pass(`The database's certificate is checked against the authority in ${config.databaseCaFile}.`);
  }
  if (config.env !== "production") return pass("Outside production the database is reached without TLS unless database.ca_file names an authority.");
  if (isRdsHost(config.dbHost ?? "")) return pass("The database's certificate is checked against the RDS authorities that ship with the code.");
  const which =
    'give database.ca_file (DATABASE_CA_FILE) the path of the authority its certificate is signed by, or, where the database is on a network of the deployment\'s own, set database.tls = "off" (DATABASE_TLS=off)';
  if (!facts.database.reachable) {
    return fail(`The database is not on RDS and neither database.ca_file nor database.tls is set, so its certificate is checked against the RDS authorities and the connection fails: ${which}.`);
  }
  return pass(`The database is reached with its certificate checked against the authorities that ship with the code. For a database that is not on RDS, ${which}.`);
}

function checkDatabaseOwner(facts: DeploymentCheckFacts): DeploymentOutcome {
  const tables = facts.deployment.tables;
  if (facts.holdsPrivate === false) return notApplicable("Where public is the only label no read is held, so it does not matter which role owns the tables.");
  if (!tables) return fail(tablesUnread(facts));
  if (!tables.owner.superuser) {
    return pass(`The role the tables' owner connects as (${tables.owner.role}) is not a superuser. Reads are held on another role's connections, which it does not bypass.`);
  }
  return fail(
    `The role in DATABASE_URL (${tables.owner.role}) is a superuser. Reads are held by row-level security, which a superuser's connections pass, and that role should be the tables' owner and nothing more: make an owner role that may create roles and is not a superuser (deploy/postgres/10-owner.sh does this for the packaged database).`
  );
}

/** The checks, in the order they are reported, after the ones every deployment has. */
export const DEPLOYMENT_CHECKS: ReadonlyArray<{
  name: string;
  blocking: boolean;
  run: (facts: DeploymentCheckFacts) => DeploymentOutcome;
}> = [
  { name: "database_tls", blocking: false, run: checkDatabaseTls },
  { name: "database_owner", blocking: false, run: checkDatabaseOwner },
  { name: "owls", blocking: false, run: checkOwls },
  // A run on a model with no price is refused where owls are created, and
  // what a run spent is what the usage report totals: held until every
  // configured model has a price.
  { name: "model_prices", blocking: true, run: checkModelPrices },
  { name: "usage_report", blocking: false, run: checkUsageReport },
  { name: "standing_mandates", blocking: false, run: checkStandingMandates },
  { name: "own_organization", blocking: false, run: checkOwnOrganization },
  { name: "publishing", blocking: false, run: checkPublishing },
  { name: "public_graph", blocking: false, run: checkPublicGraph },
  { name: "public_acts", blocking: false, run: checkPublicActs },
  { name: "connections", blocking: false, run: checkConnections },
  { name: "file_sets", blocking: false, run: checkFileSets },
  { name: "sandbox", blocking: false, run: checkSandboxService },
  // That the files never leave rests on the sandbox's confinement.
  { name: "sandbox_confinement", blocking: true, run: checkSandboxConfinement },
];

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

function pathFacts(path: string): PathFacts {
  const can = (mode: number) => {
    try {
      accessSync(path, mode);
      return true;
    } catch {
      return false;
    }
  };
  let directory = false;
  let exists = false;
  try {
    directory = statSync(path).isDirectory();
    exists = true;
  } catch {
    // Left false: the path is not there, or cannot be looked at.
  }
  return { exists, directory, readable: exists && can(constants.R_OK), writable: exists && can(constants.W_OK) };
}

/** Why the deployment's tables are read past the labels (tests/unit/db/system-clearance.test.ts). */
export const DEPLOYMENT_TABLES_REASON =
  "The preflight asks about the whole deployment, whoever reads it: counts over every label of showings, mandates, connections and file sets.";

const GENERAL_SEED_KEY = "general-assessment";

async function readDeploymentTables(config: Config): Promise<DeploymentTables> {
  const [one] = await rawQuery<{
    showings_outside: number;
    own_organization: boolean;
    holders: number;
    role: string;
    superuser: boolean;
    file_sets: number;
  }>(
    `SELECT (SELECT count(*) FROM showings WHERE to_outside AND ended_at IS NULL)::int AS showings_outside,
            EXISTS (SELECT 1 FROM parties WHERE is_own_organization) AS own_organization,
            (SELECT count(*) FROM permission_grants WHERE permission = $1 AND removed_at IS NULL)::int AS holders,
            current_user::text AS role,
            COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS superuser,
            (SELECT count(*) FROM file_sets WHERE enabled)::int AS file_sets`,
    [config.publicActsBy]
  );
  const labels = await rawQuery<{ label: string; material: boolean; general: boolean }>(
    `SELECT l.name AS label,
            (EXISTS (SELECT 1 FROM claims c WHERE c.sensitivity_label = l.name AND c.origin = 'local')
             OR EXISTS (SELECT 1 FROM sources s WHERE s.sensitivity_label = l.name AND s.origin = 'local')) AS material,
            EXISTS (SELECT 1 FROM grants g
                     WHERE g.is_platform AND g.status = 'active' AND g.mandate->>'seed_key' = $1
                       AND g.sensitivity_label = l.name) AS general
       FROM labels l`,
    [GENERAL_SEED_KEY]
  );
  const connections = await rawQuery<{ label: string; credential_env: string | null }>(
    `SELECT sensitivity_label AS label, credential_env FROM connections WHERE enabled`
  );
  const byLabel = new Map<string, { on: number; credentialUnset: number }>();
  for (const c of connections) {
    const at = byLabel.get(c.label) ?? { on: 0, credentialUnset: 0 };
    at.on += 1;
    if (c.credential_env && !process.env[c.credential_env]) at.credentialUnset += 1;
    byLabel.set(c.label, at);
  }
  const order = (a: { label: string }, b: { label: string }) =>
    a.label === PUBLIC_LABEL ? -1 : b.label === PUBLIC_LABEL ? 1 : a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  return {
    showingsOutside: one?.showings_outside ?? 0,
    ownOrganization: one?.own_organization === true,
    publicActsHolders: one?.holders ?? 0,
    owner: { role: one?.role ?? "", superuser: one?.superuser === true },
    labels: labels.sort(order),
    connections: [...byLabel.entries()].map(([label, c]) => ({ label, ...c })).sort(order),
    fileSets: one?.file_sets ?? 0,
  };
}

/** Gather what the checks above look at. `reachable` is whether the database answered the preflight's first question. */
export async function gatherDeploymentFacts(config: Config, reachable: boolean): Promise<DeploymentFacts> {
  let tables: DeploymentTables | null = null;
  let tablesError: string | null = reachable ? null : "the database cannot be reached";
  if (reachable) {
    try {
      tables = await withSystemClearance(DEPLOYMENT_TABLES_REASON, () => readDeploymentTables(config));
    } catch (err) {
      tablesError = (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);
    }
  }
  const paths: DeploymentFacts["paths"] = {};
  if (config.fileSetStoreDir.trim()) paths.FILE_SET_STORE_DIR = pathFacts(config.fileSetStoreDir.trim());
  if (config.fileSetDirectoryRoot.trim()) paths.FILE_SET_DIRECTORY_ROOT = pathFacts(config.fileSetDirectoryRoot.trim());
  if (config.usageReportDir) paths.USAGE_REPORT_DIR = pathFacts(config.usageReportDir);
  let caFileIsCertificate: boolean | null = null;
  if (config.databaseCaFile) {
    paths.DATABASE_CA_FILE = pathFacts(config.databaseCaFile);
    try {
      new X509Certificate(readFileSync(config.databaseCaFile));
      caFileIsCertificate = true;
    } catch {
      caFileIsCertificate = paths.DATABASE_CA_FILE.readable ? false : null;
    }
  }
  const sandbox = config.sandboxUrl.trim() ? await checkSandbox(config).catch(() => null) : null;
  return {
    tables,
    tablesError,
    sandbox,
    paths,
    caFileIsCertificate,
    grantsSet: {
      signup: Number(process.env.SIGNUP_GRANT_OWLS) || 0,
      monthly: Number(process.env.MONTHLY_GRANT_OWLS) || 0,
    },
  };
}

/** Facts for a deployment that uses none of this: what a test of the other checks starts from. */
export function noDeploymentFacts(): DeploymentFacts {
  return {
    tables: {
      showingsOutside: 0,
      ownOrganization: false,
      publicActsHolders: 0,
      owner: { role: "minerval_owner", superuser: false },
      labels: [],
      connections: [],
      fileSets: 0,
    },
    tablesError: null,
    sandbox: null,
    paths: {},
    caFileIsCertificate: null,
    grantsSet: { signup: 0, monthly: 0 },
  };
}
