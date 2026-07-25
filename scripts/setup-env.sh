#!/usr/bin/env bash
#
# Episteme - cloud development environment setup
#
# Brings a fresh container to the point where `npx tsc --noEmit` and
# `npx vitest run` both pass: dependencies installed, Postgres running with
# pgvector + pg_trgm, and migrations applied.
#
# Safe to re-run; every step is idempotent.
#
# Usage:
#   bash scripts/setup-env.sh

set -euo pipefail

log()  { printf '\n=== %s ===\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
fi

# -----------------------------------------------------------------------------
# 1. Locate the repository
# -----------------------------------------------------------------------------
# Never rely on $PWD: the setup script is invoked from an arbitrary working
# directory. Resolving the root explicitly is what keeps `docker compose` and
# `npm ci` from running somewhere that has no config file to find.
find_repo_root() {
  local candidate
  for candidate in \
      "${CLAUDE_PROJECT_DIR:-}" \
      "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)" \
      /home/user/episteme \
      "$PWD"; do
    if [ -n "$candidate" ] && [ -f "$candidate/package.json" ] && [ -f "$candidate/drizzle.config.ts" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if ! REPO_ROOT="$(find_repo_root)"; then
  echo "ERROR: could not locate the episteme checkout." >&2
  echo "       Set CLAUDE_PROJECT_DIR to the repository root and re-run." >&2
  exit 1
fi
cd "$REPO_ROOT"
log "Repository root: $REPO_ROOT"

# -----------------------------------------------------------------------------
# 2. Repair apt sources
# -----------------------------------------------------------------------------
# The ondrej/php PPA is not reachable through the sandbox egress proxy: it
# answers 403, which apt reports as "repository is no longer signed" and turns
# every later `apt-get update` into a hard failure. Nothing here is PHP, so drop
# any leftover entry rather than working around the fetch error.
log "Checking apt sources"
PPA_LISTS=$(grep -rlE 'ppa\.launchpad(content)?\.net/ondrej' \
              /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null || true)
if [ -n "$PPA_LISTS" ]; then
  warn "removing unreachable ondrej PPA entries:"
  printf '  %s\n' $PPA_LISTS >&2
  # shellcheck disable=SC2086
  $SUDO rm -f $PPA_LISTS
else
  echo "No blocked PPA entries found."
fi

# -----------------------------------------------------------------------------
# 3. Postgres
# -----------------------------------------------------------------------------
DB_URL="${DATABASE_URL:-postgres://episteme:episteme_dev@localhost:5432/episteme}"

# Parse the connection string so provisioning follows DATABASE_URL rather than
# hardcoded credentials.
url_body="${DB_URL#*://}"
if [[ "$url_body" == *@* ]]; then
  url_creds="${url_body%%@*}"
  url_hostpath="${url_body#*@}"
else
  url_creds=""
  url_hostpath="$url_body"
fi
DB_USER="${url_creds%%:*}"
DB_PASS="${url_creds#*:}"
[ "$DB_PASS" = "$url_creds" ] && DB_PASS=""
DB_HOSTPORT="${url_hostpath%%/*}"
DB_HOST="${DB_HOSTPORT%%:*}"
DB_NAME="${url_hostpath#*/}"
DB_NAME="${DB_NAME%%\?*}"
: "${DB_USER:=episteme}" "${DB_NAME:=episteme}"

db_ready() { pg_isready -d "$DB_URL" >/dev/null 2>&1; }

start_postgres_via_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  # `docker compose` finds its config relative to the working directory, so pass
  # the file explicitly. Check the daemon separately: Compose reports a missing
  # config file before it ever tries to connect, which hides the real cause.
  [ -f "$REPO_ROOT/docker-compose.yml" ] || return 1
  docker info >/dev/null 2>&1 || return 1
  echo "Docker daemon reachable; starting the compose service."
  docker compose -f "$REPO_ROOT/docker-compose.yml" up -d
}

as_postgres() { $SUDO su postgres -c "$1"; }

start_postgres_natively() {
  case "$DB_HOST" in
    localhost|127.0.0.1|::1|"") ;;
    *)
      warn "DATABASE_URL points at '$DB_HOST', which this script will not provision."
      return 1
      ;;
  esac

  echo "Installing PostgreSQL 16 with pgvector."
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -qq
  # pg_trgm ships with the server package; only pgvector is extra. Both come
  # from the Ubuntu archive, which is reachable without any PPA.
  $SUDO apt-get install -y -qq postgresql-16 postgresql-16-pgvector

  $SUDO pg_ctlcluster 16 main start 2>/dev/null || true

  local waited=0
  until $SUDO pg_isready -h /var/run/postgresql >/dev/null 2>&1; do
    [ "$waited" -ge 30 ] && { warn "Postgres did not come up within 30s."; return 1; }
    sleep 1
    waited=$((waited + 1))
  done

  echo "Provisioning role '$DB_USER' and database '$DB_NAME'."
  as_postgres "psql -v ON_ERROR_STOP=1 -c \"DO \\\$\\\$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
        CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}' SUPERUSER;
      ELSE
        ALTER ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
      END IF;
    END \\\$\\\$;\""

  if ! as_postgres "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"" | grep -q 1; then
    as_postgres "createdb -O ${DB_USER} ${DB_NAME}"
  fi

  as_postgres "psql -v ON_ERROR_STOP=1 -d ${DB_NAME} -f ${REPO_ROOT}/scripts/init-extensions.sql"
}

log "Starting Postgres"
if db_ready; then
  echo "Postgres already accepting connections; leaving it alone."
elif start_postgres_via_docker; then
  echo "Waiting for the container to accept connections."
  waited=0
  until db_ready; do
    [ "$waited" -ge 60 ] && { warn "container did not become ready within 60s."; break; }
    sleep 2
    waited=$((waited + 2))
  done
else
  echo "No usable Docker daemon; falling back to a native server."
  start_postgres_natively
fi

if db_ready; then
  echo "Database is up: ${DB_USER}@${DB_HOSTPORT}/${DB_NAME}"
else
  warn "Postgres is not reachable. Tests that need a database will fail."
fi

# -----------------------------------------------------------------------------
# 4. Dependencies
# -----------------------------------------------------------------------------
log "Installing dependencies"
npm ci --no-audit --no-fund

# Sub-projects are only needed for their own typecheck/build steps, so a
# failure here should not sink the whole setup.
for sub in web infra extension; do
  if [ -f "$REPO_ROOT/$sub/package.json" ]; then
    echo "--- $sub ---"
    ( cd "$REPO_ROOT/$sub" && npm ci --no-audit --no-fund ) \
      || warn "dependency install failed for '$sub'; continuing."
  fi
done

# -----------------------------------------------------------------------------
# 5. Migrations
# -----------------------------------------------------------------------------
if db_ready; then
  log "Applying migrations"
  DATABASE_URL="$DB_URL" npx drizzle-kit migrate
else
  warn "Skipping migrations: no database connection."
fi

log "Setup complete"
echo "Verify with:"
echo "  npx tsc --noEmit"
echo "  npx vitest run"
