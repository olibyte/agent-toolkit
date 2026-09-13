#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

output="$(npx --yes skills@latest add "$ROOT" --list 2>&1)"

if ! printf '%s\n' "$output" | grep -q 'handoff'; then
  printf '%s\n' "$output" >&2
  echo "check-discover: expected skill name handoff in listing" >&2
  exit 1
fi

printf '%s\n' "$output"
