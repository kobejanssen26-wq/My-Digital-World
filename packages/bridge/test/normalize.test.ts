import { beforeEach, describe, expect, it } from 'vitest';
import { parseEnvelope } from '@mdw/shared';
import { normalize } from '../src/normalize.js';
import { config, makeRepo, useHome } from './helpers.js';

let cwd: string;
beforeEach(() => {
  useHome();
  cwd = makeRepo({ remote: 'git@github.com:me/app.git', name: 'app' });
});

const base = (o: object) => ({ session_id: 'sess-1', cwd, ...o });

describe('hook payload normalization', () => {
  it('maps every supported documented hook to a valid envelope', () => {
    const cfg = config();
    const cases: [object, string][] = [
      [{ hook_event_name: 'SessionStart', source: 'startup' }, 'session.start'],
      [{ hook_event_name: 'SessionEnd', reason: 'other' }, 'session.end'],
      [{ hook_event_name: 'UserPromptSubmit', prompt: 'Add dark mode to the settings page' }, 'prompt.submit'],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }, 'tool.start'],
      [{ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/x/y.ts' }, duration_ms: 12 }, 'tool.done'],
      [{ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'pytest' }, error: 'Exit code 1', is_interrupt: false }, 'tool.fail'],
      [{ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' }, 'notification'],
      [{ hook_event_name: 'SubagentStart', agent_type: 'Explore' }, 'subagent.start'],
      [{ hook_event_name: 'SubagentStop', agent_type: 'Explore' }, 'subagent.stop'],
      [{ hook_event_name: 'Stop', last_assistant_message: 'Done!' }, 'turn.stop'],
      [{ hook_event_name: 'StopFailure', error: 'rate_limit' }, 'turn.fail'],
    ];
    for (const [payload, type] of cases) {
      const ev = normalize(base(payload), cfg)!;
      expect(ev, type).not.toBeNull();
      expect(ev.type).toBe(type);
      const parsed = parseEnvelope(JSON.parse(JSON.stringify(ev)));
      expect(parsed.ok, `${type}: ${JSON.stringify(parsed)}`).toBe(true);
    }
  });

  it('ignores unsupported hooks, missing session ids, and PreToolUse for ordinary tools', () => {
    const cfg = config();
    expect(normalize(base({ hook_event_name: 'PreCompact' }), cfg)).toBeNull();
    expect(normalize({ hook_event_name: 'Stop', cwd }, cfg)).toBeNull();
    expect(normalize(base({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }), cfg)).toBeNull();
    expect(normalize(base({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), cfg)).toBeNull();
  });

  it('never includes the raw prompt, commands, file paths or tool output', () => {
    const cfg = config();
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const evs = [
      normalize(base({ hook_event_name: 'UserPromptSubmit', prompt: `Please fix login using ${secret} in /home/me/secret-project/auth.ts` }), cfg)!,
      normalize(base({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: Bearer ${secret}" https://x` }, tool_response: { stdout: 'TOPSECRETOUTPUT' } }), cfg)!,
      normalize(base({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/home/me/secret-project/auth.ts', content: 'CODEBODY' } }), cfg)!,
      normalize(base({ hook_event_name: 'Stop', last_assistant_message: 'ASSISTANTTEXT' }), cfg)!,
    ];
    const blob = JSON.stringify(evs);
    for (const needle of [secret, '/home/me', 'secret-project', 'TOPSECRETOUTPUT', 'CODEBODY', 'ASSISTANTTEXT', 'curl', 'Authorization', cwd]) expect(blob).not.toContain(needle);
  });

  it('classifies prompts and tracks per-session history for continuations', () => {
    const cfg = config();
    const first = normalize(base({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the crash on startup' }), cfg)!;
    expect(first.data.promptKind).toBe('bugfix');
    const second = normalize(base({ hook_event_name: 'UserPromptSubmit', prompt: 'continue' }), cfg)!;
    expect(second.data.promptKind).toBe('continuation');
    const other = normalize({ session_id: 'sess-2', cwd, hook_event_name: 'UserPromptSubmit', prompt: 'continue' }, cfg)!;
    expect(other.data.promptKind).not.toBe('continuation'); // nothing to continue in a fresh session
  });

  it('omits summaries when the user disabled them', () => {
    const cfg = config({ sync: { promptSummaries: false, repoIdentity: true, projectNames: true } });
    const ev = normalize(base({ hook_event_name: 'UserPromptSubmit', prompt: 'Build a recipe app' }), cfg)!;
    expect(ev.data.summary).toBeUndefined();
    expect(ev.data.promptKind).toBe('build');
  });

  it('flags user-interrupted tool failures', () => {
    const ev = normalize(base({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, is_interrupt: true }), config())!;
    expect(ev.data.errorKind).toBe('interrupt');
  });

  it('gives each event a unique id and a source identifier', () => {
    const cfg = config();
    const a = normalize(base({ hook_event_name: 'Stop' }), cfg)!;
    const b = normalize(base({ hook_event_name: 'Stop' }), cfg)!;
    expect(a.id).not.toBe(b.id);
    expect(a.source).toMatch(/^claude-code-hook@/);
    expect(a.v).toBe(1);
  });
});
