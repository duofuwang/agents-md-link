import fs from 'node:fs/promises';
import path from 'node:path';
import {
  TARGETS,
  TARGET_NAMES,
  detected,
  overridePath,
  rulesDirPath,
  sourcePath,
  targetPath,
} from './registry.js';
import { inspectTarget, pathKey } from './link.js';
import {
  contentEquals,
  formatBytes,
  hashText,
  isManagedCopy,
  isTemplateOnly,
  managedCopy,
  normalizeText,
  readIfExists,
  readText,
} from './io.js';

export const OK_STATES = new Set(['linked', 'hardlinked', 'copy-current']);
export const FAIL_STATES = new Set([
  'missing',
  'broken-link',
  'foreign-link',
  'detached',
  'unmanaged',
  'stale-copy',
  'empty',
  'source-missing',
  'error',
]);

export async function buildPlan({ home, config, selectedNames: selectedOverride }) {
  const sourceFile = sourcePath(home, config.source);
  const sourceRaw = await readIfExists(sourceFile);
  const sourceText = sourceRaw?.text ?? '';
  const sourceHash = sourceRaw ? hashText(sourceText) : null;
  const sourceIsTemplate = sourceRaw ? isTemplateOnly(sourceText) : true;
  const selected = new Set(
    selectedOverride ?? TARGET_NAMES.filter((name) => config.targets[name] === true),
  );

  const targets = [];
  for (const target of TARGETS) {
    const file = targetPath(home, target);
    const isSelected = selected.has(target.name);
    const isDetected = detected(home, target);
    const info = await inspectTarget(file, sourceFile);
    const entry = {
      name: target.name,
      label: target.label,
      relPath: target.relPath,
      path: file,
      selected: isSelected,
      detected: isDetected,
      kind: info.kind,
      state: 'not-selected',
      size: 0,
      sizeLabel: '0 B',
      hash: null,
      text: null,
      hasContent: Boolean(info.hasContent),
      shadowed: false,
      error: null,
    };

    if (info.kind === 'missing') {
      entry.state = isSelected ? 'missing' : 'not-selected';
    } else if (info.kind === 'symlink') {
      if (info.broken) entry.state = isSelected ? 'broken-link' : 'not-selected';
      else if (info.pointsToSource) entry.state = 'linked';
      else entry.state = isSelected ? 'foreign-link' : 'not-selected';
      if (sourceRaw) {
        entry.size = sourceRaw.size;
        entry.sizeLabel = formatBytes(sourceRaw.size);
      }
    } else if (info.kind === 'hardlink') {
      entry.state = 'hardlinked';
      if (sourceRaw) {
        entry.size = sourceRaw.size;
        entry.sizeLabel = formatBytes(sourceRaw.size);
      }
    } else if (info.kind === 'file') {
      try {
        const raw = await readText(file);
        entry.size = raw.size;
        entry.sizeLabel = formatBytes(raw.size);
        entry.hash = hashText(raw.text);
        entry.text = raw.text;
        entry.hasContent = normalizeText(raw.text).trim() !== '';
        if (!entry.hasContent) {
          entry.state = 'empty';
        } else if (isManagedCopy(raw.text)) {
          entry.state = contentEquals(raw.text, managedCopy(sourceText))
            ? 'copy-current'
            : 'stale-copy';
        } else if (sourceRaw && !sourceIsTemplate && contentEquals(raw.text, sourceText)) {
          entry.state = 'copy-current';
        } else if (!isSelected) {
          entry.state = 'unmanaged';
        } else if (!sourceRaw || sourceIsTemplate) {
          entry.state = 'source-missing';
        } else {
          entry.state = 'detached';
        }
      } catch (error) {
        entry.state = 'error';
        entry.error = error.message;
      }
    } else {
      entry.state = 'error';
      entry.error = 'Target is not a regular file or link';
    }

    if (target.overridePath) {
      const override = overridePath(home, target);
      const overrideRaw = await readIfExists(override);
      if (overrideRaw && normalizeText(overrideRaw.text).trim()) {
        entry.shadowed = true;
      }
    }

    targets.push(entry);
  }

  const additionalRules = await scanAdditionalRules({ home, sourceHash, sourceIsTemplate });
  const crossRead = buildCrossRead(targets);
  const warnings = [];

  for (const target of targets) {
    if (target.selected && target.shadowed) {
      warnings.push({
        type: 'shadowed',
        target: target.name,
        path: overridePath(home, TARGETS.find((item) => item.name === target.name)),
        message: 'Codex AGENTS.override.md is present; our AGENTS.md will be ignored',
      });
    }
  }
  for (const rule of additionalRules) {
    if (rule.duplicate) {
      warnings.push({
        type: 'duplicate-rule',
        path: rule.path,
        message: 'Extra rule file is identical to the shared source and will duplicate context',
      });
    } else if (rule.extra) {
      warnings.push({
        type: 'extra-source',
        path: rule.path,
        message: 'Qoder user AGENTS.md also has content and may be loaded in addition',
      });
    }
  }
  for (const item of crossRead) {
    if (item.duplicate) {
      warnings.push({
        type: 'duplicate-context',
        tool: item.tool,
        paths: item.paths,
        message: `${item.tool} reads the same content from multiple paths`,
      });
    }
  }
  if (sourceIsTemplate && selected.size > 0) {
    warnings.push({ type: 'source-template', message: 'Shared source is still an empty template; add some rules' });
  }

  const failures = targets.filter(
    (target) => target.selected && (FAIL_STATES.has(target.state) || target.shadowed),
  );

  return {
    home,
    sourceFile,
    source: {
      exists: Boolean(sourceRaw),
      size: sourceRaw?.size ?? 0,
      sizeLabel: formatBytes(sourceRaw?.size ?? 0),
      hash: sourceHash,
      text: sourceText,
      isTemplate: sourceIsTemplate,
    },
    selectedNames: [...selected],
    targets,
    additionalRules,
    crossRead,
    warnings,
    failures,
    installed: selected.size > 0,
  };
}

async function scanAdditionalRules({ home, sourceHash, sourceIsTemplate }) {
  if (!sourceHash || sourceIsTemplate) return [];
  const results = [];
  for (const target of TARGETS) {
    if (!target.rulesDir) continue;
    const directory = rulesDirPath(home, target);
    const managed = pathKey(targetPath(home, target));
    const files = await walkRuleFiles(directory, target.rulesGlob);
    for (const file of files) {
      if (pathKey(file) === managed) continue;
      try {
        const raw = await readText(file);
        results.push({
          tool: target.name,
          path: file,
          size: raw.size,
          duplicate: hashText(raw.text) === sourceHash,
        });
      } catch {
        results.push({ tool: target.name, path: file, size: 0, duplicate: false });
      }
    }
  }

  const qoderMain = path.join(home, '.qoder-cn', 'AGENTS.md');
  try {
    const raw = await readText(qoderMain);
    if (normalizeText(raw.text).trim()) {
      results.push({
        tool: 'qoder',
        path: qoderMain,
        size: raw.size,
        duplicate: hashText(raw.text) === sourceHash,
        extra: true,
      });
    }
  } catch {
    // ignore a missing file
  }

  return results;
}

async function walkRuleFiles(directory, pattern) {
  const output = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (matchesPattern(entry.name, pattern)) output.push(full);
      }
    }
  }
  await walk(directory);
  return output;
}

function matchesPattern(name, pattern) {
  if (pattern === '*.instructions.md') return name.endsWith('.instructions.md');
  if (pattern === '*.md') return name.endsWith('.md');
  return false;
}

function buildCrossRead(targets) {
  const byName = new Map(targets.map((target) => [target.name, target]));
  const installed = (target) =>
    target && (target.selected || OK_STATES.has(target.state));

  const result = [];
  const copilot = byName.get('copilot');
  if (copilot && (copilot.detected || copilot.selected)) {
    const paths = ['copilot', 'claude', 'gemini']
      .map((name) => byName.get(name))
      .filter(installed)
      .map((target) => target.path);
    if (paths.length) {
      result.push({
        tool: 'copilot',
        paths,
        duplicate: paths.length >= 2,
        note: 'The official client removes identical copies; verify with /instructions',
      });
    }
  }

  const opencode = byName.get('opencode');
  const claude = byName.get('claude');
  if (opencode && (opencode.detected || opencode.selected) && installed(claude)) {
    const paths = [claude.path];
    if (installed(opencode)) paths.push(opencode.path);
    result.push({
      tool: 'opencode',
      paths,
      duplicate: paths.length >= 2,
      note: 'Compatibility reads the Claude file; adding the OpenCode target duplicates it',
    });
  }
  return result;
}
