# Agent instructions

This project uses Agent Skills from `.agents/skills/`. Claude Code also needs matching links under `.claude/skills/`.

Invoke `handoff` before you switch coding agents. Codex: `$handoff`. Claude Code, Cursor, and Antigravity: `/handoff`.

## Models

Subagents read `.agents/models.md` when that file exists. A missing file means inherit the current chat model. Values `inherit` and `auto` mean the same. Do not hardcode a vendor model name in a skill.

## Project

Add project-specific rules below this heading.
