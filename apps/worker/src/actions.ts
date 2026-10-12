import {
  deriveBuilding,
  deriveDeployStatus,
  deriveLifecycle,
  isOpenTask,
  markStale,
  slotPosition,
  type Delta,
  type Model,
  type ProjectAggregates,
  type ProjectBuilding,
  type TaskRow,
  type TaskStatus,
} from '@mdw/shared';
import { currentCursor } from './ingest.js';
import { eventRow, PROJECT_SELECT, projectRow, sessionRow, taskRow } from './rows.js';

/** Recompute lifecycle/location of a project straight from persisted rows. */
export async function recomputeProject(db: D1Database, projectId: string, now: number, extra: D1PreparedStatement[] = []) {
  const p = await db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).bind(projectId).first<Record<string, unknown>>();
  if (!p) return null;
  const project = projectRow(p);
  const tasks = (await db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC').bind(projectId).all<Record<string, unknown>>()).results.map(taskRow);
  const live = await db.prepare(`SELECT COUNT(*) c FROM sessions WHERE project_id = ? AND status IN ('active','idle')`).bind(projectId).first<{ c: number }>();
  const open = tasks.filter((t) => isOpenTask(t.status));
  const agg: ProjectAggregates = {
    focusTaskStatus: open[0]?.status ?? null,
    openTasks: open.length,
    completedTasks: tasks.filter((t) => t.status === 'completed').length,
    liveSessions: live?.c ?? 0,
    testStatus: project.testStatus,
    deployStatus: String(p.deploy_raw) as ProjectAggregates['deployStatus'],
    deployHints: project.deployHints,
    userPaused: project.userPaused,
    activityLevel: project.activityLevel,
    currentBuilding: project.building,
  };
  const building = deriveBuilding(agg);
  const lifecycle = deriveLifecycle(agg);
  const deployStatus = deriveDeployStatus({ deployStatus: agg.deployStatus, testStatus: agg.testStatus, deployHints: agg.deployHints, focusTaskStatus: agg.focusTaskStatus });
  let { slot, x, z } = project;
  const stmts = [...extra];
  if (building !== project.building) {
    const used = new Set((await db.prepare('SELECT slot FROM project_locations WHERE building = ? AND project_id != ?').bind(building, projectId).all<{ slot: number }>()).results.map((r) => r.slot));
    slot = 0;
    while (used.has(slot)) slot++;
    [x, z] = slotPosition(building as ProjectBuilding, slot);
    stmts.push(db.prepare('UPDATE project_locations SET building=?, slot=?, x=?, z=? WHERE project_id=?').bind(building, slot, x, z, projectId));
  }
  return { stmts, project: { ...project, building, slot, x, z, lifecycle, deployStatus }, lifecycle, deployStatus, tasks };
}

export type UserAction =
  | { action: 'pause_project'; projectId: string }
  | { action: 'resume_project'; projectId: string }
  | { action: 'complete_task'; taskId: string }
  | { action: 'reopen_task'; taskId: string }
  | { action: 'rename_project'; projectId: string; name: string };

export class ActionError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Dashboard-initiated state changes. They are logged as `user.action` events. */
export async function applyUserAction(db: D1Database, a: UserAction, now = Date.now()): Promise<Delta> {
  const seq = (await currentCursor(db)) + 1;
  let projectId: string;
  let taskId: string | null = null;
  const stmts: D1PreparedStatement[] = [];

  if (a.action === 'complete_task' || a.action === 'reopen_task') {
    const t = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(a.taskId).first<Record<string, unknown>>();
    if (!t) throw new ActionError(404, 'task_not_found');
    projectId = String(t.project_id);
    taskId = a.taskId;
    if (a.action === 'complete_task') {
      stmts.push(db.prepare(`UPDATE tasks SET status='completed', completed_at=?, completion_basis='user_marked', updated_at=?, state_ts=MAX(state_ts,?), version=? WHERE id=?`).bind(now, now, now, seq, taskId));
    } else {
      const sess = t.session_id ? await db.prepare('SELECT status FROM sessions WHERE id=?').bind(t.session_id).first<{ status: string }>() : null;
      const status: TaskStatus = sess && (sess.status === 'active' || sess.status === 'idle') ? 'in_development' : 'paused';
      stmts.push(db.prepare(`UPDATE tasks SET status=?, completed_at=NULL, completion_basis=NULL, updated_at=?, state_ts=MAX(state_ts,?), version=? WHERE id=?`).bind(status, now, now, seq, taskId));
    }
  } else {
    projectId = a.projectId;
    const p = await db.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first();
    if (!p) throw new ActionError(404, 'project_not_found');
    if (a.action === 'pause_project') stmts.push(db.prepare('UPDATE projects SET user_paused=1 WHERE id=?').bind(projectId));
    if (a.action === 'resume_project') stmts.push(db.prepare('UPDATE projects SET user_paused=0 WHERE id=?').bind(projectId));
    if (a.action === 'rename_project') {
      const name = a.name.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!name) throw new ActionError(400, 'empty_name');
      stmts.push(db.prepare('UPDATE projects SET name=?, name_locked=1 WHERE id=?').bind(name, projectId));
    }
  }

  const evId = `ua_${now.toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  stmts.push(
    db
      .prepare(`INSERT INTO events (seq, id, type, project_id, session_id, task_id, ts, ingested_at, schema_version, source, late, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(seq, evId, 'user.action', projectId, null, taskId, now, now, 1, 'dashboard', 0, JSON.stringify({ action: a.action })),
  );
  await db.batch(stmts); // state change + audit event, atomically
  const r = await recomputeProject(db, projectId, now);
  if (!r) throw new ActionError(404, 'project_not_found');
  await db.batch([
    ...r.stmts,
    db.prepare('UPDATE projects SET lifecycle=?, deploy_status=?, version=?, updated_at=? WHERE id=?').bind(r.lifecycle, r.deployStatus, seq, now, projectId),
  ]);
  return loadDelta(db, [projectId], taskId ? [taskId] : [], [], seq);
}

export async function loadDelta(db: D1Database, projectIds: string[], taskIds: string[], sessionIds: string[], cursor: number): Promise<Delta> {
  const projects = [];
  for (const id of projectIds) {
    const r = await db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).bind(id).first<Record<string, unknown>>();
    if (r) projects.push(projectRow(r));
  }
  const tasks: TaskRow[] = [];
  for (const id of taskIds) {
    const r = await db.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first<Record<string, unknown>>();
    if (r) tasks.push(taskRow(r));
  }
  const sessions = [];
  for (const id of sessionIds) {
    const r = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<Record<string, unknown>>();
    if (r) sessions.push(sessionRow(r));
  }
  const ev = await db.prepare('SELECT * FROM events WHERE seq = ?').bind(cursor).first<Record<string, unknown>>();
  return { type: 'delta', cursor, projects, sessions, tasks, events: ev ? [eventRow(ev)] : [] };
}

/** Periodic maintenance: mark silent sessions lost, apply retention. Serialized through the Hub. */
export async function maintenance(db: D1Database, retentionDays: number, now = Date.now()): Promise<Delta | null> {
  const cutoff = now - 30 * 60 * 1000;
  const { results } = await db.prepare(`SELECT * FROM sessions WHERE status IN ('active','idle') AND last_event_at < ?`).bind(cutoff).all<Record<string, unknown>>();
  const touchedProjects = new Set<string>();
  const touchedTasks: string[] = [];
  const touchedSessions: string[] = [];
  const seq = (await currentCursor(db)) + 1; // one real event seq for the whole sweep
  for (const row of results) {
    const session = sessionRow(row);
    const tasks = (await db.prepare('SELECT * FROM tasks WHERE session_id = ?').bind(session.id).all<Record<string, unknown>>()).results.map(taskRow);
    const model: Model = {
      facts: { testStatus: 'unknown', deployStatus: 'none', testTs: 0, deployTs: 0, activityLevel: 'developing', lastActive: session.lastEventAt },
      session,
      tasks,
    };
    const r = markStale(model, now);
    if (!r) continue;
    const stmts = [db.prepare(`UPDATE sessions SET status='lost' WHERE id=?`).bind(session.id)];
    for (const id of r.changedTaskIds) {
      stmts.push(db.prepare(`UPDATE tasks SET status='interrupted', updated_at=?, version=? WHERE id=?`).bind(now, seq, id));
      touchedTasks.push(id);
    }
    await db.batch(stmts);
    touchedProjects.add(session.projectId);
    touchedSessions.push(session.id);
  }
  if (touchedProjects.size) {
    for (const pid of touchedProjects) {
      const r = await recomputeProject(db, pid, now);
      if (r) await db.batch([...r.stmts, db.prepare('UPDATE projects SET lifecycle=?, deploy_status=?, version=?, updated_at=? WHERE id=?').bind(r.lifecycle, r.deployStatus, seq, now, pid)]);
    }
    await db
      .prepare(`INSERT INTO events (seq, id, type, project_id, session_id, task_id, ts, ingested_at, schema_version, source, late, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(seq, `sys_${now.toString(36)}_${crypto.randomUUID().slice(0, 8)}`, 'system.maintenance', null, null, null, now, now, 1, 'system', 0, JSON.stringify({ sessionsLost: touchedSessions.length }))
      .run();
  }
  // Retention + housekeeping
  await db.batch([
    db.prepare('DELETE FROM events WHERE ts < ?').bind(now - retentionDays * 86_400_000),
    db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE window < ?').bind(Math.floor(now / 1000) - 7200),
  ]);
  if (!touchedProjects.size) return null;
  return loadDelta(db, [...touchedProjects], touchedTasks, touchedSessions, seq);
}
