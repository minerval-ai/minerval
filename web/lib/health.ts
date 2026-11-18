// The Health page (app/admin) and the Inbox's setup lines, in short: what in
// the deployment needs someone now, each as one row with who puts it right,
// and each area of the setup checklist as one tile.
//
// Read from GET /setup/checklist and nothing else, so it can be tested
// without rendering anything (tests/unit/web/health.test.ts). The long
// sentences stay where they are (lib/admin-words.ts, and the checks' own
// messages); here each thing gets a title short enough to scan, and the long
// sentence rides along as `detail` for a hover.

import type { PreflightCheck, SetupChecklist } from "./admin-api";
import {
  checklistItems,
  count,
  listed,
  permissionPhrase,
  preflightTitle,
  preflightTodo,
  providerName,
  type ChecklistItem,
  type ItemState,
} from "./admin-words";

/** Who puts a thing right: whoever runs the deployment (its config and environment), or an administrator working here. */
export type Owner = "operator" | "admin";

export interface AttentionItem {
  key: string;
  /** Short: "No price for claude-x (MODELS_RESEARCHER)". */
  title: string;
  /** One line: what follows while it stays as it is. */
  consequence: string;
  owner: Owner;
  href: string;
  /** The verb on the button: "Fix", "Set up", "View". */
  action: string;
  /** bad: stopping work or needing someone now; warn: to do. */
  tone: "bad" | "warn";
  /** A failed check that agent work waits on. */
  blocks: boolean;
  /** The full sentence, for a hover. */
  detail?: string;
}

export const OWNER_WORDS: Record<Owner, { name: string; title: string }> = {
  operator: { name: "Operator", title: "Whoever runs the deployment: set in its config file or environment" },
  admin: { name: "Admin", title: "An administrator of this deployment, on these pages" },
};

/** Where each area of the checklist is worked on. */
export const AREA_HREF: Record<string, string> = {
  people: "/admin/people",
  labels: "/admin/labels",
  parties: "/admin/parties",
  standing_mandates: "/admin/budget",
  owls: "/admin/budget",
  usage_report: "/admin/budget",
  public_graph: "/gates",
  connections: "/admin/connections",
  material: "/sources",
};

const AREA_NAMES: Record<string, string> = {
  checks: "Checks",
  people: "People",
  labels: "Labels & providers",
  parties: "Parties",
  standing_mandates: "General mandates",
  owls: "Owls",
  usage_report: "Usage report",
  public_graph: "Public graph",
  connections: "Connections",
  material: "Material",
};

// --- the checks -----------------------------------------------------------------

/** Each check's short title when it fails or is to do, and who puts it right. */
const CHECK_SHORT: Record<string, { title: string; owner?: Owner }> = {
  config_file: { title: "Config file can't be read" },
  database: { title: "Database not ready" },
  run_log: { title: "Run log not in record mode" },
  models: { title: "Some roles have no model key" },
  embeddings: { title: "Embeddings have no key" },
  web_search: { title: "Open-web search fails" },
  page_reading: { title: "Page reading fails" },
  elicit: { title: "Elicit not set up right" },
  pangram: { title: "Pangram not set up right" },
  payments: { title: "Payments not set up right" },
  github_issues: { title: "GitHub filing has no credential" },
  reports_stay_inside: { title: "Agents' reports may leave" },
  features: { title: "A feature runs unlogged" },
  work_outside_the_run_log: { title: "Some work runs unlogged" },
  provider_labels: { title: "PROVIDER_LABELS names an unknown label" },
  model_clearance: { title: "Models not cleared for a label", owner: "admin" },
  embeddings_clearance: { title: "Embeddings not cleared for a label", owner: "admin" },
  outside_service_clearance: { title: "Outside services not cleared for a label", owner: "admin" },
  database_tls: { title: "Database connection unencrypted" },
  database_owner: { title: "Tables owned by a superuser" },
  owls: { title: "Owls not set up right" },
  model_prices: { title: "A model has no price" },
  usage_report: { title: "Usage report not set up" },
  standing_mandates: { title: "A label has no General mandate", owner: "admin" },
  own_organization: { title: "Organisation not recorded as a party", owner: "admin" },
  publishing: { title: "Pages released outside can't be signed" },
  public_graph: { title: "Public graph not reachable" },
  public_acts: { title: "Who acts on the public graph is unclear" },
  private_run_fetches: { title: "Private runs may fetch any address" },
  connections: { title: "A connection's credential is missing" },
  file_sets: { title: "File sets have nowhere to be kept" },
  sandbox: { title: "Sandbox not reachable" },
  sandbox_confinement: { title: "Sandbox not confined" },
};

/** Who puts a check right. A clearance chosen on the labels page is an administrator's; one fixed by the settings is the operator's. */
export function checkOwner(check: Pick<PreflightCheck, "name">, c?: Pick<SetupChecklist, "clearance_fixed_by_settings">): Owner {
  const owner = CHECK_SHORT[check.name]?.owner ?? "operator";
  if (owner === "admin" && /_clearance$/.test(check.name) && c && c.clearance_fixed_by_settings !== false) return "operator";
  return owner;
}

/** The first sentence of a message, cut to one line. */
export function firstLine(message: string, max = 110): string {
  const sentence = /^(.+?[.;:])(\s|$)/.exec(message)?.[1] ?? message;
  const line = sentence.replace(/[;:]$/, ".");
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const isOpen = (check: PreflightCheck) => check.status === "fail" || check.status === "to_do";

/** The labels the standing_mandates check names as having none: `None is set up at "board", "legal"`. */
export function labelsWithoutMandate(message: string): string[] {
  const m = /None is set up at ((?:"[^"]+"(?:,\s*|\s+and\s+)?)+)/.exec(message);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// --- what needs someone ---------------------------------------------------------

/**
 * Everything that needs someone now, one short row each, the ones stopping
 * work first. Built from the checklist's items that need someone, broken
 * into the particular things each names, and from the deployment's own
 * checks that fail or are to do and that no such row already covers.
 */
export function attentionItems(c: SetupChecklist, gates: readonly GateLike[] = []): AttentionItem[] {
  const out: AttentionItem[] = [];
  // Parties a person must consent for somewhere, with nobody who may.
  for (const { party, boundaries } of partiesReleasedByNobody(c, gates)) {
    out.push({
      key: `release-nobody-${party.id}`,
      title: `Nobody can consent for ${party.name}`,
      consequence: `A person decides at ${boundaries.length === 1 ? "1 boundary" : `${boundaries.length} boundaries`}; what rests on its material waits there`,
      owner: "admin",
      href: "/admin/people?drawer=grant",
      action: "Grant",
      tone: "warn",
      blocks: false,
      detail: `Where a boundary's rule says a person decides, each part that rests on ${party.name}'s material waits for someone who consents for ${party.name}, and nobody can: ${boundaries.join(", ")}.`,
    });
  }
  // The checks a row from the checklist already speaks for.
  const covered = new Set<string>();
  const checks = c.preflight?.checks ?? [];
  const check = (name: string) => checks.find((k) => k.name === name);
  const failsAndBlocks = (name: string) => {
    const k = check(name);
    return !!k && k.status === "fail" && k.blocking;
  };
  const clearanceOwner: Owner = c.clearance_fixed_by_settings === false ? "admin" : "operator";
  const labelsHref = clearanceOwner === "admin" ? "/admin/labels" : "/admin#check-model_clearance";

  // People: a permission nobody holds, a label nobody reads.
  for (const p of c.permissions) {
    if (p.scope === "none" && p.accounts + p.groups === 0) {
      out.push({
        key: `people-${p.permission}`,
        title: `Nobody may ${permissionPhrase(p.permission)}`,
        consequence:
          p.permission === "direct"
            ? "Nobody can add a source or open a mandate"
            : p.permission === "fund"
              ? "No work can be funded"
              : p.permission === "administer"
                ? "Nobody can grant permissions"
                : "Nobody holds it",
        owner: "admin",
        href: "/admin/people?drawer=grant",
        action: "Grant",
        tone: "warn",
        blocks: false,
      });
    }
    if (p.permission === "read") {
      for (const l of p.by_label ?? []) {
        if (l.accounts + l.groups > 0) continue;
        out.push({
          key: `people-read-${l.label}`,
          title: `Nobody reads at ${l.label}`,
          consequence: "What agents write there has no reader",
          owner: "admin",
          href: "/admin/people?drawer=grant",
          action: "Grant",
          tone: "warn",
          blocks: false,
        });
      }
    }
  }

  // Labels: a setting naming a label nobody defined, and what each label is not cleared for.
  if (c.undefined_labels_in_provider_setting.length > 0) {
    covered.add("provider_labels");
    out.push({
      key: "labels-undefined",
      title: `PROVIDER_LABELS names ${listed(c.undefined_labels_in_provider_setting)}, not defined`,
      consequence: "Every call to a model provider is refused, at every label",
      owner: "operator",
      href: "/admin/labels",
      action: "View",
      tone: "bad",
      blocks: failsAndBlocks("provider_labels"),
      detail:
        "An administrator defines the label, or whoever runs the deployment corrects the name in the setting.",
    });
  }
  for (const l of c.labels) {
    if (l.model_providers_cleared.length === 0) {
      covered.add("model_clearance");
      out.push({
        key: `labels-${l.name}-models`,
        title: `No model provider cleared for ${l.name}`,
        consequence: "No agent can work at that label",
        owner: clearanceOwner,
        href: labelsHref,
        action: "Fix",
        tone: "warn",
        blocks: false,
      });
    } else if (l.roles_not_served.length > 0) {
      covered.add("model_clearance");
      const providers = [...new Set(l.roles_not_served.map((r) => providerName(r.provider)))];
      out.push({
        key: `labels-${l.name}-roles`,
        title: `${listed(providers)} not cleared for ${l.name}`,
        consequence: `${l.roles_not_served.length === 1 ? "1 role's runs are" : `${count(l.roles_not_served.length, "role")}' runs are`} refused there`,
        owner: clearanceOwner,
        href: labelsHref,
        action: "Fix",
        tone: "warn",
        blocks: false,
        detail: `Roles refused at ${l.name}: ${listed(l.roles_not_served.map((r) => r.role.replace(/_/g, " ")))}.`,
      });
    }
    if (!l.outside_services_cleared.includes("embeddings")) {
      covered.add("embeddings_clearance");
      out.push({
        key: `labels-${l.name}-embeddings`,
        title: `Embeddings not cleared for ${l.name}`,
        consequence: "Search by meaning is off at that label",
        owner: clearanceOwner,
        href: labelsHref,
        action: "Fix",
        tone: "warn",
        blocks: false,
      });
    }
  }
  if (c.labels.length === 0) {
    out.push({
      key: "labels-none",
      title: "No label besides public",
      consequence: "Every member reads everything here",
      owner: "admin",
      href: "/admin/labels",
      action: "Define",
      tone: "warn",
      blocks: false,
    });
  }

  // Parties.
  const parties = c.material.sources_by_party.map((p) => p.party);
  if (parties.length === 0) {
    out.push({
      key: "parties-none",
      title: "No party recorded",
      consequence: "Nobody can say whose material a source is",
      owner: "admin",
      href: "/admin/parties",
      action: "Add",
      tone: "warn",
      blocks: false,
    });
  } else if (!parties.some((p) => p.is_own_organization)) {
    covered.add("own_organization");
    out.push({
      key: "parties-own",
      title: "Organisation not recorded as a party",
      consequence: "Its own material has no owner",
      owner: "admin",
      href: "/admin/parties",
      action: "Add",
      tone: "warn",
      blocks: false,
    });
  }

  // General mandates: one row for each label with none, from the checklist and from the deployment's own check.
  const mandateCheck = check("standing_mandates");
  const missingAt = new Set<string>();
  let missingUnlabelled = false;
  for (const m of c.standing_mandates) {
    const each = m.by_label ?? [{ label: null as string | null, mandate: m.mandate }];
    for (const at of each) {
      const where = at.label ? ` at ${at.label}` : "";
      if (!at.mandate) {
        if (at.label) missingAt.add(at.label);
        else missingUnlabelled = true;
        continue;
      }
      if (at.mandate.budget_owls <= 0 || !at.mandate.running) {
        out.push({
          key: `mandate-${at.label ?? "general"}-idle`,
          title: at.mandate.budget_owls <= 0 ? `General mandate${where} has no budget` : `General mandate${where} not running`,
          consequence: "Upkeep and audits there go unpaid",
          owner: "admin",
          href: "/admin/budget",
          action: "Add owls",
          tone: "warn",
          blocks: false,
        });
      }
    }
  }
  if (mandateCheck && isOpen(mandateCheck)) {
    covered.add("standing_mandates");
    for (const label of labelsWithoutMandate(mandateCheck.message)) missingAt.add(label);
  }
  if (missingUnlabelled) {
    out.push({
      key: "mandate-general",
      title: "No General mandate",
      consequence: "No upkeep or audit runs: nothing pays for it",
      owner: "admin",
      href: "/admin/budget",
      action: "Set up",
      tone: "warn",
      blocks: false,
    });
  }
  for (const label of missingAt) {
    out.push({
      key: `mandate-${label}`,
      title: `No General mandate at ${label}`,
      consequence: "Upkeep and audits there have nothing to pay them",
      owner: "admin",
      href: "/admin/budget",
      action: "Set up",
      tone: mandateCheck?.status === "fail" ? "bad" : "warn",
      blocks: false,
      ...(mandateCheck && isOpen(mandateCheck) ? { detail: mandateCheck.message } : {}),
    });
  }

  // Owls: a model with no price, and none created. A call on an unpriced
  // model is refused where it is made, so only the roles set to it stop.
  for (const m of c.owls.unpriced_models) {
    covered.add("model_prices");
    out.push({
      key: `owls-price-${m.setting}`,
      title: `No price for ${m.model} (${m.setting})`,
      consequence: `${roleOfSetting(m.setting)} does no work until it has one; other roles run`,
      owner: "operator",
      href: "/admin#check-model_prices",
      action: "View",
      tone: "bad",
      blocks: failsAndBlocks("model_prices"),
      detail: "Whoever runs the deployment states a price for it in its MODEL_PRICES setting (0 counts a model as free).",
    });
  }
  if (c.owls.created_here && c.owls.unpriced_models.length === 0 && (c.owls.created_total_owls ?? 0) === 0) {
    out.push({
      key: "owls-none",
      title: "No owls created yet",
      consequence: "No mandate or person has anything to spend",
      owner: "admin",
      href: "/admin/budget",
      action: "Create",
      tone: "warn",
      blocks: false,
    });
  }

  // The usage report.
  const u = c.usage_report;
  if (u.reporting) {
    if (u.destination === "none") {
      covered.add("usage_report");
      out.push({
        key: "usage-destination",
        title: "Usage reports have nowhere to go",
        consequence: u.unsent > 0 ? `${count(u.unsent, "report")} waiting` : "Each day's report is kept, unsent",
        owner: "operator",
        href: "/admin/budget",
        action: "View",
        tone: "warn",
        blocks: false,
        detail: "USAGE_REPORT_URL with USAGE_REPORT_API_KEY to send them, or USAGE_REPORT_DIR to write each one as a file.",
      });
    } else if (!u.destination_ready) {
      covered.add("usage_report");
      out.push({
        key: "usage-key",
        title: "USAGE_REPORT_API_KEY not set",
        consequence: "Usage reports can't be sent",
        owner: "operator",
        href: "/admin/budget",
        action: "View",
        tone: "warn",
        blocks: false,
      });
    } else if (u.unsent > 0 && u.last_error) {
      covered.add("usage_report");
      out.push({
        key: "usage-failed",
        title: "Usage report not sent",
        consequence: `${count(u.unsent, "report")} waiting · the last attempt failed`,
        owner: "admin",
        href: "/admin/budget",
        action: "Retry",
        tone: "bad",
        blocks: false,
        detail: u.last_error,
      });
    }
  }

  // Keeping public versions current.
  if (c.public_graph?.last_not_taken) {
    out.push({
      key: "public-not-taken",
      title: "Public graph refused the last request",
      consequence: "Public versions are not being kept current",
      owner: "admin",
      href: "/gates",
      action: "View",
      tone: "bad",
      blocks: false,
      detail: c.public_graph.last_not_taken,
    });
  }

  // Pages are released outside and the public graph is reached from here, but the key they are signed with was never registered from here.
  const key = c.public_graph?.signing_key;
  if (c.public_graph?.account_set && key && key.shown_outside > 0 && key.fingerprint && !key.registered_from_here_at) {
    out.push({
      key: "signing-key-unregistered",
      title: "Signing key not registered",
      consequence: `${key.shown_outside === 1 ? "1 page is" : `${key.shown_outside} pages are`} released outside; the public graph takes none signed with an unregistered key`,
      owner: "admin",
      href: "/admin/outside?drawer=key",
      action: "Register",
      tone: "warn",
      blocks: false,
      detail:
        "This deployment's log has no registration of the key it signs with now. Registering it from the Public graph page names the organisation's " +
        "account there as the publisher. A registration made elsewhere is not in the log; the Public graph page reads the public graph's own record.",
    });
  }

  // Connections.
  const k = c.connections;
  for (const f of k.failing) {
    out.push({
      key: `connection-${f.id}-failing`,
      title: `${f.name} not answering`,
      consequence: "Agents can't read from it",
      owner: "admin",
      href: `/admin/connections/${encodeURIComponent(f.id)}`,
      action: "View",
      tone: "bad",
      blocks: false,
    });
  }
  for (const f of k.credential_missing) {
    covered.add("connections");
    out.push({
      key: `connection-${f.id}-credential`,
      title: `No credential for ${f.name}`,
      consequence: "It can't be reached where the deployment runs",
      owner: "operator",
      href: `/admin/connections/${encodeURIComponent(f.id)}`,
      action: "View",
      tone: "bad",
      blocks: false,
    });
  }
  for (const w of k.tools_withdrawn) {
    out.push({
      key: `connection-${w.connection.id}-withdrawn-${w.tool}`,
      title: `${w.tool} withdrawn on ${w.connection.name}`,
      consequence: "It changed at the system; agents aren't offered it",
      owner: "admin",
      href: `/admin/connections/${encodeURIComponent(w.connection.id)}`,
      action: "Look again",
      tone: "warn",
      blocks: false,
    });
  }
  if (k.on > k.offering_tools) {
    const idle = k.on - k.offering_tools;
    out.push({
      key: "connections-idle",
      title: `${count(idle, "connection")} ${idle === 1 ? "offers" : "offer"} agents no tool`,
      consequence: "Switched on, and agents can't use it yet",
      owner: "admin",
      href: "/admin/connections",
      action: "Pick tools",
      tone: "warn",
      blocks: false,
    });
  }

  // Material.
  if (c.material.sources === 0 && c.material.nodes === 0) {
    out.push({
      key: "material-none",
      title: "Nothing read yet",
      consequence: "The graph is empty until a source is added",
      owner: "admin",
      href: "/sources?drawer=add",
      action: "Add source",
      tone: "warn",
      blocks: false,
    });
  }

  // The deployment's own checks that fail or are to do, and that nothing above speaks for.
  for (const k of checks) {
    if (!isOpen(k) || covered.has(k.name)) continue;
    const blocks = k.status === "fail" && k.blocking;
    out.push({
      key: `check-${k.name}`,
      title: CHECK_SHORT[k.name]?.title ?? `${preflightTitle(k)} ${k.status === "fail" ? "fails" : "is to do"}`,
      consequence: blocks ? "Agent work waits on this" : firstLine(k.message),
      owner: checkOwner(k, c),
      href: `/admin#check-${k.name}`,
      action: "View",
      tone: k.status === "fail" ? "bad" : "warn",
      blocks,
      detail: [k.message, preflightTodo(k)].filter(Boolean).join(" "),
    });
  }

  // What stops agent work first, then what needs someone now, then what is to do.
  const rank = (i: AttentionItem) => (i.blocks ? 0 : i.tone === "bad" ? 1 : 2);
  return out.map((item, i) => ({ item, i })).sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i).map(({ item }) => item);
}

// --- the areas -------------------------------------------------------------------

export interface AreaTile {
  key: string;
  name: string;
  state: ItemState;
  /** One line: the fact that matters. */
  fact: string;
  /** Every fact and what to do next, for a hover. */
  detail: string;
  href: string | null;
}

export const STATE_TONE: Record<ItemState, "ok" | "warn" | "bad" | "neu"> = {
  done: "ok",
  to_do: "warn",
  attention: "bad",
  optional: "neu",
  not_reported: "neu",
};

const owlsShort = (n: number) => Number(n.toFixed(2)).toLocaleString("en-GB", { maximumFractionDigits: 2 });

function areaFact(item: ChecklistItem, c: SetupChecklist): string {
  switch (item.key) {
    case "people": {
      const nobody = c.permissions.filter((p) => p.scope === "none" && p.accounts + p.groups === 0);
      const unread = (c.permissions.find((p) => p.permission === "read")?.by_label ?? []).filter((l) => l.accounts + l.groups === 0);
      if (nobody.length > 0) return `Nobody may ${permissionPhrase(nobody[0].permission)}`;
      if (unread.length > 0) return `Nobody reads at ${listed(unread.map((l) => l.label))}`;
      return "Every permission held";
    }
    case "labels": {
      if (c.undefined_labels_in_provider_setting.length > 0) return `PROVIDER_LABELS names ${listed(c.undefined_labels_in_provider_setting)}`;
      if (c.labels.length === 0) return "Only public";
      const noModels = c.labels.filter((l) => l.model_providers_cleared.length === 0).map((l) => l.name);
      const noEmbeddings = c.labels.filter((l) => !l.outside_services_cleared.includes("embeddings")).map((l) => l.name);
      const parts = [count(c.labels.length, "label")];
      if (noModels.length > 0) parts.push(`no provider at ${listed(noModels)}`);
      else if (noEmbeddings.length > 0) parts.push(`embeddings off at ${listed(noEmbeddings)}`);
      return parts.join(" · ");
    }
    case "parties": {
      const parties = c.material.sources_by_party.map((p) => p.party);
      if (parties.length === 0) return "None recorded";
      const own = parties.find((p) => p.is_own_organization);
      return `${count(parties.length, "party", "parties")} · ${own ? `${own.name} is this organisation` : "none is this organisation"}`;
    }
    case "standing_mandates": {
      const each = c.standing_mandates.flatMap((m) => m.by_label ?? [{ label: null as string | null, mandate: m.mandate }]);
      const running = each.filter((e) => e.mandate && e.mandate.budget_owls > 0 && e.mandate.running).length;
      const check = c.preflight?.checks.find((k) => k.name === "standing_mandates");
      const none = [
        ...new Set([
          ...each.filter((e) => !e.mandate && e.label).map((e) => e.label as string),
          ...(check && isOpen(check) ? labelsWithoutMandate(check.message) : []),
        ]),
      ];
      if (each.length === 1 && each[0].label === null && none.length === 0) {
        return running === 1 ? "Running" : each[0].mandate ? "Set up, not running" : "Not set up";
      }
      const total = Math.max(each.length, running + none.length);
      return `Running at ${running} of ${count(total, "label")}` + (none.length > 0 ? ` · none at ${listed(none)}` : "");
    }
    case "owls": {
      const o = c.owls;
      if (!o.created_here) return "Bought, as on the public graph";
      const created = o.created_total_owls ?? 0;
      const unspent = created - (o.spent_total_owls ?? 0);
      const base = created === 0 ? "None created yet" : `${owlsShort(unspent)} unspent of ${owlsShort(created)}`;
      return o.unpriced_models.length > 0 ? `${base} · ${count(o.unpriced_models.length, "model")} without a price` : base;
    }
    case "usage_report": {
      const u = c.usage_report;
      if (!u.reporting) return "Flat price: nothing to report";
      if (u.destination === "none") return "Nowhere set to send reports";
      if (!u.destination_ready) return "Key to send reports not set";
      if (u.unsent > 0 && u.last_error) return `${count(u.unsent, "report")} waiting · last send failed`;
      if (u.prepared === 0) return "No report due yet";
      return `${count(u.prepared, "report")} prepared` + (u.unsent > 0 ? ` · ${u.unsent} waiting` : ", all sent");
    }
    case "public_graph": {
      const p = c.public_graph!;
      if (p.last_not_taken) return "Last request not taken";
      if (p.keep_public_current.setting === "off") return "Keeping public versions current is off";
      return p.keep_public_current.sends ? "Public versions kept current" : "On, and nothing is sent";
    }
    case "connections": {
      const k = c.connections;
      if (k.total === 0) return "None connected";
      const trouble = [
        ...k.failing.map((f) => `${f.name} not answering`),
        ...k.credential_missing.map((f) => `no credential for ${f.name}`),
        ...(k.tools_withdrawn.length > 0 ? [`${count(k.tools_withdrawn.length, "tool")} withdrawn`] : []),
      ];
      return [`${k.on} on`, `${k.offering_tools} offering tools`, ...trouble.slice(0, 1)].join(" · ");
    }
    case "material": {
      const m = c.material;
      if (m.sources === 0 && m.nodes === 0) return "Nothing read yet";
      return [
        count(m.sources, "source"),
        count(m.nodes, "node"),
        ...(m.sources_waiting_for_review > 0 ? [`${m.sources_waiting_for_review} waiting for review`] : []),
      ].join(" · ");
    }
    default:
      return item.facts[0] ? firstLine(item.facts[0]) : "";
  }
}

/** Each area of the setup checklist as a tile, the deployment's own checks left to their own table. */
export function areaTiles(c: SetupChecklist): AreaTile[] {
  return checklistItems(c)
    .filter((item) => item.key !== "checks")
    .map((item) => ({
      key: item.key,
      name: AREA_NAMES[item.key] ?? item.title,
      state: item.state,
      fact: areaFact(item, c),
      detail: [...item.facts, ...(item.next ? [`Next: ${item.next}`] : [])].join(" "),
      href: AREA_HREF[item.key] ?? item.href ?? null,
    }));
}

/** The checks counted by status. */
export function checkCounts(checks: readonly PreflightCheck[]): Record<PreflightCheck["status"], number> {
  const n = { pass: 0, fail: 0, to_do: 0, not_applicable: 0 };
  for (const k of checks) n[k.status] += 1;
  return n;
}

/** The role a model setting sets, in words: MODELS_RESEARCHER or RESEARCHER_MODEL → "The researcher role". */
export function roleOfSetting(setting: string): string {
  const role = setting.replace(/^MODELS?_/, "").replace(/_MODELS?$/, "").toLowerCase().replace(/_/g, " ").trim();
  return role ? `The ${role} role` : "The role set to it";
}

/** What of a gate this needs: its boundary, its starting positions and its rules. */
export interface GateLike {
  from: string;
  to: string;
  to_outside: boolean;
  starting_positions: Record<string, string>;
  settings: Array<{ mode: string; party: { id: string } | null }>;
}

/**
 * The parties nobody can consent for (the permission stored as `release`),
 * at the boundaries where a person
 * decides for them: a rule there that a person decides, for that party or
 * for every party, or, for the organisation's own material, a kind that
 * starts with a person deciding (an agent's report). There what rests on
 * the party's material waits for someone who consents for it, and with none it
 * waits for good.
 */
export function partiesReleasedByNobody(
  c: SetupChecklist,
  gates: readonly GateLike[],
): Array<{ party: { id: string; name: string }; boundaries: string[] }> {
  const release = c.permissions.find((p) => p.permission === "release");
  const own = new Set(c.material.sources_by_party.filter((p) => p.party.is_own_organization).map((p) => p.party.id));
  const out: Array<{ party: { id: string; name: string }; boundaries: string[] }> = [];
  for (const entry of release?.by_party ?? []) {
    if (entry.accounts + entry.groups > 0) continue;
    const boundaries = gates
      .filter(
        (g) =>
          g.settings.some((s) => s.mode === "person" && (s.party === null || s.party.id === entry.party.id)) ||
          (own.has(entry.party.id) && Object.values(g.starting_positions).includes("person")),
      )
      .map((g) => `${g.from} → ${g.to_outside ? "outside" : g.to}`);
    if (boundaries.length > 0) out.push({ party: entry.party, boundaries });
  }
  return out;
}
