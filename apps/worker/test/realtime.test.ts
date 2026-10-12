import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { call, event, ingest, login, makeToken, T0 } from './helpers.js';

async function connect(cookie: string) {
  const res = await ((exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default).fetch(
    new Request('https://mdw.test/api/ws', { headers: { upgrade: 'websocket', cookie, origin: 'https://mdw.test' } }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const inbox: any[] = [];
  const waiters: ((m: any) => void)[] = [];
  ws.addEventListener('message', (m) => {
    const data = JSON.parse(m.data as string);
    const w = waiters.shift();
    if (w) w(data);
    else inbox.push(data);
  });
  const next = (ms = 3000) =>
    new Promise<any>((resolve, reject) => {
      if (inbox.length) return resolve(inbox.shift());
      const t = setTimeout(() => reject(new Error('ws timeout')), ms);
      waiters.push((m) => (clearTimeout(t), resolve(m)));
    });
  return { ws, next, inbox };
}

describe('realtime delivery', () => {
  it('pushes a delta to a connected client when the bridge ingests an event', async () => {
    const s = await login('10.8.0.1');
    const { token } = await makeToken(s);
    const c = await connect(s.cookie);
    const hello = await c.next();
    expect(hello.type).toBe('hello');
    const proj = { keys: ['path:rtproject001'], name: 'realtime' };
    await ingest(token, [event('prompt.submit', T0, { promptKind: 'feature', confidence: 'medium', summary: 'live' }, { sessionId: 'rt1', project: proj })]);
    const delta = await c.next();
    expect(delta.type).toBe('delta');
    expect(delta.projects[0].name).toBe('realtime');
    expect(delta.projects[0].building).toBe('intake');
    expect(delta.tasks[0].status).toBe('received');
    expect(delta.events[0].type).toBe('prompt.submit');
    expect(delta.cursor).toBeGreaterThan(hello.cursor);
    c.ws.close();
  });

  it('a disconnected client recovers missed events from the replay endpoint', async () => {
    const s = await login('10.8.0.2');
    const { token } = await makeToken(s);
    const c1 = await connect(s.cookie);
    const hello = await c1.next();
    c1.ws.close();
    const proj = { keys: ['path:rtproject002'], name: 'offline' };
    await ingest(token, [event('prompt.submit', T0, { promptKind: 'bugfix', confidence: 'medium', summary: 'while away' }, { sessionId: 'rt2', project: proj })]);
    // reconnect: hello cursor is ahead of what we had => client must resync
    const c2 = await connect(s.cookie);
    const hello2 = await c2.next();
    expect(hello2.cursor).toBeGreaterThan(hello.cursor);
    const missed = (await (await call(`/api/events?after=${hello.cursor}`, { cookie: s.cookie })).json()) as any;
    expect(missed.events.map((e: any) => e.type)).toContain('prompt.submit');
    const snap = (await (await call('/api/snapshot', { cookie: s.cookie })).json()) as any;
    expect(snap.projects.some((p: any) => p.name === 'offline')).toBe(true);
    c2.ws.close();
  });

  it('events from concurrent sessions arrive attributed to the right project', async () => {
    const s = await login('10.8.0.3');
    const { token } = await makeToken(s);
    const c = await connect(s.cookie);
    await c.next();
    const pa = { keys: ['path:rtconcurrA1'], name: 'conc-a' };
    const pb = { keys: ['path:rtconcurrB1'], name: 'conc-b' };
    await Promise.all([
      ingest(token, [event('prompt.submit', T0, { promptKind: 'feature', confidence: 'medium', summary: 'A' }, { sessionId: 'ca', project: pa })]),
      ingest(token, [event('prompt.submit', T0, { promptKind: 'feature', confidence: 'medium', summary: 'B' }, { sessionId: 'cb', project: pb })]),
    ]);
    const m1 = await c.next();
    const m2 = await c.next();
    const byName = Object.fromEntries([m1, m2].map((m) => [m.projects[0].name, m]));
    expect(byName['conc-a'].tasks[0].summary).toBe('A');
    expect(byName['conc-b'].tasks[0].summary).toBe('B');
    expect(byName['conc-a'].projects[0].id).not.toBe(byName['conc-b'].projects[0].id);
    expect(m2.cursor).toBeGreaterThan(m1.cursor); // serialized, strictly increasing
    c.ws.close();
  });

  it('user actions are broadcast too', async () => {
    const s = await login('10.8.0.4');
    const { token } = await makeToken(s);
    const proj = { keys: ['path:rtactionp01'], name: 'act' };
    await ingest(token, [event('prompt.submit', T0, { promptKind: 'feature', confidence: 'medium', summary: 'x' }, { sessionId: 'rta', project: proj })]);
    const snap = (await (await call('/api/snapshot', { cookie: s.cookie })).json()) as any;
    const id = snap.projects.find((p: any) => p.name === 'act').id;
    const c = await connect(s.cookie);
    await c.next();
    await call('/api/actions', { method: 'POST', json: { action: 'pause_project', projectId: id }, ...s });
    const d = await c.next();
    expect(d.projects[0].userPaused).toBe(true);
    expect(d.events[0].type).toBe('user.action');
    c.ws.close();
  });
});
