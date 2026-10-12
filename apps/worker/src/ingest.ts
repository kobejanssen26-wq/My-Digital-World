import {
  applyEvent,
  cleanText,
  deriveBuilding,
  deriveDeployStatus,
  deriveLifecycle,
  hueFor,
  isOpenTask,
  parseEnvelope,
  redactSecrets,
  resolveProject,
  slotPosition,
  type Delta,
  type Envelope,
  type IngestResult,
  type Model,
  type ProjectAggregates,
  type ProjectBuilding,
  type ProjectRow,
  type SessionRow,
  type TaskRow,
} from '@mdw/shared';
import { eventRow, PROJECT_SELECT, projectRow, sessionRow, taskRow } from './rows.js';

/**
 * Event ingestion. MUST be called serialized (the Hub durable object guarantees this) because it
 * reads, computes and then writes project state.
 */

const sha = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

export interface BatchResult {
  results: IngestResult[];
  delta: Delta | null;
}

type Acc = { projects: Map<string, ProjectRow>; sessions: Map<string, SessionRow>; tasks: Map<string, TaskRow>; events: ReturnType<typeof eventRow>[]; cursor: number };

export async function currentCursor(db: D1Database): Promise<number> {
  const r = await db.prepare('SELECT COALESCE(MAX(seq),0) AS c FROM events').first<{ c: number }>();
  return r?.c ?? 0;
}

export async function ingestBatch(db: D1Database, raws: unknown[], now = Date.now()): Promise<BatchResult> {
  const results: IngestResult[] = [];
  const acc: Acc = { projects: new Map(), sessions: new Map(), tasks: new Map(), events: [], cursor: 0 };
  for (const raw of raws) {
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) {
      results.push({ id: parsed.id, status: 'rejected', reason: parsed.reason });
      continue;
    }
    try {
      results.push(await ingestOne(db, parsed.event, now, acc));
    } catch (e) {
      // Transient (e.g. D1 hiccup): report as retryable, never as a permanent rejection.
      throw new Error(`ingest_failed:${parsed.event.id}:${(e as Error).message}`);
    }
  }
  const delta: Delta | null = acc.events.length
    ? {
        type: 'delta',
        cursor: acc.cursor,
        projects: [...acc.projects.values()],
        sessions: [...acc.sessions.values()],
        tasks: [...acc.tasks.values()],
        events: acc.events,
      }
    : null;
  return { results, delta };
}

async function loadProject(db: D1Database, id: string): Promise<(ProjectRow & { testTs: number; deployTs: number; deployRaw: string; nameLocked: boolean }) | null> {
  const r = await db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!r) return null;
  return { ...projectRow(r), testTs: Number(r.test_ts), deployTs: Number(r.deploy_ts), deployRaw: String(r.deploy_raw), nameLocked: r.name_locked === 1 };
}

async function resolveProjectId(db: D1Database, ev: Envelope): Promise<{ id: string; create: boolean; addKeys: string[] } | null> {
  const ref = ev.project;
  if (!ref) return null;
  const ph = ref.keys.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT alias, project_id FROM project_aliases WHERE project_id IN (SELECT project_id FROM project_aliases WHERE alias IN (${ph}))`)
    .bind(...ref.keys)
    .all<{ alias: string; project_id: string }>();
  const byProject = new Map<string, string[]>();
  for (const r of results) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), r.alias]);
  const res = resolveProject(ref.keys, [...byProject].map(([id, keys]) => ({ id, keys })));
  if (res.kind === 'existing') return { id: res.projectId, create: false, addKeys: res.addKeys };
  return { id: 'p_' + (await sha(ref.keys[0]!)).slice(0, 12), create: true, addKeys: ref.keys };
}

async function freeSlot(db: D1Database, building: ProjectBuilding, exceptId: string): Promise<number> {
  const { results } = await db.prepare('SELECT slot FROM project_locations WHERE building = ? AND project_id != ?').bind(building, exceptId).all<{ slot: number }>();
  const used = new Set(results.map((r) => r.slot));
  let i = 0;
  while (used.has(i)) i++;
  return i;
}

async function ingestOne(db: D1Database, ev: Envelope, now: number, acc: Acc): Promise<IngestResult> {
  const dupe = await db.prepare('SELECT seq FROM events WHERE id = ?').bind(ev.id).first();
  if (dupe) return { id: ev.id, status: 'duplicate' };

  const stmts: D1PreparedStatement[] = [];
  const nextSeq = (await currentCursor(db)) + 1;

  // --- session & project resolution -------------------------------------------------------
  const sessionR = await db.prepare('SELECT * FROM sessions WHERE id = ?').bind(ev.sessionId).first<Record<string, unknown>>();
  let projectId: string | null = sessionR ? String(sessionR.project_id) : null;
  let createProject = false;
  let addKeys: string[] = [];
  if (!projectId) {
    const r = await resolveProjectId(db, ev);
    if (r) ({ id: projectId, create: createProject, addKeys } = r);
  } else if (ev.project) {
    // Existing session: keep its project; learn new identity keys only if they resolve to the same project.
    const r = await resolveProjectId(db, ev);
    if (r && r.id === projectId) addKeys = r.addKeys;
  }

  if (!projectId) {
    // No way to attribute this event to a project. Keep it for audit, change no state.
    stmts.push(insertEvent(db, ev, nextSeq, null, null, null, now, false, { unattributed: true }));
    await db.batch(stmts);
    acc.cursor = nextSeq;
    acc.events.push(eventRow({ seq: nextSeq, id: ev.id, type: ev.type, project_id: null, session_id: ev.sessionId, task_id: null, ts: ev.ts, ingested_at: now, late: 0, data: JSON.stringify({ ...ev.data, unattributed: true }) }));
    return { id: ev.id, status: 'accepted', seq: nextSeq, late: false };
  }

  // --- load current state -----------------------------------------------------------------
  let project = createProject ? null : await loadProject(db, projectId);
  const ref = ev.project;
  if (!project) {
    const name = cleanText(ref?.name ?? 'Unnamed project', 80);
    const hue = hueFor(projectId);
    const building: ProjectBuilding = 'intake';
    const slot = await freeSlot(db, building, projectId);
    const [x, z] = slotPosition(building, slot);
    stmts.push(
      db
        .prepare(
          `INSERT INTO projects (id, name, repo, project_type, deploy_hints, first_seen, last_active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(projectId, name, ref?.repo ? cleanText(ref.repo, 200) : null, ref?.type ?? null, JSON.stringify(ref?.deployHints ?? []), ev.ts, ev.ts, now, now),
      db.prepare('INSERT OR IGNORE INTO project_locations (project_id, building, slot, x, z, hue) VALUES (?,?,?,?,?,?)').bind(projectId, building, slot, x, z, hue),
    );
    project = {
      id: projectId, name, summary: '', repo: ref?.repo ?? null, projectType: ref?.type ?? null, lifecycle: 'new', activityLevel: 'observed',
      testStatus: 'unknown', deployStatus: 'none', deployHints: ref?.deployHints ?? [], userPaused: false, building, slot, x, z, hue,
      firstSeen: ev.ts, lastActive: ev.ts, version: 0, testTs: 0, deployTs: 0, deployRaw: 'none', nameLocked: false,
    };
  }
  for (const k of addKeys) stmts.push(db.prepare('INSERT OR IGNORE INTO project_aliases (alias, project_id) VALUES (?,?)').bind(k, projectId));

  const session: SessionRow = sessionR
    ? sessionRow(sessionR)
    : { id: ev.sessionId, projectId, startedAt: ev.ts, endedAt: null, status: 'active', lastEventAt: ev.ts, stateTs: 0, permissionMode: null };
  const taskRows = sessionR
    ? (await db.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at, id').bind(ev.sessionId).all<Record<string, unknown>>()).results.map(taskRow)
    : [];

  const model: Model = {
    facts: {
      testStatus: project.testStatus,
      deployStatus: project.deployRaw as Model['facts']['deployStatus'],
      testTs: project.testTs,
      deployTs: project.deployTs,
      activityLevel: project.activityLevel,
      lastActive: project.lastActive,
    },
    session,
    tasks: taskRows,
  };

  // Defensive server-side sanitation of free text.
  if (ev.data.summary) ev.data.summary = cleanText(redactSecrets(ev.data.summary), 200);

  const out = applyEvent(model, ev);
  const m = out.model;

  // --- derive project-level state ---------------------------------------------------------
  const prevSessionId = ev.sessionId;
  const others = await db
    .prepare(
      `SELECT status, updated_at FROM tasks WHERE project_id = ? AND session_id IS NOT ? AND status NOT IN ('completed','failed','interrupted') ORDER BY updated_at DESC`,
    )
    .bind(projectId, prevSessionId)
    .all<{ status: string; updated_at: number }>();
  const completedOthers = await db
    .prepare(`SELECT COUNT(*) c FROM tasks WHERE project_id = ? AND session_id IS NOT ? AND status = 'completed'`)
    .bind(projectId, prevSessionId)
    .first<{ c: number }>();
  const live = await db
    .prepare(`SELECT COUNT(*) c FROM sessions WHERE project_id = ? AND id != ? AND status IN ('active','idle')`)
    .bind(projectId, prevSessionId)
    .first<{ c: number }>();

  const open = [
    ...others.results.map((r) => ({ status: r.status, updatedAt: r.updated_at })),
    ...m.tasks.filter((t) => isOpenTask(t.status)).map((t) => ({ status: t.status, updatedAt: t.updatedAt })),
  ].sort((a, b) => b.updatedAt - a.updatedAt);
  const agg: ProjectAggregates = {
    focusTaskStatus: (open[0]?.status as ProjectAggregates['focusTaskStatus']) ?? null,
    openTasks: open.length,
    completedTasks: (completedOthers?.c ?? 0) + m.tasks.filter((t) => t.status === 'completed').length,
    liveSessions: (live?.c ?? 0) + (m.session.status === 'active' || m.session.status === 'idle' ? 1 : 0),
    testStatus: m.facts.testStatus,
    deployStatus: m.facts.deployStatus,
    deployHints: project.deployHints,
    userPaused: project.userPaused,
    activityLevel: m.facts.activityLevel,
    currentBuilding: project.building,
  };
  if (ref?.deployHints?.length) {
    project.deployHints = ref.deployHints;
    agg.deployHints = ref.deployHints;
  }
  const building = deriveBuilding(agg);
  const lifecycle = deriveLifecycle(agg);
  const deployStatus = deriveDeployStatus({ deployStatus: m.facts.deployStatus, testStatus: m.facts.testStatus, deployHints: agg.deployHints, focusTaskStatus: agg.focusTaskStatus });

  let slot = project.slot;
  let x = project.x;
  let z = project.z;
  if (building !== project.building) {
    slot = await freeSlot(db, building, projectId);
    [x, z] = slotPosition(building, slot);
  }

  // Project summary: first substantive task wins; a "build" request refines it.
  let summary = project.summary;
  const createdTask = m.tasks.find((t) => out.createdTaskIds.includes(t.id));
  const adopted = out.taskId ? m.tasks.find((t) => t.id === out.taskId) : undefined;
  const candidate = createdTask ?? adopted;
  if (candidate && candidate.summary && candidate.kind !== 'question' && candidate.kind !== 'activity' && (!summary || candidate.kind === 'build')) {
    summary = candidate.summary;
  }
  const name = ref && !project.nameLocked && ref.name ? cleanText(ref.name, 80) : project.name;

  const updated: ProjectRow = {
    ...project,
    name,
    summary,
    repo: ref?.repo ? cleanText(ref.repo, 200) : project.repo,
    projectType: ref?.type ?? project.projectType,
    lifecycle,
    activityLevel: m.facts.activityLevel,
    testStatus: m.facts.testStatus,
    deployStatus,
    deployHints: agg.deployHints,
    building,
    slot,
    x,
    z,
    lastActive: m.facts.lastActive,
    version: nextSeq,
  };

  stmts.push(
    db
      .prepare(
        `UPDATE projects SET name=?, summary=?, repo=?, project_type=?, lifecycle=?, activity_level=?, test_status=?, test_ts=?, deploy_raw=?, deploy_ts=?,
           deploy_status=?, deploy_hints=?, last_active=MAX(last_active, ?), first_seen=MIN(first_seen, ?), version=?, updated_at=? WHERE id=?`,
      )
      .bind(updated.name, updated.summary, updated.repo, updated.projectType, lifecycle, updated.activityLevel, updated.testStatus, m.facts.testTs,
        m.facts.deployStatus, m.facts.deployTs, deployStatus, JSON.stringify(updated.deployHints), updated.lastActive, ev.ts, nextSeq, now, projectId),
    db.prepare('UPDATE project_locations SET building=?, slot=?, x=?, z=? WHERE project_id=?').bind(building, slot, x, z, projectId),
    db
      .prepare(
        `INSERT INTO sessions (id, project_id, started_at, ended_at, status, last_event_at, state_ts, permission_mode) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at, ended_at=excluded.ended_at, status=excluded.status, last_event_at=excluded.last_event_at,
           state_ts=excluded.state_ts, permission_mode=excluded.permission_mode`,
      )
      .bind(m.session.id, projectId, m.session.startedAt, m.session.endedAt, m.session.status, m.session.lastEventAt, m.session.stateTs, m.session.permissionMode),
  );
  for (const tid of out.changedTaskIds) {
    const t = m.tasks.find((x) => x.id === tid)!;
    t.version = nextSeq;
    stmts.push(
      db
        .prepare(
          `INSERT INTO tasks (id, project_id, session_id, kind, summary, status, created_at, updated_at, state_ts, completed_at, completion_basis, fail_streak, version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, summary=excluded.summary, status=excluded.status, created_at=excluded.created_at, updated_at=excluded.updated_at,
             state_ts=excluded.state_ts, completed_at=excluded.completed_at, completion_basis=excluded.completion_basis, fail_streak=excluded.fail_streak, version=excluded.version`,
        )
        .bind(t.id, projectId, m.session.id, t.kind, cleanText(t.summary, 200), t.status, t.createdAt, t.updatedAt, t.stateTs, t.completedAt, t.completionBasis, t.failStreak, nextSeq),
    );
    acc.tasks.set(t.id, t);
  }
  stmts.push(insertEvent(db, ev, nextSeq, projectId, out.taskId, m.session.id, now, out.late, ev.data));

  await db.batch(stmts); // atomic: all-or-nothing

  m.session.projectId = projectId;
  acc.projects.set(projectId, updated);
  acc.sessions.set(m.session.id, m.session);
  acc.cursor = nextSeq;
  acc.events.push(eventRow({ seq: nextSeq, id: ev.id, type: ev.type, project_id: projectId, session_id: m.session.id, task_id: out.taskId, ts: ev.ts, ingested_at: now, late: out.late ? 1 : 0, data: JSON.stringify(ev.data) }));
  return { id: ev.id, status: 'accepted', seq: nextSeq, late: out.late };
}

function insertEvent(db: D1Database, ev: Envelope, seq: number, projectId: string | null, taskId: string | null, sessionId: string | null, now: number, late: boolean, data: Record<string, unknown>) {
  return db
    .prepare(`INSERT INTO events (seq, id, type, project_id, session_id, task_id, ts, ingested_at, schema_version, source, late, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(seq, ev.id, ev.type, projectId, sessionId ?? ev.sessionId, taskId, ev.ts, now, ev.v, ev.source, late ? 1 : 0, JSON.stringify(data));
}
