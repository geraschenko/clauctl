#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/claude-tools/tool-costs.sh [schemas.json]

Print a table of per-tool context cost from a captured tool-schemas.json:
name, whether the tool is deferred, and the UTF-8 byte size of its
description and input_schema.

Sizes are measured on compact JSON, so they approximate rather than match
the bytes the API sees.

Defaults to tool-schemas.json alongside this script.
EOF
}

case "${1:-}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

if (($# > 1)); then
  echo "unexpected arguments: ${*:2}" >&2
  usage >&2
  exit 2
fi

schemas=${1:-"$(dirname "${BASH_SOURCE[0]}")/tool-schemas.json"}

if [[ ! -f "$schemas" ]]; then
  echo "no such file: $schemas" >&2
  exit 1
fi

jq -r '
  ["NAME", "DEFER", "DESC_B", "SCHEMA_B", "TOTAL_B"],
  (.tools[]
    | (.description | utf8bytelength) as $desc
    | (.input_schema | tojson | utf8bytelength) as $schema
    # defer_loading is absent, not false, on eagerly loaded tools.
    | [.name, (.defer_loading // false | tostring), $desc, $schema, $desc + $schema])
  | @tsv
' "$schemas" | column -t

