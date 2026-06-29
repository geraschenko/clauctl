#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/setup-worktree.sh [--replace]

Symlink generated/local development artifacts from the primary clauctl worktree
into the current worktree. This keeps secondary worktrees usable without
running npm install or rebuilding common outputs.

Linked by default:
  node_modules
  dist

Set CLAUCTL_WORKTREE_LINKS="node_modules dist other-path" to override the list.

Options:
  --replace   Remove an existing file/dir/symlink before creating each link.
EOF
}

replace=false
while (($#)); do
  case "$1" in
    --replace)
      replace=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

current_root=$(git rev-parse --show-toplevel)
primary_root=$(
  git worktree list --porcelain |
    awk '
      /^worktree / { path = substr($0, 10); bare = 0 }
      /^bare$/ { bare = 1 }
      /^$/ { if (!bare && path != "") { print path; exit } }
      END { if (!bare && path != "") print path }
    ' |
    head -n 1
)

if [[ -z "${primary_root:-}" ]]; then
  echo "could not find primary worktree" >&2
  exit 1
fi

if [[ "$current_root" == "$primary_root" ]]; then
  echo "already in primary worktree: $current_root"
  exit 0
fi

links=${CLAUCTL_WORKTREE_LINKS:-"node_modules dist"}

for relpath in $links; do
  source_path="$primary_root/$relpath"
  target_path="$current_root/$relpath"

  if [[ ! -e "$source_path" && ! -L "$source_path" ]]; then
    echo "skip $relpath: source does not exist in primary worktree" >&2
    continue
  fi

  if [[ -e "$target_path" || -L "$target_path" ]]; then
    if [[ "$replace" == true ]]; then
      rm -rf "$target_path"
    else
      echo "skip $relpath: target exists (use --replace)" >&2
      continue
    fi
  fi

  mkdir -p "$(dirname "$target_path")"
  ln -s "$source_path" "$target_path"
  echo "linked $relpath -> $source_path"
done
