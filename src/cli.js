import { parseArgs } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInstall, runStatus, runLink, runUninstall } from './apply.js';
import { LINK_MODES } from './config.js';
import { createPrompter, isInteractive, PromptError } from './prompt.js';

const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

function help() {
  return `agents-md-link ${VERSION}

Link one user-level AGENTS.md into local AI coding tools.

Usage:
  agents-md-link install       Select tools and install or migrate (alias: add)
  agents-md-link status        Show status
  agents-md-link link          Repair links, broken links and copies
  agents-md-link uninstall     Remove selected targets

Interaction:
  ↑/↓ move  Space toggle  a all  n none  Enter confirm  Esc cancel

Common options:
  -a, --targets <list>   Targets: claude,codex,gemini,copilot,qoder,opencode; * = all
  --all                  All targets
  -y, --yes              Non-interactive confirmation (required when not a TTY)
  --dry-run              Print the plan only
  --json                 Machine-readable output (status / install)

Advanced options:
  --home <dir>           Override home (testing)
  --mode <mode>          auto | symlink | hardlink | copy
  --from <path>          Seed the shared source from a file
  --append-others        Append other file contents to the source
  --adopt                Accept existing content during migration
  --force                Overwrite conflicting targets with the source
  --relink               Back up and force-relink when content differs
  -h, --help             Help
  -v, --version          Version

Source: ~/.agents/AGENTS.md
Config: ~/.agents/agents-link.json`;
}

function parse(argv) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      targets: { type: 'string', short: 'a' },
      all: { type: 'boolean' },
      mode: { type: 'string' },
      from: { type: 'string' },
      'append-others': { type: 'boolean' },
      adopt: { type: 'boolean' },
      force: { type: 'boolean' },
      relink: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const [command = 'help'] = parsed.positionals;
  return { command, values: parsed.values };
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function makeFlags(values) {
  if (values.mode && !LINK_MODES.includes(values.mode)) {
    throw new PromptError(`--mode must be one of ${LINK_MODES.join(', ')}`);
  }
  if (values.targets && values.all) {
    throw new PromptError('--targets and --all cannot be used together');
  }
  return {
    targets: values.targets ?? null,
    all: Boolean(values.all),
    mode: values.mode ?? null,
    from: values.from ? path.resolve(expandHome(values.from)) : null,
    appendOthers: Boolean(values['append-others']),
    adopt: Boolean(values.adopt),
    force: Boolean(values.force),
    relink: Boolean(values.relink),
    yes: Boolean(values.yes),
    dryRun: Boolean(values['dry-run']),
    json: Boolean(values.json),
  };
}

function needsPrompter(command, flags) {
  if (flags.yes || flags.dryRun || flags.json) return false;
  if (!isInteractive()) return false;
  return command === 'install' || command === 'link' || command === 'uninstall';
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error('Run agents-md-link --help for usage.');
    return 2;
  }

  const { command, values } = parsed;
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || command === 'help') {
    console.log(help());
    return 0;
  }

  const normalized = command === 'add' ? 'install' : command;
  if (!['install', 'status', 'link', 'uninstall'].includes(normalized)) {
    console.error(`Error: unknown command ${command}`);
    console.error('Run agents-md-link --help for usage.');
    return 2;
  }

  let flags;
  try {
    flags = makeFlags(values);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return 2;
  }

  const home = values.home ? path.resolve(expandHome(values.home)) : os.homedir();
  if (flags.json && normalized !== 'status' && normalized !== 'install') {
    console.error('Error: --json is only supported for status and install.');
    return 2;
  }
  if (normalized !== 'status' && flags.json && !flags.yes && !flags.dryRun) {
    console.error('Error: writes with --json also require --yes.');
    return 2;
  }
  if (normalized !== 'status' && !flags.yes && !flags.dryRun && !isInteractive()) {
    console.error('Error: not an interactive terminal. Add --yes; install/uninstall also need -a or --all.');
    return 2;
  }
  if (
    (normalized === 'install' || normalized === 'uninstall') &&
    !flags.targets &&
    !flags.all &&
    (flags.yes || flags.dryRun || flags.json || !isInteractive())
  ) {
    console.error('Error: install/uninstall require -a/--targets or --all.');
    return 2;
  }

  let prompter = null;
  if (needsPrompter(normalized, flags)) {
    try {
      prompter = createPrompter();
    } catch (error) {
      if (error instanceof PromptError) {
        console.error(`Error: ${error.message}`);
        return 2;
      }
      throw error;
    }
  }

  try {
    let result;
    if (normalized === 'install') result = await runInstall({ home, flags, prompter });
    else if (normalized === 'status') result = await runStatus({ home, flags });
    else if (normalized === 'link') result = await runLink({ home, flags, prompter });
    else result = await runUninstall({ home, flags, prompter });
    return result?.exitCode ?? 0;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return error instanceof PromptError ? 2 : 1;
  } finally {
    prompter?.close();
  }
}
