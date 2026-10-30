import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { main } from '../src/cli.js';
import { cleanup, makeHome, put, quiet } from '../support/fixture.js';

let home;
before(async () => {
  home = await makeHome();
  await put(home, '.claude/CLAUDE.md', '# Claude\n');
});
after(async () => {
  await cleanup(home);
});

test('help, version and unknown commands', async () => {
  assert.equal(await quiet(() => main(['--help'])), 0);
  assert.equal(await quiet(() => main(['--version'])), 0);
  assert.equal(await quiet(() => main(['nope'])), 2);
});

test('non-interactive install requires --yes, targets and adoption', async () => {
  assert.equal(await quiet(() => main(['install', '--home', home, '-a', 'claude'])), 2);
  assert.equal(await quiet(() => main(['install', '--home', home, '--yes'])), 2);
  assert.equal(
    await quiet(() => main(['install', '--home', home, '-a', 'claude', '--mode', 'hardlink', '--yes'])),
    1,
  );
  assert.equal(
    await quiet(() =>
      main(['install', '--home', home, '-a', 'claude', '--mode', 'hardlink', '--adopt', '--yes']),
    ),
    0,
  );
});

test('status is clean after install and uninstall works', async () => {
  assert.equal(await quiet(() => main(['status', '--home', home, '--json'])), 0);
  assert.equal(await quiet(() => main(['uninstall', '--home', home, '--yes'])), 2);
  assert.equal(await quiet(() => main(['uninstall', '--home', home, '-a', 'claude', '--yes'])), 0);
  assert.equal(await quiet(() => main(['status', '--home', home, '--json'])), 0);
});

test('link command runs and the old sync command is rejected', async () => {
  const other = await makeHome();
  try {
    await put(other, '.claude/CLAUDE.md', '# Other\n');
    assert.equal(
      await quiet(() => main(['install', '--home', other, '-a', 'claude', '--adopt', '--yes'])),
      0,
    );
    assert.equal(await quiet(() => main(['link', '--home', other, '--yes'])), 0);
    assert.equal(await quiet(() => main(['sync', '--home', other, '--yes'])), 2);
  } finally {
    await cleanup(other);
  }
});

test('invalid options exit with usage code', async () => {
  assert.equal(await quiet(() => main(['install', '--home', home, '--mode', 'wat'])), 2);
  assert.equal(
    await quiet(() => main(['install', '--home', home, '-a', 'claude', '--all', '--yes'])),
    2,
  );
});
