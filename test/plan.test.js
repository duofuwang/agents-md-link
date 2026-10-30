import assert from 'node:assert/strict';
import test from 'node:test';
import { TARGET_NAMES } from '../src/registry.js';
import { createLink } from '../src/link.js';
import { managedCopy } from '../src/io.js';
import { buildPlan } from '../src/plan.js';
import { cleanup, makeHome, put } from '../support/fixture.js';

function configWith(names, extra = {}) {
  return {
    version: 1,
    source: 'AGENTS.md',
    link: 'auto',
    targets: Object.fromEntries(TARGET_NAMES.map((name) => [name, names.includes(name)])),
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

test('detects hardlinked, missing and detached targets', async () => {
  await withHome(async (home) => {
    const source = await put(home, '.agents/AGENTS.md', '# Rules\n');
    await createLink(source, `${home}/.claude/CLAUDE.md`, 'hardlink');
    await put(home, '.gemini/GEMINI.md', 'independent\n');
    const plan = await buildPlan({ home, config: configWith(['claude', 'gemini', 'codex']) });
    const states = Object.fromEntries(plan.targets.map((target) => [target.name, target.state]));
    assert.equal(states.claude, 'hardlinked');
    assert.equal(states.gemini, 'detached');
    assert.equal(states.codex, 'missing');
    assert.equal(plan.failures.length, 2);
  });
});

test('unselected content is unmanaged, managed copies are current', async () => {
  await withHome(async (home) => {
    await put(home, '.agents/AGENTS.md', '# Rules\n');
    await put(home, '.codex/AGENTS.md', 'old\n');
    await put(home, '.claude/CLAUDE.md', managedCopy('# Rules\n'));
    const plan = await buildPlan({ home, config: configWith(['claude']) });
    const byName = Object.fromEntries(plan.targets.map((target) => [target.name, target]));
    assert.equal(byName.codex.state, 'unmanaged');
    assert.equal(byName.claude.state, 'copy-current');
  });
});

test('Codex AGENTS.override.md marks the target as shadowed', async () => {
  await withHome(async (home) => {
    const source = await put(home, '.agents/AGENTS.md', '# Rules\n');
    await put(home, '.codex/AGENTS.override.md', '# Override\n');
    await createLink(source, `${home}/.codex/AGENTS.md`, 'hardlink');
    const plan = await buildPlan({ home, config: configWith(['codex']) });
    const codex = plan.targets.find((target) => target.name === 'codex');
    assert.equal(codex.shadowed, true);
    assert.ok(plan.warnings.some((warning) => warning.type === 'shadowed'));
    assert.ok(plan.failures.some((target) => target.name === 'codex'));
  });
});

test('duplicate rule files are reported and the managed rule is skipped', async () => {
  await withHome(async (home) => {
    const source = await put(home, '.agents/AGENTS.md', '# Rules\n');
    await put(home, '.qoder-cn/rules/dup.md', '# Rules\n');
    await createLink(source, `${home}/.qoder-cn/rules/agents-md-link.md`, 'hardlink');
    const plan = await buildPlan({ home, config: configWith(['qoder']) });
    assert.ok(plan.additionalRules.some((rule) => rule.duplicate));
    assert.ok(!plan.additionalRules.some((rule) => rule.path.endsWith('agents-md-link.md')));
    assert.ok(plan.warnings.some((warning) => warning.type === 'duplicate-rule'));
    const qoder = plan.targets.find((target) => target.name === 'qoder');
    assert.equal(qoder.state, 'hardlinked');
  });
});

test('Qoder main AGENTS.md is listed as an extra source', async () => {
  await withHome(async (home) => {
    await put(home, '.agents/AGENTS.md', '# Rules\n');
    await put(home, '.qoder-cn/AGENTS.md', '# Extra\n');
    const plan = await buildPlan({ home, config: configWith([]) });
    const extra = plan.additionalRules.find((rule) => rule.path.endsWith('.qoder-cn/AGENTS.md') || rule.path.endsWith('.qoder-cn\\AGENTS.md'));
    assert.ok(extra);
    assert.equal(extra.extra, true);
    assert.ok(plan.warnings.some((warning) => warning.type === 'extra-source'));
  });
});

test('Copilot cross-read warning appears when Claude and Gemini are linked', async () => {
  await withHome(async (home) => {
    const source = await put(home, '.agents/AGENTS.md', '# Rules\n');
    await put(home, '.copilot/config.json', '{}\n');
    await createLink(source, `${home}/.claude/CLAUDE.md`, 'hardlink');
    await createLink(source, `${home}/.gemini/GEMINI.md`, 'hardlink');
    const plan = await buildPlan({ home, config: configWith(['claude', 'gemini']) });
    const copilot = plan.crossRead.find((item) => item.tool === 'copilot');
    assert.ok(copilot);
    assert.equal(copilot.duplicate, true);
    assert.ok(plan.warnings.some((warning) => warning.type === 'duplicate-context'));
  });
});

test('selected content without a source is source-missing', async () => {
  await withHome(async (home) => {
    await put(home, '.claude/CLAUDE.md', '# Existing\n');
    const plan = await buildPlan({ home, config: configWith(['claude']) });
    const claude = plan.targets.find((target) => target.name === 'claude');
    assert.equal(claude.state, 'source-missing');
    assert.ok(plan.failures.some((target) => target.name === 'claude'));
  });
});
