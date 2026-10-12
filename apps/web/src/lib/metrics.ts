import { isOpenTask, type ProjectRow, type SessionRow, type TaskRow, type TaskStatus } from '@mdw/shared';
import type { Data } from './data.js';

export const STALE_MS = 30 * 60 * 1000;
export const IN_PROGRESS: TaskStatus[] = ['received', 'planning', 'in_development', 'testing'];
export const ATTENTION: TaskStatus[] = ['needs_attention', 'failed', 'waiting_input'];

export const serverNow = (d: Data, clientNow: number) => clientNow + d.serverSkew;
export const isLive = (s: SessionRow) => s.status === 'active' || s.status === 'idle';
export const isStale = (s: SessionRow, now: number) => isLive(s) && now - s.lastEventAt > STALE_MS;

export interface Metrics {
  activeProjects: number;
  tasksInProgress: number;
  tasksNeedingAttention: number;
  completedTasks: number;
  connectedSessions: number;
  lastSync: number | null;
}

/** Everything is computed from persisted rows — no constants, no placeholders. */
export function computeMetrics(d: Data, now: number): Metrics {
  const projects = Object.values(d.projects).filter((p) => p.activityLevel === 'developing');
  const tasks = Object.values(d.tasks);
  const visible = new Set(projects.map((p) => p.id));
  return {
    activeProjects: projects.filter((p) => p.lifecycle === 'active' || p.lifecycle === 'attention').length,
    tasksInProgress: tasks.filter((t) => visible.has(t.projectId) && IN_PROGRESS.includes(t.status)).length,
    tasksNeedingAttention: tasks.filter((t) => visible.has(t.projectId) && ATTENTION.includes(t.status)).length,
    completedTasks: tasks.filter((t) => t.status === 'completed' && visible.has(t.projectId)).length,
    connectedSessions: Object.values(d.sessions).filter((s) => isLive(s) && !isStale(s, now)).length,
    lastSync: d.bridge.lastIngestAt,
  };
}

export type Health = { level: 'none' | 'waiting' | 'ok' | 'quiet' | 'stale'; label: string; detail: string };

/**
 * Server-side view of the integration. The server can only know when it last received events;
 * the bridge's own queue/health is shown by `mdw-bridge status` (documented), never invented here.
 */
export function integrationHealth(d: Data, now: number): Health {
  const active = d.bridge.tokens.filter((t) => !t.revokedAt);
  if (!active.length) return { level: 'none', label: 'Not connected', detail: 'No bridge credential has been created yet.' };
  const last = d.bridge.lastIngestAt;
  if (!last) return { level: 'waiting', label: 'Waiting for first event', detail: 'A bridge credential exists but no event has arrived.' };
  const age = now - last;
  if (age < 10 * 60 * 1000) return { level: 'ok', label: 'Receiving events', detail: `Last event ${Math.max(0, Math.round(age / 1000))}s ago.` };
  if (age < 6 * 3600 * 1000) return { level: 'quiet', label: 'Quiet', detail: 'No events recently. This is normal when Claude Code is not in use.' };
  return { level: 'stale', label: 'No recent events', detail: 'Nothing received for hours. If you have been using Claude Code, check `mdw-bridge status`.' };
}

export type Filter = 'all' | 'active' | 'paused' | 'completed' | 'failed';

export function projectStatus(p: ProjectRow, data: Data, now: number): { key: string; label: string; tone: 'ok' | 'warn' | 'bad' | 'idle' | 'done' | 'info' } {
  if (p.userPaused) return { key: 'paused', label: 'Paused', tone: 'idle' };
  const tasks = Object.values(data.tasks).filter((t) => t.projectId === p.id && isOpenTask(t.status));
  const focus = tasks.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const live = Object.values(data.sessions).filter((s) => s.projectId === p.id && isLive(s));
  const allStale = live.length > 0 && live.every((s) => isStale(s, now));
  if (focus && allStale && !ATTENTION.includes(focus.status)) return { key: 'disconnected', label: 'Disconnected', tone: 'idle' };
  if (focus) {
    const tone = ATTENTION.includes(focus.status) ? (focus.status === 'waiting_input' ? 'warn' : 'bad') : focus.status === 'ready_for_review' ? 'info' : 'ok';
    return { key: focus.status, label: LABELS[focus.status], tone };
  }
  if (p.lifecycle === 'completed') return { key: 'completed', label: 'Completed', tone: 'done' };
  if (p.activityLevel === 'observed') return { key: 'observed', label: 'Observed only', tone: 'idle' };
  return { key: 'idle', label: 'Idle', tone: 'idle' };
}

const LABELS: Record<TaskStatus, string> = {
  received: 'Received',
  planning: 'Planning',
  in_development: 'In development',
  waiting_input: 'Waiting for input',
  testing: 'Testing',
  needs_attention: 'Needs attention',
  ready_for_review: 'Ready for review',
  completed: 'Completed',
  paused: 'Paused',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

export function matchesFilter(p: ProjectRow, f: Filter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'active':
      return !p.userPaused && (p.lifecycle === 'active' || p.lifecycle === 'attention' || p.lifecycle === 'new');
    case 'paused':
      return p.userPaused || p.lifecycle === 'paused';
    case 'completed':
      return p.lifecycle === 'completed';
    case 'failed':
      return p.lifecycle === 'attention' || p.testStatus === 'failing';
  }
}

export function filterProjects(d: Data, filter: Filter, query: string, showObserved = false): ProjectRow[] {
  const q = query.trim().toLowerCase();
  return Object.values(d.projects)
    .filter((p) => (showObserved || p.activityLevel === 'developing') && matchesFilter(p, filter) && (!q || p.name.toLowerCase().includes(q)))
    .sort((a, b) => b.lastActive - a.lastActive);
}

export function tasksOf(d: Data, projectId: string): TaskRow[] {
  return Object.values(d.tasks).filter((t) => t.projectId === projectId).sort((a, b) => b.createdAt - a.createdAt);
}
