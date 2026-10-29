import {
  CONFIG_FILE,
  TARGET_NAMES,
  configPath,
  findTarget,
  sourcePath,
} from './registry.js';
import { readIfExists, writeTextAtomic } from './io.js';

export const LINK_MODES = ['auto', 'symlink', 'hardlink', 'copy'];

export const DEFAULT_CONFIG = {
  version: 1,
  source: 'AGENTS.md',
  link: 'auto',
};

export async function loadConfig(home) {
  const file = configPath(home);
  const raw = await readIfExists(file);
  if (!raw) {
    return {
      file,
      exists: false,
      config: { ...DEFAULT_CONFIG, targets: Object.fromEntries(TARGET_NAMES.map((name) => [name, false])) },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.text);
  } catch (error) {
    throw new Error(`Config is not valid JSON: ${file}\n${error.message}`);
  }
  const config = validateConfig(parsed, file);
  return { file, exists: true, config };
}

export function validateConfig(value, file = CONFIG_FILE) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} must be a JSON object`);
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new Error(`${file} version must be 1`);
  }
  const source = value.source ?? DEFAULT_CONFIG.source;
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error(`${file} source must be a non-empty string`);
  }
  const link = value.link ?? DEFAULT_CONFIG.link;
  if (!LINK_MODES.includes(link)) {
    throw new Error(`${file} link must be one of ${LINK_MODES.join(', ')}`);
  }
  if (value.targets !== undefined && (typeof value.targets !== 'object' || value.targets === null || Array.isArray(value.targets))) {
    throw new Error(`${file} targets must be an object`);
  }
  const targets = Object.fromEntries(TARGET_NAMES.map((name) => [name, false]));
  for (const [name, enabled] of Object.entries(value.targets ?? {})) {
    const target = findTarget(name);
    if (!target) throw new Error(`${file} contains unknown target: ${name}`);
    if (typeof enabled !== 'boolean') throw new Error(`${file} targets.${name} must be true/false`);
    targets[target.name] = enabled;
  }
  const config = { version: 1, source: source.trim(), link, targets };
  for (const key of Object.keys(value)) {
    if (!['version', 'source', 'link', 'targets'].includes(key)) {
      throw new Error(`${file} contains unknown field: ${key}`);
    }
  }
  return config;
}

export async function saveConfig(home, config) {
  const file = configPath(home);
  const ordered = {
    version: 1,
    source: config.source,
    link: config.link,
    targets: Object.fromEntries(TARGET_NAMES.map((name) => [name, config.targets[name] === true])),
  };
  await writeTextAtomic(file, `${JSON.stringify(ordered, null, 2)}\n`);
  return file;
}

export function selectedNames(config) {
  return TARGET_NAMES.filter((name) => config.targets[name] === true);
}

export function withSelected(config, names) {
  const next = { ...config, targets: { ...config.targets } };
  for (const name of names) {
    const target = findTarget(name);
    if (!target) throw new Error(`Unknown target: ${name}`);
    next.targets[target.name] = true;
  }
  return next;
}

export function withoutSelected(config, names) {
  const next = { ...config, targets: { ...config.targets } };
  for (const name of names) {
    const target = findTarget(name);
    if (!target) throw new Error(`Unknown target: ${name}`);
    next.targets[target.name] = false;
  }
  return next;
}

export function sourceAbsolute(home, config) {
  return sourcePath(home, config.source);
}
