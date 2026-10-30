import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { runInstall, runStatus, runLink, runUninstall } from '../src/apply.js';
import { inspectTarget } from '../src/link.js';
import { cleanup, makeHome, put, quiet } from '../support/fixture.js';

function flags(extra = {}) {
  return {
    targets: null,
    all: false,
    mode: 'hardlink',
    from: null,
    appendOthers: false,
    adopt: false,
    force: false,
    relink: false,
    yes: true,
    dryRun: false,
    json: false,
    ...extra,
  };
}

async function withHome(fn) {
  const home = await makeHome();
  try {
    await fn(home);
  } finally {
    await cleanup(home);
  }
}

test('install migrates existing Claude rules and links all selected targets', async () => {
  await withHome(async (home) => {
    const claude = await put(home, '.claude/CLAUDE.md', '# Claude\n\n- use Chinese\n');
    await fs.mkdir(path.join(home, '.gemini'), { recursive: true });
    const result = await quiet(() =>
      runInstall({ home, flags: flags({ targets: 'claude,gemini', adopt: true }), prompter: null }),
    );
    assert.equal(result.exitCode, 0);
    const source = path.join(home, '.agents', 'AGENTS.md');
    assert.match(await fs.readFile(source, 'utf8'), /use Chinese/);
    assert.equal((await inspectTarget(claude, source)).kind, 'hardlink');
    assert.equal((await inspectTarget(path.join(home, '.gemini', 'GEMINI.md'), source)).kind, 'hardlink');
    const loaded = await loadConfig(home);
    assert.equal(loaded.config.targets.claude, true);
    assert.equal(loaded.config.targets.gemini, true);

    await fs.appendFile(claude, '- via claude\n');
    assert.match(await fs.readFile(source, 'utf8'), /via claude/);
    await fs.appendFile(source, '- via source\n');
    assert.match(await fs.readFile(claude, 'utf8'), /via source/);
  });
});

test('broken link is repaired with relink and can be uninstalled', async () => {
  await withHome(async (home) => {
    await put(home, '.claude/CLAUDE.md', '# Rules\n');
    await fs.mkdir(path.join(home, '.gemini'), { recursive: true });
    await quiet(() => runInstall({ home, flags: flags({ targets: 'claude,gemini', adopt: true }), prompter: null }));
    const gemini = path.join(home, '.gemini', 'GEMINI.md');
    await fs.rm(gemini);
    await fs.writeFile(gemini, 'independent\n');
    const broken = await quiet(() => runStatus({ home, flags: flags({ json: true }) }));
    assert.equal(broken.exitCode, 1);
    const repaired = await quiet(() => runLink({ home, flags: flags({ relink: true }), prompter: null }));
    assert.equal(repaired.exitCode, 0);
    const source = path.join(home, '.agents', 'AGENTS.md');
    assert.equal((await inspectTarget(gemini, source)).kind, 'hardlink');
    const removed = await quiet(() => runUninstall({ home, flags: flags({ targets: 'gemini' }), prompter: null }));
    assert.equal(removed.exitCode, 0);
    await assert.rejects(fs.access(gemini));
    const loaded = await loadConfig(home);
    assert.equal(loaded.config.targets.gemini, false);
  });
});

test('differing files require --from and back up the losing file', async () => {
  await withHome(async (home) => {
    const claude = await put(home, '.claude/CLAUDE.md', '# Claude\n- c\n');
    await put(home, '.codex/AGENTS.md', '# Codex\n- x\n');
    await assert.rejects(
      quiet(() => runInstall({ home, flags: flags({ targets: 'claude,codex' }), prompter: null })),
      /--from/,
    );
    const result = await quiet(() =>
      runInstall({
        home,
        flags: flags({ targets: 'claude,codex', adopt: true, from: claude }),
        prompter: null,
      }),
    );
    assert.equal(result.exitCode, 0);
    const source = path.join(home, '.agents', 'AGENTS.md');
    assert.match(await fs.readFile(source, 'utf8'), /# Claude/);
    assert.match(await fs.readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), /# Claude/);
    const backups = path.join(home, '.agents-md-link', 'backups');
    const files = await fs.readdir(backups, { recursive: true });
    assert.ok(files.some((file) => String(file).includes('codex-AGENTS.md')));
  });
});

test('copy mode persists and link updates the copy', async () => {
  await withHome(async (home) => {
    const claude = await put(home, '.claude/CLAUDE.md', '# Copy\n');
    await quiet(() =>
      runInstall({ home, flags: flags({ targets: 'claude', adopt: true, mode: 'copy' }), prompter: null }),
    );
    const loaded = await loadConfig(home);
    assert.equal(loaded.config.link, 'copy');
    assert.match(await fs.readFile(claude, 'utf8'), /generated from/);
    const source = path.join(home, '.agents', 'AGENTS.md');
    await fs.appendFile(source, '- later\n');
    const linked = await quiet(() => runLink({ home, flags: flags({ mode: null }), prompter: null }));
    assert.equal(linked.exitCode, 0);
    assert.match(await fs.readFile(claude, 'utf8'), /later/);
    const status = await quiet(() => runStatus({ home, flags: flags({ json: true }) }));
    assert.equal(status.exitCode, 0);
    await quiet(() => runUninstall({ home, flags: flags({ targets: 'claude' }), prompter: null }));
    await assert.rejects(fs.access(claude));
    assert.match(await fs.readFile(source, 'utf8'), /Copy/);
  });
});

test('uninstall leaves failed targets enabled', async () => {
  await withHome(async (home) => {
    await put(home, '.claude/CLAUDE.md', '# Rules\n');
    await quiet(() => runInstall({ home, flags: flags({ targets: 'claude', adopt: true }), prompter: null }));
    const claude = path.join(home, '.claude', 'CLAUDE.md');
    await fs.rm(claude);
    await fs.writeFile(claude, 'independent\n');
    const result = await quiet(() => runUninstall({ home, flags: flags({ targets: 'claude' }), prompter: null }));
    assert.equal(result.exitCode, 1);
    assert.match(await fs.readFile(claude, 'utf8'), /independent/);
    const loaded = await loadConfig(home);
    assert.equal(loaded.config.targets.claude, true);
  });
});

test('empty target files are replaced without --adopt', async () => {
  await withHome(async (home) => {
    await put(home, '.claude/CLAUDE.md', '');
    const result = await quiet(() =>
      runInstall({ home, flags: flags({ targets: 'claude' }), prompter: null }),
    );
    assert.equal(result.exitCode, 0);
    const source = path.join(home, '.agents', 'AGENTS.md');
    assert.equal((await inspectTarget(path.join(home, '.claude', 'CLAUDE.md'), source)).kind, 'hardlink');
  });
});

test('from seeds a source even when selected targets are empty', async () => {
  await withHome(async (home) => {
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    const base = await put(home, 'base.md', '# Base\n- from file\n');
    const result = await quiet(() =>
      runInstall({
        home,
        flags: flags({ targets: 'claude', from: base }),
        prompter: null,
      }),
    );
    assert.equal(result.exitCode, 0);
    const source = path.join(home, '.agents', 'AGENTS.md');
    assert.match(await fs.readFile(source, 'utf8'), /from file/);
    assert.equal((await inspectTarget(path.join(home, '.claude', 'CLAUDE.md'), source)).kind, 'hardlink');
  });
});

test('interactive install selects checked targets and migrates', async () => {
  await withHome(async (home) => {
    await put(home, '.claude/CLAUDE.md', '# Interactive\n');
    await fs.mkdir(path.join(home, '.gemini'), { recursive: true });
    const prompter = {
      selectTargets: async ({ checked }) => checked,
      confirm: async () => true,
      choose: async (_question, _options, fallback) => fallback,
      close() {},
    };
    const result = await quiet(() =>
      runInstall({
        home,
        flags: flags({ targets: null, yes: false, adopt: false }),
        prompter,
      }),
    );
    assert.equal(result.exitCode, 0);
    const source = path.join(home, '.agents', 'AGENTS.md');
    assert.match(await fs.readFile(source, 'utf8'), /Interactive/);
    assert.equal((await inspectTarget(path.join(home, '.gemini', 'GEMINI.md'), source)).kind, 'hardlink');
  });
});

test('existing source wins unless adopt is used', async () => {
  await withHome(async (home) => {
    await put(home, '.claude/CLAUDE.md', '# Source\n');
    await quiet(() => runInstall({ home, flags: flags({ targets: 'claude', adopt: true }), prompter: null }));
    await put(home, '.codex/AGENTS.md', '# Different\n');
    const skipped = await quiet(() =>
      runInstall({ home, flags: flags({ targets: 'codex' }), prompter: null }),
    );
    assert.equal(skipped.exitCode, 1);
    assert.match(await fs.readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), /Different/);
    const adopted = await quiet(() =>
      runInstall({ home, flags: flags({ targets: 'codex', adopt: true }), prompter: null }),
    );
    assert.equal(adopted.exitCode, 0);
    assert.match(await fs.readFile(path.join(home, '.codex', 'AGENTS.md'), 'utf8'), /Source/);
  });
});
