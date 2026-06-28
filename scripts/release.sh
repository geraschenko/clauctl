#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh (or: npm run release)

Runs release checks (presubmit + the release-only API tests), shows the
packaged file list, then publishes to npm and tags the release.
USAGE
}

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

VERSION=$(node -p "require('./package.json').version")

# npm pack/publish take files from the working tree, not from git, so an
# unclean tree could publish unreviewed state.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "working tree is not clean; commit or stash before releasing" >&2
  exit 1
fi

# The registry would reject a duplicate version anyway, but only after the
# checks below have run (the API tests cost real money) — so fail early.
# `npm view` exits nonzero when the version (or the whole package) does not
# exist; both mean the version is publishable.
if npm view "@geraschenko/clauctl@$VERSION" version >/dev/null 2>&1; then
  echo "version $VERSION is already published; bump package.json first" >&2
  exit 1
fi

run npm run presubmit
# Release-only tests that make real API calls (src/**/*.apitest.ts); the
# default `npm test` glob never matches them.
run npm run test:api

printf '\n==> npm pack --dry-run\n'
npm pack --dry-run

printf '\nPublish @geraschenko/clauctl %s with the packaged files listed above? [y/N] ' "$VERSION"
read -r answer
case "$answer" in
  y|Y|yes|YES)
    ;;
  *)
    echo "aborting release"
    exit 1
    ;;
esac

run npm publish
run git tag "v$VERSION"
run git push origin "v$VERSION"
