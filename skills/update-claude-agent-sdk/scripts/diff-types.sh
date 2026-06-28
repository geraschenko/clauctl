#!/usr/bin/env bash
set -euo pipefail

PACKAGE='@anthropic-ai/claude-agent-sdk'

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <old-version> <new-version> [output-dir]" >&2
  exit 2
fi

old_version=$1
new_version=$2
output_dir=${3:-$(mktemp -d "${TMPDIR:-/tmp}/claude-agent-sdk-diff.XXXXXX")}
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)

if [[ -e "$output_dir/old" || -e "$output_dir/new" ]]; then
  echo "output directory already contains old/ or new/: $output_dir" >&2
  exit 1
fi
mkdir "$output_dir/old" "$output_dir/new"

pack_and_extract() {
  local version=$1
  local destination=$2
  local archive_count
  local archive

  npm pack "$PACKAGE@$version" --pack-destination "$destination" --silent >/dev/null
  archive_count=$(find "$destination" -maxdepth 1 -type f -name '*.tgz' | wc -l | tr -d ' ')
  if [[ "$archive_count" != 1 ]]; then
    echo "expected one npm archive for $PACKAGE@$version, found $archive_count" >&2
    exit 1
  fi
  archive=$(find "$destination" -maxdepth 1 -type f -name '*.tgz' -print)
  tar -xzf "$archive" -C "$destination"
}

pack_and_extract "$old_version" "$output_dir/old"
pack_and_extract "$new_version" "$output_dir/new"

old_package="$output_dir/old/package"
new_package="$output_dir/new/package"
old_artifact_version=$(node -p \
  "require(process.argv[1]).version" "$old_package/package.json")
new_artifact_version=$(node -p \
  "require(process.argv[1]).version" "$new_package/package.json")

if [[ "$old_artifact_version" != "$old_version" ]]; then
  echo "old version is not exact: requested $old_version, packed $old_artifact_version" >&2
  exit 1
fi
if [[ "$new_artifact_version" != "$new_version" ]]; then
  echo "new version is not exact: requested $new_version, packed $new_artifact_version" >&2
  exit 1
fi

if [[ ! -f "$old_package/sdk.d.ts" || ! -f "$new_package/sdk.d.ts" ]]; then
  echo "one of the package versions does not contain sdk.d.ts" >&2
  exit 1
fi

diff_to_file() {
  local old_file=$1
  local new_file=$2
  local report=$3
  local status=0

  diff -u "$old_file" "$new_file" >"$report" || status=$?
  if [[ $status -gt 1 ]]; then
    return "$status"
  fi
}

append_diff() {
  local old_file=$1
  local new_file=$2
  local report=$3
  local status=0

  diff -u "$old_file" "$new_file" >>"$report" || status=$?
  if [[ $status -gt 1 ]]; then
    return "$status"
  fi
}

optional_diff() {
  local relative_path=$1
  local report=$2

  if [[ -f "$old_package/$relative_path" && -f "$new_package/$relative_path" ]]; then
    diff_to_file "$old_package/$relative_path" "$new_package/$relative_path" "$report"
  elif [[ -f "$old_package/$relative_path" ]]; then
    diff_to_file "$old_package/$relative_path" /dev/null "$report"
  elif [[ -f "$new_package/$relative_path" ]]; then
    diff_to_file /dev/null "$new_package/$relative_path" "$report"
  else
    printf 'Absent from both package versions: %s\n' "$relative_path" >"$report"
  fi
}

diff_to_file \
  "$old_package/sdk.d.ts" \
  "$new_package/sdk.d.ts" \
  "$output_dir/sdk.d.ts.diff"
optional_diff README.md "$output_dir/README.diff"
diff_to_file \
  "$old_package/package.json" \
  "$new_package/package.json" \
  "$output_dir/package-json.diff"
optional_diff manifest.json "$output_dir/manifest.diff"

find_declarations() {
  find . -type f \( \
    -name '*.d.ts' -o \
    -name '*.d.mts' -o \
    -name '*.d.cts' \
  \) -print | LC_ALL=C sort
}

(cd "$old_package" && find_declarations) >"$output_dir/old-types.list"
(cd "$new_package" && find_declarations) >"$output_dir/new-types.list"

other_types_report="$output_dir/other-types.diff"
printf '# Changed declarations other than sdk.d.ts: %s -> %s\n\n' \
  "$old_version" "$new_version" >"$other_types_report"
while IFS= read -r declaration; do
  if [[ "$declaration" == './sdk.d.ts' ]] || \
    { [[ -f "$old_package/$declaration" ]] && \
      [[ -f "$new_package/$declaration" ]] && \
      cmp -s "$old_package/$declaration" "$new_package/$declaration"; }; then
    continue
  fi
  printf '## %s\n' "$declaration" >>"$other_types_report"
  if [[ ! -f "$old_package/$declaration" ]]; then
    printf 'Added declaration file\n' >>"$other_types_report"
    append_diff /dev/null "$new_package/$declaration" "$other_types_report"
  elif [[ ! -f "$new_package/$declaration" ]]; then
    printf 'Removed declaration file\n' >>"$other_types_report"
    append_diff "$old_package/$declaration" /dev/null "$other_types_report"
  else
    append_diff \
      "$old_package/$declaration" \
      "$new_package/$declaration" \
      "$other_types_report"
  fi
  printf '\n' >>"$other_types_report"
done < <(
  cat "$output_dir/old-types.list" "$output_dir/new-types.list" |
    LC_ALL=C sort -u
)

printf 'SDK snapshots and reports: %s\n' "$output_dir"
printf 'Primary diff: %s\n' "$output_dir/sdk.d.ts.diff"
printf 'Other changed declarations: %s\n' "$output_dir/other-types.diff"
