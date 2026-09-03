#!/usr/bin/env sh
# Resolve the Mathlib tag named in lakefile.lean to a commit and write it into
# lake-manifest.json and pin.json. Run once at first deployment and again on
# every pin advance (README.md, "Advancing the pin"). Needs Docker and
# network; touches nothing outside lean-checker/.
#
#   lean-checker/scripts/resolve-pin.sh
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
tag="$(sed -n 's/.*"mathlib_tag": *"\([^"]*\)".*/\1/p' pin.json)"
[ -n "$tag" ] || { echo "pin.json has no mathlib_tag" >&2; exit 1; }
grep -q "@ \"$tag\"" lakefile.lean || { echo "lakefile.lean does not require mathlib at $tag" >&2; exit 1; }

echo "building the toolchain stage"
docker build --target toolchain -t minerval-lean-toolchain:local .

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp lakefile.lean lean-toolchain pin.json "$work/"
# A manifest with the placeholder makes `lake update` resolve from scratch.
cp lake-manifest.json "$work/lake-manifest.json"

echo "resolving mathlib $tag with lake update (clones Mathlib; a few minutes)"
docker run --rm -v "$work:/src" -w /src minerval-lean-toolchain:local \
  sh -c 'lake update mathlib && rm -rf .lake'

rev="$(tr -d '\n' < "$work/lake-manifest.json" | sed -n 's/.*"rev": *"\([0-9a-f]\{40\}\)",[^}]*"name": *"mathlib".*/\1/p')"
[ -n "$rev" ] || { echo "lake update did not produce a mathlib rev" >&2; exit 1; }
cp "$work/lake-manifest.json" lake-manifest.json
sed -i.bak "s/\"mathlib_rev\": *\"[0-9a-f]*\"/\"mathlib_rev\": \"$rev\"/" pin.json && rm -f pin.json.bak
echo "mathlib $tag = $rev"
echo "wrote lake-manifest.json and pin.json; review and commit both"
