import { describe, expect, it } from 'vitest';
import type { Delta, EventRow, ProjectRow, SessionRow, TaskRow, Snapshot } from '@mdw/shared';
import { DEFAULT_SETTINGS, actorAt, slotPosition } from '@mdw/shared';
import { applyDelta, EMPTY_DATA, fromSnapshot, needsResync } from '../src/lib/data.js';
import { computeMetrics, filterProjects, integrationHealth, projectStatus } from '../src/lib/metrics.js';
import { reconcileActors, stepActors } from '../src/lib/actors.js';
import { clampTarget, easeToward, BOUNDS } from '../src/lib/camera.js';
import { describeEvent } from '../src/lib/format.js';
import { routeFromHash, useStore } from '../src/store.js';

const NOW = 1_800_000_000_000;
const project = (o: Partial<ProjectRow> = {}): ProjectRow => ({
  id: 'p1', name: 'alpha', summary: '', repo: null, projectType: null, lifecycle: 'active', activityLevel: 'developing', testStatus: 'unknown', deployStatus: 'none',
  deployHints: [], userPaused: false, building: 'development', slot: 0, x: 0, z: 0, hue: 10, firstSeen: NOW, lastActive: NOW, version: 1, ...o,
});
const task = (o: Partial<TaskRow> = {}): TaskRow => ({ id: 't1', projectId: 'p1', sessionId: 's1', kind: 'feature', summary: 'x', status: 'in_development', createdAt: NOW, updatedAt: NOW, stateTs: NOW, completedAt: null, completionBasis: null, failStreak: 0, version: 1, ...o });
const session = (o: Partial<SessionRow> = {}): SessionRow => ({ id: 's1', projectId: 'p1', startedAt: NOW, endedAt: null, status: 'active', lastEventAt: NOW, stateTs: NOW, permissionMode: null, ...o });
const ev = (seq: number, o: Partial<EventRow> = {}): EventRow => ({ seq, id: `e${seq}`, type: 'tool.done', projectId: 'p1', sessionId: 's1', taskId: null, ts: NOW, ingestedAt: NOW, late: false, data: {}, ...o });
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
  cursor: 5, serverTime: NOW, projects: [project()], sessions: [session()], tasks: [task()], events: [ev(5), ev(4)],
  stats: { files: 0, storageBytes: 0, storageLimitBytes: 0, r2: true }, bridge: { tokens: [], lastIngestAt: null, lastIngestSource: null }, settings: DEFAULT_SETTINGS, ...o,
});
const delta = (o: Partial<Delta> = {}): Delta => ({ type: 'delta', cursor: 6, projects: [], sessions: [], tasks: [], events: [ev(6)], ...o });

describe('data store reducer', () => {
  it('loads a snapshot, newest event first, with server clock skew', () => {
    const d = fromSnapshot(snap({ serverTime: NOW + 5000 }), NOW);
    expect(d.events.map((e) => e.seq)).toEqual([5, 4]);
    expect(d.serverSkew).toBe(5000);
    expect(d.loaded).toBe(true);
  });
  it('applies a contiguous delta and advances the cursor', () => {
    const d0 = fromSnapshot(snap());
    const d1 = applyDelta(d0, delta({ projects: [project({ version: 6, building: 'testing' })], tasks: [task({ version: 6, status: 'testing' })] }));
    expect(d1.cursor).toBe(6);
    expect(d1.projects.p1!.building).toBe('testing');
    expect(d1.tasks.t1!.status).toBe('testing');
    expect(d1.events[0]!.seq).toBe(6);
  });
  it('never lets an older version overwrite newer state, and duplicate deltas are no-ops', () => {
    const d0 = applyDelta(fromSnapshot(snap()), delta({ projects: [project({ version: 6, building: 'testing' })] }));
    const stale = applyDelta(d0, delta({ cursor: 7, events: [ev(7)], projects: [project({ version: 3, building: 'intake' })] }));
    expect(stale.projects.p1!.building).toBe('testing');
    expect(applyDelta(d0, delta({ projects: [project({ version: 6, building: 'testing' })] }))).toBe(d0);
  });
  it('detects a missed message (gap) and demands a resync', () => {
    const d0 = fromSnapshot(snap());
    expect(needsResync(d0, delta({ cursor: 9, events: [ev(9)] }))).toBe(true);
    expect(needsResync(d0, delta())).toBe(false);
    expect(needsResync(EMPTY_DATA, delta())).toBe(true);
  });
  it('store.receive refuses non-contiguous deltas', () => {
    useStore.setState({ data: fromSnapshot(snap()) });
    expect(useStore.getState().receive(delta({ cursor: 9, events: [ev(9)] }))).toBe('resync');
    expect(useStore.getState().receive(delta())).toBe('applied');
    expect(useStore.getState().data.cursor).toBe(6);
  });
});

describe('metrics are computed from stored rows', () => {
  it('empty data yields zeros and an honest empty health state', () => {
    const m = computeMetrics(EMPTY_DATA, NOW);
    expect(m).toEqual({ activeProjects: 0, tasksInProgress: 0, tasksNeedingAttention: 0, completedTasks: 0, connectedSessions: 0, lastSync: null });
    expect(integrationHealth(EMPTY_DATA, NOW).level).toBe('none');
  });
  it('counts what is persisted', () => {
    const d = fromSnapshot(snap({ tasks: [task(), task({ id: 't2', status: 'needs_attention' }), task({ id: 't3', status: 'completed' }), task({ id: 't4', status: 'waiting_input' })] }), NOW);
    const m = computeMetrics(d, NOW);
    expect(m.activeProjects).toBe(1);
    expect(m.tasksInProgress).toBe(1);
    expect(m.tasksNeedingAttention).toBe(2);
    expect(m.completedTasks).toBe(1);
    expect(m.connectedSessions).toBe(1);
  });
  it('does not count observed-only projects, and sessions silent for 30+ minutes are not "connected"', () => {
    const d = fromSnapshot(snap({ projects: [project({ activityLevel: 'observed' })], sessions: [session({ lastEventAt: NOW - 31 * 60_000 })] }), NOW);
    const m = computeMetrics(d, NOW);
    expect(m.activeProjects).toBe(0);
    expect(m.connectedSessions).toBe(0);
  });
  it('integration health reflects real timestamps', () => {
    const tok = [{ id: 'a', name: 'n', createdAt: NOW, lastUsedAt: null, revokedAt: null }];
    const base = fromSnapshot(snap({ bridge: { tokens: tok, lastIngestAt: null, lastIngestSource: null } }), NOW);
    expect(integrationHealth(base, NOW).level).toBe('waiting');
    expect(integrationHealth({ ...base, bridge: { ...base.bridge, lastIngestAt: NOW - 1000 } }, NOW).level).toBe('ok');
    expect(integrationHealth({ ...base, bridge: { ...base.bridge, lastIngestAt: NOW - 3600_000 } }, NOW).level).toBe('quiet');
    expect(integrationHealth({ ...base, bridge: { ...base.bridge, lastIngestAt: NOW - 20 * 3600_000 } }, NOW).level).toBe('stale');
  });
});

describe('project status honesty', () => {
  it('shows Disconnected instead of an endless "in development" when the session went silent', () => {
    const d = fromSnapshot(snap({ sessions: [session({ lastEventAt: NOW - 45 * 60_000 })] }), NOW);
    expect(projectStatus(d.projects.p1!, d, NOW).label).toBe('Disconnected');
  });
  it('paused wins; attention stays visible even when disconnected', () => {
    const d = fromSnapshot(snap({ tasks: [task({ status: 'needs_attention' })], sessions: [session({ lastEventAt: NOW - 45 * 60_000 })] }), NOW);
    expect(projectStatus(d.projects.p1!, d, NOW).tone).toBe('bad');
    expect(projectStatus(project({ userPaused: true }), d, NOW).label).toBe('Paused');
  });
});

describe('filters and search', () => {
  const d = fromSnapshot(snap({
    projects: [
      project({ id: 'a', name: 'Alpha Site' }),
      project({ id: 'b', name: 'Beta API', lifecycle: 'completed' }),
      project({ id: 'c', name: 'Gamma', userPaused: true, lifecycle: 'paused' }),
      project({ id: 'd', name: 'Delta', lifecycle: 'attention', testStatus: 'failing' }),
      project({ id: 'e', name: 'Observed', activityLevel: 'observed' }),
    ],
  }), NOW);
  const names = (f: Parameters<typeof filterProjects>[1], q = '', obs = false) => filterProjects(d, f, q, obs).map((p) => p.name).sort();
  it('filters by lifecycle', () => {
    expect(names('all')).toEqual(['Alpha Site', 'Beta API', 'Delta', 'Gamma']);
    expect(names('active')).toEqual(['Alpha Site', 'Delta']);
    expect(names('paused')).toEqual(['Gamma']);
    expect(names('completed')).toEqual(['Beta API']);
    expect(names('failed')).toEqual(['Delta']);
  });
  it('searches by name case-insensitively and can include observed sessions', () => {
    expect(names('all', 'alp')).toEqual(['Alpha Site']);
    expect(names('all', 'zzz')).toEqual([]);
    expect(names('all', '', true)).toContain('Observed');
  });
});

describe('3D: persisted state drives animation', () => {
  it('places new projects instantly and animates only when the persisted location changes', () => {
    let r = reconcileActors(new Map(), [project({ building: 'intake', slot: 0 })], { instant: false });
    expect(r.moved).toEqual([]);
    expect(r.actors.get('p1')!.route).toHaveLength(0);
    r = reconcileActors(r.actors, [project({ building: 'intake', slot: 0 })], { instant: false });
    expect(r.moved).toEqual([]);
    r = reconcileActors(r.actors, [project({ building: 'testing', slot: 1 })], { instant: false });
    expect(r.moved).toEqual(['p1']);
    expect(r.actors.get('p1')!.route.length).toBeGreaterThan(2);
    for (let i = 0; i < 600; i++) stepActors(r.actors, 0.05);
    expect(r.actors.get('p1')!.pos).toEqual(slotPosition('testing', 1));
  });
  it('reduced motion teleports', () => {
    const start = new Map([['p1', actorAt('intake', 0)]]);
    const r = reconcileActors(start, [project({ building: 'workshop', slot: 2 })], { instant: true });
    expect(r.actors.get('p1')!.route).toHaveLength(0);
    expect(r.actors.get('p1')!.pos).toEqual(slotPosition('workshop', 2));
  });
});

describe('camera controls', () => {
  it('clamps pan target to the world and eases without overshoot', () => {
    expect(clampTarget(500, -500)).toEqual([BOUNDS, -BOUNDS]);
    let v = 0;
    for (let i = 0; i < 200; i++) v = easeToward(v, 10, 1 / 60);
    expect(v).toBe(10);
    expect(easeToward(0, 10, 0.016)).toBeGreaterThan(0);
    expect(easeToward(0, 10, 0.016)).toBeLessThan(10);
  });
  it('store camera commands increment a tick so repeated identical commands still fire', () => {
    useStore.getState().focus(5, 5);
    const t1 = useStore.getState().camera!.tick;
    useStore.getState().focus(5, 5);
    expect(useStore.getState().camera!.tick).toBe(t1 + 1);
    useStore.getState().resetCamera();
    expect(useStore.getState().camera!.kind).toBe('reset');
  });
});

describe('navigation and descriptions', () => {
  it('parses routes', () => {
    expect(routeFromHash('#/projects/p%201')).toEqual({ route: 'projects', id: 'p 1' });
    expect(routeFromHash('#/nonsense')).toEqual({ route: 'world', id: null });
    expect(routeFromHash('')).toEqual({ route: 'world', id: null });
  });
  it('describes events from sanitized fields only', () => {
    expect(describeEvent(ev(1, { type: 'tool.fail', data: { category: 'test' } }))).toBe('Tests failed');
    expect(describeEvent(ev(1, { type: 'session.start', data: { source: 'resume' } }))).toBe('Claude resumed a session');
    expect(describeEvent(ev(1, { type: 'prompt.submit', data: { promptKind: 'bugfix', summary: 'fix login' } }))).toContain('fix login');
    expect(describeEvent(ev(1, { type: 'turn.stop' }))).toBe('Claude finished responding');
  });
  it('selecting a project clears a selected building and vice versa', () => {
    useStore.getState().selectBuilding('testing');
    useStore.getState().select('p1');
    expect(useStore.getState().selectedBuilding).toBeNull();
    useStore.getState().selectBuilding('hq');
    expect(useStore.getState().selectedId).toBeNull();
  });
});
