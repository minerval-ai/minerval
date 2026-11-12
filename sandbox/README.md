# The sandbox

Where a private deployment's agents run commands against its file sets
(`docs/file-sets.md`). A small service the API calls over a private
network. This directory is the whole of it:

| file | |
|---|---|
| `server.py` | The service. Python's standard library only. |
| `confine.py` | Starts each command confined to its run's sets and scratch directory (Landlock). |
| `Dockerfile` | The image: Python, the data libraries, the shell tools, the service. |
| `requirements.txt` | The Python libraries in the image, pinned. |
| `VERSION` | The service's version, recorded on every kept analysis. Raise it when the service's behavior changes. |

The Docker Compose packaging is a separate change. This page says what it
has to provide.

## What the service does

- `GET /health`: its version and image, the Python it has, which of the
  expected libraries import and which tools are on the path, the Landlock
  ABI of the kernel, where the store and the registered root are in its
  filesystem, and its four limits. The API states those limits to agents,
  so they are read from the running service and never from the API's own
  settings.
- `POST /run`: one shell command for one run, with the sets the API names,
  each by its path relative to the store or the registered root. Returns
  what was printed, how the command ended and which files it wrote.
- `DELETE /scratch/<run>`: the run has ended; remove its scratch directory.
- `POST /probe`: check what the deployment has to provide (below).

Every route needs the bearer token. The service keeps no record of
commands (the API stores each call), holds no credential, and makes no
outward call.

## What the deployment provides

The service confines each command itself. Three things it cannot give
itself, and the probe checks each:

1. **A network with no route out.** Attach the sandbox's container to one
   network only, shared with the API and marked internal (in Compose,
   `internal: true`), and publish none of its ports. It then has no default
   route and no name server. Do not attach it to the default bridge.
2. **The file sets mounted read-only.** Mount the store uploaded sets are
   kept in at `/sets` and the root directories are registered from at
   `/registered`, both `:ro`. The API mounts the same store read-write
   (`FILE_SET_STORE_DIR`) and the same root read-only
   (`FILE_SET_DIRECTORY_ROOT`); the paths need not be the same in the two
   containers. The files must be readable by the sandbox's user (uid 10002):
   the API writes uploads world-readable.
3. **A writable scratch directory** at `/scratch`: a tmpfs or a volume,
   sized for `SANDBOX_SCRATCH_MB` times the runs expected at once.

And one thing of the host: **a kernel with Landlock** (Linux 5.13 or later,
with `landlock` among the active security modules, as current
distributions ship it). Docker's default seccomp profile allows the three
Landlock system calls; a custom profile must too. Without Landlock the
service starts, reports why in `/health`, and runs no command, because it
could not hold a command to its own run's sets.

The rest is ordinary hardening, and none of it is needed for the service to
work: a read-only root filesystem, every capability dropped,
`no-new-privileges`, a memory limit at least `SANDBOX_MEMORY_MB` times
`SANDBOX_MAX_COMMANDS`, and a limit on processes. The image runs as an
unprivileged user and needs no privilege.

A sketch of the service's entry, for whoever writes the packaging:

```yaml
  sandbox:
    build: { context: ./sandbox, args: { SANDBOX_IMAGE: "minerval-sandbox:1" } }
    environment:
      SANDBOX_TOKEN: ${SANDBOX_TOKEN}
    volumes:
      - file_sets:/sets:ro
      - /srv/data:/registered:ro
    tmpfs:
      - /scratch:size=8g,uid=10002
    networks: [sandbox]          # and no other
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 12g
    pids_limit: 2048

networks:
  sandbox:
    internal: true               # no route out
```

The API joins the `sandbox` network as well as its own, and is given
`SANDBOX_URL=http://sandbox:8080` and the same `SANDBOX_TOKEN`.

## Settings

| variable | | default |
|---|---|---|
| `SANDBOX_TOKEN` | The bearer token the API sends. The service does not start without one. | none |
| `SANDBOX_STORE_DIR` | Where the store of uploaded sets is mounted. | `/sets` in the image |
| `SANDBOX_DIRECTORY_ROOT` | Where the root of registered directories is mounted. May be unset. | `/registered` in the image |
| `SANDBOX_SCRATCH_DIR` | Where scratch directories are made. | `/scratch` in the image |
| `SANDBOX_PORT`, `SANDBOX_HOST` | Where it listens. | `8080`, `0.0.0.0` |
| `SANDBOX_COMMAND_SECONDS` | How long a command may run. | `300` |
| `SANDBOX_OUTPUT_BYTES` | How much a command may print. | `2000000` |
| `SANDBOX_MEMORY_MB` | How much memory a command may use. | `2048` |
| `SANDBOX_SCRATCH_MB` | How large one run's scratch directory, or one file in it, may be. | `1024` |
| `SANDBOX_MAX_COMMANDS` | Commands run at once; others wait. | the machine's CPU count |
| `SANDBOX_QUEUE_SECONDS` | How long a command waits for a place before the call fails as busy. | `60` |
| `SANDBOX_SCRATCH_IDLE_HOURS` | After how long unused a scratch directory is removed without being told. | `24` |
| `SANDBOX_IMAGE` | The image's tag or digest, as a kept analysis records it. A build argument, and settable at start. | `not stated` |
| `SANDBOX_PROBE_CONNECT`, `SANDBOX_PROBE_RESOLVE` | The addresses the probe tries to connect to and the name it tries to resolve. | `1.1.1.1:443 8.8.8.8:53`, `example.com` |

The four limits are told to every agent that has a file set, each with its
reason, so a change to one changes what agents are told.

## The probe

`POST /probe` answers with one entry per check, each with what was tried:

| check | passes when |
|---|---|
| `commands_are_confined` | The kernel has Landlock. |
| `store_is_read_only`, `directory_root_is_read_only` | The service's own attempt to write a file into the mounted root fails. |
| `no_route_out` | The service's own attempt to connect to each probe address fails. |
| `no_name_resolution` | The service's own attempt to resolve the probe name fails. |
| `a_command_can_write_its_scratch` | A command writes a file in its scratch directory, and the service reports it. |
| `a_command_cannot_read_outside_its_sets` | A command cannot read a file the service made outside that command's sets and scratch directory. |
| `a_command_cannot_write_a_set` | A command's write into a mounted set fails. |
| `a_command_has_no_route_out` | A command can neither connect to a probe address nor resolve the probe name. |

The API's `checkSandbox()` (`src/services/sandbox-client.ts`) calls it and
returns the result with whether the service answered at all. Run as a local
process, as the tests run it, the service passes the checks that are its
own doing and fails the ones that are the container's, since a developer's
machine has a network and a writable disk. That is the probe working.

## What a command can and cannot do

It runs as `bash -c` in its run's scratch directory, with `HOME` and
`TMPDIR` inside it. It can read and execute the system paths (`/usr`,
`/lib`, `/bin`, `/etc` and the like), read the sets its run was given, and
do anything inside its scratch directory. It cannot read anything else: not
another set, not the listing of the store, not another run's scratch
directory, not `/proc`. It has no `/dev/shm`, which every run's commands
would share, so a Python multiprocessing pool does not start; threads and
subprocesses do. Where the kernel offers it, TCP is refused to the
command (Linux 6.7) and so are signals to processes outside it (Linux
6.12); these are additions to the container's network, not a replacement
for it. Whatever a command leaves running is ended with it.

## Running it by hand

```
SANDBOX_TOKEN=dev SANDBOX_STORE_DIR=/tmp/sb/store SANDBOX_DIRECTORY_ROOT=/tmp/sb/registered \
SANDBOX_SCRATCH_DIR=/tmp/sb/scratch SANDBOX_PORT=8089 python3 sandbox/server.py
```

The tests start it the same way (`tests/sandbox-process.ts`,
`tests/unit/sandbox/`, `tests/db/file-sets.test.ts`). They need `python3`
and a kernel with Landlock.
