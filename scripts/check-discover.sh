#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

output="$(npx --yes skills@latest add "$ROOT" --list 2>&1)"

while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  if ! printf '%s\n' "$output" | grep -Fq -- "$name"; then
    printf '%s\n' "$output" >&2
    echo "check-discover: expected skill name $name in listing" >&2
    exit 1
  fi
done < "$ROOT/scripts/expected-skills.txt"

printf '%s\n' "$output"
