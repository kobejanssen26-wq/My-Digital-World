import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Safely merge/remove our hooks in a Claude Code settings.json. We never rewrite unrelated keys,
 * never touch other tools' hooks, back the file up first, and refuse to touch invalid JSON.
 */

/** Documented hook events we subscribe to (https://code.claude.com/docs/en/hooks). */
export const HOOK_EVENTS: { event: string; matcher?: string; sync?: boolean }[] = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: 'Bash' },
  { event: 'PostToolUse' },
  { event: 'PostToolUseFailure' },
  { event: 'Notification' },
  { event: 'SubagentStart' },
  { event: 'SubagentStop', sync: true },
  { event: 'Stop', sync: true }, // sync: in `claude -p` the process exits right after the final turn and would drop async hooks
  { event: 'StopFailure', sync: true },
  { event: 'SessionEnd', sync: true }, // SessionEnd has a tiny time budget; our hook is fast and synchronous there
];

export const MARKER = 'mdw-hook';

type Json = Record<string, unknown>;
interface HookCmd {
  type: string;
  command?: string;
  args?: string[];
  [k: string]: unknown;
}
interface Group {
  matcher?: string;
  hooks?: HookCmd[];
  [k: string]: unknown;
}

export function userSettingsPath() {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
}
export function projectSettingsPath(dir: string) {
  return join(dir, '.claude', 'settings.local.json');
}

const isOurs = (h: HookCmd) => (typeof h.command === 'string' && h.command.includes(MARKER)) || (Array.isArray(h.args) && h.args.some((a) => typeof a === 'string' && a.includes(MARKER)));

/**
 * Exec form (`command` + `args`, no shell): works identically under bash, PowerShell and cmd, and paths
 * with spaces (C:\\Program Files\\nodejs\\node.exe) need no quoting. The marker is part of the hook file name.
 */
export function hookHandler(hookJs: string): { command: string; args: string[] } {
  return { command: process.execPath, args: [hookJs] };
}

export function buildSettings(existing: Json, hookJs: string): Json {
  const out: Json = structuredClone(existing);
  const hooks = ((out.hooks as Json | undefined) ?? {}) as Record<string, Group[]>;
  for (const { event, matcher, sync } of HOOK_EVENTS) {
    const groups = (hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => (g.hooks?.length ?? 0) > 0);
    const handler: HookCmd = { type: 'command', ...hookHandler(hookJs), timeout: 10 };
    if (!sync) handler.async = true; // never delay Claude Code
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [handler] });
    hooks[event] = groups;
  }
  out.hooks = hooks;
  return out;
}

export function removeOurs(existing: Json): Json {
  const out: Json = structuredClone(existing);
  const hooks = out.hooks as Record<string, Group[]> | undefined;
  if (!hooks) return out;
  for (const event of Object.keys(hooks)) {
    const groups = (hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => (g.hooks?.length ?? 0) > 0);
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

function readSettings(file: string): Json {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    return v as Json;
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}). Refusing to modify it; fix the file and retry.`);
  }
}

function writeSettings(file: string, value: Json): string | null {
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.mdw-backup-${Date.now()}`;
    copyFileSync(file, backup);
  }
  const tmp = `${file}.mdw-tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
  return backup;
}

export function installHooks(file: string, hookJs: string) {
  const backup = writeSettings(file, buildSettings(readSettings(file), hookJs));
  return { file, backup, events: HOOK_EVENTS.map((e) => e.event) };
}

export function uninstallHooks(file: string) {
  if (!existsSync(file)) return { file, changed: false, backup: null as string | null };
  const before = readSettings(file);
  const after = removeOurs(before);
  if (JSON.stringify(before) === JSON.stringify(after)) return { file, changed: false, backup: null as string | null };
  return { file, changed: true, backup: writeSettings(file, after) };
}

export function hooksInstalled(file: string): string[] {
  try {
    const hooks = (readSettings(file).hooks ?? {}) as Record<string, Group[]>;
    return Object.entries(hooks)
      .filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some(isOurs)))
      .map(([e]) => e);
  } catch {
    return [];
  }
}
