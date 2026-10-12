import { beforeAll, describe, expect, it } from 'vitest';
import { call, e, event, ingest, login, makeToken, T0 } from './helpers.js';

let session: { cookie: string; csrf: string };
let bearer: string;

async function snapshot() {
  const res = await call('/api/snapshot', { cookie: session.cookie });
  return (await res.json()) as any;
}

beforeAll(async () => {
  session = await login('10.1.0.1');
  bearer = (await makeToken(session)).token;
});

describe('event ingestion', () => {
  it('accepts valid events, creates the project automatically, and persists them', async () => {
    const evs = [
      event('session.start', T0, { source: 'startup' }),
      event('prompt.submit', T0 + 1000, { promptKind: 'build', confidence: 'high', summary: 'Build a portfolio site' }, { project: { keys: ['remote:github.com/me/demo', 'path:aaaabbbbcc'], name: 'demo', repo: 'github.com/me/demo', isNew: true, deployHints: ['wrangler'] } }),
      event('tool.done', T0 + 2000, { tool: 'Write', category: 'modify' }),
    ];
    const { res, body } = await ingest(bearer, evs);
    expect(res.status).toBe(200);
    expect(body.results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);
    const snap = await snapshot();
    const p = snap.projects.find((x: any) => x.name === 'demo');
    expect(p).toBeTruthy();
    expect(p.activityLevel).toBe('developing');
    expect(p.building).toBe('development');
    expect(p.summary).toBe('Build a portfolio site');
    expect(snap.tasks.find((t: any) => t.projectId === p.id).status).toBe('in_development');
    expect(snap.sessions.find((s: any) => s.id === 'sess-1').status).toBe('active');
    expect(snap.events.length).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent: duplicate event ids are reported and change nothing', async () => {
    const ev = event('tool.done', T0 + 3000, { tool: 'Edit', category: 'modify' });
    const first = await ingest(bearer, [ev]);
    const before = (await snapshot()).cursor;
    const second = await ingest(bearer, [ev, ev]);
    expect(first.body.results[0]!.status).toBe('accepted');
    expect(second.body.results.map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect((await snapshot()).cursor).toBe(before);
  });

  it('rejects invalid payloads per event without failing the batch', async () => {
    const good = event('tool.done', T0 + 4000, { tool: 'Read', category: 'read' });
    const { res, body } = await ingest(bearer, [{ nonsense: true }, { ...good, data: { prompt: 'leaked raw prompt' } }, good]);
    expect(res.status).toBe(200);
    expect(body.results[0]!.status).toBe('rejected');
    expect(body.results[1]!.status).toBe('rejected');
    expect(body.results[2]!.status).toBe('accepted');
  });

  it('rejects unknown event types explicitly', async () => {
    const { body } = await ingest(bearer, [event('file.exfiltrate', T0 + 5000)]);
    expect(body.results[0]).toMatchObject({ status: 'rejected', reason: 'unknown_event_type' });
  });

  it('rejects malformed bodies and oversized batches', async () => {
    const r1 = await call('/api/ingest', { method: 'POST', body: 'not json', bearer });
    expect(r1.status).toBe(400);
    const r2 = await call('/api/ingest', { method: 'POST', json: { events: Array.from({ length: 101 }, () => ({})) }, bearer });
    expect(r2.status).toBe(400);
    const r3 = await call('/api/ingest', { method: 'POST', json: { events: [] }, bearer });
    expect(r3.status).toBe(400);
  });

  it('keeps events without project metadata for known sessions and attributes them correctly', async () => {
    const ev = event('tool.done', T0 + 6000, { tool: 'Grep', category: 'read' }, { project: undefined });
    const { body } = await ingest(bearer, [ev]);
    expect(body.results[0]!.status).toBe('accepted');
    const snap = await snapshot();
    const stored = snap.events.find((x: any) => x.id === ev.id);
    expect(stored.projectId).toBeTruthy();
  });

  it('stores events with unknown sessions and no project as unattributed, with no state change', async () => {
    const before = (await snapshot()).projects.length;
    const ev = event('tool.done', T0 + 7000, { tool: 'Read', category: 'read' }, { project: undefined, sessionId: 'ghost' });
    const { body } = await ingest(bearer, [ev]);
    expect(body.results[0]!.status).toBe('accepted');
    const snap = await snapshot();
    expect(snap.projects.length).toBe(before);
    expect(snap.events.find((x: any) => x.id === ev.id).projectId).toBeNull();
  });

  it('handles out-of-order events: an old event cannot overwrite newer authoritative state', async () => {
    const proj = { keys: ['remote:github.com/me/ooo', 'path:oooooooo11'], name: 'ooo' };
    const sid = 'sess-ooo';
    const mk = (type: string, ts: number, data = {}) => event(type, ts, data, { sessionId: sid, project: proj });
    await ingest(bearer, [mk('session.start', T0), mk('prompt.submit', T0 + 1, { promptKind: 'feature', confidence: 'medium', summary: 'x' }), mk('tool.done', T0 + 10, { category: 'modify' }), mk('turn.stop', T0 + 50)]);
    let snap = await snapshot();
    const task = snap.tasks.find((t: any) => t.sessionId === sid);
    expect(task.status).toBe('ready_for_review');
    // arrives late, but belongs before the stop
    const { body } = await ingest(bearer, [mk('tool.done', T0 + 20, { category: 'modify' })]);
    expect(body.results[0]!.late).toBe(true);
    snap = await snapshot();
    expect(snap.tasks.find((t: any) => t.sessionId === sid).status).toBe('ready_for_review');
  });

  it('keeps concurrent sessions in the same repository isolated but in one project', async () => {
    const proj = { keys: ['remote:github.com/me/shared', 'path:sharedpath1'], name: 'shared' };
    const a = (type: string, ts: number, d = {}) => event(type, ts, d, { sessionId: 'sess-A', project: proj });
    const b = (type: string, ts: number, d = {}) => event(type, ts, d, { sessionId: 'sess-B', project: { ...proj, keys: ['remote:github.com/me/shared', 'path:otherworktree'] } });
    await ingest(bearer, [
      a('prompt.submit', T0, { promptKind: 'feature', confidence: 'medium', summary: 'A feature' }),
      b('prompt.submit', T0 + 1, { promptKind: 'bugfix', confidence: 'medium', summary: 'B bugfix' }),
      a('tool.done', T0 + 2, { category: 'modify' }),
      b('tool.fail', T0 + 3, { category: 'test' }),
    ]);
    const snap = await snapshot();
    const projects = snap.projects.filter((p: any) => p.name === 'shared');
    expect(projects).toHaveLength(1);
    const tasks = snap.tasks.filter((t: any) => t.projectId === projects[0].id);
    expect(tasks.find((t: any) => t.sessionId === 'sess-A').status).toBe('in_development');
    expect(tasks.find((t: any) => t.sessionId === 'sess-B').status).toBe('needs_attention');
    expect(projects[0].building).toBe('workshop'); // the problem is not hidden by the healthy session
  });

  it('creates different projects for different repositories and non-git directories', async () => {
    await ingest(bearer, [
      event('prompt.submit', T0, { promptKind: 'build', confidence: 'high', summary: 'one' }, { sessionId: 's-r1', project: { keys: ['remote:github.com/me/r1', 'path:r1r1r1r1'], name: 'r1' } }),
      event('prompt.submit', T0, { promptKind: 'build', confidence: 'high', summary: 'two' }, { sessionId: 's-r2', project: { keys: ['remote:github.com/me/r2', 'path:r2r2r2r2'], name: 'r2' } }),
      event('prompt.submit', T0, { promptKind: 'build', confidence: 'high', summary: 'script' }, { sessionId: 's-np', project: { keys: ['path:scriptdir1'], name: 'one-off-script' } }),
    ]);
    const names = (await snapshot()).projects.map((p: any) => p.name);
    for (const n of ['r1', 'r2', 'one-off-script']) expect(names).toContain(n);
  });

  it('resumed sessions reactivate without duplicating the project or session', async () => {
    const proj = { keys: ['remote:github.com/me/resume', 'path:resumepath1'], name: 'resume' };
    const mk = (type: string, ts: number, d = {}) => event(type, ts, d, { sessionId: 'sess-resume', project: proj });
    await ingest(bearer, [mk('session.start', T0), mk('prompt.submit', T0 + 1, { promptKind: 'feature', confidence: 'medium', summary: 'x' }), mk('session.end', T0 + 5, { reason: 'other' })]);
    let snap = await snapshot();
    expect(snap.sessions.find((s: any) => s.id === 'sess-resume').status).toBe('ended');
    await ingest(bearer, [mk('session.start', T0 + 1000, { source: 'resume' }), mk('tool.done', T0 + 1001, { category: 'modify' })]);
    snap = await snapshot();
    expect(snap.projects.filter((p: any) => p.name === 'resume')).toHaveLength(1);
    expect(snap.sessions.filter((s: any) => s.id === 'sess-resume')).toHaveLength(1);
    expect(snap.sessions.find((s: any) => s.id === 'sess-resume').status).toBe('active');
  });

  it('a renamed remote in the same directory stays the same project (alias learning)', async () => {
    const mk = (keys: string[], name: string, ts: number) => event('tool.done', ts, { category: 'modify' }, { sessionId: 'sess-' + name, project: { keys, name } });
    await ingest(bearer, [mk(['remote:github.com/me/old', 'path:renamepath1'], 'old', T0)]);
    await ingest(bearer, [mk(['remote:github.com/me/new', 'path:renamepath1'], 'new', T0 + 10)]);
    const snap = await snapshot();
    expect(snap.projects.filter((p: any) => ['old', 'new'].includes(p.name))).toHaveLength(1);
    expect(snap.projects.find((p: any) => p.name === 'new')).toBeTruthy();
  });

  it('does not store prompt text beyond the sanitized summary', async () => {
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const ev = event('prompt.submit', T0 + 9000, { promptKind: 'feature', confidence: 'medium', summary: `use ${secret} for it` });
    await ingest(bearer, [ev]);
    const row = await e.DB.prepare('SELECT data FROM events WHERE id=?').bind(ev.id).first<{ data: string }>();
    expect(row!.data).not.toContain(secret);
  });
});

describe('persistence and replay', () => {
  it('replays missed events after a cursor in order', async () => {
    const cursor = (await snapshot()).cursor;
    await ingest(bearer, [event('tool.done', T0 + 20000, { category: 'read' }), event('tool.done', T0 + 20001, { category: 'read' })]);
    const res = await call(`/api/events?after=${cursor}`, { cookie: session.cookie });
    const body = (await res.json()) as any;
    expect(body.events).toHaveLength(2);
    expect(body.events[0].seq).toBeLessThan(body.events[1].seq);
  });

  it('pages history with before/limit', async () => {
    const res = await call('/api/events?limit=2', { cookie: session.cookie });
    const body = (await res.json()) as any;
    expect(body.events).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    const next = await call(`/api/events?limit=2&before=${body.events[1].seq}`, { cookie: session.cookie });
    expect(((await next.json()) as any).events[0].seq).toBeLessThan(body.events[1].seq);
  });

  it('data survives a Durable Object restart (D1 is authoritative)', async () => {
    const { evictAllDurableObjects } = await import('cloudflare:test');
    const before = await snapshot();
    await evictAllDurableObjects?.();
    const after = await snapshot();
    expect(after.projects.length).toBe(before.projects.length);
    expect(after.cursor).toBe(before.cursor);
  });
});
