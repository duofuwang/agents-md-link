import { existsSync } from 'node:fs';
import path from 'node:path';

export const SOURCE_DIR = '.agents';
export const SOURCE_FILE = 'AGENTS.md';
export const CONFIG_FILE = 'agents-link.json';
export const BACKUP_ROOT = path.join('.agents-md-link', 'backups');

export const TARGETS = [
  {
    name: 'claude',
    label: 'Claude Code',
    relPath: '.claude/CLAUDE.md',
    detectPath: '.claude',
    preselect: true,
    rulesDir: '.claude/rules',
    rulesGlob: '*.md',
    rulesRecursive: true,
  },
  {
    name: 'codex',
    label: 'Codex',
    relPath: '.codex/AGENTS.md',
    detectPath: '.codex',
    preselect: true,
    overridePath: '.codex/AGENTS.override.md',
  },
  {
    name: 'gemini',
    label: 'Gemini / Antigravity',
    relPath: '.gemini/GEMINI.md',
    detectPath: '.gemini',
    preselect: true,
  },
  {
    name: 'copilot',
    label: 'GitHub Copilot CLI',
    relPath: '.copilot/copilot-instructions.md',
    detectPath: '.copilot',
    preselect: true,
    rulesDir: '.copilot/instructions',
    rulesGlob: '*.instructions.md',
    rulesRecursive: true,
  },
  {
    name: 'qoder',
    label: 'Qoder CN',
    relPath: '.qoder-cn/rules/agents-md-link.md',
    detectPath: '.qoder-cn',
    preselect: true,
    rulesDir: '.qoder-cn/rules',
    rulesGlob: '*.md',
    rulesRecursive: true,
  },
  {
    name: 'opencode',
    label: 'OpenCode',
    relPath: '.config/opencode/AGENTS.md',
    detectPath: '.config/opencode',
    preselect: false,
  },
];

const ALIASES = new Map([
  ['claude-code', 'claude'],
  ['antigravity', 'gemini'],
  ['gemini-cli', 'gemini'],
  ['github-copilot', 'copilot'],
  ['gh-copilot', 'copilot'],
  ['qoder-cn', 'qoder'],
  ['open-code', 'opencode'],
]);

export const TARGET_NAMES = TARGETS.map((target) => target.name);

export function findTarget(name) {
  const normalized = String(name).trim().toLowerCase();
  const resolved = ALIASES.get(normalized) ?? normalized;
  return TARGETS.find((target) => target.name === resolved) ?? null;
}

export function targetPath(home, target) {
  return path.join(home, ...target.relPath.split('/'));
}

export function detected(home, target) {
  return existsSync(path.join(home, ...target.detectPath.split('/')));
}

export function sourcePath(home, sourceRelative = SOURCE_FILE) {
  if (path.isAbsolute(sourceRelative)) {
    throw new Error('source must be a relative path under ~/.agents');
  }
  const base = path.resolve(home, SOURCE_DIR);
  const resolved = path.resolve(base, sourceRelative);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('source must not escape ~/.agents');
  }
  return resolved;
}

export function configPath(home) {
  return path.join(home, SOURCE_DIR, CONFIG_FILE);
}

export function backupRoot(home) {
  return path.join(home, BACKUP_ROOT);
}

export function rulesDirPath(home, target) {
  return path.join(home, ...target.rulesDir.split('/'));
}

export function overridePath(home, target) {
  return target.overridePath ? path.join(home, ...target.overridePath.split('/')) : null;
}

export function resolveTargetList(input) {
  if (input === undefined || input === null) return null;
  const raw = Array.isArray(input) ? input : String(input).split(/[\s,]+/);
  const names = [];
  for (const item of raw) {
    const token = item.trim();
    if (!token) continue;
    if (token === '*') {
      return [...TARGET_NAMES];
    }
    const target = findTarget(token);
    if (!target) {
      throw new Error(`Unknown target: ${token}. Supported: ${TARGET_NAMES.join(', ')}`);
    }
    if (!names.includes(target.name)) names.push(target.name);
  }
  return names;
}

export function defaultCheckedNames(home, config, hasConfig) {
  return TARGETS.filter((target) => {
    if (hasConfig) return config.targets[target.name] === true;
    return target.preselect && detected(home, target);
  }).map((target) => target.name);
}
