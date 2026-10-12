import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS, buildSettings, hooksInstalled, installHooks, removeOurs, uninstallHooks } from '../src/settings-install.js';
import { tmp } from './helpers.js';

const HOOK = '/opt/mdw/dist/mdw-hook.js';
const existing = {
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
  },
};

describe('settings merge', () => {
  it('adds our hooks without removing or reordering anything else', () => {
    const out = buildSettings(existing, HOOK) as any;
    expect(out.model).toBe('opus');
    expect(out.permissions).toEqual(existing.permissions);
    expect(out.hooks.PostToolUse[0]).toEqual(existing.hooks.PostToolUse[0]);
    expect(out.hooks.Stop[0]).toEqual(existing.hooks.Stop[0]);
    for (const { event } of HOOK_EVENTS) expect(JSON.stringify(out.hooks[event])).toContain('mdw-hook');
    // exec form: no shell quoting, so it works under bash AND PowerShell
    expect(out.hooks.Stop[1].hooks[0].args).toEqual([HOOK]);
    expect(out.hooks.Stop[1].hooks[0].command).toBe(process.execPath);
  });
  it('only registers documented event names; turn/session endings are synchronous so they survive process exit', () => {
    const documented = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'SessionEnd'];
    expect(HOOK_EVENTS.map((e) => e.event)).toEqual(documented);
    const out = buildSettings({}, HOOK) as any;
    expect(out.hooks.SessionEnd[0].hooks[0].async).toBeUndefined();
    expect(out.hooks.Stop[0].hooks[0].async).toBeUndefined();
    expect(out.hooks.PostToolUse[0].hooks[0].async).toBe(true);
    expect(out.hooks.PreToolUse[0].matcher).toBe('Bash');
  });
  it('is idempotent', () => {
    const once = buildSettings(existing, HOOK);
    expect(buildSettings(once, HOOK)).toEqual(once);
  });
  it('uninstall removes exactly our entries and restores the original', () => {
    expect(removeOurs(buildSettings(existing, HOOK))).toEqual(existing);
    expect(removeOurs(buildSettings({}, HOOK))).toEqual({});
  });
});

describe('settings file handling', () => {
  it('writes a timestamped backup, installs and uninstalls on disk', () => {
    const file = join(tmp('mdw-claude-'), '.claude', 'settings.json');
    const r0 = installHooks(file, HOOK);
    expect(r0.backup).toBeNull();
    writeFileSync(file, JSON.stringify(existing));
    const r = installHooks(file, HOOK);
    expect(r.backup && existsSync(r.backup)).toBe(true);
    expect(JSON.parse(readFileSync(r.backup!, 'utf8'))).toEqual(existing);
    expect(hooksInstalled(file)).toHaveLength(HOOK_EVENTS.length);
    const u = uninstallHooks(file);
    expect(u.changed).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(existing);
    expect(readdirSync(dirname(file)).filter((f) => f.includes('backup')).length).toBeGreaterThanOrEqual(2);
    expect(uninstallHooks(file).changed).toBe(false);
  });
  it('refuses to modify invalid JSON', () => {
    const file = join(tmp('mdw-claude2-'), 'settings.json');
    writeFileSync(file, '{ "hooks": ');
    expect(() => installHooks(file, HOOK)).toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ "hooks": ');
  });
});
