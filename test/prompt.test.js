import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  createPrompter,
  nextCursor,
  parseChoice,
  parseYesNo,
  setAllChecked,
  toggleAt,
} from '../src/prompt.js';
import { quiet } from '../support/fixture.js';

function fakeTty() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 80;
  return { stdin, stdout };
}

const targets = [
  { name: 'claude', selected: false, detected: true, state: 'not-selected' },
  { name: 'codex', selected: false, detected: true, state: 'not-selected' },
];

test('checkbox selection uses arrows, space and enter', async () => {
  const { stdin, stdout } = fakeTty();
  const result = await quiet(async () => {
    const prompter = createPrompter({ stdin, stdout });
    const pending = prompter.selectTargets({ targets, checked: [false, false] });
    stdin.emit('keypress', '', { name: 'down' });
    stdin.emit('keypress', '', { name: 'space' });
    stdin.emit('keypress', '', { name: 'return' });
    return pending;
  });
  assert.deepEqual(result, [false, true]);
  assert.equal(stdin.isPaused(), true);
  stdin.pause();
});

test('checkbox selection keeps locked rows checked and can cancel', async () => {
  const first = fakeTty();
  const firstResult = await quiet(async () => {
    const prompter = createPrompter(first);
    const pending = prompter.selectTargets({
      targets,
      checked: [true, false],
      lockedNames: new Set(['claude']),
    });
    first.stdin.emit('keypress', '', { name: 'space' });
    first.stdin.emit('keypress', '', { name: 'down' });
    first.stdin.emit('keypress', '', { name: 'space' });
    first.stdin.emit('keypress', '', { name: 'return' });
    return pending;
  });
  assert.deepEqual(firstResult, [true, true]);
  assert.equal(first.stdin.isPaused(), true);
  first.stdin.pause();

  const second = fakeTty();
  const cancelled = await quiet(async () => {
    const prompter = createPrompter(second);
    const pending = prompter.selectTargets({ targets, checked: [false, false] });
    second.stdin.emit('keypress', '', { name: 'escape' });
    return pending;
  });
  assert.equal(cancelled, null);
  assert.equal(second.stdin.isPaused(), true);
  second.stdin.pause();
});


test('nextCursor wraps in both directions', () => {
  assert.equal(nextCursor(0, 1, 3), 1);
  assert.equal(nextCursor(0, -1, 3), 2);
  assert.equal(nextCursor(2, 1, 3), 0);
  assert.equal(nextCursor(0, 1, 0), 0);
});

test('toggleAt respects locked rows', () => {
  assert.deepEqual(toggleAt([false, false], 0), [true, false]);
  assert.deepEqual(toggleAt([false, false], 1, [false, true]), [false, false]);
});

test('setAllChecked respects locked rows', () => {
  assert.deepEqual(setAllChecked([false, false, false], true), [true, true, true]);
  assert.deepEqual(setAllChecked([true, true, true], false, [false, true, false]), [false, true, false]);
});

test('parseYesNo handles defaults and common answers', () => {
  assert.equal(parseYesNo('', true), true);
  assert.equal(parseYesNo('', false), false);
  assert.equal(parseYesNo('y', false), true);
  assert.equal(parseYesNo('no', true), false);
  assert.equal(parseYesNo('yes', false), true);
  assert.equal(parseYesNo('no', true), false);
  assert.equal(parseYesNo('maybe', true), null);
});

test('parseChoice returns zero-based index or default', () => {
  assert.equal(parseChoice('', 3, 1), 1);
  assert.equal(parseChoice('2', 3), 1);
  assert.equal(parseChoice('9', 3), null);
});
