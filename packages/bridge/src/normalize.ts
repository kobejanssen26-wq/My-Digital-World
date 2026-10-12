import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION, categorizeTool, classifyPrompt, summarizePrompt, type Envelope, type EventData } from '@mdw/shared';
import type { BridgeConfig } from './config.js';
import { identify } from './identity.js';
import { paths } from './paths.js';

/** Subset of the documented Claude Code hook input we read. Everything else is ignored. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  source?: string; // SessionStart
  reason?: string; // SessionEnd
  prompt?: string; // UserPromptSubmit
  tool_name?: string;
  tool_input?: { command?: unknown };
  duration_ms?: number;
  is_interrupt?: boolean; // PostToolUseFailure
  notification_type?: string; // Notification
  agent_type?: string; // SubagentStart/Stop
  error?: string; // StopFailure
}

export const SOURCE = () => `claude-code-hook@${createHash('sha256').update(hostname()).digest('hex').slice(0, 8)}`;
const newId = () => 'ev_' + randomBytes(12).toString('base64url');

interface SessionState {
  prompts: number;
}
function sessionState(sessionId: string): SessionState {
  const f = join(paths.state(), createHash('sha256').update(sessionId).digest('hex').slice(0, 24) + '.json');
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as SessionState) : { prompts: 0 };
  } catch {
    return { prompts: 0 };
  }
}
function saveSessionState(sessionId: string, s: SessionState) {
  const f = join(paths.state(), createHash('sha256').update(sessionId).digest('hex').slice(0, 24) + '.json');
  try {
    writeFileSync(f, JSON.stringify(s), { mode: 0o600 });
  } catch {
    /* non-essential */
  }
}

/**
 * Convert a Claude Code hook payload to an event envelope, or null when the hook carries nothing
 * we track. Raw prompts, commands, file paths and tool output are never copied into the envelope.
 */
export function normalize(input: HookInput, cfg: BridgeConfig, now = Date.now()): Envelope | null {
  const sessionId = input.session_id;
  const hook = input.hook_event_name;
  if (!sessionId || !hook) return null;
  const cwd = input.cwd || process.cwd();
  const data: EventData = { hook };
  if (input.permission_mode) data.permissionMode = input.permission_mode.slice(0, 30);
  let type: Envelope['type'];

  switch (hook) {
    case 'SessionStart':
      type = 'session.start';
      if (input.source) data.source = input.source.slice(0, 40);
      break;
    case 'SessionEnd':
      type = 'session.end';
      if (input.reason) data.reason = input.reason.slice(0, 60);
      break;
    case 'UserPromptSubmit': {
      type = 'prompt.submit';
      const prompt = input.prompt ?? '';
      const project = identify(cwd, cfg, now);
      const st = sessionState(sessionId);
      const cls = classifyPrompt(prompt, { isNewProject: project.isNew === true, hasOpenTask: st.prompts > 0 });
      st.prompts += 1;
      saveSessionState(sessionId, st);
      data.promptKind = cls.kind;
      data.confidence = cls.confidence;
      data.words = Math.min(prompt.split(/\s+/).filter(Boolean).length, 100000);
      if (cfg.sync.promptSummaries) {
        const s = summarizePrompt(prompt);
        if (s) data.summary = s;
      }
      break;
    }
    case 'PreToolUse': {
      const tool = input.tool_name ?? '';
      const category = categorizeTool(tool, input.tool_input);
      if (category !== 'test' && category !== 'deploy') return null; // only long-running checks are worth a "start" event
      type = 'tool.start';
      data.tool = tool.slice(0, 80);
      data.category = category;
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const tool = input.tool_name ?? '';
      type = hook === 'PostToolUse' ? 'tool.done' : 'tool.fail';
      data.tool = tool.slice(0, 80);
      data.category = categorizeTool(tool, input.tool_input);
      if (typeof input.duration_ms === 'number') data.durationMs = Math.max(0, Math.min(Math.round(input.duration_ms), 86_400_000));
      if (hook === 'PostToolUseFailure' && input.is_interrupt) data.errorKind = 'interrupt';
      break;
    }
    case 'Notification':
      type = 'notification';
      data.notificationType = (input.notification_type ?? 'unknown').slice(0, 60);
      break;
    case 'SubagentStart':
    case 'SubagentStop':
      type = hook === 'SubagentStart' ? 'subagent.start' : 'subagent.stop';
      if (input.agent_type) data.agentType = input.agent_type.slice(0, 60);
      break;
    case 'Stop':
      type = 'turn.stop';
      break;
    case 'StopFailure':
      type = 'turn.fail';
      data.reason = (input.error ?? 'unknown').slice(0, 60);
      break;
    default:
      return null; // unsupported hook: ignore rather than guess
  }

  return {
    v: SCHEMA_VERSION,
    id: newId(),
    ts: now,
    source: SOURCE(),
    type,
    sessionId: sessionId.slice(0, 128),
    project: identify(cwd, cfg, now),
    data,
  };
}
