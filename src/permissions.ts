/**
 * Permissions: who may do what in a members-only deployment
 * (docs/accounts.md, "Members-only deployments").
 *
 * One setting, READS, says who a deployment serves. At its starting value,
 * "open", this is the public graph: a read needs no account, and each act
 * is guarded by the rules its route already carries. Nothing in this file
 * binds there. At "members" the deployment is private: nothing is served to
 * anyone who is not signed in, and what a signed-in person may do follows
 * from the permissions the deployment's own administrators granted them.
 *
 * The permissions are separate, and an administrator grants each on its
 * own, to an account or to a group the identity provider names. One person
 * may hold several. Nothing here decides who should hold what: whether the
 * people who direct the graph are also the people who release from it is
 * for the administrators, and every grant and removal is a row that is
 * never deleted (permission_grants), so who held what, and when, can
 * always be read.
 *
 * A request's standing is resolved once, when it arrives
 * (server/plugins/members-only.ts): the grants that reach its account, and
 * the clearance they add up to. Clearance is the set of labels the request
 * may read: `public`, every label a `read` grant names, and every label
 * those read (the pairs in label_reads, followed to the end). It is put on
 * the request's async context (currentClearance in llm/usage-context.ts) so
 * that whatever holds reads to a clearance can pick it up without a
 * parameter. Nothing holds a read to it yet: that is the database's job
 * and is later work.
 *
 * A member is an account that holds at least one live grant. An account
 * that has signed in and holds none is not a member, and is served nothing
 * but who it is.
 */
import { loadConfig } from "./config.js";
import { PUBLIC_LABEL } from "./labels.js";

export const PERMISSIONS = [
  "direct",
  "release",
  "fund",
  "read",
  "read_sources",
  "administer",
] as const;

export type PermissionName = (typeof PERMISSIONS)[number];

export function isPermissionName(value: unknown): value is PermissionName {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** What a grant of the permission is held at or for. */
export type PermissionScope = "none" | "label" | "party";

interface PermissionDefinition {
  scope: PermissionScope;
  /**
   * The permission as a phrase that completes "the permission to ...":
   * used in refusals, and in what an agent is told when its user lacks it.
   */
  phrase: string;
  /** What holding it lets a person do, as one sentence for whoever grants it. */
  covers: string;
  /** What it never lets anyone do. */
  never: string;
}

/**
 * Each permission in words. `covers` states what the permission guards in
 * the code as it stands, and grows as the acts it is meant for are built.
 */
export const PERMISSION_DEFINITIONS: Record<PermissionName, PermissionDefinition> = {
  direct: {
    scope: "none",
    phrase: "direct the graph",
    covers:
      "Open a mandate and shape it with its Grantmaker, approve its plan, ask a mandate's " +
      "Correspondent for an update, and add sources.",
    never: "Edit an assessment or a run's log.",
  },
  release: {
    scope: "party",
    phrase: "release one party's material",
    covers:
      "Release or hold what would leave the deployment of one party's material. It is granted " +
      "for that party alone. Publishing outward is not built yet, so for now the grant records " +
      "who holds that party's gate.",
    never: "Edit what the agents wrote, or release another party's material.",
  },
  fund: {
    scope: "none",
    phrase: "fund work",
    covers:
      "Put owls behind work: fund a drafted mandate, add to a mandate or a funded job, back a " +
      "mandate, and order or fund work on a node or a request.",
    never: "Decide what the work concludes. A Grantmaker can decline a mandate.",
  },
  read: {
    scope: "label",
    phrase: "read at a label",
    covers: "Read what the agents wrote at one label and at the labels that label reads.",
    never: "Change anything the agents wrote.",
  },
  read_sources: {
    scope: "label",
    phrase: "open raw sources at a label",
    covers:
      "Open the sources themselves at one label, and not only what the agents wrote from them.",
    never: "Change a source. A later edit is a new source.",
  },
  administer: {
    scope: "none",
    phrase: "administer the deployment",
    covers:
      "Grant and remove permissions, define labels and which label reads which, add parties, " +
      "and say whose material a source is. Set up the deployment's General and Governance " +
      "mandates, and create owls where the deployment creates its own. Read the usage reports " +
      "the deployment makes to the public graph, and send them.",
    never:
      "Act under a permission they have not also been granted, or change who may do what " +
      "without a log entry.",
  },
};

/** One live grant that reaches an account, directly or through a group. */
export interface HeldGrant {
  permission: PermissionName;
  /** The label a reading permission is held at; null for the others. */
  label: string | null;
  /** The party a release is held for; null for the others. */
  partyId: string | null;
  /** The group the grant was made to, when it reaches the account that way. */
  group: string | null;
}

/** What a request may do and read, resolved once when it arrives. */
export interface Standing {
  /** Holds at least one live grant. */
  member: boolean;
  grants: readonly HeldGrant[];
  /**
   * The labels the request may read: `public`, each label a `read` grant
   * names, and every label those read. Sorted.
   */
  clearance: readonly string[];
  /**
   * The labels whose sources the request may open raw: `public`, and each
   * label a `read_sources` grant names. A grant is for its own label and is
   * not followed through label_reads, so opening the sources of a second
   * label is always a second grant. Sorted.
   */
  rawSourceLabels: readonly string[];
  /** The groups the account's latest sign-in carried, while that sign-in still vouches for them. */
  groups: readonly string[];
}

/**
 * The standing of a request on the public graph, and of any request no
 * standing was resolved for: no grants, and `public` to read. A missing
 * standing is never read as a wide one.
 */
export const PUBLIC_STANDING: Standing = Object.freeze({
  member: false,
  grants: Object.freeze([]),
  clearance: Object.freeze([PUBLIC_LABEL]),
  rawSourceLabels: Object.freeze([PUBLIC_LABEL]),
  groups: Object.freeze([]),
});

/** The standing a request carries, or the public one when none was resolved. */
export function standingOf(auth: { standing?: Standing } | null | undefined): Standing {
  return auth?.standing ?? PUBLIC_STANDING;
}

/**
 * Whether a standing holds a permission. With `scope`, the grant must be at
 * that label or for that party; without, any grant of the permission counts.
 */
export function holdsPermission(
  standing: Standing,
  permission: PermissionName,
  scope?: { label?: string; partyId?: string }
): boolean {
  return standing.grants.some(
    (g) =>
      g.permission === permission &&
      (scope?.label === undefined || g.label === scope.label) &&
      (scope?.partyId === undefined || g.partyId === scope.partyId)
  );
}

/** The permissions a standing holds, each once, in the list's order. */
export function heldPermissions(standing: Standing): PermissionName[] {
  return PERMISSIONS.filter((p) => standing.grants.some((g) => g.permission === p));
}

/** The part of the config the setting lives in. */
export interface ReadsConfig {
  reads?: "open" | "members";
}

/**
 * Whether this deployment is members-only. A config without the setting (a
 * test's partial config) is open, as a deployment that sets nothing is.
 */
export function membersOnly(config: ReadsConfig = loadConfig()): boolean {
  return config?.reads === "members";
}

/** What a refusal for a missing permission says. */
export function permissionRefusal(permission: PermissionName): string {
  return (
    `This needs the permission to ${PERMISSION_DEFINITIONS[permission].phrase}, which this ` +
    `account does not hold. An administrator of this deployment grants it.`
  );
}
