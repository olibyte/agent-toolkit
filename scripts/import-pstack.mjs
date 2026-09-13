#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ALLOWED_KEYS = new Set(['name', 'description', 'license'])
const SIBLING_DIRS = ['playbooks', 'scripts', 'references', 'assets']
const HOST_AGNOSTIC_REPLACES = [
  ['`subagent_type`: `generalPurpose`', "the host's general-purpose subagent"],
  ['- `readonly`: `true`', '- Do not write to the parent workspace'],
  ['Launch all reviewers in a single message using the Task tool.', 'Spawn all reviewers in one turn.'],
  ["the Task tool's error message", 'the spawn error'],
  ['`~/.cursor/rules/pstack-models.mdc`', 'the host configured-models file'],
  ['~/.cursor/rules/pstack-models.mdc', 'the host configured-models file'],
  ['.cursor/skills/', '.agents/skills/'],
  [
    'When a worker must start from a non-default pushed branch, pass `cloud_base_branch`.',
    'When a worker must start from a non-default pushed branch, pass that branch as the isolated workspace base when the host supports it.',
  ],
  [
    'Use `environment: "local"` only when the worker needs access to something on the user\'s computer.',
    'Use this machine only when the worker needs this computer.',
  ],
  ['subagent_type: "poteto-agent"', 'a poteto-mode subagent (read references/poteto-agent.md first)'],
  ['subagent_type: generalPurpose', "the host's general-purpose subagent"],
  ['only through the Task tool', 'only by spawning subagents'],
  ['the Task tool', 'subagent spawn'],
  [
    'the `deslop` skill from the `cursor-team-kit` plugin (`/deslop`)',
    'the `unslop` skill (or a host deslop skill if present)',
  ],
  ['/deslop', 'unslop'],
  [
    '`control-ui` or `control-cli` from `cursor-team-kit`',
    'the real UI or CLI surface (project verification skill if present)',
  ],
  [
    '`control-cli` or `control-ui` from `cursor-team-kit`',
    'the real UI or CLI surface (project verification skill if present)',
  ],
  [' (from `cursor-team-kit`)', ''],
  [' from `cursor-team-kit`', ''],
  ['from `cursor-team-kit`', ''],
  ['`control-ui` or `control-cli`', 'the real UI or CLI surface'],
  ['`control-cli` or `control-ui`', 'the real UI or CLI surface'],
  ['One Cursor cloud agent', 'One isolated subagent'],
  ['each a Cursor cloud agent', 'each an isolated subagent'],
  ['Cursor cloud agent', 'isolated subagent'],
  ['environment: "cloud"', 'an isolated workspace'],
  ["Cursor's built-in babysit skill", 'a host built-in babysit skill, if it has one'],
  ['a Cursor restart', 'an editor restart'],
  [
    'Before spawning investigators, list the available MCPs from the Cursor environment. Use the available-tools map when present. Otherwise inspect the `mcps/` directory Cursor exposes for enabled MCP servers.',
    "Before spawning investigators, list the host's available MCP servers. Use the available-tools map when present. Otherwise inspect whatever MCP listing the host exposes.",
  ],
  [
    "Don't glob across `~/.cursor/projects/*/`. That reads unrelated private chats.",
    "Don't glob across other projects' transcript dirs. That reads unrelated private chats.",
  ],
]
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_SKILLS_DIR = path.join(REPO_ROOT, 'skills')
const OPTIONAL_DIR = path.join(REPO_ROOT, 'optional')
const OPTIONAL_SKILLS_FILE = path.join(REPO_ROOT, 'scripts/optional-skills.txt')
const DEFAULT_PSTACK_SKILLS_FILE = path.join(REPO_ROOT, 'scripts/default-pstack-skills.txt')
const FORBIDDEN_PHRASES_FILE = path.join(REPO_ROOT, 'scripts/forbidden-host-phrases.txt')
const PRINCIPLE_LEAF_COUNT = 23
const PRINCIPLES_PACK_DESCRIPTION =
  'Apply named engineering principles such as laziness, prove-it-works, and model-the-domain. Use when choosing a design, sequencing work, reviewing a diff, or the user names a principle.'

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { from: null, skill: null, pack: null, out: null, check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') {
      out.check = true
      continue
    }
    if (arg === '--from' || arg === '--skill' || arg === '--pack' || arg === '--out') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) {
        fail(`missing value for ${arg}`)
      }
      if (arg === '--from') out.from = value
      else if (arg === '--skill') out.skill = value
      else if (arg === '--pack') out.pack = value
      else out.out = value
      continue
    }
    fail(`unknown flag: ${arg}`)
  }
  return out
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1)
  }
  return value
}

function parseFrontmatter(text, fileLabel) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/)
  if (!match) {
    fail(`missing YAML frontmatter: ${fileLabel}`)
  }
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const parsed = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/)
    if (!parsed) {
      fail(`cannot parse frontmatter line in ${fileLabel}: ${line}`)
    }
    fields[parsed[1]] = unquote(parsed[2])
  }
  return { fields, body: text.slice(match[0].length) }
}

function yamlScalar(value) {
  if (value === '' || /[#:]|^\s|\s$|['"`\\]/.test(value) || /^(true|false|null|~|\d)/i.test(value)) {
    return JSON.stringify(value)
  }
  return value
}

function mentionsInvocation(body, skillName) {
  return body.includes(`$${skillName}`)
}

function renderSkillMarkdown(skillName, fields, body) {
  const lines = ['---', `name: ${skillName}`]
  if (fields.description) {
    lines.push(`description: ${yamlScalar(fields.description)}`)
  }
  lines.push(`license: ${yamlScalar(fields.license || 'MIT')}`)
  lines.push('---')
  const front = lines.join('\n')
  if (!mentionsInvocation(body, skillName)) {
    const paragraph = `Codex \`$${skillName}\`. Claude Code, Cursor, and Antigravity \`/${skillName}\`.`
    return `${front}\n\n${paragraph}\n\n${body.replace(/^\r?\n/, '')}`
  }
  if (body.startsWith('\n') || body === '') {
    return `${front}${body}`
  }
  return `${front}\n${body}`
}

function copySiblingDirs(sourceSkillDir, destSkillDir) {
  for (const dir of SIBLING_DIRS) {
    const from = path.join(sourceSkillDir, dir)
    if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) continue
    fs.cpSync(from, path.join(destSkillDir, dir), { recursive: true })
  }
}

export function rewriteHostAgnosticMarkdown(text) {
  let out = text
  for (const [needle, replacement] of HOST_AGNOSTIC_REPLACES) {
    out = out.split(needle).join(replacement)
  }
  out = out.split("Use the **create-skill** skill (Cursor's built-in for authoring SKILL.md files)").join(
    'Author SKILL.md per the Agent Skills spec (name, description, progressive disclosure)',
  )
  out = out.split('`control-ui`').join('the real UI surface')
  out = out.split('`control-cli`').join('the real CLI surface')
  out = out.split('Bugbot or review-automation comments').join(
    'Bugbot or other automated review comments',
  )
  out = out.split(
    'the real surface the change touches (the real UI or CLI surface (project verification skill if present) as the change demands)',
  ).join('the real UI or CLI surface the change touches (project verification skill if present)')
  out = out.split(
    'the real surface (the real UI or CLI surface (project verification skill if present) as the change demands)',
  ).join('the real UI or CLI surface (project verification skill if present) as the change demands')
  out = out.split(
    'Always `an isolated workspace` unless the task needs this machine: the real UI or CLI surface runtime verification.',
  ).join(
    'Always use an isolated workspace unless the task needs this machine for real UI or CLI verification.',
  )
  out = out.split(
    'a host built-in babysit skill, if it has one for these requests, so do not route there',
  ).join('a host built-in babysit skill, if the host has one. Do not route there')
  out = out.split('Multiple `Task` calls').join('Multiple subagent spawns')
  out = out.split('a cloud-agent URL').join('a prior agent URL or transcript')
  out = out.split("subagent spawn's error message").join('the spawn error')
  out = out.split(
    'also run the **why** skill on the existing shape so the rationale becomes a constraint, not a guess.',
  ).join(
    'also run the **why** skill when that skill is in the catalog, so the rationale becomes a constraint, not a guess. Skip with reason if it is not installed.',
  )
  out = out.split(
    'Log the run via the **show-me-your-work** skill, one canonical TSV with a row per decision and per unit, evidence as links.',
  ).join(
    'Log the run via the **show-me-your-work** skill when that skill is in the catalog. Skip with reason if it is not installed; keep a local TSV instead.',
  )
  out = out.split(
    'with YAML frontmatter (`name: verify-<app>` and a `description` that names the app, the surface, and when to reach for it \u2014 without frontmatter the skill never registers) and these sections',
  ).join(
    'with YAML frontmatter. Required keys are `name: verify-<app>`, a `description` that names the app, the surface, and when to reach for it, and `license: MIT`. Without frontmatter the skill never registers. Claude Code also needs a matching `.claude/skills/verify-<app>` link. Include these sections',
  )
  out = out.replace(/ \( *\)/g, '')
  return out
}

function rewriteDestMarkdown(destSkillDir) {
  const stack = [destSkillDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name.endsWith('.md')) {
        fs.writeFileSync(full, rewriteHostAgnosticMarkdown(fs.readFileSync(full, 'utf8')))
      }
    }
  }
}

function outParent(outFlag, defaultDir = CATALOG_SKILLS_DIR) {
  return path.resolve(outFlag || defaultDir)
}

function isPublishedCatalog(outDir) {
  return path.resolve(outDir) === path.resolve(CATALOG_SKILLS_DIR)
}

function stripLeadingBlankLine(body) {
  return body.replace(/^\r?\n/, '')
}

function rewritePrincipleLinks(markdown) {
  return markdown.replace(/\]\(\.\.\/(principle-[a-z0-9-]+)\/SKILL\.md\)/g, ']($1.md)')
}

function firstAtxH1(body) {
  const match = body.match(/^# (.+)$/m)
  return match ? match[1].replace(/\r$/, '').trim() : ''
}

function listPrincipleLeaves(fromDir) {
  const names = []
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('principle-')) continue
    const skillFile = path.join(fromDir, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    names.push(entry.name)
  }
  names.sort()
  return names
}

function importSkill(fromDir, skillName, outFlag, options = {}) {
  if (!fromDir) fail('missing --from')
  if (!skillName) fail('missing --skill')

  const sourceSkillDir = path.resolve(fromDir, skillName)
  const sourceFile = path.join(sourceSkillDir, 'SKILL.md')
  if (!fs.existsSync(sourceFile)) {
    fail(`missing source: ${sourceFile}`)
  }

  const sourceText = fs.readFileSync(sourceFile, 'utf8')
  const { fields, body } = parseFrontmatter(sourceText, sourceFile)
  const destSkillDir = path.join(outParent(outFlag, options.parentDir ?? CATALOG_SKILLS_DIR), skillName)
  fs.mkdirSync(destSkillDir, { recursive: true })
  fs.writeFileSync(path.join(destSkillDir, 'SKILL.md'), renderSkillMarkdown(skillName, fields, body))
  copySiblingDirs(sourceSkillDir, destSkillDir)
  rewriteDestMarkdown(destSkillDir)
}

function renderPrinciplesSkill(leaves) {
  const lines = [
    '---',
    'name: principles',
    `description: ${yamlScalar(PRINCIPLES_PACK_DESCRIPTION)}`,
    'license: MIT',
    '---',
    '',
    'Codex `$principles`. Claude Code, Cursor, and Antigravity `/principles`.',
    '',
    '# Principles',
    '',
    'Read the matching file under `references/` in full before you apply a principle. Cite only files you read this session.',
    '',
    '## Index',
    '',
  ]
  for (const leaf of leaves) {
    lines.push(`- **${leaf.title}** (\`${leaf.folder}\`). ${leaf.description}`)
  }
  return `${lines.join('\n')}\n`
}

function importPrinciplesPack(fromDir, outFlag) {
  if (!fromDir) fail('missing --from')

  const sourceRoot = path.resolve(fromDir)
  if (!fs.existsSync(sourceRoot)) {
    fail(`missing source: ${sourceRoot}`)
  }

  const folders = listPrincipleLeaves(sourceRoot)
  const destSkillsDir = outParent(outFlag)
  if (isPublishedCatalog(destSkillsDir) && folders.length !== PRINCIPLE_LEAF_COUNT) {
    fail(`expected ${PRINCIPLE_LEAF_COUNT} principle-* leaves, found ${folders.length}`)
  }

  const destPackDir = path.join(destSkillsDir, 'principles')
  const referencesDir = path.join(destPackDir, 'references')
  fs.rmSync(referencesDir, { recursive: true, force: true })
  fs.mkdirSync(referencesDir, { recursive: true })

  const leaves = []
  for (const folder of folders) {
    const sourceFile = path.join(sourceRoot, folder, 'SKILL.md')
    const { fields, body } = parseFrontmatter(fs.readFileSync(sourceFile, 'utf8'), sourceFile)
    const markdown = rewritePrincipleLinks(stripLeadingBlankLine(body))
    fs.writeFileSync(path.join(referencesDir, `${folder}.md`), markdown)
    leaves.push({
      folder,
      title: firstAtxH1(markdown) || folder,
      description: fields.description || '',
    })
  }

  fs.writeFileSync(path.join(destPackDir, 'SKILL.md'), renderPrinciplesSkill(leaves))
}

function importOptionalPack(fromDir, outFlag) {
  if (!fromDir) fail('missing --from')
  for (const name of loadLines(OPTIONAL_SKILLS_FILE)) {
    importSkill(fromDir, name, outFlag, {
      parentDir: OPTIONAL_DIR,
      rewriteMarkdown: true,
    })
  }
}

function importDefaultPack(fromDir, outFlag) {
  if (!fromDir) fail('missing --from')
  for (const name of loadLines(DEFAULT_PSTACK_SKILLS_FILE)) {
    importSkill(fromDir, name, outFlag, {
      rewriteMarkdown: true,
    })
  }
}

function loadLines(file) {
  if (!fs.existsSync(file)) {
    fail(`missing ${path.relative(REPO_ROOT, file)}`)
  }
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function loadForbiddenPhrases() {
  return loadLines(FORBIDDEN_PHRASES_FILE)
}

function checkSkillFile(skillFile, folderName, forbidden) {
  const rel = path.relative(REPO_ROOT, skillFile)
  const text = fs.readFileSync(skillFile, 'utf8')
  const { fields } = parseFrontmatter(text, rel)
  let failed = false
  for (const key of Object.keys(fields)) {
    if (!ALLOWED_KEYS.has(key)) {
      console.error(`${rel}: ${key}`)
      failed = true
    }
  }
  if (fields.name !== folderName) {
    console.error(`${rel}: name`)
    failed = true
  }
  for (const phrase of forbidden) {
    if (text.includes(phrase)) {
      console.error(`${rel}: ${phrase}`)
      failed = true
    }
  }
  return failed
}

function checkCatalogDir(catalogDir, forbidden) {
  let failed = false
  for (const entry of fs.readdirSync(catalogDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(catalogDir, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    if (checkSkillFile(skillFile, entry.name, forbidden)) failed = true
  }
  return failed
}

function checkSkills() {
  if (!fs.existsSync(CATALOG_SKILLS_DIR)) {
    fail(`missing skills directory: ${CATALOG_SKILLS_DIR}`)
  }

  const forbidden = loadForbiddenPhrases()
  let failed = checkCatalogDir(CATALOG_SKILLS_DIR, forbidden)
  if (fs.existsSync(OPTIONAL_DIR)) {
    failed = checkCatalogDir(OPTIONAL_DIR, forbidden) || failed
  }
  if (failed) process.exit(1)
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2))
  if (args.pack && args.skill) {
    fail('--pack cannot combine with --skill')
  }
  if (args.check) {
    checkSkills()
  } else if (args.pack) {
    const importers = {
      principles: importPrinciplesPack,
      optional: importOptionalPack,
      default: importDefaultPack,
    }
    const importer = importers[args.pack]
    if (!importer) fail(`unknown pack: ${args.pack}`)
    importer(args.from, args.out)
  } else if (args.from || args.skill) {
    importSkill(args.from, args.skill, args.out)
  } else {
    fail('missing --from and --skill, or --from and --pack, or --check')
  }
}
