#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_DEST="$ROOT/skills/fake-skill"
PSTACK_SKILLS="/Users/oliverbennett/.cursor/plugins/cache/cursor-public/pstack/68d834d9ca8f34c375ecb8057bfbcde5396a01f8/skills"
TMP=""

cleanup() {
  local status=$?
  rm -rf "$FAKE_DEST"
  if [[ -n "$TMP" ]]; then
    rm -rf "$TMP"
  fi
  if [[ -e "$FAKE_DEST" ]]; then
    echo "cleanup did not remove skills/fake-skill" >&2
    exit 1
  fi
  if [[ -e "$ROOT/skills/principle-aaa" || -e "$ROOT/skills/principle-bbb" ]]; then
    echo "fixture principle dirs left in skills/" >&2
    exit 1
  fi
  while IFS= read -r name || [[ -n "$name" ]]; do
    [[ -z "$name" ]] && continue
    if [[ -e "$ROOT/skills/$name" ]]; then
      echo "optional skill leaked into skills/$name" >&2
      exit 1
    fi
  done < "$ROOT/scripts/optional-skills.txt"
  exit "$status"
}
trap cleanup EXIT

TMP="$(mktemp -d)"
mkdir -p "$TMP/fake-skill"
cat > "$TMP/fake-skill/SKILL.md" <<'EOF'
---
name: Wrong
description: A fixture.
disable-model-invocation: true
icon: x
---

Fixture body.
EOF

node "$ROOT/scripts/import-pstack.mjs" --from "$TMP" --skill fake-skill

DEST="$FAKE_DEST/SKILL.md"
grep -q 'name: fake-skill' "$DEST"
grep -q 'license:' "$DEST"
if grep -q 'disable-model-invocation' "$DEST"; then
  echo "dest still contains disable-model-invocation" >&2
  exit 1
fi
if grep -q 'icon' "$DEST"; then
  echo "dest still contains icon" >&2
  exit 1
fi

node "$ROOT/scripts/import-pstack.mjs" --check

rm -rf "$FAKE_DEST"
if [[ -e "$FAKE_DEST" ]]; then
  echo "cleanup did not remove skills/fake-skill" >&2
  exit 1
fi

mkdir -p "$TMP/pack/principle-aaa" "$TMP/pack/principle-bbb"
cat > "$TMP/pack/principle-aaa/SKILL.md" <<'EOF'
---
name: Wrong
description: Aaa fixture.
disable-model-invocation: true
icon: x
---

# Aaa Title

See [Bbb Title](../principle-bbb/SKILL.md).
EOF
cat > "$TMP/pack/principle-bbb/SKILL.md" <<'EOF'
---
name: Wrong
description: Bbb fixture.
disable-model-invocation: true
icon: x
---

# Bbb Title

Bbb body.
EOF

node "$ROOT/scripts/import-pstack.mjs" --from "$TMP/pack" --pack principles --out "$TMP/out"

PACK_SKILL="$TMP/out/principles/SKILL.md"
grep -q 'name: principles' "$PACK_SKILL"
if grep -q 'disable-model-invocation' "$PACK_SKILL"; then
  echo "pack SKILL.md still contains disable-model-invocation" >&2
  exit 1
fi
if [[ ! -f "$TMP/out/principles/references/principle-aaa.md" ]]; then
  echo "missing principle-aaa reference" >&2
  exit 1
fi
if [[ ! -f "$TMP/out/principles/references/principle-bbb.md" ]]; then
  echo "missing principle-bbb reference" >&2
  exit 1
fi
if grep -q '^---' "$TMP/out/principles/references/principle-aaa.md"; then
  echo "principle-aaa reference has frontmatter" >&2
  exit 1
fi
if grep -q '../principle-bbb/SKILL.md' "$TMP/out/principles/references/principle-aaa.md"; then
  echo "principle-aaa still points at pstack SKILL.md path" >&2
  exit 1
fi
if ! grep -q '](principle-bbb.md)' "$TMP/out/principles/references/principle-aaa.md"; then
  echo "principle-aaa did not rewrite sibling link" >&2
  exit 1
fi
if grep -q '^---' "$TMP/out/principles/references/principle-bbb.md"; then
  echo "principle-bbb reference has frontmatter" >&2
  exit 1
fi
grep -q 'principle-aaa' "$PACK_SKILL"
grep -q 'principle-bbb' "$PACK_SKILL"
if [[ -e "$TMP/out/principle-aaa" ]]; then
  echo "principle-aaa is a sibling of principles under --out" >&2
  exit 1
fi

node "$ROOT/scripts/import-pstack.mjs" --from "$PSTACK_SKILLS" --pack principles

shopt -s nullglob
references=("$ROOT/skills/principles/references"/principle-*.md)
if [[ ${#references[@]} -ne 23 ]]; then
  echo "expected 23 principle-*.md files, found ${#references[@]}" >&2
  exit 1
fi
siblings=("$ROOT/skills"/principle-*)
if [[ ${#siblings[@]} -ne 0 ]]; then
  echo "found top-level skills/principle-* directory" >&2
  exit 1
fi

mkdir -p "$TMP/src-host/host-poison"
cat > "$TMP/src-host/host-poison/SKILL.md" <<'EOF'
---
name: host-poison
description: Fixture.
---

Uses subagent_type on purpose.
EOF

node "$ROOT/scripts/import-pstack.mjs" --from "$TMP/src-host" --skill host-poison --out "$TMP/out-host"
if ! grep -Fq subagent_type "$TMP/out-host/host-poison/SKILL.md"; then
  echo "isolated fixture lost subagent_type" >&2
  exit 1
fi

mkdir -p "$TMP/src-poteto/poteto-mode/playbooks" "$TMP/src-poteto/poteto-mode/references"
cat > "$TMP/src-poteto/poteto-mode/SKILL.md" <<'EOF'
---
name: poteto-mode
description: Fixture.
---

Fixture body for $poteto-mode.
subagent_type: generalPurpose
EOF
cat > "$TMP/src-poteto/poteto-mode/playbooks/sample.md" <<'EOF'
subagent_type: "poteto-agent"
subagent_type: generalPurpose
only through the Task tool
the Task tool
the `deslop` skill from the `cursor-team-kit` plugin (`/deslop`)
run `/deslop` leftover
`control-ui` or `control-cli` from `cursor-team-kit`
keep this from `cursor-team-kit` gone
`control-ui` or `control-cli` leftover pair
One Cursor cloud agent
each a Cursor cloud agent
Cursor cloud agent
environment: "cloud"
Cursor's built-in babysit skill
after a Cursor restart
use `origin pr ...` for view
    - indented survivor
Use `arena runners` from ~/.cursor/rules/pstack-models.mdc when present. Otherwise default to one each on `claude-fable-5-1-thinking-max`, `gpt-5.6-sol-max`, `grok-4.6-fast-xhigh`, `claude-opus-5-thinking-xhigh`. Spawn more when the arena covers multiple design directions. Same model N times when the work is generation-bound rather than judgment-sensitive.
using your configured feature model (default `grok-4.6-fast-xhigh`)
Ten lanes on `grok-4.6-fast-xhigh` at the PR head
EOF
cat > "$TMP/src-poteto/poteto-mode/references/bugbot-triage.md" <<'EOF'
Use this when Bugbot or review-automation comments arrive.
EOF

node "$ROOT/scripts/import-pstack.mjs" --from "$TMP/src-poteto" --skill poteto-mode --out "$TMP/out-poteto"

SAMPLE="$TMP/out-poteto/poteto-mode/playbooks/sample.md"
if [[ ! -f "$SAMPLE" ]]; then
  echo "poteto-mode playbook was not copied" >&2
  exit 1
fi
if grep -Fq 'subagent_type' "$SAMPLE"; then
  echo "poteto-mode playbook still has subagent_type" >&2
  exit 1
fi
if grep -Fq 'the Task tool' "$SAMPLE"; then
  echo "poteto-mode playbook still has the Task tool" >&2
  exit 1
fi
if grep -Fq 'cursor-team-kit' "$SAMPLE"; then
  echo "poteto-mode playbook still has cursor-team-kit" >&2
  exit 1
fi
if grep -Fq '/deslop' "$SAMPLE"; then
  echo "poteto-mode playbook still has /deslop" >&2
  exit 1
fi
if grep -Fq 'Cursor cloud' "$SAMPLE"; then
  echo "poteto-mode playbook still has Cursor cloud" >&2
  exit 1
fi
if grep -Fq 'environment: "cloud"' "$SAMPLE"; then
  echo "poteto-mode playbook still has environment: cloud" >&2
  exit 1
fi
if grep -Fq "Cursor's built-in babysit" "$SAMPLE"; then
  echo "poteto-mode playbook still has Cursor babysit" >&2
  exit 1
fi
if grep -Fq 'Cursor restart' "$SAMPLE"; then
  echo "poteto-mode playbook still has Cursor restart" >&2
  exit 1
fi
grep -q 'a poteto-mode subagent (read references/poteto-agent.md first)' "$SAMPLE"
grep -q "the host's general-purpose subagent" "$SAMPLE"
grep -q 'only by spawning subagents' "$SAMPLE"
grep -q 'the `unslop` skill (or a host deslop skill if present)' "$SAMPLE"
grep -q 'One isolated subagent' "$SAMPLE"
grep -q 'each an isolated subagent' "$SAMPLE"
grep -q 'an isolated workspace' "$SAMPLE"
grep -q 'a host built-in babysit skill, if it has one' "$SAMPLE"
grep -q 'an editor restart' "$SAMPLE"
if ! grep -Fq 'origin pr ...' "$SAMPLE"; then
  echo "rewrite ate spaces in origin pr ellipsis" >&2
  exit 1
fi
if ! grep -Fq '    - indented survivor' "$SAMPLE"; then
  echo "rewrite collapsed markdown indent" >&2
  exit 1
fi
if ! grep -Fq 'Bugbot or other automated review comments' "$TMP/out-poteto/poteto-mode/references/bugbot-triage.md"; then
  echo "bugbot-triage did not broaden reviewer wording" >&2
  exit 1
fi
if grep -Fq 'subagent_type' "$TMP/out-poteto/poteto-mode/SKILL.md"; then
  echo "poteto-mode SKILL.md still has subagent_type" >&2
  exit 1
fi
if grep -Fq 'claude-fable-' "$SAMPLE" || grep -Fq 'grok-4.6-' "$SAMPLE" || grep -Fq 'pstack-models.mdc' "$SAMPLE"; then
  echo "poteto-mode playbook still has a hardcoded model slug" >&2
  exit 1
fi
grep -q '.agents/models.md' "$SAMPLE"
grep -q 'spawn 3 candidates with no model' "$SAMPLE"
grep -q 'Ten lanes at the PR head' "$SAMPLE"
grep -q 'using your configured feature model' "$SAMPLE"
if grep -Fq '(default ' "$SAMPLE"; then
  echo "poteto-mode playbook still has a default model parenthetical" >&2
  exit 1
fi

node "$ROOT/scripts/import-pstack.mjs" --check

while IFS= read -r phrase || [[ -n "$phrase" ]]; do
  [[ -z "$phrase" ]] && continue
  if grep -Fq -- "$phrase" "$ROOT/skills/how/SKILL.md" "$ROOT/skills/no-comments/SKILL.md"; then
    echo "forbidden host phrase in published catalog: $phrase" >&2
    exit 1
  fi
done < "$ROOT/scripts/forbidden-host-phrases.txt"

mkdir -p "$TMP/src-default"
while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  mkdir -p "$TMP/src-default/$name"
  cat > "$TMP/src-default/$name/SKILL.md" <<EOF
---
name: Wrong
description: ${name} fixture.
disable-model-invocation: true
icon: x
---

Fixture body for ${name}.
EOF
done < "$ROOT/scripts/default-pstack-skills.txt"

cat > "$TMP/src-default/why/SKILL.md" <<'EOF'
---
name: Wrong
description: why fixture.
disable-model-invocation: true
icon: x
---

Before spawning investigators, list the available MCPs from the Cursor environment. Use the available-tools map when present. Otherwise inspect the `mcps/` directory Cursor exposes for enabled MCP servers.
EOF

cat > "$TMP/src-default/show-me-your-work/SKILL.md" <<'EOF'
---
name: Wrong
description: show-me-your-work fixture.
disable-model-invocation: true
icon: x
---

Don't glob across `~/.cursor/projects/*/`. That reads unrelated private chats.
EOF

why_catalog=""
if [[ -f "$ROOT/skills/why/SKILL.md" ]]; then
  why_catalog="$(cksum "$ROOT/skills/why/SKILL.md")"
fi

node "$ROOT/scripts/import-pstack.mjs" --from "$TMP/src-default" --pack default --out "$TMP/out-default"

if [[ ! -f "$TMP/out-default/why/SKILL.md" ]]; then
  echo "default fixture dest is not --out parent" >&2
  exit 1
fi
if [[ -d "$TMP/out-default/skills" ]]; then
  echo "default fixture wrote under --out/skills" >&2
  exit 1
fi
if [[ -z "$why_catalog" && -e "$ROOT/skills/why" ]]; then
  echo "default fixture wrote skills/why" >&2
  exit 1
fi
if [[ -n "$why_catalog" && "$(cksum "$ROOT/skills/why/SKILL.md")" != "$why_catalog" ]]; then
  echo "default fixture mutated skills/why" >&2
  exit 1
fi

while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  dest="$TMP/out-default/$name/SKILL.md"
  if [[ ! -f "$dest" ]]; then
    echo "missing default fixture dest $dest" >&2
    exit 1
  fi
  grep -q "name: $name" "$dest"
  grep -q 'license:' "$dest"
  if grep -q 'disable-model-invocation' "$dest"; then
    echo "$name fixture still contains disable-model-invocation" >&2
    exit 1
  fi
done < "$ROOT/scripts/default-pstack-skills.txt"

if grep -Fq 'Cursor environment' "$TMP/out-default/why/SKILL.md"; then
  echo "default why fixture still has Cursor environment" >&2
  exit 1
fi
if grep -Fq '`mcps/` directory Cursor' "$TMP/out-default/why/SKILL.md"; then
  echo "default why fixture still has Cursor mcps directory" >&2
  exit 1
fi
grep -q "the host's available MCP servers" "$TMP/out-default/why/SKILL.md"
if grep -Fq '~/.cursor/projects' "$TMP/out-default/show-me-your-work/SKILL.md"; then
  echo "default show-me-your-work fixture still has ~/.cursor/projects" >&2
  exit 1
fi
grep -q "other projects' transcript dirs" "$TMP/out-default/show-me-your-work/SKILL.md"

node "$ROOT/scripts/import-pstack.mjs" --from "$PSTACK_SKILLS" --pack default

while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  dest="$ROOT/skills/$name/SKILL.md"
  if [[ ! -f "$dest" ]]; then
    echo "missing skills/$name/SKILL.md" >&2
    exit 1
  fi
  grep -q "name: $name" "$dest"
  grep -q 'license:' "$dest"
  if ! grep -Fq "Codex \`\$$name\`" "$dest"; then
    echo "$name missing Codex invocation paragraph" >&2
    exit 1
  fi
done < "$ROOT/scripts/default-pstack-skills.txt"

if [[ ! -d "$ROOT/skills/why/references" ]]; then
  echo "missing why references/" >&2
  exit 1
fi
if [[ ! -f "$ROOT/skills/show-me-your-work/scripts/log.sh" ]]; then
  echo "missing show-me-your-work scripts/log.sh" >&2
  exit 1
fi
if [[ ! -d "$ROOT/skills/architect/references" ]]; then
  echo "missing architect references/" >&2
  exit 1
fi
if [[ -e "$ROOT/optional/architect" ]]; then
  echo "optional/architect still exists after default pack move" >&2
  exit 1
fi
if [[ -e "$ROOT/optional/arena" ]]; then
  echo "optional/arena still exists after default pack move" >&2
  exit 1
fi

default_skill_files=()
while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  default_skill_files+=("$ROOT/skills/$name/SKILL.md")
done < "$ROOT/scripts/default-pstack-skills.txt"

while IFS= read -r phrase || [[ -n "$phrase" ]]; do
  [[ -z "$phrase" ]] && continue
  if grep -Fq -- "$phrase" "${default_skill_files[@]}"; then
    echo "forbidden host phrase in default pack: $phrase" >&2
    exit 1
  fi
done < "$ROOT/scripts/forbidden-host-phrases.txt"

if grep -Fq 'Cursor environment' "$ROOT/skills/why/SKILL.md"; then
  echo "why still has Cursor environment" >&2
  exit 1
fi
if grep -Fq '`mcps/` directory Cursor' "$ROOT/skills/why/SKILL.md"; then
  echo "why still has Cursor mcps directory" >&2
  exit 1
fi
if grep -Fq '~/.cursor/projects' "$ROOT/skills/show-me-your-work/SKILL.md"; then
  echo "show-me-your-work still has ~/.cursor/projects" >&2
  exit 1
fi

mkdir -p "$TMP/src-optional"
while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  mkdir -p "$TMP/src-optional/$name"
  cat > "$TMP/src-optional/$name/SKILL.md" <<EOF
---
name: Wrong
description: ${name} fixture.
disable-model-invocation: true
icon: x
---

Fixture body for ${name}.
EOF
done < "$ROOT/scripts/optional-skills.txt"

cat > "$TMP/src-optional/swarm/SKILL.md" <<'EOF'
---
name: Wrong
description: swarm fixture.
disable-model-invocation: true
icon: x
---

Uses subagent_type: generalPurpose and ~/.cursor/rules/pstack-models.mdc
EOF

cat > "$TMP/src-optional/create-verification-skill/SKILL.md" <<'EOF'
---
name: Wrong
description: create-verification-skill fixture.
disable-model-invocation: true
icon: x
---

Write to .cursor/skills/verify-app/
EOF

node "$ROOT/scripts/import-pstack.mjs" --from "$TMP/src-optional" --pack optional --out "$TMP/out-optional"

if [[ ! -f "$TMP/out-optional/swarm/SKILL.md" ]]; then
  echo "optional fixture dest is not --out parent" >&2
  exit 1
fi
if [[ -d "$TMP/out-optional/skills" ]]; then
  echo "optional fixture wrote under --out/skills" >&2
  exit 1
fi
if [[ -e "$ROOT/skills/swarm" ]]; then
  echo "optional fixture wrote skills/swarm" >&2
  exit 1
fi

while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  dest="$TMP/out-optional/$name/SKILL.md"
  if [[ ! -f "$dest" ]]; then
    echo "missing optional fixture dest $dest" >&2
    exit 1
  fi
  grep -q "name: $name" "$dest"
  grep -q 'license:' "$dest"
  if grep -q 'disable-model-invocation' "$dest"; then
    echo "$name fixture still contains disable-model-invocation" >&2
    exit 1
  fi
done < "$ROOT/scripts/optional-skills.txt"

if grep -Fq 'subagent_type' "$TMP/out-optional/swarm/SKILL.md"; then
  echo "optional swarm fixture still has subagent_type" >&2
  exit 1
fi
if grep -Fq '.cursor/skills/' "$TMP/out-optional/create-verification-skill/SKILL.md"; then
  echo "optional create-verification-skill fixture still has .cursor/skills/" >&2
  exit 1
fi
grep -q '.agents/models.md' "$TMP/out-optional/swarm/SKILL.md"
grep -q '.agents/skills/' "$TMP/out-optional/create-verification-skill/SKILL.md"

node "$ROOT/scripts/import-pstack.mjs" --from "$PSTACK_SKILLS" --pack optional

while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  if [[ ! -f "$ROOT/optional/$name/SKILL.md" ]]; then
    echo "missing optional/$name/SKILL.md" >&2
    exit 1
  fi
  if [[ -e "$ROOT/skills/$name" ]]; then
    echo "optional skill $name also exists under skills/" >&2
    exit 1
  fi
done < "$ROOT/scripts/optional-skills.txt"

if [[ ! -d "$ROOT/optional/interrogate/references" ]]; then
  echo "missing interrogate references/" >&2
  exit 1
fi
if [[ ! -d "$ROOT/optional/create-verification-skill/references/feature-map-example" ]]; then
  echo "missing create-verification-skill references/feature-map-example/" >&2
  exit 1
fi
if ! grep -Fq 'Codex `$arena`' "$ROOT/skills/arena/SKILL.md"; then
  echo "arena missing Codex invocation paragraph" >&2
  exit 1
fi
if ! grep -Fq 'Codex `$architect`' "$ROOT/skills/architect/SKILL.md"; then
  echo "architect missing Codex invocation paragraph" >&2
  exit 1
fi
if grep -Fq '`readonly`: `true`' "$ROOT/optional/interrogate/SKILL.md"; then
  echo "interrogate still has readonly true" >&2
  exit 1
fi

node "$ROOT/scripts/import-pstack.mjs" --check

optional_skill_files=()
while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  optional_skill_files+=("$ROOT/optional/$name/SKILL.md")
done < "$ROOT/scripts/optional-skills.txt"

while IFS= read -r phrase || [[ -n "$phrase" ]]; do
  [[ -z "$phrase" ]] && continue
  if grep -Fq -- "$phrase" "${optional_skill_files[@]}"; then
    echo "forbidden host phrase in optional pack: $phrase" >&2
    exit 1
  fi
done < "$ROOT/scripts/forbidden-host-phrases.txt"

listing_skill_names() {
  printf '%s\n' "$1" | sed -n 's/^│    \([A-Za-z0-9_-][A-Za-z0-9_-]*\)$/\1/p'
}

default_list="$(npx --yes skills@latest add "$ROOT" --list 2>&1)"
default_names="$(listing_skill_names "$default_list")"
while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  if ! printf '%s\n' "$default_names" | grep -Fxq -- "$name"; then
    printf '%s\n' "$default_list" >&2
    echo "discover: expected $name in default listing" >&2
    exit 1
  fi
done < "$ROOT/scripts/expected-skills.txt"
while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  if printf '%s\n' "$default_names" | grep -Fxq -- "$name"; then
    printf '%s\n' "$default_list" >&2
    echo "discover: optional skill $name leaked into default listing" >&2
    exit 1
  fi
done < "$ROOT/scripts/optional-skills.txt"

set +e
full_list="$(npx --yes skills@latest add "$ROOT" --list --full-depth 2>&1)"
full_status=$?
set -e
if [[ $full_status -ne 0 ]] || printf '%s\n' "$full_list" | grep -Eqi 'unknown option|unknown flag|unrecognized'; then
  printf '%s\n' "$full_list" >&2
  echo "discover: --full-depth failed" >&2
  exit 1
fi
full_names="$(listing_skill_names "$full_list")"
while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  if ! printf '%s\n' "$full_names" | grep -Fxq -- "$name"; then
    printf '%s\n' "$full_list" >&2
    echo "discover: expected optional skill $name in --full-depth listing" >&2
    exit 1
  fi
done < "$ROOT/scripts/optional-skills.txt"
while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" ]] && continue
  if ! printf '%s\n' "$full_names" | grep -Fxq -- "$name"; then
    printf '%s\n' "$full_list" >&2
    echo "discover: expected default skill $name in --full-depth listing" >&2
    exit 1
  fi
done < "$ROOT/scripts/default-pstack-skills.txt"
