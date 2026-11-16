import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import {
  probeSandboxService,
  removeScratch,
  runInSandbox,
  sandboxConfigured,
  sandboxHealth,
  type SandboxConfig,
  type SandboxSetRef,
} from "../../../src/services/sandbox-client.js";
import { needsLandlock, startSandbox, type SandboxProcess } from "../../sandbox-process.js";

/**
 * The sandbox service (sandbox/server.py), run as a local process and
 * spoken to through its client (src/services/sandbox-client.ts): what a
 * command can and cannot reach, each limit and how passing it is reported,
 * the scratch directory, and the probe.
 *
 * A local process has the kernel's confinement of each command and not the
 * container's mounts or network, so the tests of what a command may read
 * and write are of the real mechanism, and the probe is expected to say
 * that this machine has a route out and a writable store.
 *
 * That mechanism is Landlock. On a kernel without it the service runs no
 * command, so every test here that runs one fails, with that reason
 * (needsLandlock); none is skipped. The last block shows what the API is
 * told by a sandbox on such a kernel, whatever kernel the tests run on.
 */

let sandbox: SandboxProcess;
let config: SandboxConfig;
let listener: Server;
let listenerPort: number;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const LOGS: SandboxSetRef = { name: "logs", origin: "upload", key: "logs" };
const SECRET: SandboxSetRef = { name: "secret", origin: "upload", key: "secret" };
const EXPORT: SandboxSetRef = { name: "export", origin: "directory", key: "finance/export" };

async function run(runId: string, command: string, sets: SandboxSetRef[] = [], files: Array<{ path: string; content: string }> = []) {
  needsLandlock(sandbox);
  const answered = await runInSandbox({ run: runId, command, files, sets, commandSeconds: 30 }, config);
  expect(answered.ok, JSON.stringify(answered)).toBe(true);
  if (!answered.ok) throw new Error("unreachable");
  return answered.value;
}

beforeAll(async () => {
  // A listener on this machine stands in for "somewhere outside": the probe
  // is pointed at it, and at a name that resolves here.
  listener = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  listenerPort = (listener.address() as { port: number }).port;

  sandbox = await startSandbox({
    SANDBOX_COMMAND_SECONDS: "4",
    SANDBOX_OUTPUT_BYTES: "20000",
    SANDBOX_MEMORY_MB: "150",
    SANDBOX_SCRATCH_MB: "20",
    SANDBOX_MAX_COMMANDS: "3",
    SANDBOX_QUEUE_SECONDS: "30",
    SANDBOX_PROBE_CONNECT: `127.0.0.1:${listenerPort}`,
    SANDBOX_PROBE_RESOLVE: "localhost",
  });
  config = { sandboxUrl: sandbox.url, sandboxToken: sandbox.token };

  await mkdir(join(sandbox.storeDir, "logs", "day1"), { recursive: true });
  await writeFile(join(sandbox.storeDir, "logs", "day1", "a.log"), "alpha\nbeta\nalpha again\n");
  await mkdir(join(sandbox.storeDir, "secret"));
  await writeFile(join(sandbox.storeDir, "secret", "plan.txt"), "the restricted plan\n");
  await mkdir(join(sandbox.directoryRoot, "finance", "export"), { recursive: true });
  await writeFile(join(sandbox.directoryRoot, "finance", "export", "rows.csv"), "id,amount\n1,10\n2,32\n");
}, 90_000);

afterAll(async () => {
  await sandbox?.close();
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

describe("what the service says of itself", () => {
  it("reports its version, what it has, where the sets are and its limits", async () => {
    needsLandlock(sandbox);
    const health = await sandboxHealth(config);
    expect(health.ok, JSON.stringify(health)).toBe(true);
    if (!health.ok) return;
    expect(health.value.version).toBe("1");
    expect(health.value.image).toBe("minerval-sandbox:test");
    expect(health.value.python).toMatch(/^3\.\d+\.\d+$/);
    expect(health.value.landlockAbi).toBeGreaterThanOrEqual(1);
    expect(health.value.tools).toEqual(expect.arrayContaining(["find", "grep", "sed"]));
    expect(health.value.paths).toEqual({ store: sandbox.storeDir, directoryRoot: sandbox.directoryRoot });
    expect(health.value.limits).toEqual({
      commandSeconds: 4,
      outputBytes: 20000,
      memoryMb: 150,
      scratchMb: 20,
      commandsAtOnce: 3,
      queueSeconds: 30,
    });
  });

  it("answers only a caller that holds its token", async () => {
    const health = await sandboxHealth({ sandboxUrl: sandbox.url, sandboxToken: "not-the-token" });
    expect(health).toEqual({
      ok: false,
      failure: { kind: "unauthorized", message: "the sandbox refused the deployment's token" },
    });
  });

  it("is absent when no address is configured, and unreachable when nothing listens there", async () => {
    expect(sandboxConfigured({})).toBe(false);
    expect(sandboxConfigured({ sandboxUrl: "  " })).toBe(false);
    expect(await sandboxHealth({})).toEqual({
      ok: false,
      failure: { kind: "not_configured", message: "this deployment has no sandbox configured" },
    });
    // The listener answers no HTTP, and a closed port answers nothing.
    const closed = await sandboxHealth({ sandboxUrl: "http://127.0.0.1:9", sandboxToken: "t" });
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.failure).toEqual({ kind: "unreachable", message: "the sandbox could not be reached" });
  });
});

describe("a command", () => {
  it("reads the sets it was given, searches them, and reports what it printed and how it ended", async () => {
    const result = await run("run-reads", `grep -rc alpha ${sandbox.storeDir}/logs && cat ${sandbox.directoryRoot}/finance/export/rows.csv`, [LOGS, EXPORT]);
    expect(result.ended).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(`${sandbox.storeDir}/logs/day1/a.log:2\nid,amount\n1,10\n2,32\n`);
    expect(result.sets).toEqual([
      { name: "logs", path: join(sandbox.storeDir, "logs") },
      { name: "export", path: join(sandbox.directoryRoot, "finance", "export") },
    ]);
    expect(result.version).toBe("1");
    expect(result.image).toBe("minerval-sandbox:test");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("cannot read a set it was not given, list the store, or read anything else of the machine's", async () => {
    const result = await run(
      "run-confined",
      [
        `cat ${sandbox.storeDir}/secret/plan.txt || echo NO_SECRET`,
        `ls ${sandbox.storeDir} || echo NO_LISTING`,
        `cat ${sandbox.directoryRoot}/finance/export/rows.csv || echo NO_EXPORT`,
        `ls /proc >/dev/null 2>&1 || echo NO_PROC`,
        `ls /root >/dev/null 2>&1 || echo NO_HOME`,
        `cat ${sandbox.storeDir}/logs/day1/a.log | head -1`,
      ].join("\n"),
      [LOGS]
    );
    expect(result.output).toContain("NO_SECRET");
    expect(result.output).toContain("NO_LISTING");
    expect(result.output).toContain("NO_EXPORT");
    expect(result.output).toContain("NO_PROC");
    expect(result.output).toContain("NO_HOME");
    expect(result.output).not.toContain("the restricted plan");
    expect(result.output.trim().endsWith("alpha")).toBe(true);
  });

  it("can use threads and subprocesses, and cannot share memory with another process", async () => {
    const script = [
      "import concurrent.futures as cf, multiprocessing as mp, subprocess",
      "def sq(x): return x * x",
      "if __name__ == '__main__':",
      "    print('threads', list(cf.ThreadPoolExecutor(2).map(sq, range(4))))",
      "    print('subprocess', subprocess.run(['sort'], input=b'b\\na\\n', capture_output=True).stdout)",
      "    try:",
      "        mp.Pool(2).map(sq, range(4))",
      "        print('pool started')",
      "    except PermissionError:",
      "        print('no pool')",
    ].join("\n");
    const result = await run("run-processes", "python3 p.py", [], [{ path: "p.py", content: script }]);
    expect(result.output).toBe("threads [0, 1, 4, 9]\nsubprocess b'a\\nb\\n'\nno pool\n");
  });

  it("cannot write to a set: not a new file, not a change to one, not a removal", async () => {
    const result = await run(
      "run-read-only",
      [
        `echo x > ${sandbox.storeDir}/logs/new.txt || echo NO_CREATE`,
        `echo x >> ${sandbox.storeDir}/logs/day1/a.log || echo NO_APPEND`,
        `rm ${sandbox.storeDir}/logs/day1/a.log || echo NO_REMOVE`,
        `mkdir ${sandbox.storeDir}/logs/sub || echo NO_MKDIR`,
      ].join("\n"),
      [LOGS]
    );
    for (const marker of ["NO_CREATE", "NO_APPEND", "NO_REMOVE", "NO_MKDIR"]) expect(result.output).toContain(marker);
    expect(await readdir(join(sandbox.storeDir, "logs"))).toEqual(["day1"]);
  });

  it("is given the files sent with it, writes in its scratch directory, and has what it wrote reported with hashes", async () => {
    const script = "import sys\nopen('out/summary.txt', 'w').write('two lines match\\n')\nprint('done', sys.argv[1])\n";
    const result = await run("run-writes", "mkdir -p out && python3 scripts/count.py now && pwd", [LOGS], [
      { path: "scripts/count.py", content: script },
    ]);
    expect(result.ended).toBe("exited");
    expect(result.output).toBe(`done now\n${result.scratch}\n`);
    expect(result.scratch).toBe(join(sandbox.scratchDir, "run-writes"));
    // The script was given, not written by the command, so it is not listed.
    expect(result.written).toEqual([{ path: "out/summary.txt", bytes: 16, sha256: sha256("two lines match\n") }]);
    expect(result.writtenNotListed).toBe(0);
  });

  it("keeps its scratch directory between commands of one run, and shares it with no other run", async () => {
    await run("run-a", "echo mine > note.txt");
    const again = await run("run-a", "cat note.txt");
    expect(again.output).toBe("mine\n");
    expect(again.written).toEqual([]);
    const other = await run("run-b", `cat ${sandbox.scratchDir}/run-a/note.txt || echo NOT_MINE; ls`);
    expect(other.output).toContain("NOT_MINE");
    expect(other.output).not.toContain("note.txt\n");
  });

  it("has its scratch directory removed when the run ends", async () => {
    await run("run-ends", "echo x > kept.txt");
    expect(await readdir(sandbox.scratchDir)).toContain("run-ends");
    expect(await removeScratch("run-ends", config)).toBe(true);
    expect(await readdir(sandbox.scratchDir)).not.toContain("run-ends");
    // Removing what is not there is not an error.
    expect(await removeScratch("run-ends", config)).toBe(false);
    const fresh = await run("run-ends", "ls | wc -l");
    expect(fresh.output.trim()).toBe("0");
  });

  it("is refused when a set it names is not mounted in the sandbox, or its path leaves the store", async () => {
    needsLandlock(sandbox);
    for (const set of [
      { name: "gone", origin: "upload" as const, key: "no-such-set" },
      { name: "escape", origin: "upload" as const, key: "../registered" },
      { name: "root", origin: "directory" as const, key: "/etc" },
    ]) {
      const answered = await runInSandbox({ run: "run-missing", command: "true", files: [], sets: [set], commandSeconds: 30 }, config);
      expect(answered.ok, set.name).toBe(false);
      if (!answered.ok) {
        expect(answered.failure.kind, set.name).toBe("set_not_here");
        expect(answered.failure.message, set.name).toBe(
          `the file set "${set.name}" is not where the sandbox looks for it: its files are not mounted in the sandbox`
        );
      }
    }
  });
});

describe("the limits", () => {
  it("stops a command at the time limit and keeps what it printed before", async () => {
    const result = await run("run-slow", "echo started; sleep 60; echo finished");
    expect(result.ended).toBe("timed_out");
    expect(result.exitCode).toBeNull();
    expect(result.output).toBe("started\n");
    expect(result.durationMs).toBeGreaterThanOrEqual(4000);
    expect(result.durationMs).toBeLessThan(12_000);
  });

  it("stops a command whose output passes the ceiling and keeps the part before it", async () => {
    const result = await run("run-loud", "yes 0123456789");
    expect(result.ended).toBe("output_ceiling");
    expect(result.output.length).toBe(20000);
    expect(result.output.startsWith("0123456789\n0123456789\n")).toBe(true);
  });

  it("stops a command that uses more memory than a command may, and says how much it was using", async () => {
    const result = await run(
      "run-big",
      "python3 -c \"\nimport time\nheld = bytearray(400 * 1024 * 1024)\nfor i in range(0, len(held), 4096): held[i] = 1\nprint('allocated', flush=True)\ntime.sleep(30)\n\""
    );
    expect(result.ended).toBe("memory");
    expect(result.memoryMbUsed).toBeGreaterThan(150);
  });

  it("stops a command that leaves more in its scratch directory than it may", async () => {
    const result = await run("run-fills", "for i in 1 2 3 4; do head -c 8000000 /dev/zero > part$i; done; sleep 30");
    expect(result.ended).toBe("scratch_full");
  });

  it("reports a command the system ended as killed, apart from the limits", async () => {
    const result = await run("run-killed", "echo before; kill -9 $$");
    expect(result.ended).toBe("killed");
    expect(result.signal).toBe(9);
    expect(result.output).toBe("before\n");
  });

  it("leaves nothing of a command running after it: a later command is a new process", async () => {
    await run("run-background", "(sleep 300 &) ; echo started");
    const later = await run("run-background", "echo next");
    expect(later.output).toBe("next\n");
  });
});

describe("the probe", () => {
  it("checks confinement and what a command can do, and says of this machine what is true of it", async () => {
    needsLandlock(sandbox);
    const probed = await probeSandboxService(config);
    expect(probed.ok, JSON.stringify(probed)).toBe(true);
    if (!probed.ok) return;
    const byName = new Map(probed.value.checks.map((c) => [c.check, c]));
    // The kernel's part holds in a local process as it does in the container.
    expect(byName.get("commands_are_confined")?.ok).toBe(true);
    expect(byName.get("a_command_can_write_its_scratch")?.ok).toBe(true);
    expect(byName.get("a_command_cannot_read_outside_its_sets")?.ok).toBe(true);
    expect(byName.get("a_command_cannot_write_a_set")?.ok).toBe(true);
    // The container's part does not: this store is writable by the service
    // and this machine can reach the listener the probe was pointed at. The
    // probe says so, which is what makes it worth calling.
    expect(byName.get("store_is_read_only")).toEqual({
      check: "store_is_read_only",
      ok: false,
      detail: `the sandbox service could write a file in ${sandbox.storeDir}. Mount it read-only in the sandbox's container.`,
    });
    expect(byName.get("directory_root_is_read_only")?.ok).toBe(false);
    expect(byName.get("no_route_out")).toEqual({
      check: "no_route_out",
      ok: false,
      detail: `the sandbox service connected to 127.0.0.1:${listenerPort}. Put its container on a network with no route out.`,
    });
    expect(byName.get("no_name_resolution")?.ok).toBe(false);
    expect(probed.value.ok).toBe(false);
    // The probe leaves nothing behind in the store or the scratch directory.
    expect((await readdir(sandbox.storeDir)).sort()).toEqual(["logs", "secret"]);
    expect((await readdir(sandbox.scratchDir)).filter((name) => name.startsWith("probe-") || name.startsWith(".probe"))).toEqual([]);
  });
});

describe("a sandbox on a kernel with no Landlock", () => {
  // What the service answers there (sandbox/server.py, health and run),
  // served by a stand-in so that this is checked on every kernel.
  const PROBLEM =
    "this kernel has no Landlock, so a command cannot be held to its own file sets and none will be run. " +
    "The sandbox needs Linux 5.13 or later with Landlock enabled.";

  it("is told to the API as a sandbox that runs no command, with why, and never as one that works", async () => {
    const standIn = createHttpServer((request, response) => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.url === "/health") {
        return send(200, {
          ok: false,
          problem: PROBLEM,
          version: "1",
          image: "minerval-sandbox:test",
          python: "3.13.1",
          libraries: {},
          tools: [],
          landlock_abi: 0,
          paths: { store: "/sets", directory_root: null },
          limits: { command_seconds: 300, output_bytes: 2000000, memory_mb: 2048, scratch_mb: 1024 },
        });
      }
      request.resume();
      return send(503, { error: "not_confined", message: PROBLEM });
    });
    await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
    const there = { sandboxUrl: `http://127.0.0.1:${(standIn.address() as { port: number }).port}`, sandboxToken: "t" };
    try {
      const why = PROBLEM.replace(/\.$/, "");
      expect(await sandboxHealth(there)).toEqual({ ok: false, failure: { kind: "not_confined", message: why } });
      expect(await runInSandbox({ run: "r", command: "true", files: [], sets: [], commandSeconds: 5 }, there)).toEqual({
        ok: false,
        failure: { kind: "not_confined", message: why },
      });
    } finally {
      await new Promise<void>((resolve) => standIn.close(() => resolve()));
    }
  });
});
