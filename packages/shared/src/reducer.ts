import type { Envelope } from './events.js';
import { MODIFYING_CATEGORIES } from './classify.js';
import {
  isOpenTask,
  type BuildingId,
  type DeployStatus,
  type Lifecycle,
  type ProjectBuilding,
  type PromptKind,
  type SessionRow,
  type TaskKind,
  type TaskRow,
  type TaskStatus,
  type TestStatus,
} from './model.js';

/**
 * Pure state machine. The worker loads the affected rows, calls `applyEvent`,
 * and persists the result. Rules (documented in docs/STATE_MAPPING.md):
 *
 *  - Only tool/state evidence moves a task forward; a session ending never
 *    marks work complete on its own.
 *  - Events older than the entity's `stateTs` are stored but never overwrite
 *    newer state ("late" events).
 *  - Unknown things stay unknown (testStatus 'unknown', deployStatus 'none').
 */

export interface ProjectFacts {
  testStatus: TestStatus;
  deployStatus: DeployStatus;
  testTs: number;
  deployTs: number;
  activityLevel: 'observed' | 'developing';
  lastActive: number;
}

export interface Model {
  facts: ProjectFacts;
  session: SessionRow;
  /** Tasks of this session (newest last). */
  tasks: TaskRow[];
}

export interface Outcome {
  model: Model;
  late: boolean;
  /** Task the event was attributed to. */
  taskId: string | null;
  createdTaskIds: string[];
  changedTaskIds: string[];
}

export const STALE_SESSION_MS = 30 * 60 * 1000;

/** Notification types that mean Claude is blocked on the user. */
const BLOCKING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

function openTasks(m: Model): TaskRow[] {
  return m.tasks.filter((t) => isOpenTask(t.status));
}
function currentTask(m: Model): TaskRow | undefined {
  const o = openTasks(m);
  return o[o.length - 1];
}

export function newTaskId(ev: Envelope): string {
  return `t_${ev.id}`;
}

function setStatus(t: TaskRow, status: TaskStatus, ts: number, ctx: { basis?: string } = {}) {
  if (ts < t.stateTs) return false; // out-of-order: never regress newer state
  t.status = status;
  t.stateTs = ts;
  t.updatedAt = Math.max(t.updatedAt, ts);
  if (status === 'completed') {
    t.completedAt = ts;
    t.completionBasis = ctx.basis ?? null;
  }
  return true;
}

function createTask(m: Model, ev: Envelope, kind: TaskKind, summary: string, status: TaskStatus): TaskRow {
  const t: TaskRow = {
    id: newTaskId(ev),
    projectId: m.session.projectId,
    sessionId: m.session.id,
    kind,
    summary,
    status,
    createdAt: ev.ts,
    updatedAt: ev.ts,
    stateTs: ev.ts,
    completedAt: null,
    completionBasis: null,
    failStreak: 0,
    version: 0,
  };
  m.tasks.push(t);
  return t;
}

export function applyEvent(input: Model, ev: Envelope): Outcome {
  const m: Model = structuredClone(input);
  const out: Outcome = { model: m, late: false, taskId: null, createdTaskIds: [], changedTaskIds: [] };
  const s = m.session;
  const f = m.facts;
  const touch = (t: TaskRow) => {
    if (!out.changedTaskIds.includes(t.id)) out.changedTaskIds.push(t.id);
  };

  const prevLast = s.lastEventAt;
  f.lastActive = Math.max(f.lastActive, ev.ts);
  s.lastEventAt = Math.max(s.lastEventAt, ev.ts);
  s.startedAt = Math.min(s.startedAt, ev.ts);

  // An event newer than the session end reactivates (resume) — unless it is the end itself.
  const sessionStale = ev.ts < s.stateTs;
  out.late = sessionStale || ev.ts < prevLast;
  if (ev.data.permissionMode && !sessionStale) s.permissionMode = ev.data.permissionMode;

  const reactivate = () => {
    if (sessionStale) return;
    if (s.status === 'ended' || s.status === 'lost') {
      s.status = 'active';
      s.endedAt = null;
      s.stateTs = ev.ts;
    } else if (s.status === 'idle' && ev.type !== 'notification') s.status = 'active';
  };

  switch (ev.type) {
    case 'session.start': {
      if (!sessionStale) {
        s.status = 'active';
        s.endedAt = null;
        s.stateTs = ev.ts;
      }
      break;
    }

    case 'prompt.submit': {
      reactivate();
      const kind: PromptKind = ev.data.promptKind ?? 'other';
      const summary = ev.data.summary ?? '';
      const cur = currentTask(m);
      // Adopt an implicit "activity" task created from tool events that arrived before this prompt.
      if (cur && cur.kind === 'activity' && ev.ts <= cur.createdAt) {
        cur.kind = kind === 'continuation' ? 'other' : kind;
        cur.summary = summary || cur.summary;
        cur.createdAt = ev.ts;
        out.taskId = cur.id;
        touch(cur);
        break;
      }
      const attach = cur && (kind === 'continuation' || (kind === 'other' && ev.data.confidence !== 'high'));
      if (attach && cur) {
        out.taskId = cur.id;
        if (setStatus(cur, 'received', ev.ts)) cur.failStreak = 0;
        touch(cur);
      } else if (!sessionStale || !cur) {
        const t = createTask(m, ev, kind === 'continuation' ? 'other' : kind, summary, 'received');
        out.taskId = t.id;
        out.createdTaskIds.push(t.id);
        touch(t);
        // Fresh work resets stale test results only when the previous task is done.
      }
      if (kind !== 'question' && kind !== 'continuation') f.activityLevel = 'developing';
      break;
    }

    case 'tool.start':
    case 'tool.done':
    case 'tool.fail': {
      reactivate();
      const cat = ev.data.category ?? 'other';
      const isModifying = MODIFYING_CATEGORIES.includes(cat);
      let t = currentTask(m);
      if (!t && isModifying && !sessionStale) {
        t = createTask(m, ev, 'activity', '', 'in_development');
        out.createdTaskIds.push(t.id);
      }
      if (t) {
        out.taskId = t.id;
        const ok = ev.type !== 'tool.fail';
        if (ev.type === 'tool.fail' && ev.data.errorKind === 'interrupt') {
          // The user aborted the tool. Claude is stopped and Stop will not fire: it is now waiting on the user.
          if (f.testStatus === 'running' && ev.ts >= f.testTs) {
            f.testStatus = 'unknown';
            f.testTs = ev.ts;
          }
          if (f.deployStatus === 'running' && ev.ts >= f.deployTs) {
            f.deployStatus = 'none';
            f.deployTs = ev.ts;
          }
          setStatus(t, 'waiting_input', ev.ts);
        } else if (ev.type === 'tool.start') {
          if (cat === 'test') {
            if (setStatus(t, 'testing', ev.ts) && ev.ts >= f.testTs) {
              f.testStatus = 'running';
              f.testTs = ev.ts;
            }
          } else if (cat === 'deploy') {
            if (ev.ts >= f.deployTs) {
              f.deployStatus = 'running';
              f.deployTs = ev.ts;
            }
          }
        } else if (ok) {
          if (ev.ts >= t.stateTs) t.failStreak = 0;
          if (cat === 'test') {
            if (ev.ts >= f.testTs) {
              f.testStatus = 'passing';
              f.testTs = ev.ts;
            }
            setStatus(t, 'in_development', ev.ts);
          } else if (cat === 'deploy') {
            if (ev.ts >= f.deployTs) {
              f.deployStatus = 'command_succeeded';
              f.deployTs = ev.ts;
            }
            setStatus(t, 'in_development', ev.ts);
          } else if (cat === 'read' || cat === 'web') {
            // Reading before any modification = investigating/planning.
            if (t.status === 'received' || t.status === 'waiting_input') setStatus(t, 'planning', ev.ts);
          } else {
            const wasAttention = t.status === 'needs_attention';
            // Keep needs_attention until the failing check passes again, unless it came from generic failures.
            if (!(wasAttention && f.testStatus === 'failing')) setStatus(t, 'in_development', ev.ts);
          }
          if (isModifying && f.activityLevel !== 'developing') f.activityLevel = 'developing';
        } else {
          // Failure
          if (ev.ts >= t.stateTs) t.failStreak += 1;
          if (cat === 'test') {
            if (ev.ts >= f.testTs) {
              f.testStatus = 'failing';
              f.testTs = ev.ts;
            }
            setStatus(t, 'needs_attention', ev.ts);
          } else if (cat === 'build') {
            setStatus(t, 'needs_attention', ev.ts);
          } else if (cat === 'deploy') {
            if (ev.ts >= f.deployTs) {
              f.deployStatus = 'failed';
              f.deployTs = ev.ts;
            }
            setStatus(t, 'needs_attention', ev.ts);
          } else if (t.failStreak >= 3) {
            setStatus(t, 'needs_attention', ev.ts);
          }
        }
        touch(t);
      }
      if (ev.type === 'tool.done' && isModifying) f.activityLevel = 'developing';
      break;
    }

    case 'notification': {
      const t = currentTask(m);
      if (t) out.taskId = t.id;
      const nt = ev.data.notificationType ?? '';
      if (BLOCKING_NOTIFICATIONS.has(nt)) {
        reactivate();
        if (t && setStatus(t, 'waiting_input', ev.ts)) touch(t);
      } else if (nt === 'idle_prompt' && !sessionStale && s.status === 'active') {
        s.status = 'idle';
      }
      break;
    }

    case 'subagent.start':
    case 'subagent.stop': {
      reactivate();
      const t = currentTask(m);
      if (t) out.taskId = t.id;
      break;
    }

    case 'turn.stop': {
      reactivate();
      if (!sessionStale) s.status = 'idle';
      const t = currentTask(m);
      if (t) {
        out.taskId = t.id;
        if (t.kind === 'question') {
          if (setStatus(t, 'completed', ev.ts, { basis: 'answered' })) touch(t);
        } else if (t.status === 'needs_attention' || f.testStatus === 'failing') {
          // Claude stopped while checks are failing: stay in attention.
          if (setStatus(t, 'needs_attention', ev.ts)) touch(t);
        } else if (setStatus(t, 'ready_for_review', ev.ts)) touch(t);
      }
      break;
    }

    case 'turn.fail': {
      reactivate();
      const t = currentTask(m);
      if (t) {
        out.taskId = t.id;
        if (setStatus(t, 'failed', ev.ts)) touch(t);
      }
      if (!sessionStale) s.status = 'idle';
      break;
    }

    case 'session.end': {
      // A late end that predates newer activity means the session continued: ignore it.
      if (!sessionStale && ev.ts >= prevLast) {
        s.status = 'ended';
        s.endedAt = ev.ts;
        s.stateTs = ev.ts;
        for (const t of openTasks(m)) {
          if (t.status === 'ready_for_review' && f.testStatus !== 'failing') {
            // Evidence: Claude finished its last turn cleanly and the user then closed the session.
            if (setStatus(t, 'completed', ev.ts, { basis: 'claude_finished_session_closed' })) touch(t);
          } else if (t.status === 'needs_attention') {
            // keep: unresolved problems must stay visible
          } else if (setStatus(t, 'interrupted', ev.ts)) touch(t);
        }
      }
      break;
    }
  }

  return out;
}

/** Sessions with no event for STALE_SESSION_MS are marked lost; their in-flight tasks interrupted. */
export function markStale(m: Model, now: number): { model: Model; changedTaskIds: string[] } | null {
  if (m.session.status === 'ended' || m.session.status === 'lost') return null;
  if (now - m.session.lastEventAt < STALE_SESSION_MS) return null;
  const c: Model = structuredClone(m);
  c.session.status = 'lost';
  const changed: string[] = [];
  for (const t of c.tasks) {
    if (isOpenTask(t.status) && t.status !== 'ready_for_review' && t.status !== 'needs_attention') {
      t.status = 'interrupted';
      t.updatedAt = now;
      changed.push(t.id);
    }
  }
  return { model: c, changedTaskIds: changed };
}

// ---------------------------------------------------------------------------
// Project-level derivation (location + lifecycle) from aggregate facts.
// ---------------------------------------------------------------------------

export interface ProjectAggregates {
  focusTaskStatus: TaskStatus | null; // status of the most recently updated open task
  openTasks: number;
  completedTasks: number;
  liveSessions: number;
  testStatus: TestStatus;
  deployStatus: DeployStatus;
  deployHints: string[];
  userPaused: boolean;
  activityLevel: 'observed' | 'developing';
  currentBuilding: ProjectBuilding;
}

export function deriveBuilding(a: ProjectAggregates): ProjectBuilding {
  if (a.userPaused) return a.currentBuilding;
  const st = a.focusTaskStatus;
  if (!st) {
    if (a.completedTasks > 0 && a.liveSessions === 0) return 'completed';
    return a.currentBuilding;
  }
  if (st === 'needs_attention' || st === 'failed' || a.testStatus === 'failing') return 'workshop';
  if (st === 'testing') return 'testing';
  if (st === 'ready_for_review') {
    const deployReady = a.testStatus === 'passing' && a.deployHints.length > 0;
    return deployReady ? 'deployment' : 'development';
  }
  if (st === 'planning' || st === 'waiting_input') return 'planning';
  if (st === 'received') return 'intake';
  return 'development';
}

export function deriveLifecycle(a: ProjectAggregates): Lifecycle {
  if (a.userPaused) return 'paused';
  if (a.focusTaskStatus === 'needs_attention' || a.focusTaskStatus === 'failed') return 'attention';
  if (a.openTasks > 0) return 'active';
  if (a.completedTasks > 0) return a.liveSessions > 0 ? 'active' : 'completed';
  return a.liveSessions > 0 ? 'active' : a.activityLevel === 'developing' ? 'idle' : 'new';
}

/** "Ready" deployment status is derived: passing tests + known deploy tooling, never claimed live. */
export function deriveDeployStatus(a: { deployStatus: DeployStatus; testStatus: TestStatus; deployHints: string[]; focusTaskStatus: TaskStatus | null }): DeployStatus {
  if (a.deployStatus === 'running' || a.deployStatus === 'failed' || a.deployStatus === 'command_succeeded') return a.deployStatus;
  if (a.testStatus === 'passing' && a.deployHints.length > 0 && a.focusTaskStatus === 'ready_for_review') return 'ready';
  return 'none';
}

export const BUILDING_FOR_STATUS_DOC: Record<string, BuildingId> = {};
