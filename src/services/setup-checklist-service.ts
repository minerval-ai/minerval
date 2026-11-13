/**
 * The setup checklist of a members-only deployment
 * (docs/setup-checklist.md): one read of what an administrator needs in
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
import { clearedLabels, knownProviderNames, OUTSIDE_SERVICE_NAMES } from "../provider-labels.js";
import { connectionsNotShown, listConnections } from "./connection-service.js";
import { deploymentChecks, type PreflightReport } from "./deployment-checks.js";
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
   * report. Null where the build has no preflight (services/deployment-checks.ts).
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
  /** The General and the Governance mandate, each with its mandate once set up. */
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
    prepared: number;
    unsent: number;
    /** Why the latest attempt to send failed, when the oldest unsent report has one. */
    last_error: string | null;
  };
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
    /** On, and the environment variable its credential is read from is not set. */
    credential_missing: Array<{ id: string; name: string }>;
    /**
     * Connections at labels the administrator does not read: counted, and
     * not among the figures above, which are of the ones they read.
     */
    not_shown: number;
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
 * config schema (src/config.ts) that holds it. The config file, where a
 * build has one, names the same roles under `models.`; this list is kept
 * here because this build has no config file to read them from.
 */
const ROLE_MODEL_FIELDS: ReadonlyArray<[role: string, field: keyof Config]> = [
  ["steward", "stewardModel"],
  ["steward_strong", "stewardStrongModel"],
  ["curator", "curatorModel"],
  ["extractor", "extractorModel"],
  ["extractor_fallback", "extractorFallbackModel"],
  ["matcher", "matcherModel"],
  ["tagger", "taggerModel"],
  ["contribution_reviewer", "governanceModel"],
  ["audit", "auditModel"],
  ["redactor", "redactorModel"],
  ["arbitration", "arbitrationModel"],
  ["grantmaker", "grantmakerModel"],
  ["program_officer", "programOfficerModel"],
  ["lookout", "lookoutModel"],
  ["correspondent", "correspondentModel"],
  ["consistency", "consistencyModel"],
  ["consistency_strong", "consistencyStrongModel"],
  ["assistant", "assistantModel"],
  ["assistant_standard", "assistantStandardModel"],
  ["assistant_title", "assistantTitleModel"],
  ["extension", "extensionModel"],
  ["researcher_strong", "researcherStrongModel"],
  ["researcher_standard", "researcherStandardModel"],
  ["researcher_cheap", "researcherCheapModel"],
  ["solver", "solverModel"],
  ["judge", "judgeModel"],
];

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
  config: Config
): ChecklistLabel[] {
  const known = knownProviderNames(config);
  const outside = new Set<string>(OUTSIDE_SERVICE_NAMES);
  const roles = roleProviders(config);
  return labels
    .filter((label) => label.name !== PUBLIC_LABEL)
    .map((label) => {
      const cleared = known.filter((provider) => clearedLabels(provider, config).includes(label.name));
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

  return {
    preflight,
    permissions: permissionHolders(grants, ownLabels, parties),
    labels: checklistLabels(labels, config),
    undefined_labels_in_provider_setting: await undefinedLabels(labelsNamedByProviderSetting(config)),
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
      destination_ready: usage.destination.kind === "online" ? usage.destination.ready : usage.destination.kind === "file",
      prepared: usage.reports.length,
      unsent: unsent.length,
      // Reports are sent oldest first and a failure stops the pass, so the
      // oldest unsent report is the one that carries why.
      last_error: unsent.length > 0 ? unsent[unsent.length - 1]!.last_error : null,
    },
    connections: {
      total: connections.length,
      on: on.length,
      offering_tools: on.filter((c) => c.tools.some((t) => t.offered)).length,
      failing: on.filter((c) => c.state.status === "failing").map((c) => ({ id: c.id, name: c.name })),
      tools_withdrawn: on.flatMap((c) =>
        c.tools.filter((t) => t.withdrawn !== null).map((t) => ({ connection: { id: c.id, name: c.name }, tool: t.name }))
      ),
      credential_missing: on
        .filter((c) => c.credential.env !== null && !c.credential.set)
        .map((c) => ({ id: c.id, name: c.name })),
      not_shown: await connectionsNotShown(connections.length),
    },
    material: await materialCounts(parties),
  };
}
