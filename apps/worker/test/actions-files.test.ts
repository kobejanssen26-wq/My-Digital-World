import { describe, expect, it } from 'vitest';
import { call, e, event, ingest, login, makeToken, T0 } from './helpers.js';
import { safeName, validateUpload } from '../src/files.js';

describe('dashboard actions', () => {
  it('pausing keeps the project in place and is honest in lifecycle; resume restores', async () => {
    const s = await login('10.6.0.1');
    const t = await makeToken(s);
    const proj = { keys: ['remote:github.com/me/pausable', 'path:pausablep1'], name: 'pausable' };
    await ingest(t.token, [
      event('prompt.submit', T0, { promptKind: 'feature', confidence: 'medium', summary: 'do it' }, { sessionId: 'sp', project: proj }),
      event('tool.done', T0 + 1, { category: 'modify' }, { sessionId: 'sp', project: proj }),
    ]);
    let snap = (await (await call('/api/snapshot', { cookie: s.cookie })).json()) as any;
    const p = snap.projects.find((x: any) => x.name === 'pausable');
    expect(p.building).toBe('development');
    const r = await call('/api/actions', { method: 'POST', json: { action: 'pause_project', projectId: p.id }, ...s });
    expect(r.status).toBe(200);
    // a later test failure must not move a paused project
    await ingest(t.token, [event('tool.fail', T0 + 2, { category: 'test' }, { sessionId: 'sp', project: proj })]);
    snap = (await (await call('/api/snapshot', { cookie: s.cookie })).json()) as any;
    const paused = snap.projects.find((x: any) => x.id === p.id);
    expect(paused.lifecycle).toBe('paused');
    expect(paused.building).toBe('development');
    await call('/api/actions', { method: 'POST', json: { action: 'resume_project', projectId: p.id }, ...s });
    snap = (await (await call('/api/snapshot', { cookie: s.cookie })).json()) as any;
    expect(snap.projects.find((x: any) => x.id === p.id).building).toBe('workshop');
  });

  it('marking a task complete moves a finished project to the completed district after sessions end', async () => {
    const s = await login('10.6.0.2');
    const t = await makeToken(s);
    const proj = { keys: ['path:completeme01'], name: 'completeme' };
    const mk = (type: string, ts: number, d = {}) => event(type, ts, d, { sessionId: 'sc', project: proj });
    await ingest(t.token, [mk('prompt.submit', T0, { promptKind: 'feature', confidence: 'medium', summary: 'x' }), mk('tool.done', T0 + 1, { category: 'modify' }), mk('turn.stop', T0 + 2), mk('session.end', T0 + 3)]);
    const snap = (await (await call('/api/snapshot', { cookie: s.cookie })).json()) as any;
    const p = snap.projects.find((x: any) => x.name === 'completeme');
    expect(p.building).toBe('completed');
    expect(p.lifecycle).toBe('completed');
    const task = snap.tasks.find((x: any) => x.projectId === p.id);
    expect(task.completionBasis).toBe('claude_finished_session_closed');
    expect(p.deployStatus).toBe('none'); // completion never implies deployment
    expect(p.testStatus).toBe('unknown'); // nor tests
  });

  it('validates action payloads and unknown ids', async () => {
    const s = await login('10.6.0.3');
    expect((await call('/api/actions', { method: 'POST', json: { action: 'rm_rf' }, ...s })).status).toBe(400);
    expect((await call('/api/actions', { method: 'POST', json: { action: 'pause_project', projectId: 'nope' }, ...s })).status).toBe(404);
  });

  it('search queries stored records, escapes wildcards', async () => {
    const s = await login('10.6.0.4');
    const hit = (await (await call('/api/search?q=pausable', { cookie: s.cookie })).json()) as any;
    expect(hit.projects.some((p: any) => p.name === 'pausable')).toBe(true);
    const wild = (await (await call('/api/search?q=%25', { cookie: s.cookie })).json()) as any;
    expect(wild.projects).toHaveLength(0);
  });

  it('settings reject unknown keys', async () => {
    const s = await login('10.6.0.5');
    expect((await call('/api/settings', { method: 'PUT', json: { evil: 1 }, ...s })).status).toBe(400);
  });
});

describe('maintenance', () => {
  it('marks silent sessions lost and interrupts in-flight tasks, and applies retention', async () => {
    const s = await login('10.6.0.6');
    const t = await makeToken(s);
    const proj = { keys: ['path:staleproj001'], name: 'stale' };
    const old = Date.now() - 3 * 3600_000;
    await ingest(t.token, [
      event('prompt.submit', old, { promptKind: 'feature', confidence: 'medium', summary: 'x' }, { sessionId: 'ss', project: proj }),
      event('tool.done', old + 1, { category: 'modify' }, { sessionId: 'ss', project: proj }),
    ]);
    const { env } = await import('cloudflare:workers');
    await (env as any).HUB.get((env as any).HUB.idFromName('main')).maintain();
    const snap = (await (await call('/api/snapshot', { cookie: s.cookie })).json()) as any;
    expect(snap.sessions.find((x: any) => x.id === 'ss').status).toBe('lost');
    expect(snap.tasks.find((x: any) => x.sessionId === 'ss').status).toBe('interrupted');
    const p = snap.projects.find((x: any) => x.name === 'stale');
    expect(p.lifecycle).not.toBe('active');
  });
});

describe('personal cloud', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const upload = (s: { cookie: string; csrf: string }, name: string, body: Uint8Array, type: string, folder?: string) =>
    call(`/api/files?name=${encodeURIComponent(name)}${folder ? `&folder=${folder}` : ''}`, { method: 'PUT', body, headers: { 'content-type': type, 'content-length': String(body.byteLength) }, ...s });

  it('uploads, lists, downloads and deletes a file', async () => {
    const s = await login('10.7.0.1');
    const up = await upload(s, 'pic.png', PNG, 'image/png');
    expect(up.status).toBe(201);
    const { id } = (await up.json()) as { id: string };
    const list = (await (await call('/api/files', { cookie: s.cookie })).json()) as any;
    expect(list.files.some((f: any) => f.id === id)).toBe(true);
    expect(list.usage.bytes).toBeGreaterThan(0);
    const dl = await call(`/api/files/${id}/download`, { cookie: s.cookie });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PNG);
    const inline = await call(`/api/files/${id}/download?inline=1`, { cookie: s.cookie });
    expect(inline.headers.get('content-type')).toBe('image/png');
    expect(inline.headers.get('content-security-policy')).toContain('sandbox');
    expect((await call(`/api/files/${id}`, { method: 'DELETE', cookie: s.cookie, csrf: s.csrf })).status).toBe(200);
    expect((await call(`/api/files/${id}/download`, { cookie: s.cookie })).status).toBe(404);
    expect(await e.FILES!.get(`files/${id}`)).toBeNull();
  });

  it('requires authentication for every file operation', async () => {
    expect((await call('/api/files/f_x/download')).status).toBe(401);
    expect((await call('/api/files/f_x', { method: 'DELETE' })).status).toBe(401);
    expect((await call('/api/files?name=a', { method: 'PUT', body: 'x' })).status).toBe(401);
  });

  it('rejects mismatched content, executable names, oversize and missing length', async () => {
    const s = await login('10.7.0.2');
    expect((await upload(s, 'fake.png', new Uint8Array([1, 2, 3, 4]), 'image/png')).status).toBe(415);
    expect((await upload(s, 'run.exe', new Uint8Array([1, 2, 3, 4]), 'application/octet-stream')).status).toBe(415);
    const big = await call('/api/files?name=big.bin', { method: 'PUT', body: 'x', headers: { 'content-length': String(26 * 1024 * 1024) }, ...s });
    expect(big.status).toBe(413);
  });

  it('never serves non-allowlisted types inline (html/svg download only)', async () => {
    const s = await login('10.7.0.3');
    const up = await upload(s, 'x.html', new TextEncoder().encode('<script>alert(1)</script>'), 'text/html');
    const { id } = (await up.json()) as { id: string };
    const res = await call(`/api/files/${id}/download?inline=1`, { cookie: s.cookie });
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('manages folders and refuses to delete non-empty ones', async () => {
    const s = await login('10.7.0.4');
    const f = (await (await call('/api/files/folders', { method: 'POST', json: { name: 'Docs' }, ...s })).json()) as { id: string };
    expect((await call('/api/files/folders', { method: 'POST', json: { name: 'Docs' }, ...s })).status).toBe(409);
    expect((await call('/api/files/folders', { method: 'POST', json: { name: '../x' }, ...s })).status).toBe(400);
    const up = await upload(s, 'note.txt', new TextEncoder().encode('hello'), 'text/plain', f.id);
    expect(up.status).toBe(201);
    expect((await call(`/api/files/folders/${f.id}`, { method: 'DELETE', cookie: s.cookie, csrf: s.csrf })).status).toBe(409);
    const list = (await (await call(`/api/files?folder=${f.id}`, { cookie: s.cookie })).json()) as any;
    expect(list.files).toHaveLength(1);
    const search = (await (await call('/api/files?q=note', { cookie: s.cookie })).json()) as any;
    expect(search.files.some((x: any) => x.name === 'note.txt')).toBe(true);
  });

  it('enforces the configured storage limit', async () => {
    const s = await login('10.7.0.5');
    await call('/api/settings', { method: 'PUT', json: { storageLimitMb: 1 }, ...s });
    const res = await upload(s, 'huge.txt', new Uint8Array(2 * 1024 * 1024), 'text/plain');
    expect(res.status).toBe(507);
    await call('/api/settings', { method: 'PUT', json: { storageLimitMb: 1024 }, ...s });
  });

  it('sanitizes names', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('..hidden')).toBe('hidden');
    expect(validateUpload('a.png', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe('idle completion (cloud sessions never send SessionEnd)', () => {
  it('moves a finished, idle project to the completed district and records the basis', async () => {
    const s = await login('10.9.0.1');
    const t = await makeToken(s);
    const proj = { keys: ['path:idlecomplete1'], name: 'idle-done' };
    const old = Date.now() - 20 * 60_000;
    const mk = (type: string, ts: number, d = {}) => event(type, ts, d, { sessionId: 'sid', project: proj });
    await ingest(t.token, [mk('prompt.submit', old, { promptKind: 'feature', confidence: 'medium', summary: 'x' }), mk('tool.done', old + 1, { category: 'modify' }), mk('turn.stop', old + 2)]);
    let snap = (await (await call('/api/snapshot', { cookie: s.cookie })).json()) as any;
    expect(snap.projects.find((p: any) => p.name === 'idle-done').building).toBe('development');
    const { env } = await import('cloudflare:workers');
    await (env as any).HUB.get((env as any).HUB.idFromName('main')).maintain();
    snap = (await (await call('/api/snapshot', { cookie: s.cookie })).json()) as any;
    const p = snap.projects.find((x: any) => x.name === 'idle-done');
    expect(p.building).toBe('completed');
    expect(p.testStatus).toBe('unknown');
    expect(p.deployStatus).toBe('none');
    expect(snap.tasks.find((x: any) => x.projectId === p.id).completionBasis).toBe('claude_finished_then_idle');
  });
});
