import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  loadConfig,
  saveConfig,
  validateConfig,
} from '../src/config.js';
import { configPath, sourcePath, TARGET_NAMES } from '../src/registry.js';
import { cleanup, makeHome } from '../support/fixture.js';

let home;
before(async () => {
  home = await makeHome();
});
after(async () => {
  await cleanup(home);
});

test('missing config uses defaults with no selected targets', async () => {
  const loaded = await loadConfig(home);
  assert.equal(loaded.exists, false);
  assert.equal(loaded.config.link, 'auto');
  assert.equal(loaded.config.source, 'AGENTS.md');
  assert.deepEqual(Object.keys(loaded.config.targets).sort(), [...TARGET_NAMES].sort());
  assert.ok(Object.values(loaded.config.targets).every((value) => value === false));
  assert.equal(loaded.file, configPath(home));
});

test('saveConfig writes an explicit target map and reloads', async () => {
  const loaded = await loadConfig(home);
  const config = {
    ...loaded.config,
    link: 'hardlink',
    targets: { ...loaded.config.targets, claude: true, qoder: true },
  };
  await saveConfig(home, config);
  const reloaded = await loadConfig(home);
  assert.equal(reloaded.exists, true);
  assert.equal(reloaded.config.link, 'hardlink');
  assert.equal(reloaded.config.targets.claude, true);
  assert.equal(reloaded.config.targets.qoder, true);
  assert.equal(reloaded.config.targets.codex, false);
});

test('invalid config fields are rejected', () => {
  assert.throws(() => validateConfig({ targets: { nope: true } }), /unknown target/i);
  assert.throws(() => validateConfig({ link: 'wat' }), /link/);
  assert.throws(() => validateConfig({ targets: { claude: 'yes' } }), /true\/false/);
  assert.throws(() => validateConfig({ extra: 1 }), /unknown field/);
});

test('source must stay under ~/.agents', () => {
  assert.throws(() => sourcePath(home, '../outside.md'), /must not escape/);
  assert.throws(() => sourcePath(home, 'C:\\outside.md'), /relative path/);
});
