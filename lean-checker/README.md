# lean-checker

The Lean checker service of [docs/mathematics.md](../docs/mathematics.md),
section 5: one container image per pin, holding a pinned Lean toolchain,
Mathlib at a pinned revision with its prebuilt oleans, the community REPL,
the `minerval_check` executable, and a small HTTP server. The API talks to
it over private addressing with a bearer token; the checker calls nothing.

```
lean-checker/
  pin.json              the pin: pin_id, toolchain, Mathlib tag and revision, checker version
  lean-toolchain        the toolchain, for elan (must agree with pin.json)
  lakefile.lean         requires Mathlib at the tag; declares minerval_check and MinervalWarm
  lake-manifest.json    the resolved revision (placeholder until scripts/resolve-pin.sh runs)
  Minerval/Check.lean   minerval_check: gates 2-4 of the verdict rule, as one JSON object
  MinervalWarm.lean     `import Mathlib`, built at image time as the pre-warm
  Dockerfile            the multi-stage image; every step says why it exists
  server/               the HTTP service (TypeScript, fastify only); tests run without Lean
  golden/lean-checks.json   the adversarial fixture of section 12.2, as data
  scripts/run-golden.ts     runs the fixture against a live checker
  scripts/resolve-pin.sh    resolves the Mathlib tag to a revision
```

## The contract

Every route but `/health` needs `Authorization: Bearer $LEAN_CHECKER_TOKEN`.

| Route | Lane | What it does |
| --- | --- | --- |
| `GET /health` | both | pin, lane, queue depth, CPU spent today |
| `GET /v1/pins` | both | the live pin and its image digest |
| `POST /v1/elaborate {statement_source}` | warm | convention check, compile, `minerval_check elaborate`; returns errors with positions, or `pp_type`, `expr_hash`, `source_hash`, `constants`, `definitions`, `definitions_axioms`, `witness_present`, `warnings` |
| `POST /v1/scratch {source, statement_source?}` | warm | semi-trusted iteration: diagnostics only, `verdict` is always `null` |
| `POST /v1/search {query, backend?, limit?}` | warm | proxy to `LOOGLE_URL`; `503 search_unconfigured` when unset |
| `POST /v1/check {mode, kind, statement_source, submission_source, replay?, force?, limits?}` | both | static policy, then a queued job: `202 {check_id, status}`; a static rejection is a finished record: `200` |
| `GET /v1/checks/:id` | both | the record: `status`, `verdict`, `failed_gate`, `checks` (one entry per gate), `diagnostics`, `truncated`, `resource`, the pin fields, both hashes |

Verdicts are `accepted`, `rejected` (a gate failed on the merits; `failed_gate`
names it), or `error` (the checker could not decide; `error_reason` says
why; never evidence). Gates, in order: `static_policy`, `compile`, `target`,
`axioms`, `declarations`, `replay`. A warm-lane instance refuses
`mode: "prize"` (`LEAN_CHECKER_REFUSE_PRIZE_ON_WARM=1`); prize verdicts come
from a cold-lane task. Repeated checks of the same statement, submission,
kind, replay, and mode return the stored record unless `force` is set.

Hashes: `source_hash = sha256("minerval-statement-v1\n" + pin_id + "\n" +
normalised source)`, where normalisation is CRLF to LF, trailing whitespace
stripped, one final newline, NFC. `expr_hash = sha256("minerval-expr-v1\n" +
pp_all)`, over the statement body as Lean prints it with `pp.all`.
`submission_sha256` is over the submission's bytes exactly as sent.

The statement convention (section 5.4) is enforced by the server: first line
`import Mathlib`, then `set_option autoImplicit false`, one
`namespace Minerval.S<8 hex>_v<n>`, a `def Statement : Prop :=`, an optional
witness `example : ... :=`, and the matching `end`. The submission is
appended after a three-line header whose `import MinervalCheck.Statement` is
its only import; diagnostics are reported relative to the submission.

## Building the image

Both files that name the Mathlib revision hold a deliberate placeholder
(`0000…`) until the pin is resolved, and the image build fails on it.

```sh
# 1. Resolve the Mathlib tag in pin.json to a commit (needs Docker and network).
lean-checker/scripts/resolve-pin.sh          # writes lake-manifest.json and pin.json; commit both

# 2. Build. The tag is the pin id.
PIN=$(sed -n 's/.*"pin_id": *"\([^"]*\)".*/\1/p' lean-checker/pin.json)
DOCKER_BUILDKIT=1 docker build -t minerval/lean-checker:$PIN lean-checker/

# 3. Smoke-test it locally (section 5.8's v0 line, below), then push.
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker tag minerval/lean-checker:$PIN <account>.dkr.ecr.us-east-1.amazonaws.com/minerval/lean-checker:$PIN
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/minerval/lean-checker:$PIN
docker inspect --format '{{index .RepoDigests 0}}' minerval/lean-checker:$PIN   # the image digest
```

The first build downloads the toolchain (hundreds of MB), clones Mathlib,
and fetches its cache (several GB); expect tens of minutes. Later builds of
the same pin reuse the cache mount. The digest from step 3 is what verdicts
report as `image_digest`: pass it to the deploy as
`-c leanCheckerImageDigest=sha256:…` (v1) or `-e LEAN_CHECKER_IMAGE_DIGEST=…`
(v0). Until then the placeholder `unknown-until-pushed` is reported, on
purpose.

### First-deployment checklist

Nothing in this directory has run against a real toolchain yet: the server
is tested against a fake runner, and `Minerval/Check.lean` is compiled for
the first time by the image build. Expect to adjust:

- `Minerval/Check.lean`: every comment marked `API:` names a Lean API that
  may have moved between releases (`importModules` parameters,
  `Environment.getModuleFor?`, `SMap.fold`, `Compiler.CSimp.ext` and its
  `thmNames` field, `getInitFnNameFor?`, `getExportNameFor?`,
  `Expr.getUsedConstants`). If Mathlib refuses to import without its
  extensions initialised, set `LEAN_CHECKER_LOAD_EXTS`-equivalent by adding
  `--load-exts` in `server/src/runner-process.ts` (see the comment on
  `loadEnv`).
- `leanchecker`: the Dockerfile uses the toolchain's binary when present and
  builds `lean4checker` at the matching tag otherwise. Confirm
  `lake env leanchecker MinervalCheck.Submission` finds a module on
  `LEAN_PATH` from a directory outside the project; if it does not, the
  fallback is a `--search-path`-style flag or a symlink of the work
  directory into the project's build tree.
- `lake env` under a read-only project directory: the build compiles the
  Lake configuration so nothing needs writing. If `lake env` still tries,
  the fallback is to bake `LEAN_PATH` at build time
  (`lake env printenv LEAN_PATH` into an `ENV`) and call `lean` directly.
- `readonlyRootFilesystem` in the task definitions: everything writable is
  under `/work`; if something insists on `/tmp` or `$HOME`, point it at
  `/work` rather than loosening the root.
- ECS: Fargate has no tmpfs, so `/work` is an ephemeral volume; Debian base,
  Node, and elan versions in the Dockerfile are tags to verify and then pin
  by digest.

## The first measurements

Nobody has made these yet (section 5.8); make them on the first build and
record them here.

| Measurement | How | Value |
| --- | --- | --- |
| Image size | `docker image ls minerval/lean-checker` | |
| Cache-fetch duration | time of the `lake exe cache get` step in the build log | |
| `import Mathlib` warm start | `POST /v1/scratch {"source": "example : True := trivial"}` on a fresh container; `resource.wall_ms` | |
| Peak memory of a check | `resource.max_rss_mb` on the golden `valid-proof` case, and `docker stats` | |
| `leanchecker` runtime | `checks.replay` step: compare `resource.wall_ms` of a check with `LEAN_CHECKER_REPLAY_TOOL=none` against the default | |
| `--fresh` replay runtime | one `replay: "fresh"` check; expect hours | |
| Statement compile, cached vs not | second check of the same statement: `statement_compile.cached` | |
| Cold-lane start to first check | RunTask to `/health` answering, in the API's logs | |

What the numbers decide: whether the warm lane moves `elaborate`/`scratch`
onto the persistent REPL (`/opt/minerval/bin/repl`) instead of one `lean`
process per request; whether Mathlib's `.git` directories can be dropped
from the runtime image (they exist so `lake env` can verify the manifest);
the health check's `startPeriod`; and the per-check cost line in section 5.8.

## Running one instance (v0)

Section 5.8's single-instance mode: one container, no network, read-only
root, a tmpfs work directory, no capabilities, bounded processes, memory, and
CPUs. Both lanes run in this one container; set `LEAN_CHECKER_LANE=cold` on a
per-check `docker run` to get a container that exits after its check is
fetched.

```sh
docker run --rm --network none --read-only --tmpfs /work:rw,size=8g,uid=10001 \
  --cap-drop ALL --pids-limit 256 --memory 12g --cpus 2 \
  -e LEAN_CHECKER_TOKEN="$(openssl rand -hex 24)" \
  -e LEAN_CHECKER_IMAGE_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' minerval/lean-checker:$PIN)" \
  -e LEAN_CHECKER_REFUSE_PRIZE_ON_WARM=0 \
  -p 127.0.0.1:8080:8080 \
  minerval/lean-checker:$PIN
```

`--network none` makes `POST /v1/search` answer `search_unconfigured` and
keeps every Lean process offline, which is the point. Then:

```sh
curl -s localhost:8080/health | jq .pin
cd lean-checker/server && npx tsx ../scripts/run-golden.ts --url http://localhost:8080 --token "$LEAN_CHECKER_TOKEN"
```

The golden run is the acceptance test for a pin: every case in
`golden/lean-checks.json` must match its expected verdict and gate. The
static-policy portion is also asserted without Lean by
`server/test/golden-static.test.ts`.

The API reaches a v0 instance with `LEAN_CHECKER_URL=http://<host>:8080` and
`LEAN_CHECKER_TOKEN` set to the same token. On an EC2 instance, bind the
port to the instance's private address and restrict the security group to
the API's group.

## Deploying (v1)

`infra/lib/lean-checker-stack.ts` is `EpistemeLeanChecker`: the ECR
repository, the token secret, the warm-lane Fargate service (2 vCPU, 16 GB,
60 GB ephemeral) in the isolated subnets, the cold-lane task definition
(4 vCPU, 16 GB), the VPC endpoints, and the checker security group whose
only egress is to those endpoints. `infra/bin/app.ts` passes the service
URL, the secret, and the cold-lane launch parameters to the API stack, which
sets `LEAN_CHECKER_URL`, `LEAN_CHECKER_TOKEN`, and
`LEAN_CHECKER_COLD_*` on the API task and grants it `ecs:RunTask`.

```sh
cd infra && npm ci
npx cdk deploy EpistemeLeanChecker            # creates the repository first; the service will fail to pull until an image is pushed
# build and push the image (above), then
npx cdk deploy EpistemeLeanChecker EpistemeApi -c leanCheckerImageDigest=sha256:...
npm test                                      # synth-level assertions, including the no-callback rule
```

A cold-lane check from the API: `RunTask` with the exported task definition
in the exported subnets and security group, poll `DescribeTasks` for the
task's private IP, `POST /v1/check` to `http://<ip>:8080` with
`mode: "prize"`, poll `GET /v1/checks/:id`, and the task exits on its own
once the finished record has been fetched (`LEAN_CHECKER_COLD_MAX_CHECKS=1`)
or after `LEAN_CHECKER_COLD_IDLE_S`. The API's poller and recovery sweep are
the API's; nothing here calls it.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LEAN_CHECKER_TOKEN` | required | bearer token; the server refuses to start without it |
| `LEAN_CHECKER_LANE` | `warm` | `warm` or `cold` |
| `LEAN_CHECKER_PORT`, `LEAN_CHECKER_HOST` | `8080`, `0.0.0.0` | |
| `LEAN_CHECKER_IMAGE_DIGEST` | unset | reported as `image_digest`; the pin file's placeholder otherwise |
| `LEAN_CHECKER_JOB_TIMEOUT_S` / `_MEMORY_MB` / `_MAX_HEARTBEATS` | `600` / `12288` / `400000` | per-check ceilings; a request may lower them |
| `LEAN_CHECKER_ELAB_TIMEOUT_S` / `_MEMORY_MB` / `_MAX_HEARTBEATS` | `180` / `12288` / `400000` | per-elaboration ceilings |
| `LEAN_CHECKER_KILL_AFTER_S` | `10` | grace between SIGTERM and SIGKILL |
| `LEAN_CHECKER_MAX_CONCURRENT` | `1` | checks running at once |
| `LEAN_CHECKER_MAX_WARM_CONCURRENT` | `2` | elaborations and scratch runs at once |
| `LEAN_CHECKER_DAILY_CPU_HOURS` | `20` | per-day CPU cap; `429` once spent |
| `LEAN_CHECKER_RECORD_TTL_HOURS` | `72` | how long a finished record is readable |
| `LEAN_CHECKER_REFUSE_PRIZE_ON_WARM` | `1` | warm lane refuses `mode: "prize"` |
| `LEAN_CHECKER_COLD_MAX_CHECKS` / `_COLD_IDLE_S` | `1` / `1200` | cold lane exit conditions |
| `LEAN_CHECKER_REPLAY_TOOL` | `leanchecker` | `none` records `error` for gate 5, never `accepted` |
| `LOOGLE_URL`, `LEAN_SEARCH_NATURAL_URL` | unset | search backends |
| `LEAN_CHECKER_BODY_LIMIT_BYTES` | `2097152` | request size |

## Advancing the pin

Section 5.5: at most three live pins (the platform pin, the previous one,
and any pin an open bounty still names); a statement is checked under its
own pin, never a newer one; retired images stay in the registry.

1. Pick the new Mathlib tag (a monthly one) and its toolchain. Edit
   `pin.json` (`pin_id`, `lean_toolchain`, `mathlib_tag`, `repl_tag`),
   `lean-toolchain`, and the `@ "vX.Y.Z"` in `lakefile.lean`; bump
   `checker_version` if `Minerval/Check.lean` or the server changed.
2. `scripts/resolve-pin.sh` to write the revision into `lake-manifest.json`
   and `pin.json`. Commit all of them together.
3. Build the image; run the golden fixture against it; record the
   measurements above. A case that changes verdict under the new pin is a
   finding, not a fixture to edit: decide whether it is a Mathlib rename
   (the fixture's statement needs a new version) or a checker regression.
4. Push under the new tag. The old tag stays: the lifecycle rule expires
   untagged layers only.
5. Deploy `EpistemeLeanChecker` with the new digest. The warm lane rolls to
   the new pin; cold-lane tasks for statements still on the old pin need the
   old image, so the API's launcher passes the statement's pin as the image
   tag override until the migration job (section 5.5) has re-elaborated
   every open statement or the Steward has republished it.
6. Run the migration job: re-elaborate every open statement under the new
   pin and compare `expr_hash` (and the closure hash of the constants it
   references); a statement with a live bounty never changes pin without a
   new version and the 30-day notice.

## Development

```sh
cd lean-checker/server
npm ci
npm run typecheck        # tsc on the server and on scripts/
npm test                 # vitest: auth, static policy, convention, hashes, queue, verdict rule, truncation, routes, golden static cases
```

The tests never start Lean. `src/runner.ts` is the seam: `ProcessLeanRunner`
is the only code that shells out (`lake env lean`, `minerval_check`,
`leanchecker`, each wrapped in `timeout --kill-after` and GNU `time`, output
capped at 64 KB and 200 diagnostics), and `FakeLeanRunner` answers from
canned raw results. The verdict rule (`src/verdict.ts`) is a pure function
over those raw results, so the gate order is tested directly.
