import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';
import { createInterface } from 'node:readline/promises';

export class PromptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromptError';
    this.code = 'ENOTTY';
  }
}

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function parseYesNo(input, defaultYes = true) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return defaultYes;
  if (['y', 'yes'].includes(text)) return true;
  if (['n', 'no'].includes(text)) return false;
  return null;
}

export function parseChoice(input, count, defaultIndex = 0) {
  const text = String(input ?? '').trim();
  if (!text) return defaultIndex;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > count) return null;
  return value - 1;
}

export function nextCursor(index, delta, count) {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}

export function toggleAt(checked, index, locked = []) {
  const next = checked.slice();
  if (!locked[index]) next[index] = !next[index];
  return next;
}

export function setAllChecked(checked, value, locked = []) {
  return checked.map((item, index) => (locked[index] ? item : value));
}

const COLOR = process.env.NO_COLOR || process.env.TERM === 'dumb'
  ? { bold: '', dim: '', cyan: '', green: '', reset: '' }
  : {
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      cyan: '\x1b[36m',
      green: '\x1b[32m',
      reset: '\x1b[0m',
    };

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

function pad(value, width) {
  return String(value).padEnd(width);
}

export function createPrompter({ stdin = process.stdin, stdout = process.stdout } = {}) {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new PromptError('Not an interactive terminal. Use --targets/--all and --yes in scripts or skills.');
  }

  let rl = null;
  function getRl() {
    if (!rl) {
      stdin.resume();
      rl = createInterface({ input: stdin, output: stdout });
    }
    return rl;
  }

  async function ask(question) {
    return (await getRl().question(question)).trim();
  }

  async function confirm(question, defaultYes = true) {
    for (;;) {
      const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
      const answer = parseYesNo(await ask(question + suffix), defaultYes);
      if (answer !== null) return answer;
      console.log('Please answer y or n.');
    }
  }

  async function choose(question, options, defaultIndex = 0) {
    console.log(question);
    options.forEach((option, index) => console.log(`  ${index + 1}) ${option}`));
    for (;;) {
      const answer = parseChoice(
        await ask(`Choose [1-${options.length}] (default ${defaultIndex + 1}): `),
        options.length,
        defaultIndex,
      );
      if (answer !== null) return answer;
      console.log('Invalid choice.');
    }
  }

  async function selectTargets({ targets, checked, lockedNames = new Set(), title = 'Select targets' }) {
    if (!targets.length) return [];
    if (rl) {
      rl.close();
      rl = null;
    }

    if (typeof stdin.setRawMode !== 'function') {
      throw new PromptError('This terminal does not support interactive selection. Use --targets.');
    }

    const locked = targets.map((target) => lockedNames.has(target.name));
    const state = checked.map(Boolean);
    let cursor = 0;
    let rendered = 0;
    let finished = false;

    function erase() {
      for (let index = 0; index < rendered; index += 1) {
        moveCursor(stdout, 0, -1);
        clearLine(stdout, 0);
        cursorTo(stdout, 0);
      }
      rendered = 0;
    }

    function draw() {
      erase();
      const lines = [`${COLOR.bold}${title}${COLOR.reset}`];
      targets.forEach((target, index) => {
        const pointer = index === cursor ? `${COLOR.cyan}›${COLOR.reset}` : ' ';
        const box = state[index] ? `${COLOR.green}[x]${COLOR.reset}` : '[ ]';
        const status = target.selected ? target.state : target.detected ? 'detected' : 'not detected';
        const lock = locked[index] ? '  installed' : '';
        lines.push(`${pointer} ${box} ${pad(target.name, 9)} ${pad(status, 11)}${lock}`);
      });
      lines.push(`${COLOR.dim}↑/↓ move  Space toggle  a all  n none  Enter confirm  Esc cancel${COLOR.reset}`);
      stdout.write(`${lines.join('\n')}\n`);
      rendered = lines.length;
    }

    return new Promise((resolve) => {
      function finish(value) {
        if (finished) return;
        finished = true;
        stdin.off('keypress', onKey);
        try {
          stdin.setRawMode(false);
        } catch {
          // terminal already restored
        }
        erase();
        stdout.write(SHOW_CURSOR);
        stdin.pause();
        if (value === null) {
          stdin.unref?.();
          resolve(null);
          return;
        }
        const chosen = targets.filter((_, index) => state[index]).map((target) => target.name);
        console.log(
          chosen.length
            ? `${COLOR.green}Selected: ${chosen.join(', ')}${COLOR.reset}`
            : 'No targets selected.',
        );
        resolve(state);
      }

      function onKey(_text, key) {
        if (key.ctrl && key.name === 'c') return finish(null);
        if (key.name === 'escape') return finish(null);
        if (key.name === 'return' || key.name === 'enter') return finish(state);
        if (key.name === 'up') {
          cursor = nextCursor(cursor, -1, targets.length);
          draw();
          return;
        }
        if (key.name === 'down') {
          cursor = nextCursor(cursor, 1, targets.length);
          draw();
          return;
        }
        if (key.name === 'space') {
          state.splice(0, state.length, ...toggleAt(state, cursor, locked));
          draw();
          return;
        }
        if (key.name === 'a') {
          state.splice(0, state.length, ...setAllChecked(state, true, locked));
          draw();
          return;
        }
        if (key.name === 'n') {
          state.splice(0, state.length, ...setAllChecked(state, false, locked));
          draw();
        }
      }

      stdin.setRawMode(true);
      stdin.resume();
      emitKeypressEvents(stdin);
      stdout.write(HIDE_CURSOR);
      stdin.on('keypress', onKey);
      draw();
    });
  }

  return {
    ask,
    confirm,
    choose,
    selectTargets,
    close: () => {
      rl?.close();
      rl = null;
    },
  };
}
