// The deployment's settings as its pages say them (docs/settings.md): the
// order and names of the groups, a value as a person reads it, a value as a
// form gives it, and the steps of a deployment's first day. Nothing here
// reads the API; the pages hand it what GET /settings answered.

import type { SettingValue, SettingView } from "./admin-api";

/** The groups, in the order a deployment decides them. A group not named here follows, by name. */
export const SETTING_GROUPS: ReadonlyArray<{ group: string; name: string; about: string }> = [
  { group: "models", name: "Models", about: "Which model serves each role." },
  { group: "model_providers", name: "Model providers", about: "The providers' keys, and model servers this deployment runs itself." },
  { group: "features", name: "Features", about: "The optional parts of the product." },
  { group: "pricing", name: "Owls and prices", about: "What an owl costs, whether owls are sold or created here, and the most each paid operation can cost." },
  { group: "outside_services.elicit", name: "Elicit", about: "Paid scholarly search for the Steward." },
  { group: "outside_services.pangram", name: "Pangram", about: "Paid detection of machine-written text and of a text's original source." },
  { group: "outside_services.payments", name: "Payments", about: "Selling owls through Stripe." },
  { group: "outside_services.github_issues", name: "GitHub issues", about: "Filing the agents' problem reports as issues." },
  { group: "run_log", name: "Run log", about: "How much a run depends on its log, and how long logs are kept." },
  { group: "private_runs", name: "Private runs", about: "What a run that reads a private label may fetch." },
  { group: "publishing", name: "Publishing", about: "Releasing pages outside." },
  { group: "public_graph", name: "Public graph", about: "How this deployment reaches the public graph and pays toward it." },
  { group: "usage_report", name: "Usage report", about: "Where a metered deployment's usage reports go." },
  { group: "releases", name: "Releases", about: "Whether this deployment learns of new releases from the public graph." },
  { group: "hosting", name: "Hosting", about: "Where this deployment is reached." },
  { group: "sandbox", name: "Sandbox", about: "The sandbox agents run commands over file sets in." },
  { group: "file_sets", name: "File sets", about: "Where sets of files are kept." },
  { group: "database", name: "Database", about: "Where the database is." },
  { group: "connections", name: "Connections", about: "The key credentials given in the app are sealed with." },
  { group: "accounts", name: "Accounts", about: "Who this deployment serves." },
  { group: "", name: "Providers by label", about: "Which labels each provider may be sent text at." },
  { group: "budgets", name: "Budgets", about: "What a run of each kind works to." },
  { group: "allocation", name: "Allocation", about: "What the ledger prices and paces work with." },
  { group: "sessions", name: "Sessions", about: "How long a run waits on an answer." },
  { group: "limits", name: "Limits", about: "Limits on what no price covers." },
  { group: "sql", name: "Read-only SQL", about: "How long a query may run and what a caller's database time costs." },
  { group: "processing", name: "Processing", about: "How documents are read and nodes are made." },
  { group: "sweeps", name: "Sweeps", about: "The schedulers and sweeps." },
  { group: "researcher", name: "Researcher", about: "The researcher's switches." },
  { group: "mathematics", name: "Mathematics", about: "The Lean checker, the solver, bounties and prizes." },
  { group: "mirror", name: "Mirror", about: "Publishing and following the mirror feed." },
  { group: "queues", name: "Queues", about: "Where the queues are." },
  { group: "build", name: "Build", about: "What the image was built from." },
  { group: "oidc", name: "Sign-in provider", about: "minerval.ai as a sign-in provider for organizations." },
];

export interface SettingGroup {
  group: string;
  name: string;
  about: string;
  settings: SettingView[];
}

/** The settings by group, in the groups' order, each group's settings as the registry lists them. */
export function groupSettings(settings: readonly SettingView[]): SettingGroup[] {
  const by = new Map<string, SettingView[]>();
  for (const s of settings) by.set(s.group, [...(by.get(s.group) ?? []), s]);
  const known = SETTING_GROUPS.filter((g) => by.has(g.group)).map((g) => ({ ...g, settings: by.get(g.group)! }));
  const rest = [...by.keys()]
    .filter((group) => !SETTING_GROUPS.some((g) => g.group === group))
    .sort()
    .map((group) => ({ group, name: group, about: "", settings: by.get(group)! }));
  return [...known, ...rest];
}

/** A setting's own name inside its group: "steward" of "models.steward". */
export function settingName(setting: Pick<SettingView, "key" | "group">): string {
  return setting.group && setting.key.startsWith(`${setting.group}.`) ? setting.key.slice(setting.group.length + 1) : setting.key;
}

/** A value as a person reads it in a row. */
export function valueWords(setting: Pick<SettingView, "kind" | "secret" | "is_set" | "last_four">, value: SettingValue | null): string {
  if (setting.secret) {
    if (!setting.is_set) return "Not set";
    return setting.last_four ? `Set · ends ${setting.last_four}` : "Set";
  }
  if (value === null) return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value === "" ? "Empty" : value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    if (typeof value[0] === "string") return (value as string[]).join(", ");
    return `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
  }
  const names = Object.keys(value);
  return names.length === 0 ? "None" : names.join(", ");
}

/** Where a value comes from, as the pill beside it says. */
export function sourceWords(setting: Pick<SettingView, "source" | "where">): { word: string; title: string } {
  if (setting.where === "machine") {
    return { word: "On the machine", title: "Set by whoever runs the deployment, and not changed here." };
  }
  switch (setting.source) {
    case "environment":
      return { word: "Fixed · environment", title: "Whoever runs the deployment set it in the machine's environment, which fixes it." };
    case "file":
      return { word: "Fixed · config file", title: "Whoever runs the deployment set it in the config file, which fixes it." };
    case "app":
      return { word: "Set here", title: "An administrator set it in the app." };
    default:
      return { word: "Default", title: "Nobody has set it: it is on the code's default." };
  }
}

/** What goes in the form's field for a value: text, or JSON for a setting written as groups. */
export function fieldText(setting: Pick<SettingView, "kind">, value: SettingValue | null): string {
  if (value === null) return "";
  if (setting.kind === "list") return (value as string[]).join("\n");
  if (setting.kind === "groups" || setting.kind === "lists") return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * The value a form's text stands for, in the setting's kind, or what is
 * wrong with it. The API checks the value itself; this only turns the text
 * into the kind the API takes.
 */
export function parseField(kind: SettingView["kind"], text: string): { ok: true; value: SettingValue } | { ok: false; error: string } {
  const trimmed = text.trim();
  switch (kind) {
    case "text":
      return { ok: true, value: trimmed };
    case "number": {
      const n = Number(trimmed);
      if (trimmed === "" || !Number.isFinite(n)) return { ok: false, error: "Give a number." };
      return { ok: true, value: n };
    }
    case "boolean":
      if (trimmed !== "true" && trimmed !== "false") return { ok: false, error: "Choose yes or no." };
      return { ok: true, value: trimmed === "true" };
    case "list":
      return {
        ok: true,
        value: trimmed
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      };
    case "groups":
    case "lists": {
      try {
        const parsed: unknown = JSON.parse(trimmed === "" ? (kind === "groups" ? "[]" : "{}") : trimmed);
        const right = kind === "groups" ? Array.isArray(parsed) : !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
        if (!right) return { ok: false, error: kind === "groups" ? "Give a list of entries, in square brackets." : "Give names with their lists, in braces." };
        return { ok: true, value: parsed as SettingValue };
      } catch {
        return { ok: false, error: "That is not valid JSON." };
      }
    }
  }
}

/** The roles whose model must be somebody's choice before real work runs (loadBearingModelVariables in the API). */
export const LOAD_BEARING_MODELS = [
  "models.steward",
  "models.steward_strong",
  "models.curator",
  "models.extractor",
  "models.audit",
  "models.arbitration",
  "models.solver",
] as const;

/** The name the organisation's own party carries from setup until an administrator names it. */
export const OWN_ORGANISATION_SETUP_NAME = "This organization";

export interface FirstDayStep {
  key: "organisation" | "models" | "features" | "owls";
  title: string;
  /** Whether somebody has decided it. */
  done: boolean;
  fact: string;
  /** The settings this step is, by key: the same rows the settings page shows. */
  settings: string[];
}

/**
 * The steps of a deployment's first day, in order: its name, the models, the
 * features, the owls. Each is the same setting the settings page shows; this
 * only says which are still nobody's choice. Null once the two that have no
 * sensible default (the name and the models) are done.
 */
export function firstDaySteps(input: {
  settings: readonly SettingView[];
  ownParty: { name: string } | null;
  mathematicsOn: boolean;
}): FirstDayStep[] | null {
  const by = new Map(input.settings.map((s) => [s.key, s]));
  const named = input.ownParty !== null && input.ownParty.name !== OWN_ORGANISATION_SETUP_NAME;
  const roles = LOAD_BEARING_MODELS.filter((key) => key !== "models.solver" || input.mathematicsOn);
  const unchosen = roles.filter((key) => {
    const s = by.get(key);
    return s !== undefined && s.source === "default" && !s.waiting;
  });
  if (named && unchosen.length === 0) return null;
  const features = by.get("features.off");
  const off = (features?.waiting?.value ?? features?.value ?? []) as string[];
  const owls = by.get("pricing.owls");
  const owlsValue = String(owls?.waiting?.value ?? owls?.value ?? "sold");
  return [
    {
      key: "organisation",
      title: "Name the organisation",
      done: named,
      fact: named ? input.ownParty!.name : "It is recorded as \"This organization\" until it is named.",
      settings: [],
    },
    {
      key: "models",
      title: "Choose the models",
      done: unchosen.length === 0,
      fact:
        unchosen.length === 0
          ? "Every load-bearing role runs on a model somebody chose."
          : `${unchosen.length} of ${roles.length} load-bearing roles would run on the code's default, the cheap tier kept for tests.`,
      settings: [...roles],
    },
    {
      key: "features",
      title: "Decide the features",
      done: features !== undefined && features.source !== "default",
      fact: off.length === 0 ? "Everything is on." : `Off: ${off.join(", ")}.`,
      settings: ["features.off"],
    },
    {
      key: "owls",
      title: "Decide where owls come from",
      done: owls !== undefined && owls.source !== "default",
      fact: owlsValue === "created" ? "Administrators create them here." : "They are sold, where payments are set up.",
      settings: ["pricing.owls"],
    },
  ];
}
