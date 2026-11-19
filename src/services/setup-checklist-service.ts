/**
 * The setup checklist of a members-only deployment
 * (docs/deployment.md, "The setup checklist"): one read of what an administrator needs in
 * order to see what has been set up and what is still to do.
 *
 * It decides nothing and holds no list of steps. Each part is a fact the
 * deployment can see about itself: its own checks of its configuration,
 * where the build has them (services/deployment-checks.ts), who holds each
 * permission, which labels exist and which providers are cleared for each,
 * whether the standing mandates exist and have a budget, whether every
 * model has a price, where the usage reports go, how the connections
 * stand, and how much material is in. Nothing is marked done because a
 * person said so. The page that shows it (web/app/admin) turns the facts
 * into what to do next and where.
 *
 * Every part but three is read through the service that already serves it
 * to its own route (permissions, labels, parties, standing mandates, owls,
 * usage reports, connections), so the checklist and those pages cannot
 * disagree. The three that have no route of their own are read here: the
 * deployment's own checks, which providers are cleared for which label (a
 * setting, src/provider-labels.ts), and the counts of material.
 *
 * What an administrator is shown here is held to what they read, like
 * every read (db/clearance.ts): the connections and the standing mandates
 * are the ones at labels the administrator reads, and the part for
 * connections says how many it leaves out. Two things are counted past
 * that, under system clearance, because the question is about the whole
 * deployment and the answer is a number: how much material is in at all,
 * by the party it belongs to, and how many connections there are. A count
 * names no row, and no label of any row is returned.
 */
import { loadConfig, type Config } from "../config.js";
import { rawQuery } from "../db/client.js";
import { withSystemClearance } from "../db/clearance.js";
import { featureOn, type FeatureName } from "../features.js";
import { PUBLIC_LABEL } from "../labels.js";
import { resolveProvider } from "../llm/providers/routing.js";
import { PERMISSION_DEFINITIONS, PERMISSIONS, type PermissionName } from "../permissions.js";
import {
  clearanceFixedBySettings,
  clearedLabels,
  knownProviderNames,
  OUTSIDE_SERVICE_NAMES,
  type StoredClearance,
} from "../provider-labels.js";
import { readStoredClearance } from "./provider-clearance-service.js";
import { connectionsNotShown, listConnections } from "./connection-service.js";
import { deploymentChecks, type PreflightReport } from "./deployment-checks.js";
import { CONFIG_FILE_KEYS } from "../config-file.js";
import { listLabels } from "./label-admin-service.js";
import { undefinedLabels } from "./label-service.js";
import { owlsCreatedHere } from "./owl.js";
import { createdOwlsSummary, listStandingMandates, type StandingMandateView } from "./owl-creation-service.js";
import { listParties } from "./party-service.js";
import { listLiveGrants, type GrantView } from "./permission-service.js";
import { outgoingUsageReports } from "./usage-report-service.js";

/** How many accounts and how many groups hold something. */
export interface Holders {
  accounts: number;
  groups: number;
}

export interface PermissionHolders extends Holders {
  permission: PermissionName;
  /** What the permission is granted at: nothing, one label, or one party. */
  scope: "none" | "label" | "party";
  /** For a permission granted at a label: each label besides `public`, held or not. */
  by_label?: Array<{ label: string } & Holders>;
  /** For a permission granted for a party: each party, held or not. */
  by_party?: Array<{ party: { id: string; name: string } } & Holders>;
}

export interface ChecklistLabel {
  name: string;
  /** The labels a holder of this one may also read, as recorded: one step. */
  reads: string[];
  /** The model providers the deployment has cleared to receive text at this label. */
  model_providers_cleared: string[];
  /** The outside services (embeddings, web search and so on) cleared for it. */
  outside_services_cleared: string[];
  /**
   * The roles whose configured model is served by a provider that is not
   * cleared for this label. A run of such a role at this label is refused
   * before anything is sent.
   */
  roles_not_served: Array<{ role: string; model: string; provider: string | null }>;
}

export interface SetupChecklist {
  /**
   * The deployment's own checks of its configuration: the preflight's
   * report (services/deployment-checks.ts). The type allows null for a
   * client reading a deployment built before the preflight; this build
   * always carries a report.
   */
  preflight: PreflightReport | null;
  /** Each permission and how many accounts and groups hold it now. */
  permissions: PermissionHolders[];
  /** Every label besides `public`, with what is cleared for it. Empty until one is defined. */
  labels: ChecklistLabel[];
  /**
   * Label names the provider setting uses that this deployment does not
   * define. While there is one, every call to a provider is refused
   * (llm/provider-clearance.ts), so it is the first thing to put right.
   */
  undefined_labels_in_provider_setting: string[];
  /**
   * Whether PROVIDER_LABELS (or [provider_labels]) fixes which providers
   * each label may be sent to. When false, holders of `clear_providers`
   * choose it on the labels page.
   */
  clearance_fixed_by_settings: boolean;
  /** The General mandate, with its mandate once set up. */
  standing_mandates: StandingMandateView[];
  owls: {
    /** Whether this deployment creates its own owls (OWLS=created) or sells them. */
    created_here: boolean;
    /** Created and spent so far, in owls; null where owls are sold. */
    created_total_owls: number | null;
    spent_total_owls: number | null;
    /** Models the deployment is configured to run that have no price; empty where owls are sold. */
    unpriced_models: Array<{ setting: string; model: string }>;
  };
  usage_report: {
    price: "metered" | "flat";
    /** Whether this deployment prepares usage reports at all. */
    reporting: boolean;
    /** Where reports go: online, a file to hand over, or nowhere yet. */
    destination: "online" | "file" | "none";
    /** For an online destination: whether the key it needs is set. */
    destination_ready: boolean;
    /** True where reports go to minerval.ai over this deployment's connection and wait on report_usage, which an admin of the organization grants. */
    waits_on_organization?: boolean;
    prepared: number;
    unsent: number;
    /** Why the latest attempt to send failed, when the oldest unsent report has one. */
    last_error: string | null;
  };
  /**
   * Keeping the public versions of nodes current (outward-acts-service.ts):
   * the setting, whether anything is behind it, and what the public graph
   * said when it last did not take a request. The setting starts on and
   * sends nothing until a person has named a public mandate, which is said
   * here so that an administrator sees it.
   */
  public_graph: {
    /** Whether the deployment reaches the public graph: connected with its own key, or with an address and a key in its settings. */
    account_set: boolean;
    /**
     * This deployment's connection to minerval.ai (docs/organizations.md,
     * "Connecting"): its state, the organization and the grants it holds,
     * what minerval.ai last said against it, and the grants the deployment's
     * own settings need that it does not hold, each with why. Null where it
     * has never been connected.
     */
    connection: {
      state: "waiting" | "connected" | "denied" | "expired" | "by_hand";
      organization_name: string | null;
      grants: string[];
      problem: string | null;
      missing_grants: Array<{ grant: string; why: string }>;
    } | null;
    keep_public_current: { setting: "on" | "off"; sends: boolean; in_words: string };
    last_not_taken: string | null;
    /**
     * Whether the deployment's signing key is registered on the public
     * graph, as this deployment's log of acts records it: pages shown
     * outside that are open (those the reader reads), the key's fingerprint
     * (null where it has none), and when that key was last registered from
     * here (null where the log has no registration of it). A key registered
     * by a statement carried elsewhere is not in the log; GET
     * /outside/account reads the public graph's own record.
     */
    signing_key: { released_outside: number; fingerprint: string | null; registered_from_here_at: string | null };
  };
  /**
   * Following the public graph (docs/organizations.md, "The mirror";
   * services/mirror-following.ts), as far as it can be said without asking
   * the feed: null where this deployment follows nothing and could not.
   */
  mirror: MirrorAttention | null;
  connections: {
    total: number;
    /** Switched on. */
    on: number;
    /** On, with at least one tool agents are offered. */
    offering_tools: number;
    /** On, and the server did not answer when last asked. */
    failing: Array<{ id: string; name: string }>;
    /** Tools that stopped being offered because they changed, and wait for an administrator to look. */
    tools_withdrawn: Array<{ connection: { id: string; name: string }; tool: string }>;
    /** On, and its credential cannot be sent: the variable it names is not set, or no key set opens the one given on its page. */
    credential_missing: Array<{ id: string; name: string }>;
    /**
     * Connections at labels the administrator does not read: counted, and
     * not among the figures above, which are of the ones they read.
     */
    not_shown: number;
  };
  /**
   * The gates, and how far each has come toward the Redactor deciding
   * alone, which is where a gate is meant to end up: each gate starts with
   * a person deciding after the Redactor so that its people can see the
   * Redactor's work before they leave it to it (docs/the-gate.md, "Where a
   * gate starts"). Empty until something has crossed a boundary.
   */
  gates: {
    /** The aim, in words, for the page to say. */
    aim: string;
    each: Array<{
      gate_id: string;
      from: string;
      to: string;
      to_outside: boolean;
      /** The kinds the gate as a whole leaves to a person, to the Redactor, and open, for every party that has not said. */
      a_person_decides: string[];
      the_redactor_decides: string[];
      open: string[];
      /** Settings narrower than the whole boundary, or for one party's material, which this summary does not show. */
      narrower_settings: number;
      /** Items waiting on a person now, those the Redactor referred among them, and how long the oldest has waited. */
      waiting_on_a_person: number;
      referred_by_the_redactor: number;
      oldest_waiting_hours: number | null;
      agreement: { window_days: number; decided: number; as_proposed: number; kinds_ready: string[] };
    }>;
  };
  material: {
    /** Sources recorded: documents, addresses and kept readings. */
    sources: number;
    /** Sources that are no party's on record. */
    sources_with_no_party: number;
    /** How many sources are each party's material. */
    sources_by_party: Array<{ party: { id: string; name: string; is_own_organization: boolean }; sources: number }>;
    /** Sources submitted by members that the Contribution Reviewer has not yet decided. */
    sources_waiting_for_review: number;
    /** Claims, quantities and questions the graph holds. */
    nodes: number;
  };
}

// ---- who holds what -----------------------------------------------------------

function holdersOf(grants: readonly GrantView[]): Holders {
  return {
    accounts: new Set(grants.filter((g) => g.account).map((g) => g.account!.id)).size,
    groups: new Set(grants.filter((g) => g.group !== null).map((g) => g.group!)).size,
  };
}

function permissionHolders(
  grants: readonly GrantView[],
  labels: readonly string[],
  parties: ReadonlyArray<{ id: string; name: string }>
): PermissionHolders[] {
  return PERMISSIONS.map((permission) => {
    const held = grants.filter((g) => g.permission === permission);
    const scope = PERMISSION_DEFINITIONS[permission].scope;
    return {
      permission,
      scope,
      ...holdersOf(held),
      ...(scope === "label"
        ? { by_label: labels.map((label) => ({ label, ...holdersOf(held.filter((g) => g.label === label)) })) }
        : {}),
      ...(scope === "party"
        ? {
            by_party: parties.map((party) => ({
              party: { id: party.id, name: party.name },
              ...holdersOf(held.filter((g) => g.party?.id === party.id)),
            })),
          }
        : {}),
    };
  });
}

// ---- which providers are cleared for which label ------------------------------

/** Roles whose model is never called while a feature is off. */
const ROLE_FEATURE: Readonly<Record<string, FeatureName>> = {
  extension: "extension",
  solver: "mathematics",
};

/**
 * The roles the configuration names a model for, each with the field of the
 * config schema (src/config.ts) that holds it: the rows of the config
 * file's `models.` group (src/config-file.ts), so that the checklist, the
 * preflight and the file name the same roles.
 */
const ROLE_MODEL_FIELDS: ReadonlyArray<[role: string, field: keyof Config]> = CONFIG_FILE_KEYS.filter(
  (key) => key.key.startsWith("models.") && key.field
).map((key) => [key.key.slice("models.".length), key.field as keyof Config]);

/** Every role the configuration names a model for, with the provider that serves it. */
function roleProviders(config: Config): Array<{ role: string; model: string; provider: string | null }> {
  const roles: Array<{ role: string; model: string; provider: string | null }> = [];
  for (const [role, field] of ROLE_MODEL_FIELDS) {
    const feature = ROLE_FEATURE[role];
    if (feature && !featureOn(feature, config)) continue;
    const model = String(config[field] ?? "").trim();
    // An empty model is a role that is not in use (the Redactor's, left
    // empty, is the Steward's model, which is listed under its own role).
    if (model) roles.push({ role, model, provider: resolveProvider(model) });
  }
  return roles;
}

function checklistLabels(
  labels: ReadonlyArray<{ name: string; reads: string[] }>,
  config: Config,
  stored: StoredClearance
): ChecklistLabel[] {
  const known = knownProviderNames(config);
  const outside = new Set<string>(OUTSIDE_SERVICE_NAMES);
  const roles = roleProviders(config);
  return labels
    .filter((label) => label.name !== PUBLIC_LABEL)
    .map((label) => {
      const cleared = known.filter((provider) => clearedLabels(provider, config, stored).includes(label.name));
      return {
        name: label.name,
        reads: label.reads,
        model_providers_cleared: cleared.filter((provider) => !outside.has(provider)),
        outside_services_cleared: cleared.filter((provider) => outside.has(provider)),
        roles_not_served: roles.filter((r) => r.provider === null || !cleared.includes(r.provider)),
      };
    });
}

/** The labels the provider setting names, besides `public`. */
function labelsNamedByProviderSetting(config: Config): string[] {
  const names = new Set<string>();
  for (const labels of Object.values(config.providerLabels ?? {})) {
    for (const label of labels) if (label !== PUBLIC_LABEL) names.add(label);
  }
  return [...names].sort();
}

// ---- material -----------------------------------------------------------------

const MATERIAL_COUNT_REASON =
  "The setup checklist tells an administrator how much material the whole deployment holds, which is a count of rows at every label.";

async function materialCounts(
  parties: ReadonlyArray<{ id: string; name: string; is_own_organization: boolean }>
): Promise<SetupChecklist["material"]> {
  // Counted at every label: the administrator is asking whether anything is
  // in at all, and may not read the label most of it is at. Numbers only.
  const { byParty, waiting, nodes } = await withSystemClearance(MATERIAL_COUNT_REASON, async () => {
    const byParty = await rawQuery<{ party_id: string | null; n: number }>(
      `SELECT party_id, count(*)::int AS n FROM sources GROUP BY party_id`
    );
    const [waiting] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM contributions
        WHERE contribution_type = 'propose_source' AND review_status = 'pending'`
    );
    const [nodes] = await rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM claims`);
    return { byParty, waiting, nodes };
  });
  const counts = new Map(byParty.map((row) => [row.party_id, row.n]));
  return {
    sources: byParty.reduce((sum, row) => sum + row.n, 0),
    sources_with_no_party: counts.get(null) ?? 0,
    // In the parties' own order: the organization itself first, then by name.
    sources_by_party: parties.map((party) => ({
      party: { id: party.id, name: party.name, is_own_organization: party.is_own_organization },
      sources: counts.get(party.id) ?? 0,
    })),
    sources_waiting_for_review: waiting?.n ?? 0,
    nodes: nodes?.n ?? 0,
  };
}

// ---- the whole ------------------------------------------------------------------

import { mirrorAttention, type MirrorAttention } from "./mirror-following.js";

export async function setupChecklist(): Promise<SetupChecklist> {
  const config = loadConfig();
  const [preflight, grants, labels, parties, standingMandates, usage, connections] = await Promise.all([
    deploymentChecks(),
    listLiveGrants(),
    listLabels(),
    listParties(),
    listStandingMandates(),
    outgoingUsageReports(),
    listConnections(),
  ]);
  const created = owlsCreatedHere(config) ? await createdOwlsSummary(1) : null;
  const ownLabels = labels.map((l) => l.name).filter((name) => name !== PUBLIC_LABEL);
  const unsent = usage.reports.filter((r) => r.sent_at === null);
  const on = connections.filter((c) => c.enabled);
  const fixed = clearanceFixedBySettings(config);
  const stored = fixed ? {} : await readStoredClearance();

  return {
    preflight,
    permissions: permissionHolders(grants, ownLabels, parties),
    labels: checklistLabels(labels, config, stored),
    undefined_labels_in_provider_setting: await undefinedLabels(labelsNamedByProviderSetting(config)),
    clearance_fixed_by_settings: fixed,
    standing_mandates: standingMandates,
    owls: {
      created_here: created !== null,
      created_total_owls: created?.created.total_owls ?? null,
      spent_total_owls: created?.spent.total_owls ?? null,
      unpriced_models: created?.prices.unpriced_models ?? [],
    },
    usage_report: {
      price: usage.price,
      reporting: usage.reporting,
      destination: usage.destination.kind,
      // Where the destination waits on a grant from the organization rather than on a setting.
      ...(usage.destination.kind === "online" && !usage.destination.ready && (await (await import("./public-graph-client.js")).liveConnection())
        ? { waits_on_organization: true }
        : {}),
      destination_ready: usage.destination.kind === "online" ? usage.destination.ready : usage.destination.kind === "file",
      prepared: usage.reports.length,
      unsent: unsent.length,
      // Reports are sent oldest first and a failure stops the pass, so the
      // oldest unsent report is the one that carries why.
      last_error: unsent.length > 0 ? unsent[unsent.length - 1]!.last_error : null,
    },
    public_graph: await publicGraphState(config),
    mirror: await mirrorAttention(),
    connections: {
      total: connections.length,
      on: on.length,
      offering_tools: on.filter((c) => c.tools.some((t) => t.offered)).length,
      failing: on.filter((c) => c.state.status === "failing").map((c) => ({ id: c.id, name: c.name })),
      tools_withdrawn: on.flatMap((c) =>
        c.tools.filter((t) => t.withdrawn !== null).map((t) => ({ connection: { id: c.id, name: c.name }, tool: t.name }))
      ),
      credential_missing: on
        .filter((c) => c.credential.source !== null && !c.credential.set)
        .map((c) => ({ id: c.id, name: c.name })),
      not_shown: await connectionsNotShown(connections.length),
    },
    gates: await gatesOverview(),
    material: await materialCounts(parties),
  };
}

const GATES_AIM =
  "Every gate starts with a person approving what the Redactor proposes, so that the people who consent can see its work under " +
  "the policy before they rely on it. The aim is the Redactor deciding alone: a gate that waits on a person moves at that person's " +
  "pace. Hand a kind to the Redactor once its proposals are ones you approve as they stand, and write what you still want to see " +
  "into the policy's guidelines for when the Redactor asks a person; it refers those, with its recommendation, whatever the gate is set to.";

/** Each gate, how it is set, what waits on a person there, and how often its people approved the Redactor's proposals as they stood. */
async function gatesOverview(): Promise<SetupChecklist["gates"]> {
  const { gatesFor } = await import("./gate-settings-service.js");
  const { gateBacklog } = await import("./release-gate-service.js");
  const { gateAgreement, modesAtGate } = await import("./gate-trust-service.js");
  // Read as an administrator, whom the checklist is for: every gate, each named by its labels.
  const gates = await gatesFor({ id: "", holding: [], administer: true, consentParties: [], clearance: [] });
  const backlog = (await gateBacklog({ clearance: [], administer: true, consentParties: [] })) as {
    gates: Array<{
      gate_id: string;
      items_waiting_on_a_person: number;
      items_referred: number;
      waiting: Array<{ waiting_on: string; items: number; oldest_waiting_hours: number }>;
    }>;
  };
  const each: SetupChecklist["gates"]["each"] = [];
  for (const g of gates as Array<{ gate_id: string; from: string; to: string; to_outside: boolean }>) {
    const { modes, narrower_settings } = await modesAtGate(g.gate_id);
    const kinds = (mode: string) => Object.entries(modes).filter(([, m]) => m === mode).map(([k]) => k);
    const waiting = backlog.gates.find((b) => b.gate_id === g.gate_id);
    const lines = waiting?.waiting ?? [];
    const onPerson = lines.filter((l) => l.waiting_on === "waiting_on_person" || l.waiting_on === "referred");
    const agreement = await gateAgreement(g.gate_id);
    each.push({
      gate_id: g.gate_id,
      from: g.from,
      to: g.to_outside ? "outside" : g.to,
      to_outside: g.to_outside,
      a_person_decides: kinds("person"),
      the_redactor_decides: kinds("redactor"),
      open: kinds("open"),
      narrower_settings,
      waiting_on_a_person: waiting?.items_waiting_on_a_person ?? 0,
      referred_by_the_redactor: waiting?.items_referred ?? 0,
      oldest_waiting_hours: onPerson.length > 0 ? Math.max(...onPerson.map((l) => l.oldest_waiting_hours)) : null,
      agreement: {
        window_days: agreement.window_days,
        decided: agreement.decided,
        as_proposed: agreement.as_proposed,
        kinds_ready: agreement.by_kind.filter((k) => k.suggests_the_redactor && modes[k.kind] === "person").map((k) => k.kind),
      },
    });
  }
  return { aim: GATES_AIM, each };
}

const RELEASED_OUTSIDE_COUNT_REASON =
  "The setup checklist tells an administrator whether pages are released outside under a signing key that is not registered, and the key signs pages at every label.";

/** Where keeping public versions current stands, and whether the signing key is registered from here, for the checklist. */
async function publicGraphState(config: {
  publicGraphApiUrl?: string;
  publicGraphApiKey?: string;
  mirrorFeedUrl?: string;
  publicGraphPrice?: string;
  reads?: string;
  usageReportDir?: string;
  publishSigningKey?: string;
}): Promise<SetupChecklist["public_graph"]> {
  const connection = await (await import("./public-graph-client.js")).readConnection();
  const { keepsPublicCurrent } = await import("./keep-current.js");
  const kept = await keepsPublicCurrent();
  const state = { setting: kept.asks ? ("on" as const) : ("off" as const), sends: kept.asks, in_words: kept.in_words };
  const [last] = await rawQuery<{ said: string | null }>(
    `SELECT a.public_graph_said AS said FROM outward_acts a
      WHERE a.kind = 'keep_current'
        AND a.at = (SELECT max(at) FROM outward_acts WHERE kind = 'keep_current') AND a.result <> 'done'`
  );
  const { signingKeyId } = await import("./outbound-service.js");
  const { keyIdOf } = await import("./mirror-batch.js");
  const fingerprint = signingKeyId();
  // Counted at every label, as the preflight counts them: the key signs every page shown outside, whoever reads its label.
  const [outside] = await withSystemClearance(RELEASED_OUTSIDE_COUNT_REASON, () =>
    rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM releases WHERE to_outside AND ended_at IS NULL`)
  );
  const registrations = await rawQuery<{ at: Date; public_key: string | null }>(
    `SELECT at, sent->>'public_key' AS public_key FROM outward_acts WHERE kind = 'register_publisher' AND result = 'done' ORDER BY at DESC`
  );
  const ofThisKey = fingerprint ? registrations.find((r) => r.public_key && keyIdOf(r.public_key) === fingerprint) : undefined;
  return {
    // Connected to minerval.ai with its own key, or reaching it with the account key in the settings.
    account_set: Boolean(connection?.state === "connected" || (config.publicGraphApiUrl && config.publicGraphApiKey)),
    connection: connection
      ? {
          state: connection.state,
          organization_name: connection.organizationName,
          grants: connection.grants,
          problem: connection.lastError,
          missing_grants: connection.state === "connected" ? (await import("./public-graph-connection.js")).neededGrants(config).filter((n) => !connection.grants.includes(n.grant as never)) : [],
        }
      : null,
    keep_public_current: { setting: state.setting, sends: state.sends, in_words: state.in_words },
    last_not_taken: last ? (last.said ?? "The public graph could not be reached.") : null,
    signing_key: { released_outside: outside?.n ?? 0, fingerprint, registered_from_here_at: ofThisKey?.at.toISOString() ?? null },
  };
}
