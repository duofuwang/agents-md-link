---
name: agents-md-link
description: Link one user-level AGENTS.md into Qoder, Claude Code, Codex, Gemini/Antigravity, Copilot and OpenCode. Invoke manually only when the user asks to install, inspect, repair or remove user-level rules; it creates links, backups and config files.
disable-model-invocation: true
---

# agents-md-link

User-level only. Never read or write project-level `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`.

`run.js` in this directory forwards to the repository's `bin/agents-md-link.js`. Run every command from this directory.

## Ask first

Before installing or uninstalling, ask the user which tools to handle. Do not select everything on their behalf.

Supported: `claude`, `codex`, `gemini`, `copilot`, `qoder`, `opencode`.

## Common commands

```bash
node run.js status
node run.js install -a claude,codex --yes
node run.js link --yes
node run.js uninstall -a copilot --yes
```

First install or when a target already has content:

- One non-empty file: add `--adopt` to use it as the shared source.
- Multiple files with different content: ask the user for a base, then pass `--from <path>`. Do not merge automatically.
- Without `--adopt` the tool refuses to overwrite. Report that as-is; do not bypass it.

Link mode defaults to `auto`. Use `--mode symlink|hardlink|copy` only when the user asks. Do not change the config otherwise.

## Report

- Preserve the tool's target paths, states and backup paths verbatim.
- A `status` exit code of 1 means a target is missing, broken, detached, or shadowed by a Codex override; say which one.
- Do not edit `~/.agents/AGENTS.md` or any tool target file unless the user explicitly asks.
