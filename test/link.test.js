import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  createLink,
  inspectTarget,
  removeTarget,
  sameFile,
  symlinkCapability,
} from '../src/link.js';
import { cleanup, makeHome, put } from '../support/fixture.js';

let home;
let source;
before(async () => {
  home = await makeHome();
  source = await put(home, '.agents/AGENTS.md', '# Source\n');
});
after(async () => {
  await cleanup(home);
});

test('hardlink is detected as the same inode', async () => {
  const target = path.join(home, '.codex', 'AGENTS.md');
  const result = await createLink(source, target, 'hardlink');
  assert.equal(result.type, 'hardlinked');
  assert.equal(await sameFile(source, target), true);
  const info = await inspectTarget(target, source);
  assert.equal(info.kind, 'hardlink');
  assert.equal(info.sameInode, true);
  await removeTarget(target);
});

test('auto mode creates a link and inspects it', async () => {
  const target = path.join(home, '.gemini', 'GEMINI.md');
  await createLink(source, target, 'auto');
  const info = await inspectTarget(target, source);
  assert.ok(info.kind === 'hardlink' || (info.kind === 'symlink' && info.pointsToSource));
  await removeTarget(target);
});

test('symlink-specific states when the platform allows symlinks', async (t) => {
  if (!(await symlinkCapability())) {
    t.skip('symlinks are not available in this environment');
    return;
  }
  const target = path.join(home, '.claude', 'CLAUDE.md');
  await createLink(source, target, 'symlink');
  const info = await inspectTarget(target, source);
  assert.equal(info.kind, 'symlink');
  assert.equal(info.pointsToSource, true);

  const foreign = path.join(home, '.claude', 'foreign.md');
  const other = await put(home, '.claude/other.md', '# Other\n');
  await fs.symlink(other, foreign, 'file');
  const foreignInfo = await inspectTarget(foreign, source);
  assert.equal(foreignInfo.kind, 'symlink');
  assert.equal(foreignInfo.pointsToSource, false);

  await removeTarget(foreign);
  await removeTarget(target);
});

test('broken symlink is reported as broken', async (t) => {
  if (!(await symlinkCapability())) {
    t.skip('symlinks are not available in this environment');
    return;
  }
  const target = path.join(home, '.claude', 'broken.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(path.join(home, 'missing.md'), target, 'file');
  const info = await inspectTarget(target, source);
  assert.equal(info.kind, 'symlink');
  assert.equal(info.broken, true);
  await removeTarget(target);
});
