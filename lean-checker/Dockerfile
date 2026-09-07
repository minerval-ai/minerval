# syntax=docker/dockerfile:1.7
#
# The Minerval Lean checker image: one image per pin (docs/mathematics.md,
# section 5.3). Everything a check needs is baked in at build time so the
# running container needs no network at all: the pinned toolchain, Mathlib at
# the pinned revision with its prebuilt oleans, the community REPL, the
# `minerval_check` executable, and the HTTP server.
#
# Build (from the repository root; see README.md for the pin procedure):
#   docker build -t minerval/lean-checker:$(sed -n 's/.*"pin_id": *"\([^"]*\)".*/\1/p' lean-checker/pin.json) lean-checker/
#
# Every stage starts from the same pinned Debian so the toolchain's dynamic
# libraries match between the stage that builds Mathlib and the one that
# runs the server. Pin by digest at first build: `docker pull` the tag, then
# `docker inspect --format '{{index .RepoDigests 0}}'`, and replace the tag
# below with the `debian@sha256:...` form so a rebuild months later gets the
# same bytes.
ARG DEBIAN_IMAGE=debian:bookworm-20250811-slim
# Node runs the server. Copied out of the official image rather than
# apt-installed so its version is pinned exactly and independently of Debian.
ARG NODE_IMAGE=node:22.22.2-bookworm-slim
# elan is the toolchain manager; the version is pinned so the install is
# reproducible. Chosen at first deployment alongside the Mathlib pin.
ARG ELAN_VERSION=4.1.2

# ---- base ---------------------------------------------------------------------
FROM ${DEBIAN_IMAGE} AS base
# ca-certificates and curl: elan, the Mathlib cache, and the health check.
# git: Lake materialises dependencies with git and checks their revisions.
# time (GNU time): reports CPU seconds and peak RSS per process, which the
#   verdict record carries as cpu_ms and max_rss_mb.
# coreutils' timeout is the wall-clock limit outside Lean.
# zstd: the Mathlib cache's leantar archives are zstd-compressed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git time zstd \
 && rm -rf /var/lib/apt/lists/*
ENV ELAN_HOME=/opt/elan \
    PATH=/opt/elan/bin:/usr/local/bin:/usr/bin:/bin

# ---- toolchain: elan plus exactly the pinned Lean --------------------------------
FROM base AS toolchain
ARG ELAN_VERSION
WORKDIR /opt/minerval/checker
COPY lean-toolchain pin.json ./
# The pin is one fact recorded in three files; a mismatch is a build error,
# not something to discover after a verdict names the wrong toolchain.
RUN set -eu; \
    want="$(sed -n 's/.*"lean_toolchain": *"\([^"]*\)".*/\1/p' pin.json)"; \
    have="$(tr -d '[:space:]' < lean-toolchain)"; \
    [ "$want" = "$have" ] || { echo "pin.json says $want but lean-toolchain says $have" >&2; exit 1; }
# Install elan from its release tarball (not the curl|sh script, which picks
# the latest elan), then only the toolchain the pin names. `--default-toolchain
# none` keeps elan from downloading whatever is current.
RUN set -eu; \
    curl -sSfL "https://github.com/leanprover/elan/releases/download/v${ELAN_VERSION}/elan-x86_64-unknown-linux-gnu.tar.gz" -o /tmp/elan.tar.gz; \
    mkdir -p /tmp/elan && tar -xzf /tmp/elan.tar.gz -C /tmp/elan; \
    /tmp/elan/elan-init -y --no-modify-path --default-toolchain none; \
    rm -rf /tmp/elan /tmp/elan.tar.gz; \
    elan toolchain install "$(tr -d '[:space:]' < lean-toolchain)"; \
    elan default "$(tr -d '[:space:]' < lean-toolchain)"; \
    lean --version && lake --version

# ---- mathlib: the pinned revision with its prebuilt oleans --------------------
FROM toolchain AS mathlib
WORKDIR /opt/minerval/checker
COPY lakefile.lean lake-manifest.json ./
# The manifest must carry the resolved revision: the all-zero placeholder in
# the repository is a deliberate build failure until scripts/resolve-pin.sh
# has been run at first deployment.
RUN set -eu; \
    if grep -q '"rev": *"0000000000000000000000000000000000000000"' lake-manifest.json; then \
      echo "lake-manifest.json still holds the placeholder revision; run lean-checker/scripts/resolve-pin.sh" >&2; exit 1; fi; \
    pinrev="$(sed -n 's/.*"mathlib_rev": *"\([^"]*\)".*/\1/p' pin.json)"; \
    manrev="$(tr -d '\n' < lake-manifest.json | sed -n 's/.*"rev": *"\([0-9a-f]\{40\}\)",[^}]*"name": *"mathlib".*/\1/p')"; \
    [ -n "$manrev" ] || { echo "could not read mathlib's rev from lake-manifest.json" >&2; exit 1; }; \
    [ "$pinrev" = "$manrev" ] || { echo "pin.json mathlib_rev $pinrev != lake-manifest.json $manrev" >&2; exit 1; }
# Materialise Mathlib at the manifest's revision (Lake clones it) and fetch
# the prebuilt oleans for exactly that revision. Compiling Mathlib from
# source takes hours; the cache takes minutes, and this is the first of the
# measurements the README asks for (cache-fetch duration, image size).
RUN --mount=type=cache,target=/root/.cache/mathlib \
    lake exe cache get
# `--no-build` turns a stale or partial cache into a build failure here
# instead of an hours-long source build: every Mathlib module must already
# be up to date.
RUN lake build --no-build Mathlib

# ---- checker: minerval_check, the pre-warm, and the REPL ------------------------
FROM mathlib AS checker
WORKDIR /opt/minerval/checker
COPY MinervalWarm.lean ./
COPY Minerval/ ./Minerval/
# MinervalWarm is `import Mathlib`: building it loads every olean once and
# proves the cache is usable under this toolchain (the pre-warm of section
# 5.3). minerval_check is the checker executable of Minerval/Check.lean.
RUN lake build MinervalWarm minerval_check && test -x .lake/build/bin/minerval_check
# Smoke test: with no arguments the checker prints its usage as a JSON
# object with "ok": false and exits 2; grep's status is the step's status.
RUN .lake/build/bin/minerval_check 2>/dev/null | grep -q '"ok":false'
# Lake compiles its configuration into .lake/lakefile.olean on first use; do
# it now so `lake env` at run time reads the cache and never needs to write
# into the read-only project directory.
RUN lake env true
# The community REPL at the matching tag, for the warm lane's future
# persistent-process mode (the server shells out per request in v0; the
# README's measurements decide when the REPL takes over).
ARG REPL_REF
RUN set -eu; \
    ref="${REPL_REF:-$(sed -n 's/.*"repl_tag": *"\([^"]*\)".*/\1/p' pin.json)}"; \
    git clone --depth 1 --branch "$ref" https://github.com/leanprover-community/repl /opt/minerval/repl; \
    cd /opt/minerval/repl && lake build; \
    mkdir -p /opt/minerval/bin && cp .lake/build/bin/repl /opt/minerval/bin/repl
# Gate 5 replays the submission's declarations through the kernel with
# `leanchecker`. Recent toolchains ship it; for one that does not, build
# lean4checker at the matching tag and install it under that name so the
# server's `lake env leanchecker` works either way.
RUN set -eu; \
    if lake env sh -c 'command -v leanchecker' >/dev/null 2>&1; then \
      echo "toolchain ships leanchecker"; \
    else \
      ref="$(tr -d '[:space:]' < lean-toolchain | sed 's/.*://')"; \
      git clone --depth 1 --branch "$ref" https://github.com/leanprover/lean4checker /opt/minerval/lean4checker; \
      cd /opt/minerval/lean4checker && lake build; \
      cp .lake/build/bin/lean4checker /opt/minerval/bin/leanchecker; \
    fi

# ---- server: the TypeScript service, built from its lockfile -----------------------
FROM ${NODE_IMAGE} AS server
WORKDIR /opt/minerval/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src/ ./src/
RUN npm run build && npm ci --omit=dev

# ---- runtime ------------------------------------------------------------------------
FROM base AS runtime
ARG NODE_IMAGE
# Node from the pinned official image: the binary and nothing else.
COPY --from=server /usr/local/bin/node /usr/local/bin/node
# The toolchain and the project with Mathlib's oleans. Ownership is root so
# the service user can read but never write them: Mathlib is read-only by
# construction, and a submission cannot modify what the next check imports.
COPY --from=toolchain /opt/elan /opt/elan
COPY --from=checker /opt/minerval/checker /opt/minerval/checker
COPY --from=checker /opt/minerval/bin /opt/minerval/bin
COPY --from=server /opt/minerval/server/dist /opt/minerval/server/dist
COPY --from=server /opt/minerval/server/node_modules /opt/minerval/server/node_modules
COPY --from=server /opt/minerval/server/package.json /opt/minerval/server/package.json
# The pin record every response carries (section 5.3). The image digest is
# not knowable here (it is a digest of the finished image), so the file holds
# a placeholder and the deployment passes LEAN_CHECKER_IMAGE_DIGEST.
RUN node -e ' \
  const p = require("/opt/minerval/checker/pin.json"); \
  const rec = { pin_id: p.pin_id, lean_toolchain: p.lean_toolchain, mathlib_rev: p.mathlib_rev, \
    mathlib_tag: p.mathlib_tag, image_digest_placeholder: "unknown-until-pushed", checker_version: p.checker_version }; \
  require("fs").writeFileSync("/etc/minerval-lean-pin.json", JSON.stringify(rec, null, 2) + "\n");' \
 && cat /etc/minerval-lean-pin.json
# A dedicated unprivileged user. /work is the only writable path: statement
# oleans, per-check directories, and the children's HOME and TMPDIR live
# there, on a tmpfs or an ephemeral volume mounted at run time.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin checker \
 && mkdir -p /work && chown checker:checker /work
ENV ELAN_HOME=/opt/elan \
    PATH=/opt/minerval/bin:/opt/elan/bin:/usr/local/bin:/usr/bin:/bin \
    HOME=/work/home \
    LEAN_CHECKER_PROJECT_DIR=/opt/minerval/checker \
    LEAN_CHECKER_WORK_ROOT=/work \
    LEAN_CHECKER_BIN=/opt/minerval/checker/.lake/build/bin/minerval_check \
    LEAN_CHECKER_PIN_FILE=/etc/minerval-lean-pin.json \
    LEAN_CHECKER_PORT=8080 \
    LEAN_CHECKER_LANE=warm \
    NODE_ENV=production
WORKDIR /opt/minerval/checker
USER checker
EXPOSE 8080
VOLUME ["/work"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -sf http://localhost:8080/health || exit 1
# The server refuses to start without LEAN_CHECKER_TOKEN; there is no default.
CMD ["node", "/opt/minerval/server/dist/index.js"]
