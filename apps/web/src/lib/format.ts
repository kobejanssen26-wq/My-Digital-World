import { STATUS_LABEL, type EventRow, type ProjectRow, type SessionRow, type TaskRow } from '@mdw/shared';

export function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

export const fmtTime = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const TOOL_VERB: Record<string, string> = {
  read: 'read project files',
  modify: 'changed files',
  test: 'ran tests',
  build: 'ran a build/lint check',
  deploy: 'ran a deploy command',
  shell: 'ran a shell command',
  agent: 'used a subagent tool',
  web: 'looked something up online',
  other: 'used a tool',
};

/** Human-readable description derived only from stored, sanitized event fields. */
export function describeEvent(ev: EventRow, project?: Pick<ProjectRow, 'name'> | null): string {
  const d = ev.data as Record<string, string | number | undefined>;
  const who = 'Claude';
  switch (ev.type) {
    case 'session.start':
      return d.source === 'resume' ? `${who} resumed a session` : `${who} started a session`;
    case 'session.end':
      return `Session ended${d.reason ? ` (${String(d.reason).replace(/_/g, ' ')})` : ''}`;
    case 'prompt.submit':
      return d.summary ? `New request (${d.promptKind ?? 'task'}): ${d.summary}` : `New request (${d.promptKind ?? 'task'})`;
    case 'tool.start':
      return d.category === 'test' ? `${who} started running tests` : `${who} started a ${d.category} command`;
    case 'tool.done':
      return `${who} ${TOOL_VERB[String(d.category ?? 'other')] ?? 'used a tool'}${d.tool ? ` (${d.tool})` : ''}`;
    case 'tool.fail':
      return d.errorKind === 'interrupt'
        ? `A ${d.category ?? 'tool'} run was interrupted by you`
        : `${d.category === 'test' ? 'Tests failed' : d.category === 'build' ? 'A build/lint check failed' : d.category === 'deploy' ? 'A deploy command failed' : `A tool call failed${d.tool ? ` (${d.tool})` : ''}`}`;
    case 'notification':
      return d.notificationType === 'permission_prompt' ? `${who} is waiting for your permission` : d.notificationType === 'idle_prompt' ? `${who} is idle, waiting for you` : `Notification: ${String(d.notificationType ?? 'unknown').replace(/_/g, ' ')}`;
    case 'subagent.start':
      return `${who} started a subagent${d.agentType ? ` (${d.agentType})` : ''}`;
    case 'subagent.stop':
      return `A subagent finished${d.agentType ? ` (${d.agentType})` : ''}`;
    case 'turn.stop':
      return `${who} finished responding`;
    case 'turn.fail':
      return `${who}'s turn ended with an error${d.reason ? ` (${String(d.reason).replace(/_/g, ' ')})` : ''}`;
    case 'user.action':
      return `You: ${String(d.action ?? 'action').replace(/_/g, ' ')}${project ? ` — ${project.name}` : ''}`;
    case 'system.maintenance':
      return 'Inactive sessions were tidied up (finished work completed, silent sessions marked lost)';
    default:
      return ev.type;
  }
}

export function taskStatusLabel(t: Pick<TaskRow, 'status'>) {
  return STATUS_LABEL[t.status];
}

export const COMPLETION_BASIS_LABEL: Record<string, string> = {
  answered: 'Question answered',
  claude_finished_session_closed: 'Claude finished its last turn and the session was closed. Not verified by tests or deployment.',
  claude_finished_then_idle: 'Claude finished and nothing happened for 10+ minutes. Not verified by tests or deployment.',
  user_marked: 'Marked complete by you',
};

export function sessionLabel(s: SessionRow, stale: boolean) {
  if (stale) return 'Disconnected (no events for 30+ min)';
  return { active: 'Active', idle: 'Idle (waiting for you)', ended: 'Ended', lost: 'Lost contact' }[s.status];
}
