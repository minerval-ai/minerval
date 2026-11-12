/**
 * Turning enforcement on, and checking that it holds (clearance.ts).
 *
 * The database holds reads and writes to a clearance only where a
 * deployment has more than one label. Turning that on and off is one step,
 * minerval_enforcement_sync() (the migration that added it describes what
 * it does), and it runs from three places:
 *
 *  - the trigger on `labels`, in the transaction that adds or removes a
 *    label, so a second label never exists without it;
 *  - ensureEnforcement below, at every start after migrations, so a table
 *    or a view a migration added is covered without its author doing
 *    anything;
 *  - armEnforcement below, just before the first private label is defined.
 *
 * On the public graph the step finds nothing to do, takes no lock and
 * changes nothing.
 */
import {
  CLEARED_ROLE,
  ENFORCEMENT_OFF_RECHECK_MS,
  noteEnforcement,
  withSystemClearance,
} from "./clearance.js";
import { queryAtPublicClearance, rawQuery, setClearedLogin } from "./client.js";
import { PUBLIC_LABEL } from "../labels.js";

const STEP_REASON =
  "The step that turns enforcement on changes every labelled table, which only their owner may do.";
const FACTS_REASON =
  "Checking enforcement reads the catalog and the label table as the owner, to compare with what a cleared connection sees.";

/** 42883: the function does not exist, so the migration that adds it has not run. */
function stepMissing(err: unknown): boolean {
  return (err as { code?: string }).code === "42883";
}

/**
 * Run the step and tell this process the result. Returns whether
 * enforcement is on and one line per change the step made (none when
 * everything was already right). Safe to run at every start, in every
 * process: the step serializes itself and changes only what is wrong.
 */
export async function ensureEnforcement(): Promise<{ on: boolean; changes: string[] }> {
  return withSystemClearance(STEP_REASON, async () => {
    let changes: string[];
    try {
      const rows = await rawQuery<{ line: string }>(`SELECT minerval_enforcement_sync() AS line`);
      changes = rows.map((r) => r.line);
    } catch (err) {
      // A database the migrations have not reached has no labels to enforce.
      if (stepMissing(err)) return { on: false, changes: [] };
      throw err;
    }
    const [state] = await rawQuery<{ on: boolean }>(`SELECT minerval_enforcement_on() AS on`);
    const on = state?.on === true;
    if (on) await setClearedLogin();
    noteEnforcement(on);
    return { on, changes };
  });
}

// On the process for the reason clearance.ts gives: a test that reloads its
// modules must keep the suite's setting.
const SETTLE_MS = Symbol.for("minerval.enforcementSettleMs");
const processSlots = globalThis as unknown as Record<symbol, number | undefined>;

/** How long armEnforcement waits. Tests set it to nothing; a deployment leaves it. */
export function setEnforcementSettleMs(ms: number): void {
  processSlots[SETTLE_MS] = Math.max(0, ms);
}

/**
 * Turn enforcement on before the first private label exists, and wait until
 * every process of the deployment has noticed.
 *
 * A process learns that enforcement is on by asking, at most every
 * ENFORCEMENT_OFF_RECHECK_MS, and until it has asked it reads on the
 * owner's connection, unfiltered. So the order matters: enforcement first,
 * then the wait, then the label. No row can carry a label that is not yet a
 * row in `labels`, so by the time anything private can be written, every
 * process is holding its reads to a clearance. Whoever defines a label
 * calls this first (services/label-admin-service.ts). It returns at once
 * when enforcement is already on, which is every time but the first.
 *
 * A label inserted without it (from a console) still turns enforcement on,
 * in the same transaction, through the trigger; other processes then notice
 * within the interval.
 */
export async function armEnforcement(): Promise<void> {
  const armed = await withSystemClearance(STEP_REASON, async () => {
    const [state] = await rawQuery<{ on: boolean }>(`SELECT minerval_enforcement_on() AS on`);
    if (state?.on === true) return false;
    await rawQuery(`SELECT minerval_enforcement_sync(true)`);
    await setClearedLogin();
    return true;
  });
  noteEnforcement(true);
  const settleMs = processSlots[SETTLE_MS] ?? ENFORCEMENT_OFF_RECHECK_MS + 1_000;
  if (armed && settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
}

// ---- what the preflight needs ------------------------------------------------

/**
 * The facts that decide whether enforcement holds. Read from the catalog
 * and from a live cleared connection, never assumed.
 */
export interface EnforcementFacts {
  /** The policies exist. */
  on: boolean;
  /** The labels the deployment defines. */
  labels: string[];
  /** Tables in `public` with a sensitivity_label column. */
  labelledTables: string[];
  /** Labelled tables without row-level security or without both policies. Empty when enforcement holds. */
  uncoveredTables: string[];
  /** Views in `public` that would read their tables as the owner, past the policies. */
  viewsReadingAsOwner: string[];
  /** public_read views not owned by the role the policies bind, so read-only SQL would see every label. */
  sqlViewsUnheld: string[];
  /** The role in DATABASE_URL. It is the tables' owner and is not bound by the policies, by design. */
  owner: { role: string; superuser: boolean; bypassesRowSecurity: boolean };
  /**
   * The role cleared connections log in as. Any of superuser,
   * bypassesRowSecurity, a table it owns or a role it is a member of would
   * switch enforcement off for it without a sign.
   */
  cleared: {
    exists: boolean;
    canLogIn: boolean;
    superuser: boolean;
    bypassesRowSecurity: boolean;
    ownsTables: string[];
    memberOf: string[];
  };
  /**
   * What a live connection at `public` clearance is, when enforcement is on:
   * the role it runs as, and whether it could read a row at another label.
   * Null when enforcement is off, or with `error` when no such connection
   * could be made (then nothing but system work can reach the database).
   */
  liveConnection: { role: string; seesBeyondPublic: boolean } | { error: string } | null;
}

export async function enforcementFacts(): Promise<EnforcementFacts> {
  const facts = await withSystemClearance(FACTS_REASON, async () => {
    const [state] = await rawQuery<{ on: boolean; owner: string; superuser: boolean; bypass: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_policy WHERE polname = 'label_clearance') AS on,
              current_user::text AS owner,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`
    );
    const labels = await rawQuery<{ name: string }>(`SELECT name FROM labels`);
    const tables = await rawQuery<{ name: string; covered: boolean }>(
      `SELECT c.relname::text AS name,
              c.relrowsecurity
                AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_clearance')
                AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'label_sql_read')
                AS covered
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'sensitivity_label' AND NOT a.attisdropped)
        ORDER BY c.relname`
    );
    const views = await rawQuery<{ name: string }>(
      `SELECT c.relname::text AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'v'
          AND NOT COALESCE((SELECT option_value = 'true' FROM pg_options_to_table(c.reloptions)
                             WHERE option_name = 'security_invoker'), false)
        ORDER BY c.relname`
    );
    const sqlViews = await rawQuery<{ name: string }>(
      `SELECT c.relname::text AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles o ON o.oid = c.relowner
        WHERE n.nspname = 'public_read' AND c.relkind = 'v' AND o.rolname <> 'minerval_sql_views'
        ORDER BY c.relname`
    );
    const [role] = await rawQuery<{
      can_login: boolean;
      superuser: boolean;
      bypass: boolean;
      owns: string[] | null;
      member_of: string[] | null;
    }>(
      `SELECT r.rolcanlogin AS can_login, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
              (SELECT array_agg(c.relname::text ORDER BY c.relname) FROM pg_class c
                WHERE c.relowner = r.oid AND c.relkind IN ('r', 'p', 'v')) AS owns,
              (SELECT array_agg(g.rolname::text ORDER BY g.rolname) FROM pg_auth_members m
                 JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of
         FROM pg_roles r WHERE r.rolname = $1`,
      [CLEARED_ROLE]
    );
    const [beyond] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM claims WHERE sensitivity_label <> $1`,
      [PUBLIC_LABEL]
    );
    return {
      on: state?.on === true,
      labels: labels.map((l) => l.name).sort(),
      labelledTables: tables.map((t) => t.name),
      uncoveredTables: tables.filter((t) => !t.covered).map((t) => t.name),
      viewsReadingAsOwner: views.map((v) => v.name),
      sqlViewsUnheld: sqlViews.map((v) => v.name),
      owner: {
        role: state?.owner ?? "",
        superuser: state?.superuser === true,
        bypassesRowSecurity: state?.bypass === true,
      },
      cleared: {
        exists: role !== undefined,
        canLogIn: role?.can_login === true,
        superuser: role?.superuser === true,
        bypassesRowSecurity: role?.bypass === true,
        ownsTables: role?.owns ?? [],
        memberOf: role?.member_of ?? [],
      },
      privateClaims: beyond?.n ?? 0,
    };
  });

  let liveConnection: EnforcementFacts["liveConnection"] = null;
  if (facts.on) {
    try {
      const [seen] = await queryAtPublicClearance<{ role: string; n: number }>(
        `SELECT current_user::text AS role,
                (SELECT count(*)::int FROM claims WHERE sensitivity_label <> $1) AS n`,
        [PUBLIC_LABEL]
      );
      liveConnection = { role: seen?.role ?? "", seesBeyondPublic: (seen?.n ?? 0) > 0 };
    } catch (err) {
      liveConnection = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  const { privateClaims: _privateClaims, ...rest } = facts;
  return { ...rest, liveConnection };
}

/**
 * What is wrong with enforcement, in sentences, or nothing. On a deployment
 * whose only label is `public` there is nothing to hold and nothing is
 * wrong. A preflight refuses to start on any of these.
 */
export function enforcementProblems(facts: EnforcementFacts): string[] {
  const secondLabel = facts.labels.some((l) => l !== PUBLIC_LABEL);
  if (!facts.on && !secondLabel) return [];
  const problems: string[] = [];
  const list = (names: string[]) => names.join(", ");
  if (!facts.on) {
    problems.push(
      "A label other than public is defined, and the database is not holding reads to a clearance: no table has its policy."
    );
    return problems;
  }
  if (facts.uncoveredTables.length > 0) {
    problems.push(`These labelled tables are not under row-level security: ${list(facts.uncoveredTables)}.`);
  }
  if (facts.viewsReadingAsOwner.length > 0) {
    problems.push(
      `These views read their tables as the owner, past the policies: ${list(facts.viewsReadingAsOwner)}.`
    );
  }
  if (facts.sqlViewsUnheld.length > 0) {
    problems.push(`These views of read-only SQL would show rows at every label: ${list(facts.sqlViewsUnheld)}.`);
  }
  if (!facts.cleared.exists) {
    problems.push(`The role ${CLEARED_ROLE} does not exist, so nothing but system work can reach the database.`);
  } else {
    if (facts.cleared.superuser || facts.cleared.bypassesRowSecurity) {
      problems.push(
        `The role ${CLEARED_ROLE} is a superuser or bypasses row-level security, so no policy binds it.`
      );
    }
    if (facts.cleared.ownsTables.length > 0) {
      problems.push(
        `The role ${CLEARED_ROLE} owns ${list(facts.cleared.ownsTables)}, and a table's owner is not bound by its policy.`
      );
    }
    if (facts.cleared.memberOf.length > 0) {
      problems.push(
        `The role ${CLEARED_ROLE} is a member of ${list(facts.cleared.memberOf)} and could act as it.`
      );
    }
  }
  if (facts.liveConnection && "error" in facts.liveConnection) {
    problems.push(`No connection held to a clearance could be opened: ${facts.liveConnection.error}`);
  } else if (facts.liveConnection) {
    if (facts.liveConnection.role !== CLEARED_ROLE) {
      problems.push(
        `A connection that should be held to a clearance is running as ${facts.liveConnection.role}, not ${CLEARED_ROLE}.`
      );
    }
    if (facts.liveConnection.seesBeyondPublic) {
      problems.push("A connection held to public alone can read a claim at another label.");
    }
  }
  return problems;
}
