#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# The web container restores node_modules from a cached snapshot that can
# predate the checkout: a commit that adds a dependency (unpdf in #464) then
# fails typecheck and every test file that imports it. Reinstall each npm
# package whose lockfile is newer than its installed tree, so a current
# snapshot costs nothing and a stale one is repaired before the session
# starts. Local sessions are left alone: a developer manages their own
# node_modules.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# The root package first: it carries the API, workers, and the unit suite.
# The others are separately deployed packages with their own lockfiles.
# lean-checker/server is skipped: it is built alongside a Lean toolchain the
# container does not have.
for dir in . web extension infra; do
  lock="$dir/package-lock.json"
  installed="$dir/node_modules/.package-lock.json"
  [ -f "$lock" ] || continue
  if [ ! -f "$installed" ] || [ "$lock" -nt "$installed" ]; then
    echo "session-start: installing dependencies in $dir"
    # npm ci, not npm install: install rewrites lockfile metadata under a
    # different npm version and leaves the tree dirty in every session.
    (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error)
  fi
done
