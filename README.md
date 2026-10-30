# agents-md-link

Link one user-level `AGENTS.md` into the local config files of multiple AI coding tools. User-level only: it never reads or writes project-level `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`.

- Source: `~/.agents/AGENTS.md`
- Config: `~/.agents/agents-sync.json`
- Backups: `~/.agents-md-sync/backups/`

The `.agents-md-sync` directory and the Qoder target file `agents-md-sync.md` keep their original names so existing links and backups keep working.

## What it does

- Keeps a single source at `~/.agents/AGENTS.md`; tool config files point to it.
- Prefers symlinks and falls back to hardlinks on Windows without Developer Mode.
- Never silently overwrites an existing rule file: it backs up first and asks you to pick a base when files differ.
- Shows status, repairs broken links, and removes targets.

## Quick start

```bash
# Run without installing globally
node bin/agents-md-link.js install

# Optional: install the global command
npm link
agents-md-link install
```

`install` shows a checkbox list of supported tools. Use ↑/↓ to move, Space to toggle, `a` for all, `n` for none, Enter to confirm, Esc to cancel. Detected tools are selected by default. After confirmation it creates the source, backs up existing files, and links the selected targets.

## Commands

| Command | What it does |
|---|---|
| `agents-md-link install` | Select tools, install or migrate (alias: `add`) |
| `agents-md-link status` | Show every target, extra rules and cross-read hints |
| `agents-md-link sync` | Repair missing targets, broken links and stale copies |
| `agents-md-link uninstall` | Select installed targets and remove them |

Normal use needs no flags. Flags are for scripts and skills:

```bash
agents-md-link install -a claude,codex --yes
agents-md-link status --json
agents-md-link uninstall -a copilot --yes
```

## Targets

| Name | User-level path |
|---|---|
| claude | `~/.claude/CLAUDE.md` |
| codex | `~/.codex/AGENTS.md` |
| gemini | `~/.gemini/GEMINI.md` |
| copilot | `~/.copilot/copilot-instructions.md` |
| qoder | `~/.qoder-cn/rules/agents-md-sync.md` |
| opencode | `~/.config/opencode/AGENTS.md` (not selected by default) |

Other files under `~/.qoder-cn/rules/`, `~/.claude/rules/` and `~/.copilot/instructions/` are not managed. `status` lists them and reports `duplicate-rule` when a file is identical to the source. A non-empty `~/.qoder-cn/AGENTS.md` is also listed as an extra source.

## Link modes

- `auto`: try a symlink, then fall back to a hardlink.
- `symlink`: symlink only; requires Developer Mode on Windows.
- `hardlink`: hardlink only; no elevation, but an editor's atomic save can break it.
- `copy`: a managed whole-file copy with a generated header; not instant, run `sync` after editing the source.

```bash
agents-md-link install -a claude --mode hardlink --yes
```

`install --mode` is saved to the config and reused by `sync`. If `status` shows `detached`, run `agents-md-link sync` and choose "Back up and relink", or run `agents-md-link sync --relink --yes`.

## Existing content

On first install, selected tools may already have rule files:

- One non-empty file: ask whether to use it as the shared source.
- Multiple non-empty files with different content: stop, list them, and ask for a base with `--from <path>` or a manual merge into `~/.agents/AGENTS.md`.
- Source already exists: the source wins; for each target with content, ask "Back up and replace", "Skip", or "Use this target as the source".

Different files are never concatenated automatically. Every migration, overwrite and relink is backed up first.

## Duplicate loading

- Claude: loads both `~/.claude/CLAUDE.md` and `~/.claude/rules/*.md`; identical rules duplicate context.
- Qoder: the desktop app loads `~/.qoder-cn/rules/*.md`; this tool puts the shared rule in `agents-md-sync.md`. Qoder CLI may also read `~/.qoder-cn/AGENTS.md`. Qoder does not read `CLAUDE.md` by default.
- Copilot: reads its own file and may also read `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md`. The official client removes identical copies; verify with `/instructions`.
- OpenCode: reads `~/.claude/CLAUDE.md` through its compatibility layer, so the OpenCode target is off by default to avoid a second copy.
- Codex: if `~/.codex/AGENTS.override.md` exists, our `AGENTS.md` is ignored; `status` marks it as `shadowed`.

Project-level files are outside this tool. If a repo repeats global rules, each tool still loads both.

## Installing for others

```bash
npm install -g agents-md-link
agents-md-link install
```

Or from a clone, `npm install -g .`. The npm package name is `agents-md-link`.

## Development

```bash
npm test
```

Zero runtime dependencies, Node.js 20+, ESM.

## Optional skill

`skills/agents-md-link/` is a thin, manually invoked skill that calls the repository CLI. From the repository root, install it with a junction (PowerShell, no admin required):

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.agents\skills\agents-md-link" `
  -Target "$PWD\skills\agents-md-link"
```

Then run `node run.js status` or `node run.js install ...` from the skill directory. Copying the skill directory instead of using a junction breaks `run.js` because it resolves the repository bin by relative path.
