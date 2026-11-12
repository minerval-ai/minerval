/**
 * The sandbox service (sandbox/server.py) run as a local process, for
 * tests. It is the real service: the same file the image runs, started with
 * python3 on a free port, with a store, a root for registered directories
 * and a scratch directory under one temporary directory.
 *
 * What a local process is and is not. Each command is still confined by the
 * kernel to its run's sets and scratch directory (sandbox/confine.py), so
 * tests of what a command can read and write are tests of the real thing.
 * What a local process does not have is the container: the store here is
 * writable by the service itself and the machine has a network. Those are
 * the deployment's to provide, and the service's own probe is what checks
 * them (docs/file-sets.md).
 *
 * Needs python3 and a kernel with Landlock (Linux 5.13 or later), which
 * the test machines have. Without Landlock the service starts and refuses
 * every command, and a test that runs one says so.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "sandbox", "server.py");

export interface SandboxProcess {
  url: string;
  token: string;
  /** Where uploaded sets are kept: FILE_SET_STORE_DIR for the API, SANDBOX_STORE_DIR for the service. */
  storeDir: string;
  /** The root directories are registered from, for both. */
  directoryRoot: string;
  scratchDir: string;
  /** What the service has printed, for a test that fails. */
  log: () => string;
  close: () => Promise<void>;
}

/** Make a tree writable again so it can be removed: a closed set's files are read-only. */
async function makeWritable(path: string): Promise<void> {
  try {
    await chmod(path, 0o755);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeWritable(join(path, entry.name));
    }
  } catch {
    // Already gone, or not ours to change.
  }
}

/** Start the service. `env` overrides its settings (SANDBOX_COMMAND_SECONDS and the like). */
export async function startSandbox(env: Record<string, string> = {}): Promise<SandboxProcess> {
  const root = await mkdtemp(join(tmpdir(), "minerval-sandbox-"));
  const storeDir = join(root, "store");
  const directoryRoot = join(root, "registered");
  const scratchDir = join(root, "scratch");
  for (const dir of [storeDir, directoryRoot, scratchDir]) await mkdir(dir);
  const token = "sandbox-test-token";

  let output = "";
  const child: ChildProcess = spawn("python3", [SERVER], {
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      SANDBOX_HOST: "127.0.0.1",
      SANDBOX_PORT: "0",
      SANDBOX_TOKEN: token,
      SANDBOX_STORE_DIR: storeDir,
      SANDBOX_DIRECTORY_ROOT: directoryRoot,
      SANDBOX_SCRATCH_DIR: scratchDir,
      SANDBOX_IMAGE: "minerval-sandbox:test",
      PYTHONUNBUFFERED: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the sandbox service did not start in 60 seconds:\n${output}`)), 60_000);
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const listening = /sandbox listening on [^:]+:(\d+)/.exec(output);
      if (listening) {
        clearTimeout(timer);
        resolve(Number(listening[1]));
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the sandbox service exited with code ${code} before it listened:\n${output}`));
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`python3 could not be started for the sandbox service: ${err.message}`));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    storeDir,
    directoryRoot,
    scratchDir,
    log: () => output,
    close: async () => {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}
