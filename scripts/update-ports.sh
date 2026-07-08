#!/usr/bin/env bash
# Update the pi-coding-agent ports in src/tui/components/.
#
# Usage: scripts/update-ports.sh <old-tag> <new-tag>
#   old-tag: the pi tag the ports currently track (the "@ <version>" in each
#            file header, with a leading "v", e.g. v0.80.2-fork.2)
#   new-tag: the pi tag to migrate to
#
# For each ported file this copies the upstream file at both tags into a temp
# directory, formats both with this repo's prettier (so formatting noise
# cancels out), and applies the old→new diff to our port. Conflicts are left
# as .rej files next to the port for manual resolution — our intentional
# diffs are listed in each file's header comment.
#
# The pi repo is read via $PI_REPO (default: ~/git/earendil-works/pi).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PI_REPO="${PI_REPO:-$HOME/git/earendil-works/pi}"
PRETTIER="$REPO_ROOT/node_modules/.bin/prettier"

# ours (repo-relative) -> upstream (pi-repo-relative), colon-separated.
UPSTREAM_COMPONENTS="packages/coding-agent/src/modes/interactive/components"
PORTS=(
  "src/tui/components/assistant-message.ts:$UPSTREAM_COMPONENTS/assistant-message.ts"
  "src/tui/components/user-message.ts:$UPSTREAM_COMPONENTS/user-message.ts"
  "src/tui/components/tool-execution.ts:$UPSTREAM_COMPONENTS/tool-execution.ts"
)

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <old-tag> <new-tag>" >&2
  exit 1
fi
OLD_TAG="$1"
NEW_TAG="$2"
OLD_VERSION="${OLD_TAG#v}"
NEW_VERSION="${NEW_TAG#v}"

WORKDIR="$(mktemp -d /tmp/update-ports.XXXXXX)"
mkdir -p "$WORKDIR/old" "$WORKDIR/new"
echo "workdir: $WORKDIR"

status=0
for port in "${PORTS[@]}"; do
  ours="${port%%:*}"
  upstream="${port#*:}"
  name="$(basename "$ours")"

  git -C "$PI_REPO" show "$OLD_TAG:$upstream" > "$WORKDIR/old/$name"
  git -C "$PI_REPO" show "$NEW_TAG:$upstream" > "$WORKDIR/new/$name"
  "$PRETTIER" --log-level warn --write "$WORKDIR/old/$name" "$WORKDIR/new/$name"

  if diff -u "$WORKDIR/old/$name" "$WORKDIR/new/$name" > "$WORKDIR/$name.patch"; then
    echo "$ours: no upstream change"
    continue
  fi

  if patch --no-backup-if-mismatch "$REPO_ROOT/$ours" "$WORKDIR/$name.patch"; then
    echo "$ours: updated"
  else
    echo "$ours: CONFLICTS — resolve $ours.rej by hand" >&2
    status=1
  fi
  sed -i "s/@ $OLD_VERSION/@ $NEW_VERSION/" "$REPO_ROOT/$ours"
done

echo
echo "next: resolve any .rej files, then run treefmt and the presubmit."
exit "$status"
