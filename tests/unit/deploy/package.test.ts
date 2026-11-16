/**
 * The packaged private deployment (deploy/compose.yml, deploy/env.example,
 * docs/self-hosting.md): what can be held from the files alone.
 *
 *   - No secret is in a file: every setting env.example leaves active is
 *     empty, and the Compose file names no value for one.
 *   - Every setting the Compose file takes from the deployment is named in
 *     env.example, with a comment, and every setting env.example names is
 *     one the Compose file takes.
 *   - Every setting the Compose file hands the API is one the API reads.
 *   - The sandbox is on one network that has no route out and publishes no
 *     port, and the database publishes none.
 *   - The deployment is a members-only one and nothing in it names a kind
 *     of organization.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const compose = readFileSync(join(ROOT, "deploy", "compose.yml"), "utf8");
const example = readFileSync(join(ROOT, "deploy", "env.example"), "utf8");

/** One service's block of the Compose file, as text. */
function service(name: string): string {
  const services = compose.slice(compose.indexOf("\nservices:\n"), compose.indexOf("\nvolumes:\n"));
  const start = services.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no service ${name}`);
  const rest = services.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The settings env.example names: active ones with their values, and commented ones. */
function exampleSettings(): { active: Map<string, string>; commented: Set<string>; uncommentedLines: string[] } {
  const active = new Map<string, string>();
  const commented = new Set<string>();
  const uncommentedLines: string[] = [];
  for (const line of example.split("\n")) {
    const on = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    const off = /^# ([A-Z][A-Z0-9_]*)=/.exec(line);
    if (on) active.set(on[1]!, on[2]!);
    else if (off) commented.add(off[1]!);
    if (line.trim() && !line.startsWith("#")) uncommentedLines.push(line);
  }
  return { active, commented, uncommentedLines };
}

/** Settings the Compose file takes from the deployment: interpolated, or passed through by name. */
function takenFromDeployment(): { interpolated: Set<string>; required: Set<string>; passedThrough: Set<string> } {
  const interpolated = new Set<string>();
  const required = new Set<string>();
  for (const m of compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)(:\?|:-)?/g)) {
    interpolated.add(m[1]!);
    if (m[2] === ":?") required.add(m[1]!);
  }
  const passedThrough = new Set<string>();
  for (const m of compose.matchAll(/^      - ([A-Z][A-Z0-9_]*)$/gm)) passedThrough.add(m[1]!);
  return { interpolated, required, passedThrough };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sourceFiles(path);
    return /\.(ts|tsx|mjs|py)$/.test(entry.name) ? [path] : [];
  });
}

describe("no secret is in a file", () => {
  it("every setting env.example leaves active has no value", () => {
    const { active, uncommentedLines } = exampleSettings();
    expect([...active].filter(([, value]) => value !== "")).toEqual([]);
    // And nothing else in the file is anything but a comment.
    expect(uncommentedLines.filter((line) => !/^[A-Z][A-Z0-9_]*=$/.test(line))).toEqual([]);
  });

  it("the Compose file gives no secret a value of its own", () => {
    const given: string[] = [];
    for (const line of compose.split("\n")) {
      const setting = /^\s*(?:- )?([A-Z][A-Z0-9_]*)\s*[:=]\s*(.*)$/.exec(line);
      if (!setting || !/(PASSWORD|SECRET|TOKEN|_KEY|API_KEYS)/.test(setting[1]!)) continue;
      // Taken from .env by name, or nothing at all.
      if (setting[2] !== "" && !setting[2]!.startsWith("${")) given.push(line.trim());
    }
    expect(given).toEqual([]);
  });
});

describe("the settings a deployment gives", () => {
  const { active, commented } = exampleSettings();
  const named = new Set([...active.keys(), ...commented]);
  const { interpolated, required, passedThrough } = takenFromDeployment();

  it("are each named in env.example", () => {
    // GIT_SHA is stamped by whoever builds the image, not chosen by the deployment.
    const taken = [...new Set([...interpolated, ...passedThrough])].filter((name) => name !== "GIT_SHA");
    expect(taken.filter((name) => !named.has(name)).sort()).toEqual([]);
  });

  it("and env.example names none the Compose file does not take", () => {
    const taken = new Set([...interpolated, ...passedThrough]);
    expect([...named].filter((name) => !taken.has(name)).sort()).toEqual([]);
  });

  it("the ones with no starting value are the active lines, and Compose stops on each while it is empty", () => {
    expect([...active.keys()].sort()).toEqual([...required].sort());
  });

  it("each has a comment above it", () => {
    const lines = example.split("\n");
    const bare: string[] = [];
    lines.forEach((line, i) => {
      const setting = /^(?:# )?([A-Z][A-Z0-9_]*)=/.exec(line);
      if (!setting) return;
      // The line above is a sentence of comment, or another setting that shares one.
      const above = lines[i - 1] ?? "";
      if (!/^# \S/.test(above)) bare.push(setting[1]!);
    });
    expect(bare).toEqual([]);
  });

  it("every setting handed to the API or the web app is one its code reads", () => {
    const read = new Set<string>();
    for (const dir of ["src", "web/app", "web/lib", "web/components"]) {
      for (const file of sourceFiles(join(ROOT, dir))) {
        for (const m of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]!);
      }
    }
    for (const file of ["web/auth.ts", "web/next.config.mjs", "web/instrumentation.ts", "sandbox/server.py"]) {
      for (const m of readFileSync(join(ROOT, file), "utf8").matchAll(/(?:process\.env\.|["'])([A-Z][A-Z0-9_]{3,})/g)) read.add(m[1]!);
    }
    // Auth.js reads its own address itself.
    read.add("AUTH_URL");
    const handed = new Set<string>();
    for (const name of ["api", "web", "sandbox"]) {
      for (const m of service(name).matchAll(/^      - ([A-Z][A-Z0-9_]*)(?:=|$)/gm)) handed.add(m[1]!);
    }
    expect([...handed].filter((name) => !read.has(name)).sort()).toEqual([]);
  });
});

describe("what each service may reach", () => {
  it("the sandbox is on the one network with no route out, and publishes nothing", () => {
    const sandbox = service("sandbox");
    expect(sandbox).toContain("networks: [sandbox]");
    expect(sandbox).not.toMatch(/\n    ports:/);
    expect(sandbox).toContain("read_only: true");
    expect(sandbox).toContain("cap_drop: [ALL]");
    expect(sandbox).toMatch(/file_sets:\/sets:ro/);
    expect(sandbox).toMatch(/:\/registered:ro/);
    expect(compose).toMatch(/\n  sandbox:\n    internal: true\n/);
  });

  it("the database is on a network with no route out, and publishes nothing", () => {
    const postgres = service("postgres");
    expect(postgres).toContain("networks: [data]");
    expect(postgres).not.toMatch(/\n    ports:/);
    expect(compose).toMatch(/\n  data:\n    internal: true\n/);
  });

  it("the API is not given the database superuser's password", () => {
    expect(service("api")).not.toContain("POSTGRES_PASSWORD");
    expect(service("web")).not.toContain("POSTGRES_PASSWORD");
    expect(service("web")).not.toContain("DB_OWNER_PASSWORD");
  });
});

describe("one kind of deployment", () => {
  it("is members-only, in the API and in the web app as built and as run", () => {
    expect(service("api")).toContain("- READS=members");
    expect(service("web")).toContain("- READS=members");
    expect(service("web")).toMatch(/args:\n\s+READS: members/);
  });

  it("names no kind of organization and has no profile", () => {
    for (const text of [compose, example, readFileSync(join(ROOT, "docs", "self-hosting.md"), "utf8")]) {
      // "profile" is also the name of an OpenID Connect scope, which is not what is meant.
      expect(text.replace(/openid profile email/g, "")).not.toMatch(/\bprofiles?\b|evaluator|enterprise|dogfood/i);
    }
  });
});
