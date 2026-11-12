#!/usr/bin/env python3
"""The sandbox service: commands run against file sets, with no network.

A private deployment of Minerval takes in sets of files (data, logs,
transcripts, code), and its agents explore them the way a coding agent
explores a repository: listing, searching, reading, and running their own
analysis. This service is where those commands run (docs/file-sets.md in
the repository). The API calls it over a private network; nothing else
does.

What it holds and what it does:

  - The deployment's file sets, mounted read-only: the store uploaded sets
    are kept in (SANDBOX_STORE_DIR) and the root that registered
    directories live under (SANDBOX_DIRECTORY_ROOT).
  - A scratch directory for each agent run, which is that run's alone, and
    is removed when the API says the run has ended (and after
    SANDBOX_SCRATCH_IDLE_HOURS without use, in case it never says).
  - POST /run runs one shell command for one run, with the sets the API
    names for it, and returns what it printed, how it ended, and which
    files it wrote. Each command is confined by confine.py to the system
    paths, the run's sets and the run's scratch directory.
  - Four limits, each reported by GET /health so the API can state them to
    the agent before it calls: the time a command may run, the output it
    may print, the memory it may use, and the size its scratch directory
    may reach. A command that passes one is stopped, and the answer says
    which.
  - POST /probe checks the things the deployment has to provide and this
    process cannot give itself: that the sets are mounted read-only and
    that there is no route out.

What it does not do: it has no credentials, makes no outward call, keeps no
record of commands (the API stores each call with its output), and decides
nothing about which run may read which set. The API decides that from the
run's label and names the sets; this service holds a command to them.

Only the standard library is used.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONFINE = os.path.join(HERE, "confine.py")

# The Python libraries and shell tools the image is built with (Dockerfile,
# requirements.txt). /health reports which of them this process really has,
# and the API tells an agent that list and no other.
LIBRARIES = [
    "numpy", "pandas", "scipy", "statsmodels", "sklearn", "matplotlib", "pyarrow", "polars", "duckdb",
    "openpyxl", "lxml", "bs4", "yaml",
]
# The tools named are the ones worth saying: bash and the coreutils are
# taken as read.
TOOLS = [
    "find", "grep", "rg", "sed", "awk", "jq", "sqlite3", "git", "diff", "file", "tree",
    "tar", "gzip", "unzip", "xz", "zstd",
]

RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Directories the service makes in every scratch directory for the
# command's HOME and TMPDIR. They are not listed among the files a command
# wrote, and they count toward the scratch directory's size.
HOME_DIR = ".home"
TMP_DIR = ".tmp"
WRITTEN_LISTED_MAX = 200


def env_int(name, default, minimum=1):
    raw = os.environ.get(name, "")
    if raw == "":
        return default
    value = int(raw)
    if value < minimum:
        raise SystemExit("%s must be at least %d, got %s" % (name, minimum, raw))
    return value


class Config:
    def __init__(self):
        self.host = os.environ.get("SANDBOX_HOST", "0.0.0.0")
        self.port = env_int("SANDBOX_PORT", 8080, 0)
        self.token = os.environ.get("SANDBOX_TOKEN", "")
        if not self.token:
            raise SystemExit("SANDBOX_TOKEN is not set: the sandbox answers only a caller that holds it.")
        self.store = self._dir("SANDBOX_STORE_DIR", required=True)
        self.directory_root = self._dir("SANDBOX_DIRECTORY_ROOT", required=False)
        self.scratch = self._dir("SANDBOX_SCRATCH_DIR", required=True)
        self.command_seconds = env_int("SANDBOX_COMMAND_SECONDS", 300)
        self.output_bytes = env_int("SANDBOX_OUTPUT_BYTES", 2_000_000)
        self.memory_mb = env_int("SANDBOX_MEMORY_MB", 2048)
        self.scratch_mb = env_int("SANDBOX_SCRATCH_MB", 1024)
        self.max_commands = env_int("SANDBOX_MAX_COMMANDS", max(2, os.cpu_count() or 2))
        self.queue_seconds = env_int("SANDBOX_QUEUE_SECONDS", 60)
        self.scratch_idle_hours = env_int("SANDBOX_SCRATCH_IDLE_HOURS", 24)
        self.image = os.environ.get("SANDBOX_IMAGE", "") or "not stated"
        self.system_paths = [
            p for p in os.environ.get("SANDBOX_SYSTEM_PATHS", "/usr:/lib:/lib64:/lib32:/bin:/sbin:/etc:/opt").split(":")
            if p and os.path.exists(p)
        ]
        self.probe_connect = os.environ.get("SANDBOX_PROBE_CONNECT", "1.1.1.1:443 8.8.8.8:53").split()
        self.probe_resolve = os.environ.get("SANDBOX_PROBE_RESOLVE", "example.com")
        with open(os.path.join(HERE, "VERSION")) as f:
            self.version = f.read().strip()

    @staticmethod
    def _dir(name, required):
        raw = os.environ.get(name, "")
        if not raw:
            if required:
                raise SystemExit("%s is not set." % name)
            return None
        path = os.path.realpath(raw)
        if not os.path.isdir(path):
            raise SystemExit("%s is %s, which is not a directory." % (name, raw))
        return path


class Refused(Exception):
    """A request the service will not carry out, with the status and a code the API reads."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def beneath(root, relative):
    """The real path of `relative` under `root`, or None when it is not under it."""
    if root is None or not isinstance(relative, str) or relative.startswith("/"):
        return None
    path = os.path.realpath(os.path.join(root, relative))
    if path != root and not path.startswith(root + os.sep):
        return None
    return path


def landlock_abi():
    try:
        out = subprocess.run([sys.executable, CONFINE, "--check"], capture_output=True, text=True, timeout=20)
        return int(out.stdout.strip() or "0")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0


def what_is_installed():
    """The libraries that import and the tools on the PATH, each checked once at start."""
    script = (
        "import importlib, json\n"
        "found = {}\n"
        "for name in %r:\n"
        "    try:\n"
        "        m = importlib.import_module(name)\n"
        "        found[name] = str(getattr(m, '__version__', ''))\n"
        "    except Exception:\n"
        "        pass\n"
        "print(json.dumps(found))\n" % (LIBRARIES,)
    )
    try:
        out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=120)
        libraries = json.loads(out.stdout or "{}")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        libraries = {}
    return libraries, [tool for tool in TOOLS if shutil.which(tool)]


def session_processes(session):
    """The pids of every live process in a session."""
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % entry) as f:
                fields = f.read().rsplit(")", 1)[1].split()
        except (OSError, IndexError):
            continue
        if len(fields) > 3 and fields[3] == str(session):
            pids.append(int(entry))
    return pids


def memory_bytes(pids):
    """The memory a group of processes holds: proportional set size where the kernel reports it."""
    total = 0
    for pid in pids:
        try:
            with open("/proc/%d/smaps_rollup" % pid) as f:
                for line in f:
                    if line.startswith("Pss:"):
                        total += int(line.split()[1]) * 1024
                        break
            continue
        except (OSError, ValueError, IndexError):
            pass
        try:
            with open("/proc/%d/statm" % pid) as f:
                total += int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
        except (OSError, ValueError, IndexError):
            pass
    return total


def kill_session(session):
    try:
        os.killpg(session, signal.SIGKILL)
    except OSError:
        pass
    for pid in session_processes(session):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass


def tree_bytes(root):
    total = 0
    for directory, _dirs, files in os.walk(root):
        for name in files:
            try:
                total += os.lstat(os.path.join(directory, name)).st_size
            except OSError:
                pass
    return total


def snapshot(root):
    """Every regular file under a scratch directory, by relative path, with its size and time."""
    seen = {}
    for directory, dirs, files in os.walk(root):
        if directory == root:
            dirs[:] = [d for d in dirs if d not in (HOME_DIR, TMP_DIR)]
        for name in files:
            path = os.path.join(directory, name)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if not os.path.islink(path) and os.path.isfile(path):
                seen[os.path.relpath(path, root)] = (st.st_size, st.st_mtime_ns)
    return seen


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class Sandbox:
    def __init__(self, config):
        self.config = config
        self.abi = landlock_abi()
        self.libraries, self.tools = what_is_installed()
        self.slots = threading.BoundedSemaphore(config.max_commands)
        self.run_locks = {}
        self.run_locks_guard = threading.Lock()

    # ---- what the API is told ------------------------------------------------

    def health(self):
        c = self.config
        return {
            "ok": self.abi >= 1,
            "version": c.version,
            "image": c.image,
            "python": "%d.%d.%d" % sys.version_info[:3],
            "libraries": self.libraries,
            "tools": self.tools,
            "landlock_abi": self.abi,
            "paths": {"store": c.store, "directory_root": c.directory_root},
            "limits": {
                "command_seconds": c.command_seconds,
                "output_bytes": c.output_bytes,
                "memory_mb": c.memory_mb,
                "scratch_mb": c.scratch_mb,
            },
            **(
                {}
                if self.abi >= 1
                else {
                    "problem": "this kernel has no Landlock, so a command cannot be held to its own file sets "
                    "and none will be run. The sandbox needs Linux 5.13 or later with Landlock enabled."
                }
            ),
        }

    # ---- scratch directories -------------------------------------------------

    def run_lock(self, run):
        with self.run_locks_guard:
            return self.run_locks.setdefault(run, threading.Lock())

    def scratch_of(self, run):
        if not isinstance(run, str) or not RUN_ID.match(run):
            raise Refused(400, "bad_run", "run is the calling run's id: letters, digits, hyphens and underscores.")
        return os.path.join(self.config.scratch, run)

    def remove_scratch(self, run):
        path = self.scratch_of(run)
        with self.run_lock(run):
            existed = os.path.isdir(path)
            shutil.rmtree(path, ignore_errors=True)
        with self.run_locks_guard:
            self.run_locks.pop(run, None)
        return existed

    def sweep(self):
        """Remove scratch directories no command has used for the idle time."""
        cutoff = time.time() - self.config.scratch_idle_hours * 3600
        for name in os.listdir(self.config.scratch):
            path = os.path.join(self.config.scratch, name)
            try:
                if os.path.isdir(path) and os.stat(path).st_mtime < cutoff:
                    if RUN_ID.match(name):
                        self.remove_scratch(name)
                    else:
                        shutil.rmtree(path, ignore_errors=True)
            except OSError:
                pass

    # ---- one command ---------------------------------------------------------

    def set_paths(self, sets):
        """Where each named set is in this process's filesystem."""
        out = []
        if not isinstance(sets, list):
            raise Refused(400, "bad_sets", "sets is a list.")
        for entry in sets:
            origin = entry.get("origin") if isinstance(entry, dict) else None
            root = self.config.store if origin == "upload" else self.config.directory_root if origin == "directory" else None
            path = beneath(root, entry.get("key")) if isinstance(entry, dict) else None
            if path is None or path == root or not os.path.isdir(path):
                name = entry.get("name") if isinstance(entry, dict) else None
                raise Refused(
                    409,
                    "set_not_here",
                    "the file set %s is not where the sandbox looks for it: its files are not mounted in the sandbox"
                    % json.dumps(name or "?"),
                )
            out.append({"name": entry.get("name"), "path": path})
        return out

    def run(self, body):
        if self.abi < 1:
            raise Refused(503, "not_confined", self.health()["problem"])
        command = body.get("command")
        if not isinstance(command, str) or not command.strip():
            raise Refused(400, "bad_command", "command is the shell command to run.")
        run = body.get("run")
        scratch = self.scratch_of(run)
        sets = self.set_paths(body.get("sets", []))
        files = body.get("files", [])
        if not isinstance(files, list):
            raise Refused(400, "bad_files", "files is a list.")

        if not self.slots.acquire(timeout=self.config.queue_seconds):
            raise Refused(
                503,
                "busy",
                "the sandbox was running %d commands for other runs and none finished in %d seconds"
                % (self.config.max_commands, self.config.queue_seconds),
            )
        try:
            with self.run_lock(run):
                return self._run(scratch, command, files, sets)
        finally:
            self.slots.release()

    def _run(self, scratch, command, files, sets):
        c = self.config
        for sub in ("", HOME_DIR, TMP_DIR):
            os.makedirs(os.path.join(scratch, sub), mode=0o700, exist_ok=True)
        os.utime(scratch)
        for entry in files:
            path = beneath(scratch, entry.get("path")) if isinstance(entry, dict) else None
            content = entry.get("content") if isinstance(entry, dict) else None
            if path is None or path == scratch or not isinstance(content, str):
                raise Refused(400, "bad_files", "each file has a path inside the scratch directory and its text.")
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
        before = snapshot(scratch)

        spec = {
            "read": c.system_paths + [s["path"] for s in sets],
            "write": [scratch],
            "file_bytes": c.scratch_mb * 1024 * 1024,
        }
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": os.path.join(scratch, HOME_DIR),
            "TMPDIR": os.path.join(scratch, TMP_DIR),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "MPLBACKEND": "Agg",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        started = time.monotonic()
        child = subprocess.Popen(
            [sys.executable, CONFINE, "--spec", json.dumps(spec), "--", "/bin/bash", "-c", command],
            cwd=scratch,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        state = {"output": bytearray(), "over": False}

        def read_output():
            fd = child.stdout.fileno()
            while True:
                try:
                    block = os.read(fd, 65536)
                except OSError:
                    return
                if not block:
                    return
                if state["over"]:
                    continue
                state["output"] += block
                if len(state["output"]) > c.output_bytes:
                    del state["output"][c.output_bytes:]
                    state["over"] = True
                    kill_session(child.pid)

        reader = threading.Thread(target=read_output, daemon=True)
        reader.start()

        stopped = None
        detail = {}
        peak = 0
        ticks = 0
        while child.poll() is None:
            time.sleep(0.1)
            ticks += 1
            if state["over"]:
                break
            if time.monotonic() - started > c.command_seconds:
                stopped = "timed_out"
            elif ticks % 5 == 0:
                used = memory_bytes(session_processes(child.pid))
                peak = max(peak, used)
                if used > c.memory_mb * 1024 * 1024:
                    stopped = "memory"
                    detail["memory_mb_used"] = round(used / (1024 * 1024))
                elif ticks % 10 == 0:
                    size = tree_bytes(scratch)
                    if size > c.scratch_mb * 1024 * 1024:
                        stopped = "scratch_full"
            if stopped:
                kill_session(child.pid)
                break
        child.wait()
        # Anything the command left running goes with it: a later command is a new process.
        kill_session(child.pid)
        reader.join(timeout=2)
        try:
            child.stdout.close()
        except OSError:
            pass
        duration_ms = int((time.monotonic() - started) * 1000)

        if state["over"]:
            ended = "output_ceiling"
        elif stopped:
            ended = stopped
        elif child.returncode < 0:
            # Ended by a signal this service did not send. On a machine out
            # of memory that is the kernel ending the command.
            ended = "killed"
        else:
            ended = "exited"

        after = snapshot(scratch)
        changed = sorted(path for path, seen in after.items() if before.get(path) != seen)
        written = []
        for path in changed[:WRITTEN_LISTED_MAX]:
            full = os.path.join(scratch, path)
            try:
                written.append({"path": path, "bytes": os.path.getsize(full), "sha256": sha256_file(full)})
            except OSError:
                pass
        return {
            "ended": ended,
            "exit_code": child.returncode if child.returncode >= 0 else None,
            "signal": -child.returncode if child.returncode < 0 else None,
            "output": bytes(state["output"]).decode("utf-8", errors="replace"),
            "output_bytes": len(state["output"]),
            "duration_ms": duration_ms,
            "written": written,
            "written_not_listed": max(0, len(changed) - len(written)),
            # The most memory seen in use, looked at twice a second: 0 for a
            # command that ended before the first look.
            "memory_mb_peak": round(peak / (1024 * 1024)),
            "scratch_bytes": tree_bytes(scratch),
            "scratch": scratch,
            "sets": sets,
            "version": c.version,
            "image": c.image,
            "python": "%d.%d.%d" % sys.version_info[:3],
            **detail,
        }

    # ---- the probe -----------------------------------------------------------

    def probe(self):
        """Check what the deployment has to provide, and say of each check what was tried."""
        c = self.config
        checks = []

        def check(name, ok, detail):
            checks.append({"check": name, "ok": bool(ok), "detail": detail})

        check(
            "commands_are_confined",
            self.abi >= 1,
            "Landlock ABI %d: each command is held to the system paths, its run's sets and its run's scratch directory."
            % self.abi
            if self.abi >= 1
            else self.health()["problem"],
        )

        # The sets are mounted read-only: this process itself cannot write to them.
        for label, root in (("store", c.store), ("directory_root", c.directory_root)):
            if root is None:
                continue
            marker = os.path.join(root, ".minerval-sandbox-probe-" + secrets.token_hex(6))
            try:
                with open(marker, "w") as f:
                    f.write("probe")
                os.remove(marker)
                check(
                    "%s_is_read_only" % label,
                    False,
                    "the sandbox service could write a file in %s. Mount it read-only in the sandbox's container." % root,
                )
            except OSError as err:
                check("%s_is_read_only" % label, True, "a write to %s by the service failed: %s." % (root, err.strerror))

        # No route out, as this process sees it.
        for target in c.probe_connect:
            host, _, port = target.rpartition(":")
            try:
                socket.create_connection((host, int(port)), timeout=3).close()
                check(
                    "no_route_out",
                    False,
                    "the sandbox service connected to %s. Put its container on a network with no route out." % target,
                )
            except (OSError, ValueError) as err:
                check("no_route_out", True, "a connection to %s failed: %s." % (target, err))
        resolved = []
        resolver = threading.Thread(
            target=lambda: resolved.extend(_resolve(c.probe_resolve)), daemon=True
        )
        resolver.start()
        resolver.join(timeout=5)
        check(
            "no_name_resolution",
            not resolved,
            "the sandbox service resolved %s to %s, so it can reach a name server." % (c.probe_resolve, resolved[0])
            if resolved
            else "%s did not resolve." % c.probe_resolve,
        )

        if self.abi >= 1:
            run = "probe-" + secrets.token_hex(8)
            canary_dir = os.path.join(c.scratch, ".probe-canary-" + secrets.token_hex(6))
            os.makedirs(canary_dir, mode=0o700)
            canary = os.path.join(canary_dir, "canary.txt")
            with open(canary, "w") as f:
                f.write("canary")
            target = c.probe_connect[0] if c.probe_connect else "1.1.1.1:443"
            host, _, port = target.rpartition(":")
            command = (
                "echo written > probe.txt\n"
                "if cat %s >/dev/null 2>&1; then echo READ_OUTSIDE; fi\n"
                "if touch %s/.minerval-sandbox-probe-command 2>/dev/null; then echo WROTE_SET; "
                "rm -f %s/.minerval-sandbox-probe-command; fi\n"
                "python3 - <<'EOF'\n"
                "import socket\n"
                "try:\n"
                "    socket.create_connection((%r, %d), timeout=3).close()\n"
                "    print('CONNECTED')\n"
                "except Exception:\n"
                "    pass\n"
                "socket.setdefaulttimeout(5)\n"
                "try:\n"
                "    socket.getaddrinfo(%r, 80)\n"
                "    print('RESOLVED')\n"
                "except Exception:\n"
                "    pass\n"
                "EOF\n" % (canary, c.store, c.store, host, int(port), c.probe_resolve)
            )
            try:
                scratch = self.scratch_of(run)
                with self.run_lock(run):
                    result = self._run(scratch, command, [], [{"name": "store", "path": c.store}])
                out = result["output"]
                check(
                    "a_command_can_write_its_scratch",
                    any(w["path"] == "probe.txt" for w in result["written"]),
                    "a command wrote a file in its scratch directory, and the file was reported.",
                )
                check(
                    "a_command_cannot_read_outside_its_sets",
                    "READ_OUTSIDE" not in out,
                    "a command could not read a file outside its sets and its scratch directory."
                    if "READ_OUTSIDE" not in out
                    else "a command read a file outside its sets and its scratch directory.",
                )
                check(
                    "a_command_cannot_write_a_set",
                    "WROTE_SET" not in out,
                    "a command's write to a set failed." if "WROTE_SET" not in out else "a command wrote into a set.",
                )
                check(
                    "a_command_has_no_route_out",
                    "CONNECTED" not in out and "RESOLVED" not in out,
                    "a command could neither connect to %s nor resolve %s." % (target, c.probe_resolve)
                    if "CONNECTED" not in out and "RESOLVED" not in out
                    else "a command reached the network (%s)." % ", ".join(
                        w for w in ("CONNECTED", "RESOLVED") if w in out
                    ).lower(),
                )
            finally:
                self.remove_scratch(run)
                shutil.rmtree(canary_dir, ignore_errors=True)

        return {
            "ok": all(ch["ok"] for ch in checks),
            "version": c.version,
            "image": c.image,
            "checks": checks,
        }


def _resolve(name):
    try:
        return [socket.getaddrinfo(name, 80)[0][4][0]]
    except OSError:
        return []


def make_handler(sandbox):
    token = sandbox.config.token.encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "minerval-sandbox/" + sandbox.config.version

        def log_message(self, format, *args):  # noqa: A002 - the base class's name
            return

        def _send(self, status, body):
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self):
            given = self.headers.get("Authorization", "")
            if given.startswith("Bearer ") and hmac.compare_digest(given[7:].encode("utf-8"), token):
                return True
            self._send(401, {"error": "unauthorized", "message": "The sandbox answers only a caller that holds its token."})
            return False

        def _body(self):
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(body, dict):
                raise Refused(400, "bad_request", "The body is a JSON object.")
            return body

        def _answer(self, work):
            try:
                self._send(200, work())
            except Refused as refused:
                self._send(refused.status, {"error": refused.code, "message": refused.message})
            except (ValueError, UnicodeDecodeError):
                self._send(400, {"error": "bad_request", "message": "The body is not JSON."})
            except Exception as err:  # noqa: BLE001 - reported to the caller, which records it
                self._send(500, {"error": "sandbox_error", "message": "%s: %s" % (type(err).__name__, err)})

        def do_GET(self):  # noqa: N802 - the base class's name
            if not self._authorized():
                return
            if self.path == "/health":
                return self._answer(sandbox.health)
            self._send(404, {"error": "not_found", "message": "No such route."})

        def do_POST(self):  # noqa: N802
            if not self._authorized():
                return
            if self.path == "/run":
                return self._answer(lambda: sandbox.run(self._body()))
            if self.path == "/probe":
                return self._answer(sandbox.probe)
            self._send(404, {"error": "not_found", "message": "No such route."})

        def do_DELETE(self):  # noqa: N802
            if not self._authorized():
                return
            if self.path.startswith("/scratch/"):
                run = self.path[len("/scratch/"):]
                return self._answer(lambda: {"removed": sandbox.remove_scratch(run)})
            self._send(404, {"error": "not_found", "message": "No such route."})

    return Handler


def main():
    config = Config()
    sandbox = Sandbox(config)
    server = ThreadingHTTPServer((config.host, config.port), make_handler(sandbox))
    server.daemon_threads = True

    def sweep_forever():
        while True:
            time.sleep(600)
            sandbox.sweep()

    threading.Thread(target=sweep_forever, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    # The line a process that started this one waits for.
    print(
        "sandbox listening on %s:%d (version %s, Landlock ABI %d)"
        % (config.host, server.server_address[1], config.version, sandbox.abi),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()


if __name__ == "__main__":
    main()
