import fs from 'node:fs/promises';
import path from 'node:path';
import {
  TARGETS,
  TARGET_NAMES,
  backupRoot,
  resolveTargetList,
  targetPath,
} from './registry.js';
import {
  LINK_MODES,
  loadConfig,
  saveConfig,
  selectedNames,
  withSelected,
  withoutSelected,
} from './config.js';
import {
  copyFile,
  exists,
  formatBytes,
  hashText,
  isManagedCopy,
  isTemplateOnly,
  managedCopy,
  normalizeText,
  readIfExists,
  readText,
  sanitizeSegment,
  stripManagedCopy,
  templateSource,
  timestamp,
  writeTextAtomic,
  writeTextInPlace,
} from './io.js';
import {
  createLink,
  inspectTarget,
  removeTarget,
  symlinkCapability,
} from './link.js';
import { buildPlan, OK_STATES } from './plan.js';

export function displayPath(home, file) {
  const relative = path.relative(home, file);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join('/')}`;
  }
  return file;
}

function targetByName(name) {
  return TARGETS.find((target) => target.name === name);
}

function createBackupSession(home) {
  let directory = null;
  async function ensureDirectory() {
    if (!directory) {
      directory = path.join(backupRoot(home), `${timestamp()}-${process.pid}`);
      await fs.mkdir(directory, { recursive: true });
    }
    return directory;
  }
  return {
    async backup(file, label) {
      let info;
      try {
        info = await fs.stat(file);
      } catch {
        return null;
      }
      if (info.isFile() && info.size === 0) return null;
      const dir = await ensureDirectory();
      const base = sanitizeSegment(label || path.basename(file));
      let destination = path.join(dir, base);
      let index = 2;
      while (await exists(destination)) {
        destination = path.join(dir, `${base}-${index}`);
        index += 1;
      }
      try {
        await copyFile(file, destination);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      return destination;
    },
    get path() {
      return directory;
    },
  };
}

function fail(failures, name, reason) {
  failures.push({ name, reason });
}

async function resolveMode({ config, flags, prompter, interactive, askFallback = true }) {
  let mode = flags.mode || config.link || 'auto';
  if (!LINK_MODES.includes(mode)) {
    throw new Error(`Unknown link mode: ${mode}`);
  }
  if (mode === 'auto') {
    if (await symlinkCapability()) return 'auto';
    if (interactive && askFallback) {
      const choice = await prompter.choose(
        'Symlinks are unavailable (Developer Mode is off). Hardlinks can break when an editor saves atomically.',
        ['Continue with hardlinks (recommended)', 'Use copies', 'Cancel'],
        0,
      );
      if (choice === 0) return 'hardlink';
      if (choice === 1) return 'copy';
      return null;
    }
    return 'hardlink';
  }
  if ((mode === 'symlink' || mode === 'hardlink') && !(await symlinkCapability())) {
    if (mode === 'hardlink') return mode;
    if (interactive && askFallback) {
      const choice = await prompter.choose(
        'Symlinks are unavailable (Developer Mode is off).',
        ['Use hardlinks', 'Use copies', 'Cancel'],
        0,
      );
      if (choice === 0) return 'hardlink';
      if (choice === 1) return 'copy';
      return null;
    }
    throw new Error('Symlinks are unavailable. Enable Developer Mode, or use --mode hardlink / copy');
  }
  return mode;
}

function createKind(mode) {
  if (mode === 'auto') return 'auto';
  if (mode === 'symlink') return 'symlink';
  return 'hardlink';
}

function actionLabel(action) {
  if (action.action === 'keep') return 'up to date';
  if (action.action === 'skip') return 'skip';
  if (action.action === 'copy') return action.backup ? 'backup + write copy' : 'write copy';
  return action.backup ? 'backup + relink' : 'link';
}

function summarize({ home, sourceFile, sourceChanged, actions, mode }) {
  const lines = [];
  lines.push(sourceChanged ? `Source: update ${displayPath(home, sourceFile)}` : `Source: ${displayPath(home, sourceFile)}`);
  for (const [name, action] of actions) {
    const target = targetByName(name);
    if (!target) continue;
    lines.push(
      `  ${name.padEnd(9)} ${actionLabel(action).padEnd(14)} ${displayPath(home, targetPath(home, target))}`,
    );
  }
  return lines.join('\n');
}

async function prepareRemove({ home, entry, action, sourceFile, sourceText, session }) {
  const current = await inspectTarget(entry.path, sourceFile);
  if (current.kind === 'missing') return;
  if (current.kind === 'symlink') {
    if (action.backup && !current.pointsToSource) {
      await session.backup(entry.path, `${entry.name}-${path.basename(entry.path)}`);
    }
    await removeTarget(entry.path);
    return;
  }
  if (current.kind === 'hardlink') {
    await removeTarget(entry.path);
    return;
  }
  if (current.kind === 'file') {
    const raw = await readIfExists(entry.path);
    const text = raw?.text ?? '';
    const hasContent = normalizeText(text).trim() !== '';
    if (action.backup && hasContent) {
      await session.backup(entry.path, `${entry.name}-${path.basename(entry.path)}`);
    } else if (
      hasContent &&
      !isManagedCopy(text) &&
      !contentEqualsSafe(text, sourceText)
    ) {
      throw new Error('Target has independent content and no backup; refusing to overwrite');
    }
    await removeTarget(entry.path);
    return;
  }
  throw new Error('Target is not a regular file or link');
}

function contentEqualsSafe(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return hashText(a) === hashText(b);
}

async function materialize({ entry, action, sourceFile, sourceText, mode }) {
  await prepareRemove({ entry, action, sourceFile, sourceText, session: action.session });
  if (action.action === 'copy') {
    await writeTextAtomic(entry.path, managedCopy(sourceText));
    return 'copy';
  }
  const result = await createLink(sourceFile, entry.path, createKind(mode));
  return result.type;
}

function groupCandidates(candidates) {
  const groups = new Map();
  for (const entry of candidates) {
    const hash = hashText(entry.text ?? '');
    if (!groups.has(hash)) groups.set(hash, { text: entry.text ?? '', items: [] });
    groups.get(hash).items.push(entry);
  }
  return [...groups.values()];
}

function appendCandidates(home, candidates) {
  const seen = new Set();
  const parts = [];
  for (const entry of candidates) {
    const hash = hashText(entry.text ?? '');
    if (seen.has(hash)) continue;
    seen.add(hash);
    parts.push(`<!-- migrated from ${displayPath(home, entry.path)} -->\n${stripManagedCopy(entry.text ?? '').trim()}`);
  }
  return `${parts.join('\n\n')}\n`;
}

async function planInstallActions({ home, plan, flags, prompter, interactive, mode }) {
  const selected = plan.targets.filter((target) => target.selected);
  const actions = new Map();
  const failures = [];
  const skipped = new Set();
  let sourceText = plan.source.text;
  let sourceChanged = false;

  const realSource = plan.source.exists && !plan.source.isTemplate;
  const candidates = selected.filter(
    (entry) => entry.kind === 'file' && entry.hasContent && !OK_STATES.has(entry.state),
  );
  const included = new Set();

  if (!realSource) {
    if (flags.from) {
      const raw = await readText(flags.from);
      sourceText = stripManagedCopy(raw.text);
      sourceChanged = true;
    } else if (candidates.length === 0) {
      if (!plan.source.exists) {
        sourceText = templateSource();
        sourceChanged = true;
      } else {
        sourceText = plan.source.text;
      }
    } else if (flags.appendOthers) {
      sourceText = appendCandidates(home, candidates);
      sourceChanged = true;
      for (const entry of candidates) included.add(entry.name);
    } else {
      const groups = groupCandidates(candidates);
      if (groups.length === 1) {
        const base = groups[0];
        if (!flags.adopt && !flags.force) {
          if (interactive) {
            const ok = await prompter.confirm(
              `Detected content in ${displayPath(home, base.items[0].path)}. Use it as the shared source?`,
              true,
            );
            if (!ok) {
              sourceText = templateSource();
              sourceChanged = true;
              for (const entry of candidates) {
                skipped.add(entry.name);
                actions.set(entry.name, { action: 'skip', backup: false });
                fail(failures, entry.name, 'user declined migration');
              }
            }
          } else {
            throw new Error('Detected existing content. Non-interactive mode requires --adopt or --from.');
          }
        }
        if (!skipped.size) {
          sourceText = stripManagedCopy(base.text);
          sourceChanged = true;
          for (const entry of base.items) included.add(entry.name);
        }
      } else if (interactive) {
        const options = groups.map(
          (group) =>
            `${displayPath(home, group.items[0].path)}  ${formatBytes(group.items[0].size)}`,
        );
        options.push('Exit and merge manually');
        const choice = await prompter.choose('Found multiple files with different content:', options, 0);
        if (choice === groups.length) return { aborted: true };
        sourceText = stripManagedCopy(groups[choice].text);
        sourceChanged = true;
        for (const entry of groups[choice].items) included.add(entry.name);
      } else {
        throw new Error(
          `Found ${groups.length} groups with different content. Use --from <path> to pick a base, or merge manually.`,
        );
      }
    }
  } else if (flags.from) {
    const raw = await readText(flags.from);
    sourceText = stripManagedCopy(raw.text);
    sourceChanged = true;
  } else if (flags.appendOthers && candidates.length > 0) {
    sourceText = `${normalizeText(plan.source.text).trimEnd()}\n\n${appendCandidates(home, candidates)}`;
    sourceChanged = true;
    for (const entry of candidates) included.add(entry.name);
  }

  for (const entry of selected) {
    if (skipped.has(entry.name)) continue;
    if (included.has(entry.name)) {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
      continue;
    }
    const state = entry.state;
    const sameAsSource =
      entry.kind === 'file' && entry.text !== null && contentEqualsSafe(entry.text, sourceText);

    if (state === 'linked' || state === 'hardlinked') {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'keep', backup: false });
      continue;
    }
    if (state === 'copy-current') {
      const action = mode === 'copy' && !isManagedCopy(entry.text ?? '') ? 'copy' : mode === 'copy' ? 'keep' : 'link';
      actions.set(entry.name, { action, backup: false });
      continue;
    }
    if (state === 'stale-copy') {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
      continue;
    }
    if (state === 'missing' || state === 'broken-link' || state === 'empty') {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: false });
      continue;
    }
    if (state === 'error') {
      actions.set(entry.name, { action: 'skip', backup: false });
      fail(failures, entry.name, entry.error || 'Failed to read target');
      continue;
    }
    if (state === 'foreign-link') {
      if (flags.force || flags.adopt) {
        actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
      } else if (interactive) {
        const choice = await prompter.choose(
          `${displayPath(home, entry.path)} is a link to another location:`,
          ['Back up the linked content and replace', 'Skip'],
          1,
        );
        if (choice === 0) {
          actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
        } else {
          actions.set(entry.name, { action: 'skip', backup: false });
          fail(failures, entry.name, 'foreign link, skipped');
        }
      } else {
        actions.set(entry.name, { action: 'skip', backup: false });
        fail(failures, entry.name, 'foreign link, requires --force');
      }
      continue;
    }

    if (sameAsSource) {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: false });
      continue;
    }
    if (state === 'not-selected') continue;

    if (flags.force || flags.adopt) {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
      continue;
    }
    if (interactive) {
      const options = ['Back up and replace with the source', 'Skip this target'];
      if (entry.text && !isManagedCopy(entry.text)) options.push('Use this target as the source');
      const choice = await prompter.choose(
        `${displayPath(home, entry.path)} has content that differs from the source:`,
        options,
        0,
      );
      if (choice === 0) {
        actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
      } else if (choice === 1) {
        actions.set(entry.name, { action: 'skip', backup: false });
        fail(failures, entry.name, 'user skipped');
      } else {
        sourceText = entry.text;
        sourceChanged = true;
        actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: false });
      }
      continue;
    }

    actions.set(entry.name, { action: 'skip', backup: false });
    fail(failures, entry.name, 'content differs from the source; use --adopt or --force');
  }

  if (sourceChanged) {
    for (const entry of selected) {
      const action = actions.get(entry.name);
      if (
        action &&
        action.action === 'keep' &&
        (entry.state === 'copy-current' || entry.state === 'stale-copy') &&
        isManagedCopy(entry.text ?? '')
      ) {
        actions.set(entry.name, { action: 'copy', backup: false });
      }
    }
  }

  for (const entry of selected) {
    if (!actions.has(entry.name)) {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: false });
    }
  }

  return { sourceText, sourceChanged, actions, failures };
}

export async function runInstall({ home, flags, prompter }) {
  const interactive = Boolean(prompter) && !flags.yes && !flags.dryRun && !flags.json;
  const loaded = await loadConfig(home);
  const basePlan = await buildPlan({ home, config: loaded.config });
  const alreadySelected = new Set(selectedNames(loaded.config));

  let requested;
  if (flags.all) {
    requested = [...TARGET_NAMES];
  } else if (flags.targets) {
    requested = resolveTargetList(flags.targets);
  } else if (interactive) {
    const checked = basePlan.targets.map((entry) => {
      if (alreadySelected.has(entry.name)) return true;
      const target = targetByName(entry.name);
      return !loaded.exists && target.preselect && entry.detected;
    });
    const selected = await prompter.selectTargets({
      targets: basePlan.targets,
      checked,
      lockedNames: alreadySelected,
      title: 'Select tools to install',
    });
    if (!selected) {
      console.log('Cancelled; nothing changed.');
      return { exitCode: 0 };
    }
    requested = basePlan.targets.filter((entry, index) => selected[index]).map((entry) => entry.name);
  } else {
    throw new Error('Non-interactive install requires -a/--targets or --all, plus --yes');
  }

  const effective = [...new Set([...alreadySelected, ...requested])];
  if (effective.length === 0) {
    console.log('No targets selected; nothing changed.');
    return { exitCode: 0 };
  }
  const config = withSelected(loaded.config, effective);
  const plan = await buildPlan({ home, config, selectedNames: effective });
  const mode = await resolveMode({ config, flags, prompter, interactive });
  if (mode === null) {
    console.log('Cancelled.');
    return { exitCode: 0 };
  }

  const planned = await planInstallActions({
    home,
    plan,
    flags,
    prompter,
    interactive,
    mode,
  });
  if (planned.aborted) {
    console.log('Aborted; no files changed.');
    return { exitCode: 1 };
  }

  const { sourceText, sourceChanged, actions, failures } = planned;
  const summary = summarize({ home, sourceFile: plan.sourceFile, sourceChanged, actions, mode });
  if (!flags.json) {
    console.log(`\n${summary}`);
    for (const warning of plan.warnings) {
      if (warning.type === 'source-template' && sourceChanged && !isTemplateOnly(sourceText)) continue;
      console.log(`  Warning: ${warning.message}${warning.path ? `: ${displayPath(home, warning.path)}` : ''}`);
    }
  }

  const hasChanges =
    sourceChanged ||
    [...actions.values()].some((action) => action.action === 'link' || action.action === 'copy' || action.action === 'skip');
  if (!hasChanges && failures.length === 0) {
    if (!loaded.exists) {
      await saveConfig(home, flags.mode ? { ...config, link: flags.mode } : config);
    }
    if (flags.json) {
      console.log(JSON.stringify({ command: 'install', status: 'up-to-date', source: plan.sourceFile }, null, 2));
    } else {
    console.log('Up to date.');
    }
    return { exitCode: 0 };
  }

  if (flags.dryRun) {
    const result = {
      command: 'install',
      source: displayPath(home, plan.sourceFile),
      sourceChanged,
      targets: [...actions].map(([name, action]) => ({ name, ...action })),
      failures,
      mode,
      dryRun: true,
    };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    return { exitCode: failures.length ? 1 : 0, result };
  }

  if (interactive) {
    const ok = await prompter.confirm('Execute?', true);
    if (!ok) {
      console.log('Cancelled; no files changed.');
      return { exitCode: 0 };
    }
  }

  const session = createBackupSession(home);
  if (sourceChanged) {
    const sourceRaw = await readIfExists(plan.sourceFile);
    if (sourceRaw && normalizeText(sourceRaw.text).trim() && !isTemplateOnly(sourceRaw.text)) {
      await session.backup(plan.sourceFile, 'source-AGENTS.md');
    }
    await writeTextInPlace(plan.sourceFile, sourceText);
  }

  const results = [];
  for (const [name, action] of actions) {
    const entry = plan.targets.find((item) => item.name === name);
    if (!entry) continue;
    if (action.action === 'keep' || action.action === 'skip') {
      results.push({ name, result: action.action, path: entry.path });
      continue;
    }
    try {
      const actual = await materialize({
        entry,
        action: { ...action, session },
        sourceFile: plan.sourceFile,
        sourceText,
        mode,
      });
      results.push({ name, result: actual, path: entry.path });
    } catch (error) {
      fail(failures, name, error.message);
      results.push({ name, result: 'failed', path: entry.path, error: error.message });
    }
  }

  const configFile = await saveConfig(home, flags.mode ? { ...config, link: flags.mode } : config);
  const skipped = [...actions.values()].filter((action) => action.action === 'skip').length;
  const result = { source: plan.sourceFile, sourceChanged, results, failures, mode };
  if (flags.json) {
    console.log(JSON.stringify({ command: 'install', ...result }, null, 2));
  } else {
    console.log('\nDone:');
    for (const item of results) {
      console.log(`  ${item.name.padEnd(9)} ${String(item.result).padEnd(11)} ${displayPath(home, item.path)}`);
    }
    console.log(`  Config: ${displayPath(home, configFile)}`);
    if (session.path) console.log(`  Backup: ${session.path}`);
    if (failures.length) {
      console.log('\nIncomplete:');
      for (const item of failures) console.log(`  ${item.name}: ${item.reason}`);
    }
  }
  return {
    exitCode: failures.length || skipped ? 1 : 0,
    result,
  };
}

export async function runStatus({ home, flags }) {
  const loaded = await loadConfig(home);
  const plan = await buildPlan({ home, config: loaded.config });
  if (!loaded.exists && !plan.source.exists && selectedNames(loaded.config).length === 0) {
    if (flags.json) {
      console.log(JSON.stringify({ command: 'status', installed: false, home }, null, 2));
    } else {
      console.log('Not installed. Run agents-md-link install.');
    }
    return { exitCode: 0 };
  }

  const selected = plan.targets.filter((target) => target.selected);
  if (!flags.json) {
    console.log(`\nUser  ${displayPath(home, plan.sourceFile)}  ${plan.source.sizeLabel}${plan.source.isTemplate ? ' (empty template)' : ''}`);
    for (const target of plan.targets) {
      const suffix = target.shadowed ? '  (shadowed)' : '';
      const state = target.selected ? target.state : target.state === 'linked' || target.state === 'hardlinked' ? `${target.state} (unselected)` : 'not selected';
      console.log(`  ${target.name.padEnd(9)} ${String(state).padEnd(22)} ${displayPath(home, target.path)}${suffix}`);
    }

    if (plan.additionalRules.length) {
      console.log('\nExtra rules (unmanaged):');
      for (const rule of plan.additionalRules) {
        console.log(`  ${displayPath(home, rule.path)}${rule.duplicate ? '  [same as source]' : ''}`);
      }
    }
    if (plan.crossRead.length) {
      console.log('\nCross-reads:');
      for (const item of plan.crossRead) {
        console.log(`  ${item.tool}`);
        for (const file of item.paths) console.log(`    → ${displayPath(home, file)}`);
        if (item.note) console.log(`    ${item.note}`);
      }
    }
    if (plan.warnings.length) {
      console.log('\nWarnings:');
      for (const warning of plan.warnings) console.log(`  ${warning.message}${warning.path ? `：${displayPath(home, warning.path)}` : ''}`);
    }
  }

  const ok = plan.failures.length === 0 && !(plan.source.exists === false && selected.length > 0);
  if (flags.json) {
    const result = {
      command: 'status',
      home,
      source: plan.sourceFile,
      sourceExists: plan.source.exists,
      sourceTemplate: plan.source.isTemplate,
      targets: plan.targets.map((target) => ({
        name: target.name,
        path: target.path,
        selected: target.selected,
        detected: target.detected,
        state: target.state,
        shadowed: target.shadowed,
      })),
      additionalRules: plan.additionalRules,
      crossRead: plan.crossRead,
      warnings: plan.warnings,
      ok,
    };
    console.log(JSON.stringify(result, null, 2));
  }
  return { exitCode: ok ? 0 : 1, result: plan };
}

export async function runSync({ home, flags, prompter }) {
  const interactive = Boolean(prompter) && !flags.yes && !flags.dryRun;
  const loaded = await loadConfig(home);
  if (!loaded.exists || selectedNames(loaded.config).length === 0) {
    console.log('No targets installed. Run agents-md-link install first.');
    return { exitCode: 0 };
  }
  const config = loaded.config;
  const plan = await buildPlan({ home, config });
  if (!plan.source.exists) {
    console.error(`Source not found: ${displayPath(home, plan.sourceFile)}. Run agents-md-link install first.`);
    return { exitCode: 1 };
  }
  const mode = await resolveMode({ config, flags, prompter, interactive, askFallback: false });
  if (mode === null) return { exitCode: 0 };

  const actions = new Map();
  const failures = [];
  const selected = plan.targets.filter((target) => target.selected);
  const sourceText = plan.source.text;

  for (const entry of selected) {
    const sameAsSource =
      entry.kind === 'file' && entry.text !== null && contentEqualsSafe(entry.text, sourceText);
    if (entry.shadowed) {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: false });
      fail(failures, entry.name, 'AGENTS.override.md shadows this target');
      continue;
    }
    if (entry.state === 'linked' || entry.state === 'hardlinked') {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'keep', backup: false });
    } else if (entry.state === 'copy-current') {
      actions.set(entry.name, { action: mode === 'copy' ? 'keep' : 'link', backup: false });
    } else if (entry.state === 'stale-copy') {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
    } else if (entry.state === 'missing' || entry.state === 'broken-link' || entry.state === 'empty') {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: false });
    } else if (entry.state === 'error') {
      actions.set(entry.name, { action: 'skip', backup: false });
      fail(failures, entry.name, entry.error || 'Failed to read target');
    } else if (sameAsSource) {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: false });
    } else if (entry.state === 'foreign-link') {
      if (flags.force) {
        actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
      } else if (interactive) {
        const choice = await prompter.choose(
          `${displayPath(home, entry.path)} is a link to another location:`,
          ['Back up the linked content and replace', 'Skip'],
          1,
        );
        if (choice === 0) actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
        else {
          actions.set(entry.name, { action: 'skip', backup: false });
          fail(failures, entry.name, 'foreign link, skipped');
        }
      } else {
        actions.set(entry.name, { action: 'skip', backup: false });
        fail(failures, entry.name, 'foreign link, requires --force');
      }
    } else if (flags.relink || flags.force) {
      actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
    } else if (interactive) {
      const choice = await prompter.choose(
        `${displayPath(home, entry.path)} differs from the source:`,
        ['Back up and relink', 'Skip'],
        0,
      );
      if (choice === 0) actions.set(entry.name, { action: mode === 'copy' ? 'copy' : 'link', backup: true });
      else {
        actions.set(entry.name, { action: 'skip', backup: false });
        fail(failures, entry.name, 'user skipped');
      }
    } else {
      actions.set(entry.name, { action: 'skip', backup: false });
      fail(failures, entry.name, 'content differs from the source; use --relink or --force');
    }
  }

  console.log(`\n${summarize({ home, sourceFile: plan.sourceFile, sourceChanged: false, actions, mode })}`);
  const hasChanges = [...actions.values()].some((action) => action.action !== 'keep' && action.action !== 'skip');
  if (!hasChanges && failures.length === 0) {
    console.log('Up to date.');
    return { exitCode: 0 };
  }
  if (flags.dryRun) return { exitCode: failures.length ? 1 : 0 };
  if (interactive) {
    const ok = await prompter.confirm('Execute?', true);
    if (!ok) return { exitCode: 0 };
  }

  const session = createBackupSession(home);
  const results = [];
  for (const [name, action] of actions) {
    const entry = plan.targets.find((item) => item.name === name);
    if (!entry) continue;
    if (action.action === 'keep' || action.action === 'skip') {
      results.push({ name, result: action.action, path: entry.path });
      continue;
    }
    try {
      const actual = await materialize({
        entry,
        action: { ...action, session },
        sourceFile: plan.sourceFile,
        sourceText,
        mode,
      });
      results.push({ name, result: actual, path: entry.path });
    } catch (error) {
      fail(failures, name, error.message);
      results.push({ name, result: 'failed', path: entry.path, error: error.message });
    }
  }

  console.log('\nDone:');
  for (const item of results) {
    console.log(`  ${item.name.padEnd(9)} ${String(item.result).padEnd(11)} ${displayPath(home, item.path)}`);
  }
  if (session.path) console.log(`  Backup: ${session.path}`);
  if (failures.length) {
    console.log('\nIncomplete:');
    for (const item of failures) console.log(`  ${item.name}: ${item.reason}`);
  }
  return { exitCode: failures.length ? 1 : 0, result: { results, failures, mode } };
}

export async function runUninstall({ home, flags, prompter }) {
  const interactive = Boolean(prompter) && !flags.yes && !flags.dryRun;
  const loaded = await loadConfig(home);
  const selected = selectedNames(loaded.config);
  if (selected.length === 0) {
    console.log('No targets installed.');
    return { exitCode: 0 };
  }

  let names;
  if (flags.all) {
    names = selected;
  } else if (flags.targets) {
    names = resolveTargetList(flags.targets).filter((name) => selected.includes(name));
  } else if (interactive) {
    const plan = await buildPlan({ home, config: loaded.config });
    const entries = plan.targets.filter((target) => target.selected);
    const checked = entries.map(() => false);
    const chosen = await prompter.selectTargets({
      targets: entries,
      checked,
      title: 'Select targets to remove',
    });
    if (!chosen) {
      console.log('Cancelled; nothing changed.');
      return { exitCode: 0 };
    }
    names = entries.filter((entry, index) => chosen[index]).map((entry) => entry.name);
  } else {
    throw new Error('Non-interactive uninstall requires -a/--targets or --all, plus --yes');
  }

  if (names.length === 0) {
    console.log('No targets selected; nothing changed.');
    return { exitCode: 0 };
  }

  if (flags.dryRun) {
    console.log('Will remove:');
    for (const name of names) {
      const target = targetByName(name);
      console.log(`  ${name.padEnd(9)} ${displayPath(home, targetPath(home, target))}`);
    }
    return { exitCode: 0 };
  }

  const plan = await buildPlan({ home, config: loaded.config });
  const sourceFile = plan.sourceFile;
  const failures = [];
  const removed = [];
  const session = createBackupSession(home);

  for (const name of names) {
    const entry = plan.targets.find((target) => target.name === name);
    if (!entry) continue;
    const current = await inspectTarget(entry.path, sourceFile);
    if (current.kind === 'missing') {
      removed.push(name);
      continue;
    }
    if (current.kind === 'symlink') {
      if (current.broken) {
        await removeTarget(entry.path);
        removed.push(name);
        continue;
      }
      if (!current.pointsToSource && !flags.force) {
        fail(failures, name, 'Link points elsewhere; requires --force');
        continue;
      }
      if (!current.pointsToSource) await session.backup(entry.path, `${name}-${path.basename(entry.path)}`);
      await removeTarget(entry.path);
      removed.push(name);
    } else if (current.kind === 'hardlink') {
      await removeTarget(entry.path);
      removed.push(name);
    } else if (current.kind === 'file' && entry.kind === 'file') {
      const raw = await readIfExists(entry.path);
      const text = raw?.text ?? '';
      if (!normalizeText(text).trim() || isManagedCopy(text) || contentEqualsSafe(text, plan.source.text) || flags.force) {
        if (flags.force && normalizeText(text).trim()) {
          await session.backup(entry.path, `${name}-${path.basename(entry.path)}`);
        }
        await removeTarget(entry.path);
        removed.push(name);
      } else {
        fail(failures, name, 'Target is an independent file; not removed');
      }
    } else {
      fail(failures, name, 'Target is not a removable link or managed copy');
    }
  }

  const config = withoutSelected(loaded.config, removed);
  await saveConfig(home, config);
  console.log('\nRemoved:');
  for (const name of removed) {
    const target = targetByName(name);
    console.log(`  ${name.padEnd(9)} ${displayPath(home, targetPath(home, target))}`);
  }
  console.log(`  Source kept: ${displayPath(home, sourceFile)}`);
  if (session.path) console.log(`  Backup: ${session.path}`);
  if (failures.length) {
    console.log('\nIncomplete:');
    for (const item of failures) console.log(`  ${item.name}: ${item.reason}`);
  }
  return { exitCode: failures.length ? 1 : 0, result: { removed, failures } };
}
