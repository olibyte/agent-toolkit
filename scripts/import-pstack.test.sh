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

node "$ROOT/scripts/import-pstack.mjs" --check

while IFS= read -r phrase || [[ -n "$phrase" ]]; do
  [[ -z "$phrase" ]] && continue
  if grep -Fq -- "$phrase" "$ROOT/skills/how/SKILL.md" "$ROOT/skills/no-comments/SKILL.md"; then
    echo "forbidden host phrase in published catalog: $phrase" >&2
    exit 1
  fi
done < "$ROOT/scripts/forbidden-host-phrases.txt"
