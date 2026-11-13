// The words of the administration pages (app/admin): what each permission is
// called, what the setup checklist says about each thing the deployment can
// see of itself, and how an entry of the log reads as a sentence.
//
// Kept apart from the pages so that it can be read in one place and tested
// without rendering anything (tests/unit/web/admin-words.test.ts). Nothing
// here asks the API anything; it turns what the API answered into sentences.
//
// Sentences the API itself writes (what a permission covers, a preflight
// check's message, the notice on a connection, what a usage report says) are
// shown as the API wrote them and are not rewritten here.

import type {
  ChecklistLabel,
  Holders,
  LogEntry,
  PreflightCheck,
  SetupChecklist,
  Withheld,
} from "./admin-api";

// --- small helpers --------------------------------------------------------------

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". */
export function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function owlsText(n: number): string {
  const text = Number(n.toFixed(3)).toLocaleString("en-GB", { maximumFractionDigits: 3 });
  return `${text} ${n === 1 ? "owl" : "owls"}`;
}

/** The first letter in capitals, for a phrase that stands alone in a table cell. */
export function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "2 people and 1 group", "1 person", "nobody". */
export function holdersText(h: Holders): string {
  const parts = [
    ...(h.accounts > 0 ? [count(h.accounts, "person", "people")] : []),
    ...(h.groups > 0 ? [count(h.groups, "group")] : []),
  ];
  return parts.length > 0 ? parts.join(" and ") : "nobody";
}

// --- permissions ----------------------------------------------------------------

/** What each permission is called on a page, and in the middle of a sentence. */
const PERMISSION_WORDS: Record<string, { name: string; to: string }> = {
  direct: { name: "Direct the graph", to: "direct the graph" },
  release: { name: "Release a party's material", to: "release a party's material" },
  fund: { name: "Fund work", to: "fund work" },
  read: { name: "Read at a label", to: "read at a label" },
  read_sources: { name: "Open raw sources at a label", to: "open raw sources at a label" },
  administer: { name: "Administer the deployment", to: "administer the deployment" },
};

export function permissionName(permission: string): string {
  return PERMISSION_WORDS[permission]?.name ?? permission.replace(/_/g, " ");
}

/** As it follows "the permission to". */
export function permissionPhrase(permission: string): string {
  return PERMISSION_WORDS[permission]?.to ?? permission.replace(/_/g, " ");
}

/** A grant with its scope: "read at internal", "release for Orrin Labs", "fund work". */
export function grantText(grant: {
  permission: string;
  label?: string | null;
  party?: { name: string } | null;
}): string {
  if (grant.permission === "read" && grant.label) return `read at ${grant.label}`;
  if (grant.permission === "read_sources" && grant.label) return `open raw sources at ${grant.label}`;
  if (grant.permission === "release" && grant.party) return `release for ${grant.party.name}`;
  return permissionPhrase(grant.permission);
}

/** What a page says to a person who reached it without the permission it needs. */
export function needsPermission(permission: string): string {
  return (
    `This page needs the permission to ${permissionPhrase(permission)}, which you do not hold. ` +
    `An administrator of this deployment grants it.`
  );
}

// --- the preflight's checks -----------------------------------------------------

/**
 * Each check in plain words, and what to do when it fails where the check's
 * own sentence does not already say.
 */
const PREFLIGHT_WORDS: Record<string, { title: string; todo?: string }> = {
  config_file: { title: "The config file" },
  database: {
    title: "The database",
    todo: "This is put right where the deployment runs: the database it points at, the pgvector extension, and applying the migrations that are waiting.",
  },
  run_log: { title: "The run log" },
  models: {
    title: "A model for each role",
    todo: "Set the missing key in the environment the API runs in, or name a different model for the role under [models] in the config file.",
  },
  embeddings: {
    title: "Embeddings",
    todo: "Set OPENAI_API_KEY in the environment the API runs in.",
  },
  web_search: {
    title: "Searching the open web",
    todo: "Set OPENROUTER_API_KEY in the environment the API runs in, or give the roles named a model that Anthropic searches for.",
  },
  page_reading: { title: "Reading web pages" },
  elicit: { title: "Elicit" },
  pangram: { title: "Pangram" },
  payments: { title: "Payments" },
  github_issues: {
    title: "Filing agents' reports on GitHub",
    todo: "Set the credential it names, or leave outside_services.github_issues.repo empty so that nothing is filed.",
  },
  reports_stay_inside: { title: "Agents' reports stay inside" },
  features: { title: "Features" },
  work_outside_the_run_log: {
    title: "Work that leaves no log",
    todo: "No setting changes this yet. It is listed so that whoever runs the deployment knows.",
  },
};

export function preflightTitle(check: Pick<PreflightCheck, "name">): string {
  const words = PREFLIGHT_WORDS[check.name]?.title ?? check.name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function preflightTodo(check: Pick<PreflightCheck, "name" | "status">): string | null {
  return check.status === "fail" ? (PREFLIGHT_WORDS[check.name]?.todo ?? null) : null;
}

// --- model providers ------------------------------------------------------------

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

export function providerName(provider: string | null): string {
  if (provider === null) return "no provider this deployment knows";
  if (provider.startsWith("endpoint:")) return `the deployment's own endpoint "${provider.slice("endpoint:".length)}"`;
  return PROVIDER_NAMES[provider] ?? provider;
}

/** What is cleared for one label, and what is left unserved there. */
export function labelClearanceFacts(label: ChecklistLabel): string[] {
  const facts: string[] = [];
  if (label.model_providers_cleared.length === 0) {
    facts.push(
      `${label.name}: no model provider is cleared for it, so no agent can work at this label yet.`
    );
    return facts;
  }
  facts.push(`${label.name}: cleared for ${listed(label.model_providers_cleared.map(providerName))}.`);
  if (label.roles_not_served.length > 0) {
    const byProvider = new Map<string, string[]>();
    for (const role of label.roles_not_served) {
      const name = providerName(role.provider);
      byProvider.set(name, [...(byProvider.get(name) ?? []), role.role.replace(/_/g, " ")]);
    }
    const roles = [...byProvider.entries()].map(([provider, names]) => `${listed(names)} (${provider})`);
    facts.push(
      `At ${label.name}, the work of these roles is refused, because the provider their model runs on is not cleared for it: ${roles.join("; ")}.`
    );
  }
  if (!label.outside_services_cleared.includes("embeddings")) {
    facts.push(
      `Embeddings are not cleared for ${label.name}, so what is written at this label cannot be matched against the graph or searched by meaning.`
    );
  }
  return facts;
}

// --- the setup checklist --------------------------------------------------------

/**
 * done: the deployment can see that this is in place.
 * to_do: something is not in place yet, and the item says what and who.
 * attention: something that was in place needs someone, or is stopping work.
 * optional: nothing is set up, and nothing needs to be.
 */
export type ItemState = "done" | "to_do" | "attention" | "optional" | "not_reported";

export const ITEM_STATE_WORDS: Record<ItemState, string> = {
  done: "In place",
  to_do: "To do",
  attention: "Needs someone",
  optional: "Not set up",
  // Nothing is known here either way: the build has no means of looking.
  not_reported: "Not reported",
};

export interface ChecklistItem {
  key: string;
  title: string;
  state: ItemState;
  /** What the deployment can see of itself, a sentence each. */
  facts: string[];
  /** What to do next and who can do it. Absent when nothing is to do. */
  next?: string;
  /** Where it is done. */
  href?: string;
  link?: string;
}

const CONFIG_OWNER = "Whoever runs the deployment";

function checksItem(c: SetupChecklist): ChecklistItem {
  if (c.preflight === null) {
    // A build with no preflight has nothing to report here, and says so: an
    // empty list would read as every check passing.
    return {
      key: "checks",
      title: "The deployment's own checks",
      state: "not_reported",
      facts: [
        "This build does not check its own configuration, so nothing is reported here. The lines below are read from the deployment as it runs.",
      ],
    };
  }
  const { checks, agent_work: agentWork } = c.preflight;
  const failed = checks.filter((k) => k.status === "fail");
  const passed = checks.filter((k) => k.status === "pass").length;
  const notApplicable = checks.length - passed - failed.length;
  const facts = [
    `${count(checks.length, "check")}: ${passed} pass, ${failed.length} fail` +
      (notApplicable > 0 ? `, ${notApplicable} ${notApplicable === 1 ? "does" : "do"} not apply.` : "."),
  ];
  if (agentWork === "refused") {
    facts.push("Agent work is not started: a check that must pass first has failed.");
  }
  return {
    key: "checks",
    title: "The deployment's own checks",
    state: agentWork === "refused" ? "attention" : failed.length > 0 ? "to_do" : "done",
    facts,
    ...(failed.length > 0
      ? {
          next: `${CONFIG_OWNER} puts these right. They are settings in its config file and its environment, and each failed check below says which.`,
        }
      : {}),
  };
}

function peopleItem(c: SetupChecklist): ChecklistItem {
  const facts: string[] = [];
  const gaps: string[] = [];
  for (const p of c.permissions) {
    const name = permissionName(p.permission);
    if (p.scope === "none") {
      facts.push(`${name}: ${holdersText(p)}.`);
      if (p.accounts + p.groups === 0) {
        gaps.push(`Nobody holds the permission to ${permissionPhrase(p.permission)}${GAP_CONSEQUENCE[p.permission] ?? ""}.`);
      }
      continue;
    }
    if (p.scope === "label") {
      const labels = p.by_label ?? [];
      if (labels.length === 0) {
        facts.push(`${name}: there is no label besides public yet, and every member reads public.`);
        continue;
      }
      const verb = p.permission === "read" ? "Read at" : "Open raw sources at";
      for (const l of labels) {
        facts.push(`${verb} ${l.label}: ${holdersText(l)}.`);
        if (p.permission === "read" && l.accounts + l.groups === 0) {
          gaps.push(`Nobody may read at ${l.label}, so what the agents write at that label has no reader.`);
        }
      }
      continue;
    }
    const parties = p.by_party ?? [];
    if (parties.length === 0) {
      facts.push(`${name}: no party is recorded yet.`);
      continue;
    }
    for (const party of parties) facts.push(`Release for ${party.party.name}: ${holdersText(party)}.`);
  }
  return {
    key: "people",
    title: "People and permissions",
    state: gaps.length > 0 ? "to_do" : "done",
    facts,
    ...(gaps.length > 0 ? { next: `${gaps[0]} An administrator grants permissions.` } : {}),
    href: "/admin/people",
    link: "People and permissions",
  };
}

/** What follows from nobody holding a permission, as the end of a sentence. */
const GAP_CONSEQUENCE: Record<string, string> = {
  direct: ", so nobody can add a source or open a mandate",
  fund: ", so no work can be funded",
};

function labelsItem(c: SetupChecklist): ChecklistItem {
  const base = {
    key: "labels",
    title: "Labels and model providers",
    href: "/admin/labels",
    link: "Labels and parties",
  };
  const undefinedNames = c.undefined_labels_in_provider_setting;
  if (undefinedNames.length > 0) {
    return {
      ...base,
      state: "attention",
      facts: [
        `The setting that clears providers (PROVIDER_LABELS) names ${undefinedNames.length === 1 ? "a label" : "labels"} this deployment does not define: ${listed(undefinedNames)}.`,
        "Until that is put right, every call to a model provider is refused, at every label.",
        ...c.labels.flatMap(labelClearanceFacts),
      ],
      next: `An administrator defines the label, or ${CONFIG_OWNER.toLowerCase()} corrects the name in the setting.`,
    };
  }
  if (c.labels.length === 0) {
    return {
      ...base,
      state: "to_do",
      facts: [
        "The only label is public. Everything in this deployment can be read by every member, and can be sent to every model provider and outside service it uses.",
      ],
      next: "An administrator defines a label for material that is not for every member.",
    };
  }
  const facts = c.labels.flatMap(labelClearanceFacts);
  const unserved = c.labels.some(
    (l) =>
      l.model_providers_cleared.length === 0 ||
      l.roles_not_served.length > 0 ||
      !l.outside_services_cleared.includes("embeddings")
  );
  return {
    ...base,
    state: unserved ? "to_do" : "done",
    facts,
    ...(unserved
      ? {
          next: `${CONFIG_OWNER} clears a provider for a label in its PROVIDER_LABELS setting. Which outside party may be sent private text is chosen there, and is never guessed.`,
        }
      : {}),
  };
}

function partiesItem(c: SetupChecklist): ChecklistItem {
  const parties = c.material.sources_by_party.map((p) => p.party);
  const base = { key: "parties", title: "Parties", href: "/admin/labels#parties", link: "Labels and parties" };
  if (parties.length === 0) {
    return {
      ...base,
      state: "to_do",
      facts: [
        "No party is recorded. A party is whoever a source belongs to: this organisation, or an outside party that supplied material.",
      ],
      next: "An administrator adds this organisation as a party, and then any outside party whose material the graph will hold.",
    };
  }
  const names = parties.map((p) => (p.is_own_organization ? `${p.name} (this organisation)` : p.name));
  const own = parties.some((p) => p.is_own_organization);
  return {
    ...base,
    state: own ? "done" : "to_do",
    facts: [`${count(parties.length, "party", "parties")}: ${listed(names)}.`],
    ...(own
      ? {}
      : { next: "None of them is marked as this organisation. An administrator adds the organisation itself as a party." }),
  };
}

function mandatesItem(c: SetupChecklist): ChecklistItem {
  const WHAT: Record<string, string> = { general: "upkeep has", governance: "audits have" };
  // One line for each mandate, or, where the deployment holds material at
  // more than one label, for each mandate at each label the reader reads: a
  // mandate's work runs at its label, so a label with none has nobody
  // paying for its upkeep or its audits.
  const each = c.standing_mandates.flatMap((m) =>
    m.by_label
      ? m.by_label.map((at) => ({ m, mandate: at.mandate, where: ` at the label ${at.label}`, short: ` at ${at.label}` }))
      : [{ m, mandate: m.mandate, where: "", short: "" }]
  );
  const facts = each.map(({ m, mandate, where, short }) => {
    if (!mandate) return `${m.title}${short}: not set up. Until it is, ${WHAT[m.name] ?? "its work has"} no mandate to pay for it${where}.`;
    if (mandate.budget_owls <= 0) return `${m.title}${short}: set up with no budget, so it can pay for nothing yet.`;
    const daily = mandate.daily_owls > 0 ? `, at most ${owlsText(mandate.daily_owls)} a day` : "";
    const waiting = mandate.running ? "" : " It is not running: its budget is spent, or it is waiting for one.";
    return `${m.title}${short}: set up with a budget of ${owlsText(mandate.budget_owls)}${daily}.${waiting}`;
  });
  const ready = each.every(({ mandate }) => mandate && mandate.budget_owls > 0 && mandate.running);
  const missing = each.some(({ mandate }) => !mandate);
  return {
    key: "standing_mandates",
    title: "The General and Governance mandates",
    state: ready ? "done" : "to_do",
    facts,
    ...(ready
      ? {}
      : {
          next: missing
            ? "An administrator sets them up. No agent work runs unless a mandate pays for it."
            : "An administrator adds to the budget, or anyone who holds the permission to fund backs the mandate.",
        }),
    href: "/admin/owls#standing-mandates",
    link: "Owls",
  };
}

function owlsItem(c: SetupChecklist): ChecklistItem {
  const base = { key: "owls", title: "Owls", href: "/admin/owls", link: "Owls" };
  if (!c.owls.created_here) {
    return {
      ...base,
      state: "done",
      facts: ["Owls here are bought, as on the public graph. Nobody creates them."],
    };
  }
  const created = c.owls.created_total_owls ?? 0;
  const facts = [
    `This deployment creates its own owls: ${owlsText(created)} created so far, ${owlsText(c.owls.spent_total_owls ?? 0)} spent by its agents' runs.`,
  ];
  const unpriced = c.owls.unpriced_models;
  if (unpriced.length > 0) {
    facts.push(
      `${count(unpriced.length, "model")} that a role is set to run ${unpriced.length === 1 ? "has" : "have"} no price here, so a run on ${unpriced.length === 1 ? "it" : "one"} is refused before anything is sent: ${listed(unpriced.map((m) => `${m.model} (${m.setting})`))}.`
    );
    return {
      ...base,
      state: "attention",
      facts,
      next: `${CONFIG_OWNER} states a price for each in its MODEL_PRICES setting.`,
    };
  }
  if (created === 0) {
    return {
      ...base,
      state: "to_do",
      facts,
      next: "An administrator creates owls into a mandate's budget or a person's balance.",
    };
  }
  return { ...base, state: "done", facts };
}

function usageItem(c: SetupChecklist): ChecklistItem {
  const u = c.usage_report;
  const base = { key: "usage_report", title: "The usage report", href: "/admin/usage-report", link: "The usage report" };
  if (!u.reporting) {
    return {
      ...base,
      state: "done",
      facts: ["This deployment pays a flat price for the public graph's feed, so it reports nothing."],
    };
  }
  const waiting = u.unsent > 0 ? `${count(u.unsent, "report")} ${u.unsent === 1 ? "is" : "are"} waiting to be sent.` : null;
  if (u.destination === "none") {
    return {
      ...base,
      state: "to_do",
      facts: [
        "Each day's total of owls spent is reported to the public graph, and there is nowhere set for the reports to go.",
        ...(waiting ? [waiting] : []),
      ],
      next: `${CONFIG_OWNER} sets where they go: USAGE_REPORT_URL with USAGE_REPORT_API_KEY to send them, or USAGE_REPORT_DIR to write each one as a file to hand over.`,
    };
  }
  if (!u.destination_ready) {
    return {
      ...base,
      state: "to_do",
      facts: ["Reports are set to be sent to the public graph, and the key they are sent under is not set.", ...(waiting ? [waiting] : [])],
      next: `${CONFIG_OWNER} sets USAGE_REPORT_API_KEY in the environment the API runs in.`,
    };
  }
  if (u.unsent > 0 && u.last_error) {
    return {
      ...base,
      state: "attention",
      facts: [waiting!, `The last attempt to send failed: ${u.last_error}`],
      next: "An administrator can try again from the usage report page once the cause is put right.",
    };
  }
  return {
    ...base,
    state: "done",
    facts: [
      u.prepared === 0
        ? "No day with a report to make has ended yet."
        : `${count(u.prepared, "report")} prepared${waiting ? `. ${waiting}` : ", all sent."}`,
    ],
  };
}

function connectionsItem(c: SetupChecklist): ChecklistItem {
  const k = c.connections;
  const base = { key: "connections", title: "Connections", href: "/admin/connections", link: "Connections" };
  // What the administrator is not shown: connections at labels they do not read.
  const notShown =
    k.not_shown > 0
      ? [
          `${count(k.not_shown, "more connection")} ${k.not_shown === 1 ? "is at a label" : "are at labels"} you do not read, and ${k.not_shown === 1 ? "is" : "are"} not counted here. An administrator who reads ${k.not_shown === 1 ? "that label" : "those labels"} sees ${k.not_shown === 1 ? "it" : "them"}.`,
        ]
      : [];
  if (k.total === 0) {
    return {
      ...base,
      state: "optional",
      facts: [k.not_shown > 0 ? "No system is connected at a label you read." : "No system is connected.", ...notShown],
      next: "An administrator can connect one, so that agents read the organisation's data where it lives.",
    };
  }
  const facts = [
    `${count(k.total, "connection")}, ${k.on} switched on, ${k.offering_tools} offering tools to agents.`,
    ...notShown,
  ];
  for (const f of k.failing) facts.push(`${f.name} did not answer when it was last asked.`);
  for (const f of k.credential_missing) {
    facts.push(`The credential for ${f.name} is not set where the deployment runs.`);
  }
  for (const w of k.tools_withdrawn) {
    facts.push(
      `${w.tool} on ${w.connection.name} was withdrawn from agents because it changed at the system, and waits for an administrator to look at it again.`
    );
  }
  const needsSomeone = k.failing.length + k.credential_missing.length + k.tools_withdrawn.length > 0;
  const idle = k.on > k.offering_tools;
  if (idle) facts.push(`${count(k.on - k.offering_tools, "connection")} switched on ${k.on - k.offering_tools === 1 ? "offers" : "offer"} agents no tool yet.`);
  return {
    ...base,
    state: needsSomeone ? "attention" : idle ? "to_do" : "done",
    facts,
    ...(needsSomeone
      ? { next: "An administrator opens the connection, looks at it again, and picks its tools once more." }
      : idle
        ? { next: "An administrator picks which of its tools agents are offered." }
        : {}),
  };
}

function materialItem(c: SetupChecklist): ChecklistItem {
  const m = c.material;
  const base = { key: "material", title: "Material", href: "/sources/new", link: "Add a source" };
  if (m.sources === 0 && m.nodes === 0) {
    return {
      ...base,
      state: "to_do",
      facts: ["Nothing has been read yet."],
      next: "Anyone who holds the permission to direct the graph can add a document or an address. An administrator can connect a system.",
    };
  }
  const facts = [
    `${count(m.sources, "source")} and ${count(m.nodes, "claim, quantity or question", "claims, quantities and questions")}.`,
  ];
  if (m.sources_waiting_for_review > 0) {
    facts.push(
      `${count(m.sources_waiting_for_review, "submitted source")} ${m.sources_waiting_for_review === 1 ? "is" : "are"} waiting for review before anything is read from ${m.sources_waiting_for_review === 1 ? "it" : "them"}.`
    );
  }
  const unowned = m.sources_by_party.length > 0 && m.sources_with_no_party > 0;
  if (unowned) {
    facts.push(`${count(m.sources_with_no_party, "source")} ${m.sources_with_no_party === 1 ? "is" : "are"} recorded as no party's.`);
  }
  return {
    ...base,
    state: "done",
    facts,
    ...(unowned
      ? { next: "An administrator can say whose material a source is, on the Labels and parties page." }
      : {}),
  };
}

/** Every item, in the order a deployment is set up. */
export function checklistItems(c: SetupChecklist): ChecklistItem[] {
  return [
    checksItem(c),
    peopleItem(c),
    labelsItem(c),
    partiesItem(c),
    mandatesItem(c),
    owlsItem(c),
    usageItem(c),
    connectionsItem(c),
    materialItem(c),
  ];
}

/** The items that need someone, the ones stopping work first. */
export function itemsNeedingSomeone(items: readonly ChecklistItem[]): ChecklistItem[] {
  return [...items.filter((i) => i.state === "attention"), ...items.filter((i) => i.state === "to_do")];
}

// --- the log --------------------------------------------------------------------

function isWithheld(value: unknown): value is Withheld {
  return typeof value === "object" && value !== null && (value as Withheld).withheld === true;
}

const labelWords = (v: string | Withheld | undefined) =>
  v === undefined ? "a label" : isWithheld(v) ? "a label whose name is withheld from you" : v;
const partyWords = (v: string | Withheld | null | undefined) =>
  v === undefined || v === null ? "no party" : isWithheld(v) ? "a party whose name is withheld from you" : v;
const connectionWords = (v: string | Withheld | undefined) =>
  v === undefined || isWithheld(v) ? "a connection whose name is withheld from you" : `the connection "${v}"`;

const VIA_WORDS: Record<string, string> = {
  first_administrator: "The deployment's first-administrator setting",
  operator: "The operator key",
};

const WITHDRAWN_WORDS: Record<string, string> = {
  changed: "it changed at the system",
  missing: "the system no longer lists it",
  address_changed: "the connection's address changed",
};

/** One entry of the log as a sentence. A name the reader is not entitled to is said to be withheld. */
export function logSentence(entry: LogEntry): string {
  const who = entry.by ?? VIA_WORDS[entry.via ?? ""] ?? "The deployment";
  const to = entry.account
    ? entry.account
    : entry.group
      ? `the group ${entry.group}`
      : "an account";
  // The permission with what it is held at: "read at internal", "release
  // the material of Orrin Labs", "fund work".
  const permission =
    entry.permission === "read"
      ? `read at ${labelWords(entry.label)}`
      : entry.permission === "read_sources"
        ? `open raw sources at ${labelWords(entry.label)}`
        : entry.permission === "release"
          ? `release the material of ${partyWords(entry.party)}`
          : permissionPhrase(entry.permission ?? "");
  switch (entry.event) {
    case "granted":
      return `${who} granted ${to} the permission to ${permission}.`;
    case "removed":
      return `${who} removed from ${to} the permission to ${permission}.`;
    case "label_defined":
      return isWithheld(entry.label)
        ? `${who} defined ${labelWords(entry.label)}.`
        : `${who} defined the label ${labelWords(entry.label)}.`;
    case "label_read_added":
      return `${who} recorded that ${labelWords(entry.label)} reads ${labelWords(entry.reads)}.`;
    case "label_read_removed":
      return `${who} took back that ${labelWords(entry.label)} reads ${labelWords(entry.reads)}.`;
    case "party_added":
      return isWithheld(entry.party)
        ? `${who} added ${partyWords(entry.party)}.`
        : `${who} added the party ${partyWords(entry.party)}.`;
    case "source_party_set":
      return `${who} recorded a source as the material of ${partyWords(entry.party)}; before, it was that of ${partyWords(entry.previous_party)}.`;
    case "connection_added":
      return `${who} added ${connectionWords(entry.connection)}.`;
    case "connection_changed":
      return (
        `${who} changed ${connectionWords(entry.connection)}` +
        (entry.changed && entry.changed.length > 0 ? `: ${listed(entry.changed.map((c) => c.replace(/_/g, " ")))}.` : ".")
      );
    case "connection_tools_offered": {
      const parts = [
        ...(entry.offered && entry.offered.length > 0 ? [`offered agents ${listed(entry.offered)}`] : []),
        ...(entry.no_longer_offered && entry.no_longer_offered.length > 0
          ? [`stopped offering ${listed(entry.no_longer_offered)}`]
          : []),
      ];
      return `${who} ${parts.length > 0 ? parts.join(" and ") : "changed which tools agents are offered"} on ${connectionWords(entry.connection)}.`;
    }
    case "connection_tool_withdrawn":
      return (
        `${entry.tool ? `The tool ${entry.tool}` : "A tool"} on ${connectionWords(entry.connection)} was withdrawn from agents` +
        (entry.reason ? `, because ${WITHDRAWN_WORDS[entry.reason] ?? entry.reason.replace(/_/g, " ")}.` : ".")
      );
    case "owls_created": {
      const into = entry.account
        ? `${entry.account}'s balance`
        : entry.mandate
          ? `the budget of the mandate ${entry.mandate.title || "(untitled)"}`
          : "a budget";
      return `${who} created ${owlsText(entry.amount_owls ?? 0)} into ${into}.` + (entry.note ? ` Note: ${entry.note}` : "");
    }
    case "standing_mandate_created":
      return (
        `${who} set up the mandate ${entry.mandate?.title || "(untitled)"}` +
        (entry.amount_owls ? `, creating ${owlsText(entry.amount_owls)} as its budget.` : ".")
      );
    default:
      return `${who}: ${entry.event.replace(/_/g, " ")}.`;
  }
}

// --- connections ----------------------------------------------------------------

export const CONNECTION_STATE_WORDS: Record<string, string> = {
  answering: "Answering",
  failing: "Not answering",
  never_checked: "Never asked",
  off: "Switched off",
};

/** The server's own marking of a tool, as the hint it is. */
export function toolMarking(tool: { read_only_hint: boolean | null; marked_as_writing: boolean }): string {
  if (tool.marked_as_writing) return "The server marks this tool as one that changes things, so it cannot be picked.";
  if (tool.read_only_hint === true) return "The server marks this tool as read-only. That is the server's own word, a hint.";
  return "The server gives no marking for this tool. Whether it only reads is your judgment of the system.";
}

export function withdrawnWords(reason: string): string {
  return WITHDRAWN_WORDS[reason] ?? reason.replace(/_/g, " ");
}

const CALL_OUTCOME_WORDS: Record<string, string> = {
  answered: "Answered",
  tool_error: "The system answered with an error",
  failed: "Failed",
  in_flight: "Not yet answered",
};

export function callOutcome(outcome: string): string {
  return CALL_OUTCOME_WORDS[outcome] ?? outcome.replace(/_/g, " ");
}
