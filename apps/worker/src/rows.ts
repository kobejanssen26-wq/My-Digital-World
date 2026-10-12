import type { EventRow, ProjectRow, SessionRow, TaskRow, ProjectBuilding, Settings } from '@mdw/shared';
import { DEFAULT_SETTINGS } from '@mdw/shared';

type R = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);
const s = (v: unknown) => String(v ?? '');

export const PROJECT_SELECT = `SELECT p.*, l.building, l.slot, l.x, l.z, l.hue FROM projects p JOIN project_locations l ON l.project_id = p.id`;

export function projectRow(r: R): ProjectRow {
  return {
    id: s(r.id),
    name: s(r.name),
    summary: s(r.summary),
    repo: (r.repo as string | null) ?? null,
    projectType: (r.project_type as string | null) ?? null,
    lifecycle: s(r.lifecycle) as ProjectRow['lifecycle'],
    activityLevel: s(r.activity_level) as ProjectRow['activityLevel'],
    testStatus: s(r.test_status) as ProjectRow['testStatus'],
    deployStatus: s(r.deploy_status) as ProjectRow['deployStatus'],
    deployHints: JSON.parse(s(r.deploy_hints) || '[]'),
    userPaused: n(r.user_paused) === 1,
    building: s(r.building) as ProjectBuilding,
    slot: n(r.slot),
    x: n(r.x),
    z: n(r.z),
    hue: n(r.hue),
    firstSeen: n(r.first_seen),
    lastActive: n(r.last_active),
    version: n(r.version),
  };
}

export function sessionRow(r: R): SessionRow {
  return {
    id: s(r.id),
    projectId: s(r.project_id),
    startedAt: n(r.started_at),
    endedAt: r.ended_at == null ? null : n(r.ended_at),
    status: s(r.status) as SessionRow['status'],
    lastEventAt: n(r.last_event_at),
    stateTs: n(r.state_ts),
    permissionMode: (r.permission_mode as string | null) ?? null,
  };
}

export function taskRow(r: R): TaskRow {
  return {
    id: s(r.id),
    projectId: s(r.project_id),
    sessionId: (r.session_id as string | null) ?? null,
    kind: s(r.kind) as TaskRow['kind'],
    summary: s(r.summary),
    status: s(r.status) as TaskRow['status'],
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
    stateTs: n(r.state_ts),
    completedAt: r.completed_at == null ? null : n(r.completed_at),
    completionBasis: (r.completion_basis as string | null) ?? null,
    failStreak: n(r.fail_streak),
    version: n(r.version),
  };
}

export function eventRow(r: R): EventRow {
  return {
    seq: n(r.seq),
    id: s(r.id),
    type: s(r.type),
    projectId: (r.project_id as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
    ts: n(r.ts),
    ingestedAt: n(r.ingested_at),
    late: n(r.late) === 1,
    data: JSON.parse(s(r.data) || '{}'),
  };
}

export async function loadSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of results) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* ignore corrupt value */
    }
  }
  return out as unknown as Settings;
}
