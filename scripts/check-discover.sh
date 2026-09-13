#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

listing_skill_names() {
  printf '%s\n' "$1" | sed -n 's/^│    \([A-Za-z0-9_-][A-Za-z0-9_-]*\)$/\1/p'
}

output="$(npx --yes skills@latest add "$ROOT" --list 2>&1)"
default_names="$(listing_skill_names "$output")"

while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  if ! printf '%s\n' "$default_names" | grep -Fxq -- "$name"; then
    printf '%s\n' "$output" >&2
    echo "check-discover: expected skill name $name in listing" >&2
    exit 1
  fi
done < "$ROOT/scripts/expected-skills.txt"

while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  if printf '%s\n' "$default_names" | grep -Fxq -- "$name"; then
    printf '%s\n' "$output" >&2
    echo "check-discover: optional skill $name leaked into default listing" >&2
    exit 1
  fi
done < "$ROOT/scripts/optional-skills.txt"

set +e
full_output="$(npx --yes skills@latest add "$ROOT" --list --full-depth 2>&1)"
full_status=$?
set -e
if [[ $full_status -ne 0 ]] || printf '%s\n' "$full_output" | grep -Eqi 'unknown option|unknown flag|unrecognized'; then
  printf '%s\n' "$full_output" >&2
  echo "check-discover: --full-depth failed" >&2
  exit 1
fi

full_names="$(listing_skill_names "$full_output")"
while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  if ! printf '%s\n' "$full_names" | grep -Fxq -- "$name"; then
    printf '%s\n' "$full_output" >&2
    echo "check-discover: expected optional skill $name in --full-depth listing" >&2
    exit 1
  fi
done < "$ROOT/scripts/optional-skills.txt"

printf '%s\n' "$output"
